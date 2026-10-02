/**
 * Which stop is a vehicle at / approaching, given its along-route distance?
 * (isomorphic + pure: server delay/next-stop logic and the client TripView share it.)
 *
 * Why chainage instead of "nearest stop": the stops of an out-and-back / loop pattern come in twins
 * (opposite sides of one road, 14-50 m apart, but 1-3 km apart ALONG the route), and upstream's
 * `vehicle_trip_index` freezes for minutes whenever a pole is passed outside its ~65 m geofence.
 * Neither a position-only search nor a hint-driven tie-break can tell the legs apart then. The
 * server tracks every vehicle with continuity (see kbDistAlong in lib/route-info.ts), so its
 * `dist_m` is leg-aware; this module only maps that chainage to stop semantics.
 *
 * No "use client", no Node imports, relative imports only (node:test loads it).
 */
import { preparePolyline, projectStopsAlong, type LatLng } from "./polyline";

/** Along-route metres of every trip.times stop on `routed` (null = stop not on the road shape). */
export function stopAlongFor(
  routed: ReadonlyArray<LatLng> | null | undefined,
  stopPts: ReadonlyArray<LatLng | null>,
  maxOffM = 80,
): Array<number | null> | null {
  if (!routed || routed.length < 2) return null;
  const pl = preparePolyline(routed);
  if (!pl) return null;
  return projectStopsAlong(pl, stopPts, maxOffM);
}

export interface UpstreamHint {
  /** vehicle_trip_index: the last stop upstream registered (null/undefined = unknown) */
  vti: number | null | undefined;
  /** upstream at_stop (null/undefined = unknown -> a plain pole zone decides) */
  atStop: boolean | null | undefined;
}

export interface StopProgress {
  /** the stop being served (at) or the next stop (!at); stops with a smaller index are passed */
  index: number;
  at: boolean;
  /** 0..1 between the previous placed stop and `index` (1 when `at`) */
  progress: number;
}

export interface ChainageOpts {
  /** upstream "at stop vti" accepted from this far before the pole (m along the route) */
  zoneBeforeM?: number;
  /** ... and this far after it (the geofence lags the pole) */
  zoneAfterM?: number;
  /** pole zone used when upstream sends no at_stop */
  atZoneM?: number;
}

const ZONE_BEFORE_M = 90; // real captures: AT rows lie -75 m .. +70 m along the route from the pole (Euclid <= 65 m)
const ZONE_AFTER_M = 90;
const AT_ZONE_M = 35;

/**
 * Stop semantics for chainage `s` (m along the road shape; `along` = stopAlongFor / the stored
 * `stops`). Skip-tolerant by construction: the answer depends on where the vehicle IS, upstream's
 * index only decides "at the stop it names" — a frozen index cannot hold the vehicle back.
 * Returns null when fewer than two stops are placed on the shape.
 */
export function stopsAtChainage(
  along: ReadonlyArray<number | null>,
  s: number,
  up?: UpstreamHint | null,
  opts: ChainageOpts = {},
): StopProgress | null {
  if (!Number.isFinite(s)) return null;
  const before = opts.zoneBeforeM ?? ZONE_BEFORE_M;
  const after = opts.zoneAfterM ?? ZONE_AFTER_M;
  const atZone = opts.atZoneM ?? AT_ZONE_M;
  const placed: number[] = [];
  for (let i = 0; i < along.length; i++) if (typeof along[i] === "number" && Number.isFinite(along[i] as number)) placed.push(i);
  if (placed.length < 2) return null;
  const a = (i: number): number => along[i] as number;

  // upstream says "at stop vti" and the vehicle really is inside that pole's zone: believe it
  const vti = up && typeof up.vti === "number" && up.vti >= 0 && up.vti < along.length && typeof along[up.vti] === "number" ? up.vti : null;
  if (vti !== null && up?.atStop === true && s >= a(vti) - before && s <= a(vti) + after) {
    return { index: vti, at: true, progress: 1 };
  }
  // no at_stop information at all: a plain pole zone
  if (!up || up.atStop === null || up.atStop === undefined) {
    let best = -1;
    let bestD = atZone;
    for (const i of placed) {
      const d = Math.abs(s - a(i));
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best >= 0) return { index: best, at: true, progress: 1 };
  }
  // otherwise: approaching the first placed stop still ahead of us
  const nx = placed.find((i) => a(i) > s);
  const last = placed[placed.length - 1];
  if (nx === undefined) {
    // past the last stop: upstream's explicit "not at stop" keeps it approaching the terminus
    const at = !(up && up.atStop === false);
    return { index: last, at, progress: at ? 1 : 0.98 };
  }
  let prevStop = -1;
  for (const i of placed) {
    if (i >= nx) break;
    prevStop = i;
  }
  const a0 = prevStop >= 0 ? a(prevStop) : 0;
  const a1 = a(nx);
  const progress = a1 > a0 ? Math.max(0, Math.min(1, (s - a0) / (a1 - a0))) : 0;
  return { index: nx, at: false, progress };
}

/**
 * The TripView entry point: stop progress from the vehicle's server-side `dist_m`, or null when the
 * server's chainage cannot be read against `stopAlong` (no drawn road shape, the vehicle reports another
 * shape / revision, no dist_m) — the caller then falls back to its position-only heuristic.
 */
export function progressFromVehicle(
  stopAlong: ReadonlyArray<number | null> | null | undefined,
  tripShapeId: string | null | undefined,
  v: { shape?: string; dist_m?: number; at_stop?: boolean } | null | undefined,
  vti: number | null | undefined,
): StopProgress | null {
  if (!stopAlong || !tripShapeId || !v || v.shape !== tripShapeId) return null;
  if (typeof v.dist_m !== "number" || !Number.isFinite(v.dist_m)) return null;
  return stopsAtChainage(stopAlong, v.dist_m, { vti, atStop: v.at_stop });
}
