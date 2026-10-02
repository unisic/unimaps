/**
 * Server-side OSRM routing for the road-shape store. Pure helpers plus an
 * injected fetch, so tests never touch the network. The public demo server
 * (router.project-osrm.org) is shared and policed: callers must throttle
 * (≤1 req/s), send an identifying User-Agent and stop on block/config errors.
 */
import { decodePolyline, segMeters, type LatLng } from "./shared/polyline";

/** Max waypoints per request (matches the browser fallback in lib/client/api.ts). */
export const OSRM_CHUNK = 12;

/** Overlapping chunks of ≤ size points (consecutive chunks share one point). */
export function chunkWaypoints(pts: readonly LatLng[], size = OSRM_CHUNK): LatLng[][] {
  if (pts.length <= size) return pts.length >= 2 ? [pts.slice()] : [];
  const out: LatLng[][] = [];
  for (let i = 0; i < pts.length - 1; i += size - 1) {
    const slice = pts.slice(i, i + size);
    if (slice.length >= 2) out.push(slice);
  }
  return out;
}

/** Concatenate chunk geometries, dropping the duplicated joint point. */
export function mergeChunkGeometries(parts: readonly LatLng[][]): LatLng[] {
  const out: LatLng[] = [];
  for (const part of parts) {
    if (!part.length) continue;
    const last = out[out.length - 1];
    const start =
      last && Math.abs(part[0][0] - last[0]) < 1e-6 && Math.abs(part[0][1] - last[1]) < 1e-6 ? 1 : 0;
    for (let i = start; i < part.length; i++) out.push(part[i]);
  }
  return out;
}

export function osrmRouteUrl(base: string, pts: readonly LatLng[], continueStraight: boolean): string {
  const coords = pts.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const cs = continueStraight ? "&continue_straight=true" : "";
  return `${base.replace(/\/+$/, "")}/${coords}?overview=full&geometries=polyline6&steps=false&alternatives=false${cs}`;
}

export type OsrmFailure =
  /** this geometry can't be routed — fall back to straight lines for it */
  | "unroutable"
  /** transient (5xx, network, timeout, garbage) — retry later, commit nothing */
  | "unavailable"
  /** our request/config is wrong (Invalid*, 404, 414) — stop the worker */
  | "config"
  /** 401/403 — we are blocked; back off for a long time */
  | "blocked"
  /** 429 — honour Retry-After */
  | "ratelimited";

export type OsrmOutcome =
  | { ok: true; pts: LatLng[]; legs: number[] }
  | { ok: false; kind: OsrmFailure; detail: string; retryAfterSec?: number };

/** Classify an OSRM HTTP response (status + parsed JSON body or null). */
export function classifyOsrmResponse(status: number, body: unknown, retryAfter?: string | null): OsrmOutcome {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const code = typeof rec?.code === "string" ? rec.code : "";
  if (status === 429) {
    const ra = Number(retryAfter);
    return { ok: false, kind: "ratelimited", detail: "HTTP 429", retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : 60 };
  }
  if (status === 401 || status === 403) return { ok: false, kind: "blocked", detail: `HTTP ${status}` };
  if (status === 404 || status === 414) return { ok: false, kind: "config", detail: `HTTP ${status}` };
  if (code === "NoRoute" || code === "NoSegment") return { ok: false, kind: "unroutable", detail: code };
  if (code.startsWith("Invalid") || code === "NotImplemented" || code === "TooBig") {
    return { ok: false, kind: code === "TooBig" ? "unroutable" : "config", detail: code };
  }
  if (status >= 500 || !rec) return { ok: false, kind: "unavailable", detail: `HTTP ${status}${rec ? "" : " (no JSON)"}` };
  if (status !== 200 || code !== "Ok") return { ok: false, kind: "unavailable", detail: `HTTP ${status} ${code}` };
  const routes = Array.isArray(rec.routes) ? rec.routes : [];
  const r0 = routes[0] && typeof routes[0] === "object" ? (routes[0] as Record<string, unknown>) : null;
  const geom = typeof r0?.geometry === "string" ? r0.geometry : "";
  const pts = geom ? decodePolyline(geom, 6) : [];
  if (pts.length < 2) return { ok: false, kind: "unroutable", detail: "empty geometry" };
  const legs = Array.isArray(r0?.legs)
    ? (r0!.legs as unknown[]).map((l) => {
        const d = l && typeof l === "object" ? (l as Record<string, unknown>).distance : NaN;
        return typeof d === "number" ? d : NaN;
      })
    : [];
  return { ok: true, pts, legs };
}

/**
 * Indices of implausible legs: a stop-to-stop leg more than 2× the straight
 * distance AND over 400 m longer — the signature of a wrong-carriageway snap
 * sending OSRM around the block.
 */
export function implausibleLegs(legs: readonly number[], wps: readonly LatLng[]): number[] {
  const bad: number[] = [];
  for (let i = 0; i < legs.length && i + 1 < wps.length; i++) {
    const straight = segMeters(wps[i][0], wps[i][1], wps[i + 1][0], wps[i + 1][1]);
    const d = legs[i];
    if (Number.isFinite(d) && d > 2 * straight && d - straight > 400) bad.push(i);
  }
  return bad;
}

export interface OsrmClientOpts {
  base: string;
  fetchImpl: typeof fetch;
  /** resolves when the next request may be sent (counts every attempt) */
  throttle: () => Promise<void>;
  userAgent: string;
  timeoutMs?: number;
}

async function requestRoute(pts: readonly LatLng[], continueStraight: boolean, o: OsrmClientOpts): Promise<OsrmOutcome> {
  await o.throttle();
  let res: Response;
  try {
    res = await o.fetchImpl(osrmRouteUrl(o.base, pts, continueStraight), {
      headers: { "User-Agent": o.userAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (err) {
    return { ok: false, kind: "unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return classifyOsrmResponse(res.status, body, res.headers.get("retry-after"));
}

const isHard = (o: OsrmOutcome): boolean => !o.ok && o.kind !== "unroutable";

/** Route one chunk: continue_straight first, plain retry when unroutable or implausible. */
export async function routeChunk(pts: readonly LatLng[], o: OsrmClientOpts): Promise<OsrmOutcome> {
  const first = await requestRoute(pts, true, o);
  if (isHard(first)) return first;
  if (first.ok && implausibleLegs(first.legs, pts).length === 0) return first;
  const second = await requestRoute(pts, false, o);
  if (isHard(second)) return second;
  if (!first.ok) return second;
  if (!second.ok) return first;
  const badA = implausibleLegs(first.legs, pts).length;
  const badB = implausibleLegs(second.legs, pts).length;
  return badB < badA ? second : first;
}

export type RouteResult =
  | { ok: true; pts: LatLng[]; straightLegs: number; totalLegs: number }
  | { ok: false; kind: Exclude<OsrmFailure, "unroutable">; detail: string; retryAfterSec?: number };

/**
 * Road geometry through all waypoints. Hard failures abort the whole build
 * (nothing is committed). Unroutable or still-implausible pieces degrade to
 * straight lines — per chunk, or per stop pair when only some legs are bad.
 */
export async function routeWaypoints(wps: readonly LatLng[], o: OsrmClientOpts): Promise<RouteResult> {
  const parts: LatLng[][] = [];
  let straightLegs = 0;
  const totalLegs = Math.max(0, wps.length - 1);
  for (const chunk of chunkWaypoints(wps)) {
    const r = await routeChunk(chunk, o);
    if (!r.ok) {
      if (r.kind !== "unroutable") return { ok: false, kind: r.kind, detail: r.detail, retryAfterSec: r.retryAfterSec };
      parts.push(chunk);
      straightLegs += chunk.length - 1;
      continue;
    }
    if (implausibleLegs(r.legs, chunk).length === 0) {
      parts.push(r.pts);
      continue;
    }
    // some legs are bad: route this chunk pair by pair, straight where still bad
    for (let i = 0; i + 1 < chunk.length; i++) {
      const pair = [chunk[i], chunk[i + 1]];
      const pr = await routeChunk(pair, o);
      if (!pr.ok && pr.kind !== "unroutable") {
        return { ok: false, kind: pr.kind, detail: pr.detail, retryAfterSec: pr.retryAfterSec };
      }
      if (pr.ok && implausibleLegs(pr.legs, pair).length === 0) parts.push(pr.pts);
      else {
        parts.push(pair);
        straightLegs += 1;
      }
    }
  }
  return { ok: true, pts: mergeChunkGeometries(parts), straightLegs, totalLegs };
}
