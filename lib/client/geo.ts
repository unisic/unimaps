"use client";

/** Distance helpers for the command palette's "nearest stops" features. */
import type { Stop } from "@/lib/client/types";

/** Great-circle distance in meters (haversine). */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** "230 m" below 1 km, then "1,4 km" (Polish decimal comma). */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}

/* same pace as the server router (lib/router.ts WALK_MPS) */
const WALK_MPS = 1.1;

/** "~7 min pieszo". ponytail: straight line, a real foot route would need the OSRM foot profile. */
export function formatWalk(m: number): string {
  return `~${Math.max(1, Math.ceil(m / WALK_MPS / 60))} min pieszo`;
}

/** The `limit` stops closest to `pos`, nearest first. O(n) over ~956 stops. */
export function nearestStops(
  stops: Stop[],
  pos: { lat: number; lon: number },
  limit: number,
): Array<{ s: Stop; dist: number }> {
  return stops
    .map((s) => ({ s, dist: haversineMeters(pos.lat, pos.lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

export interface ActiveStopResult {
  /** The stop index the vehicle is currently at or approaching next */
  index: number;
  /** True if the vehicle is currently stopped at the stop, false if in transit towards it */
  isAtStop: boolean;
  /** Progress along the segment from previous stop towards the next stop (0.0 to 1.0) */
  progress?: number;
}

/**
 * Determines the active stop index along a route given vehicle GPS position.
 * Stops with index < result.index are PASSED.
 * If isAtStop is true, the bus is at stop `result.index`.
 * If isAtStop is false, the bus has departed from the previous stop and is moving towards `result.index`.
 */
export function findActiveStop(
  stops: Array<{ lat: number; lon: number } | null | undefined>,
  vehicle: { lat: number; lon: number; at_stop?: boolean; current_stop_sequence?: number | null } | null,
  vtiHint?: number | null,
): ActiveStopResult {
  const n = stops.length;
  if (n === 0) return { index: 0, isAtStop: false, progress: 0 };
  if (n === 1) return { index: 0, isAtStop: true, progress: 1 };

  // If no valid vehicle coords, use vtiHint
  if (!vehicle || !Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon)) {
    const hint = vtiHint ?? 0;
    return { index: Math.max(0, Math.min(n - 1, hint)), isAtStop: false, progress: 0 };
  }

  const vLat = vehicle.lat;
  const vLon = vehicle.lon;

  // 0. Upstream says "at stop vtiHint" and the bus really is inside that pole's zone: believe it. Plain
  //    nearest-stop cannot: twin stops of an out-and-back (opposite sides of one road, 14-50 m apart,
  //    visited minutes apart) and a pattern that revisits the very same stop object (D.A. at both ends)
  //    are equally near, and the lowest index / the nearer pole wins.
  if (vehicle.at_stop === true && vtiHint != null && vtiHint >= 0 && vtiHint < n) {
    const h = stops[vtiHint];
    if (h && Number.isFinite(h.lat) && Number.isFinite(h.lon) && haversineMeters(vLat, vLon, h.lat, h.lon) <= 90) {
      return { index: vtiHint, isAtStop: true, progress: 1 };
    }
  }

  // 1. Check if the vehicle is physically at any stop
  let closestStopIdx = 0;
  let minStopDist = Infinity;
  const near: Array<{ i: number; d: number }> = [];
  for (let i = 0; i < n; i++) {
    const s = stops[i];
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const d = haversineMeters(vLat, vLon, s.lat, s.lon);
    if (d < minStopDist) {
      minStopDist = d;
      closestStopIdx = i;
    }
    if (d <= 55) near.push({ i, d });
  }
  // twins / revisited stop objects: of the poles about as near as the nearest one, the one closest
  // to the hint index is the visit upstream is on (the lowest index is just an iteration artefact)
  if (near.length > 1 && vtiHint != null && vtiHint >= 0 && vtiHint < n) {
    const cands = near.filter((c) => c.d <= minStopDist + 30);
    cands.sort((a, b) => Math.abs(a.i - vtiHint) - Math.abs(b.i - vtiHint) || a.d - b.d);
    closestStopIdx = cands[0].i;
    minStopDist = cands[0].d;
  }

  // If vehicle is physically at the stop (<= 55m when explicitly at_stop, or <= 35m dwell)
  if (minStopDist <= 55) {
    if (vehicle.at_stop === true || (vehicle.at_stop !== false && minStopDist <= 35)) {
      return { index: closestStopIdx, isAtStop: true, progress: 1 };
    }
  }

  // 2. Geometric segment projection onto ALL consecutive stop segments.
  // Evaluate the whole route so skipped stops (where upstream sequence never advanced)
  // do not hold the vehicle back to an old stop when GPS has physically progressed.
  const rad = Math.PI / 180;
  interface Candidate {
    segIdx: number;
    dist: number;
    progress: number;
    rawT: number;
  }
  const candidates: Candidate[] = [];

  for (let i = 0; i < n - 1; i++) {
    const A = stops[i];
    const B = stops[i + 1];
    if (!A || !B || !Number.isFinite(A.lat) || !Number.isFinite(B.lat)) continue;

    const midLat = ((A.lat + B.lat) / 2) * rad;
    const cosLat = Math.cos(midLat);
    const dx = (B.lon - A.lon) * cosLat;
    const dy = B.lat - A.lat;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;

    const vx = (vLon - A.lon) * cosLat;
    const vy = vLat - A.lat;
    const t = (vx * dx + vy * dy) / L2;
    const clampedT = Math.max(0, Math.min(1, t));
    const projLat = A.lat + clampedT * dy;
    const projLon = A.lon + (clampedT * dx) / cosLat;
    const distToSeg = haversineMeters(vLat, vLon, projLat, projLon);

    candidates.push({ segIdx: i, dist: distToSeg, progress: clampedT, rawT: t });
  }

  if (candidates.length === 0) {
    return { index: closestStopIdx, isAtStop: minStopDist <= 55, progress: 0 };
  }

  // Find minimum distance to any route segment
  let minSegDist = Infinity;
  for (const c of candidates) {
    if (c.dist < minSegDist) minSegDist = c.dist;
  }

  // Plausible candidates are those close to the minimum segment distance (within 70m tolerance)
  // Segments kilometers away (from a stale upstream sequence or skipped stops) are excluded.
  const threshold = Math.max(minSegDist + 70, minSegDist * 1.6);
  const plausible = candidates.filter((c) => c.dist <= threshold);

  // If upstream explicitly provided at_stop === false and current_stop_sequence:
  // ONLY accept current_stop_sequence IF it is one of the plausible segments near the bus!
  if (vehicle.at_stop === false && vehicle.current_stop_sequence != null) {
    const seq = vehicle.current_stop_sequence;
    const seqMatch = plausible.find((c) => c.segIdx === seq);
    if (seqMatch) {
      return {
        index: Math.min(n - 1, seqMatch.segIdx + 1),
        isAtStop: false,
        progress: Math.max(0.05, Math.min(0.95, seqMatch.progress)),
      };
    }
  }

  // If there are multiple plausible candidates (e.g. loops or spurs sharing the same roadway),
  // use vtiHint to disambiguate IF vtiHint is near one of the candidates.
  let best = plausible[0];
  if (plausible.length > 1 && vtiHint != null && vtiHint >= 0 && vtiHint < n) {
    const nearHint = plausible.filter(
      (c) => Math.abs(c.segIdx + 1 - vtiHint) <= 2 || Math.abs(c.segIdx - vtiHint) <= 2,
    );
    if (nearHint.length > 0) {
      nearHint.sort((a, b) => a.dist - b.dist);
      best = nearHint[0];
    } else {
      // No plausible candidate near hint -> hint is stale, pick geometrically closest
      plausible.sort((a, b) => {
        const aBetween = a.rawT >= 0 && a.rawT <= 1 ? 0 : 1;
        const bBetween = b.rawT >= 0 && b.rawT <= 1 ? 0 : 1;
        if (aBetween !== bBetween) return aBetween - bBetween;
        return a.dist - b.dist;
      });
      best = plausible[0];
    }
  } else if (plausible.length > 1) {
    plausible.sort((a, b) => {
      const aBetween = a.rawT >= 0 && a.rawT <= 1 ? 0 : 1;
      const bBetween = b.rawT >= 0 && b.rawT <= 1 ? 0 : 1;
      if (aBetween !== bBetween) return aBetween - bBetween;
      return a.dist - b.dist;
    });
    best = plausible[0];
  }

  // If vehicle is past the last stop on the route
  if (best.segIdx === n - 2 && best.rawT > 1) {
    return { index: n - 1, isAtStop: true, progress: 1 };
  }

  // If vehicle is approaching the last stop and within 55m
  if (best.segIdx + 1 === n - 1 && best.progress >= 0.98) {
    return { index: n - 1, isAtStop: minStopDist <= 55, progress: 1 };
  }

  // The vehicle is driving on segment best.segIdx -> best.segIdx + 1.
  // Stop best.segIdx has been passed, and the vehicle is approaching best.segIdx + 1!
  return {
    index: best.segIdx + 1,
    isAtStop: false,
    progress: best.progress,
  };
}
