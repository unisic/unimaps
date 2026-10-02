/**
 * Pure MZK variant-geometry helpers (no imports of the poller singleton, so the
 * shape store can use them without an import cycle).
 *
 * getTheoreticalCourseDetails returns one road-following `segment` per
 * stop-to-stop pair, and the operator's `reachedMeters` / `stopPoints[].distance`
 * are measured along those same segments — so stop distances are simply the
 * segment boundaries, and reachedMeters maps piecewise between them.
 */
import { preparePolyline, projectStopsAlong, type LatLng } from "./shared/polyline";

interface CourseDetails {
  segments?: Array<{ nodes?: Array<{ latitude?: unknown; longitude?: unknown }> }>;
  stopPoints?: Array<{ latitude?: unknown; longitude?: unknown }>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Road polyline + per-stop along distances (in the shared metric) of one variant. */
export function mzkShapeFromCourseDetails(raw: unknown): { pts: LatLng[]; stops: Array<number | null> } | null {
  const tc = (raw && typeof raw === "object" ? raw : {}) as CourseDetails;
  const segs = Array.isArray(tc.segments) ? tc.segments : [];
  const pts: LatLng[] = [];
  const bounds: Array<LatLng | null> = [];
  for (const seg of segs) {
    const nodes = Array.isArray(seg?.nodes) ? seg.nodes : [];
    let first: LatLng | null = null;
    for (const n of nodes) {
      const lat = num(n?.latitude);
      const lon = num(n?.longitude);
      if (lat === null || lon === null) continue;
      const p: LatLng = [lat, lon];
      first ??= p;
      const last = pts[pts.length - 1];
      if (!last || last[0] !== lat || last[1] !== lon) pts.push(p);
    }
    bounds.push(first);
  }
  if (pts.length >= 2 && segs.length) bounds.push(pts[pts.length - 1]);
  const pl = preparePolyline(pts);
  if (!pl) return null;

  const sp = Array.isArray(tc.stopPoints) ? tc.stopPoints : [];
  // segments line up with stops (n stops → n-1 segments): boundaries ARE the stops
  const stopRefs: Array<LatLng | null> =
    segs.length > 0 && sp.length === segs.length + 1
      ? bounds
      : sp.map((s) => {
          const lat = num(s?.latitude);
          const lon = num(s?.longitude);
          return lat !== null && lon !== null ? [lat, lon] : null;
        });
  return { pts, stops: projectStopsAlong(pl, stopRefs) };
}

/**
 * Map the operator's reachedMeters onto our polyline metric, piecewise between
 * stops. `segDist[k]` is the operator's length of the segment ending at stop k
 * (running vehicle stopPoints[k].distance; [0] is 0). Null when unmappable.
 */
export function mzkRemapDist(
  reached: number,
  segDist: ReadonlyArray<number | null | undefined>,
  stops: ReadonlyArray<number | null>,
): number | null {
  if (!Number.isFinite(reached) || reached < 0 || stops.length < 2) return null;
  let opCum = 0;
  let prevOp = 0;
  let prevS: number | null = stops[0];
  for (let k = 1; k < stops.length; k++) {
    const d = segDist[k];
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0) return null;
    opCum += d;
    const sK = stops[k];
    if (reached <= opCum) {
      if (prevS === null || sK === null) return null;
      const frac = opCum > prevOp ? (reached - prevOp) / (opCum - prevOp) : 0;
      return prevS + frac * (sK - prevS);
    }
    prevOp = opCum;
    prevS = sK;
  }
  // past the last stop (terminus overshoot) — clamp to the end
  return stops[stops.length - 1];
}

/**
 * MZK stop indices into stopPoints: `served` is the stop the vehicle is at
 * (onStopPoint carries its symbol), `next` the next stop it will arrive at.
 * Fixes the old behaviour of pointing "next stop" at stopPoints[orderInCourse],
 * which is usually the stop just passed.
 */
export function mzkStopIndices(v: {
  onStopPoint?: unknown;
  nearestSymbolOrderNo?: unknown;
  orderInCourse?: unknown;
  stopPoints?: ReadonlyArray<{ symbol?: unknown }> | null;
}): { served: number | null; next: number | null } {
  const sp = Array.isArray(v.stopPoints) ? v.stopPoints : [];
  const n = sp.length;
  if (n === 0) return { served: null, next: null };
  const ord = typeof v.orderInCourse === "number" && Number.isInteger(v.orderInCourse) ? v.orderInCourse : null;
  const base = ord !== null && ord >= 0 ? Math.min(ord, n - 1) : 0;
  if (v.onStopPoint != null && v.onStopPoint !== false && v.onStopPoint !== "") {
    const sym = String(v.onStopPoint);
    for (let k = base; k < n; k++) {
      if (String(sp[k]?.symbol) === sym) return { served: k, next: k + 1 < n ? k + 1 : null };
    }
  }
  const near = v.nearestSymbolOrderNo;
  if (typeof near === "number" && Number.isInteger(near) && near >= 0 && near < n && (ord === null || near > ord)) {
    return { served: null, next: near };
  }
  return { served: null, next: base + 1 < n ? base + 1 : null };
}
