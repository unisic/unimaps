/**
 * Server-side OSRM routing for the road-shape store. Pure helpers plus an
 * injected fetch, so tests never touch the network. The public demo server
 * (router.project-osrm.org) is shared and policed: callers must throttle
 * (≤1 req/s), send an identifying User-Agent and stop on block/config errors.
 */
import { bearing } from "./geo";
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

/**
 * OSRM snaps a waypoint only to a road heading within ± this of the bus's direction: never the opposite
 * carriageway, nor the side street of a junction stop (Buczkowice Żylica: Wczasowa, 10 m away, runs 62° off).
 */
const BEARING_RANGE = 45;
/** Neighbours closer than this give no usable direction. */
const BEARING_MIN_M = 25;

/** The bus's direction at each waypoint (previous to next waypoint, the ends along their one leg); null = can't tell. */
export function waypointBearings(wps: readonly LatLng[]): Array<number | null> {
  return wps.map((_, i) => {
    const a = wps[Math.max(0, i - 1)];
    const b = wps[Math.min(wps.length - 1, i + 1)];
    if (segMeters(a[0], a[1], b[0], b[1]) < BEARING_MIN_M) return null;
    const deg = bearing(a[0], a[1], b[0], b[1]);
    return deg === null ? null : Math.round(deg) % 360;
  });
}

export function osrmRouteUrl(
  base: string,
  pts: readonly LatLng[],
  continueStraight: boolean,
  bearings?: ReadonlyArray<number | null>,
): string {
  const coords = pts.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const cs = continueStraight ? "&continue_straight=true" : "";
  const br = bearings ? `&bearings=${bearings.map((b) => (b === null ? "" : `${b},${BEARING_RANGE}`)).join(";")}` : "";
  return `${base.replace(/\/+$/, "")}/${coords}?overview=full&geometries=polyline6&steps=false&alternatives=false${cs}${br}`;
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
  /** snapM: summed distance from each waypoint to where OSRM snapped it */
  | { ok: true; pts: LatLng[]; legs: number[]; snapM: number }
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
  const snapM = (Array.isArray(rec.waypoints) ? rec.waypoints : []).reduce((a: number, w: unknown) => {
    const d = w && typeof w === "object" ? (w as Record<string, unknown>).distance : NaN;
    return a + (typeof d === "number" && Number.isFinite(d) ? d : 0);
  }, 0);
  return { ok: true, pts, legs, snapM };
}

function longLegs(legs: readonly number[], wps: readonly LatLng[], ratio: number, extraM: number): number[] {
  const bad: number[] = [];
  for (let i = 0; i < legs.length && i + 1 < wps.length; i++) {
    const straight = segMeters(wps[i][0], wps[i][1], wps[i + 1][0], wps[i + 1][1]);
    const d = legs[i];
    if (Number.isFinite(d) && d > ratio * straight && d - straight > extraM) bad.push(i);
  }
  return bad;
}

/**
 * Indices of implausible legs: a stop-to-stop leg more than 2× the straight
 * distance AND over 400 m longer — the signature of a wrong-carriageway snap
 * sending OSRM around the block, so another way of asking is tried. Not proof:
 * a mountain serpentine (Szczyrk: 934 m apart, 2.4 km by road) looks the same.
 */
export function implausibleLegs(legs: readonly number[], wps: readonly LatLng[]): number[] {
  return longLegs(legs, wps, 2, 400);
}

/**
 * Indices of legs too long to draw: over 3× the straight distance AND over 3 km
 * longer. Anything shorter is drawn on the road, a detour on real streets beats
 * a straight line through buildings (the longest real one seen is +1.5 km).
 */
export function absurdLegs(legs: readonly number[], wps: readonly LatLng[]): number[] {
  return longLegs(legs, wps, 3, 3000);
}

export interface OsrmClientOpts {
  base: string;
  fetchImpl: typeof fetch;
  /** resolves when the next request may be sent (counts every attempt) */
  throttle: () => Promise<void>;
  userAgent: string;
  timeoutMs?: number;
}

async function requestRoute(
  pts: readonly LatLng[],
  continueStraight: boolean,
  o: OsrmClientOpts,
  bearings?: ReadonlyArray<number | null>,
): Promise<OsrmOutcome> {
  await o.throttle();
  let res: Response;
  try {
    res = await o.fetchImpl(osrmRouteUrl(o.base, pts, continueStraight, bearings), {
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
const total = (legs: readonly number[]): number => legs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

/**
 * Route one chunk with continue_straight, once without and once with the bus's direction at each stop
 * (`bearings`: a stop next to a side street or the opposite carriageway snaps to the bus's road), plain
 * only when neither is plausible. The answer with the fewest implausible legs wins, then the shortest
 * counting each stop's way to its snap: a stop on a bend that the directions push 60 m along the road
 * must not buy a shorter route (Janowice Leśniczówka).
 */
export async function routeChunk(
  pts: readonly LatLng[],
  o: OsrmClientOpts,
  bearings?: ReadonlyArray<number | null>,
): Promise<OsrmOutcome> {
  const tries: Array<[boolean, ReadonlyArray<number | null> | undefined]> = [[true, undefined]];
  if (bearings?.some((b) => b !== null)) tries.push([true, bearings]);
  tries.push([false, undefined]);
  let best: OsrmOutcome | null = null;
  let bestBad = Infinity;
  for (const [cs, br] of tries) {
    if (bestBad === 0 && !cs) break;
    const r = await requestRoute(pts, cs, o, br);
    if (isHard(r)) return r;
    if (!r.ok) {
      best ??= r;
      continue;
    }
    const bad = implausibleLegs(r.legs, pts).length;
    if (!best?.ok || bad < bestBad || (bad === bestBad && total(r.legs) + r.snapM < total(best.legs) + best.snapM)) {
      best = r;
      bestBad = bad;
    }
  }
  return best!;
}

export type RouteResult =
  | { ok: true; pts: LatLng[]; straightLegs: number; totalLegs: number }
  | { ok: false; kind: Exclude<OsrmFailure, "unroutable">; detail: string; retryAfterSec?: number };

/**
 * Road geometry through all waypoints. Hard failures abort the whole build
 * (nothing is committed). A chunk that is unroutable or has an absurd leg is
 * routed pair by pair, so one bad stop costs one straight leg, not eleven.
 */
export async function routeWaypoints(wps: readonly LatLng[], o: OsrmClientOpts): Promise<RouteResult> {
  const parts: LatLng[][] = [];
  let straightLegs = 0;
  const totalLegs = Math.max(0, wps.length - 1);
  const bearings = waypointBearings(wps);
  let start = 0;
  for (const chunk of chunkWaypoints(wps)) {
    const br = bearings.slice(start, start + chunk.length);
    start += chunk.length - 1;
    const r = await routeChunk(chunk, o, br);
    if (!r.ok && r.kind !== "unroutable") return { ok: false, kind: r.kind, detail: r.detail, retryAfterSec: r.retryAfterSec };
    if (r.ok && absurdLegs(r.legs, chunk).length === 0) {
      parts.push(r.pts);
      continue;
    }
    if (chunk.length === 2) {
      parts.push(chunk);
      straightLegs += 1;
      continue;
    }
    for (let i = 0; i + 1 < chunk.length; i++) {
      const pair = [chunk[i], chunk[i + 1]];
      const pr = await routeChunk(pair, o, [br[i], br[i + 1]]);
      if (!pr.ok && pr.kind !== "unroutable") {
        return { ok: false, kind: pr.kind, detail: pr.detail, retryAfterSec: pr.retryAfterSec };
      }
      if (pr.ok && absurdLegs(pr.legs, pair).length === 0) parts.push(pr.pts);
      else {
        parts.push(pair);
        straightLegs += 1;
      }
    }
  }
  return { ok: true, pts: mergeChunkGeometries(parts), straightLegs, totalLegs };
}
