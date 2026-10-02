/**
 * KB stop patterns — the unit the road-shape store routes and caches. A
 * pattern is a trip's ordered stop list plus the deterministic routing tweaks
 * applied to it (stop-pole adjustments, known detours), so every trip, live
 * execution and GTFS seed with the same stops shares one road geometry.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { col, parseCsvLine, splitLines } from "./gtfs-csv";
import { adjustStopRoutePoint, injectDetourPoints } from "./shared/detours";
import type { LatLng } from "./shared/polyline";

export interface ResolvedStop {
  /** String(internalId) — the GTFS stop_id */
  id: string;
  lat: number;
  lon: number;
}

export interface KbPattern {
  /** "kb:" + 12 hex — stable while the stop ids and applied detour stay the same */
  key: string;
  /** resolved stop per trip.times index (null = unresolved) */
  stopPts: Array<LatLng | null>;
  /** routing waypoints (adjusted stops + injected detour via-points) */
  waypoints: LatLng[];
  /** hash of the waypoint coordinates — changes when a stop moves or a detour is edited */
  wpSig: string;
  line: string;
  dir: string;
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/**
 * Build the pattern for one trip's `times` array. `resolve` maps a times entry
 * to its physical stop exactly like the poller's stopCoords (designator, then
 * place_id). Null when fewer than two stops resolve.
 */
export function buildKbPattern(
  times: readonly unknown[],
  line: string,
  dir: string,
  resolve: (t: Record<string, unknown>) => ResolvedStop | null,
): KbPattern | null {
  const ids: string[] = [];
  const stopPts: Array<LatLng | null> = [];
  const routePts: LatLng[] = [];
  for (const t of times) {
    const s = t && typeof t === "object" ? resolve(t as Record<string, unknown>) : null;
    if (!s) {
      ids.push("?");
      stopPts.push(null);
      continue;
    }
    ids.push(s.id);
    stopPts.push([s.lat, s.lon]);
    routePts.push(adjustStopRoutePoint(s.id, [s.lat, s.lon]));
  }
  if (routePts.length < 2) return null;
  const { points, detour } = injectDetourPoints(routePts, line, dir);
  const applied = detour && points !== routePts ? detour.id : "";
  const key = "kb:" + sha1(`${ids.join(",")}|${applied}`).slice(0, 12);
  const wpSig = sha1(points.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(";")).slice(0, 12);
  return { key, stopPts, waypoints: points, wpSig, line, dir };
}

export interface GtfsSeed {
  rawTripIds: string[];
  line: string;
  dir: string;
  /** synthetic times entries ({designator} per stop_sequence, {} for gaps) */
  times: Array<Record<string, unknown>>;
}

/** GTFS trip_id → upstream trip id (multi-service trips carry a `_<service>` suffix). */
export function rawTripId(gtfsTripId: string): string {
  const i = gtfsTripId.indexOf("_");
  return i > 0 ? gtfsTripId.slice(0, i) : gtfsTripId;
}

/**
 * Distinct stop patterns of a built GTFS feed (grouped by line, headsign and
 * stop sequence). Missing files yield []. Feeds the shape store's background
 * queue so most patterns are routed before any vehicle on them shows up.
 */
export function readGtfsPatternSeeds(gtfsDir: string): GtfsSeed[] {
  let tripsTxt: string;
  let timesTxt: string;
  let routesTxt: string;
  try {
    tripsTxt = fs.readFileSync(path.join(gtfsDir, "trips.txt"), "utf-8");
    timesTxt = fs.readFileSync(path.join(gtfsDir, "stop_times.txt"), "utf-8");
    routesTxt = fs.readFileSync(path.join(gtfsDir, "routes.txt"), "utf-8");
  } catch {
    return [];
  }

  const routeName = new Map<string, string>();
  {
    const lines = splitLines(routesTxt);
    const h = parseCsvLine(lines[0] ?? "");
    const iId = col(h, "route_id");
    const iName = col(h, "route_short_name");
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = parseCsvLine(lines[i]);
      routeName.set(f[iId], f[iName] ?? "");
    }
  }

  const tripMeta = new Map<string, { line: string; dir: string }>();
  {
    const lines = splitLines(tripsTxt);
    const h = parseCsvLine(lines[0] ?? "");
    const iRoute = col(h, "route_id");
    const iTrip = col(h, "trip_id");
    const iHead = col(h, "trip_headsign");
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = parseCsvLine(lines[i]);
      const raw = rawTripId(f[iTrip] ?? "");
      if (!raw || tripMeta.has(raw)) continue;
      tripMeta.set(raw, { line: routeName.get(f[iRoute]) ?? "", dir: f[iHead] ?? "" });
    }
  }

  // stop_times are keyed by the raw upstream trip id (one row set per trip)
  const seqs = new Map<string, Array<[number, string]>>();
  {
    const lines = splitLines(timesTxt);
    const h = parseCsvLine(lines[0] ?? "");
    const iTrip = col(h, "trip_id");
    const iStop = col(h, "stop_id");
    const iSeq = col(h, "stop_sequence");
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = parseCsvLine(lines[i]);
      const raw = rawTripId(f[iTrip] ?? "");
      const seq = Number(f[iSeq]);
      if (!raw || !Number.isInteger(seq) || seq < 0 || seq > 500) continue;
      let arr = seqs.get(raw);
      if (!arr) seqs.set(raw, (arr = []));
      arr.push([seq, f[iStop] ?? ""]);
    }
  }

  const groups = new Map<string, GtfsSeed>();
  for (const [raw, rows] of seqs) {
    const meta = tripMeta.get(raw);
    if (!meta) continue;
    rows.sort((a, b) => a[0] - b[0]);
    const n = rows[rows.length - 1][0] + 1;
    const times: Array<Record<string, unknown>> = Array.from({ length: n }, () => ({}));
    for (const [seq, stopId] of rows) {
      const d = Number(stopId);
      if (Number.isInteger(d)) times[seq] = { designator: d };
    }
    const sig = `${meta.line}\u0001${meta.dir}\u0001${times.map((t) => t.designator ?? "?").join(",")}`;
    const g = groups.get(sig);
    if (g) g.rawTripIds.push(raw);
    else groups.set(sig, { rawTripIds: [raw], line: meta.line, dir: meta.dir, times });
  }
  return [...groups.values()];
}
