/**
 * Isomorphic polyline math shared by the server shape store and the client
 * motion engine. Both sides MUST measure distance with the same metric, or the
 * server's stop distances / `dist_m` drift from the client's own `cum` — so all
 * along-route metres in the app come from `segMeters` here (the same planar
 * formula as lib/geo.ts metersBetween).
 *
 * No "use client", no Node imports, relative imports only (node:test loads it).
 */

export type LatLng = [number, number];

const M_PER_DEG = 111_320;
const RAD = Math.PI / 180;

/** Planar metres between two nearby points — identical to lib/geo.ts metersBetween. */
export function segMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * M_PER_DEG;
  const dLon = (lon2 - lon1) * M_PER_DEG * Math.cos(((lat1 + lat2) / 2) * RAD);
  return Math.hypot(dLat, dLon);
}

/** Planar compass bearing (deg, [0, 360)) from point 1 to point 2; null if identical. */
export function planarBearing(lat1: number, lon1: number, lat2: number, lon2: number): number | null {
  const dy = lat2 - lat1;
  const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * RAD);
  if (dx === 0 && dy === 0) return null;
  const b = Math.atan2(dx, dy) / RAD;
  return (b + 360) % 360;
}

/* ---------------------------------------------------------------- encoding */

/** Google encoded-polyline (precision 6 by default — the app-wide wire format). */
export function encodePolyline(pts: ReadonlyArray<readonly [number, number]>, precision = 6): string {
  const f = 10 ** precision;
  let out = "";
  let pLat = 0;
  let pLon = 0;
  for (const [lat, lon] of pts) {
    const iLat = Math.round(lat * f);
    const iLon = Math.round(lon * f);
    out += encodeSigned(iLat - pLat) + encodeSigned(iLon - pLon);
    pLat = iLat;
    pLon = iLon;
  }
  return out;
}

function encodeSigned(v: number): string {
  let s = v < 0 ? ~(v * 2) : v * 2;
  let out = "";
  while (s >= 0x20) {
    out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
    s = Math.floor(s / 32);
  }
  return out + String.fromCharCode(s + 63);
}

/** Inverse of encodePolyline. Malformed input yields the points decoded so far. */
export function decodePolyline(str: string, precision = 6): LatLng[] {
  const f = 10 ** precision;
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number | null => {
    let result = 0;
    let mul = 1;
    for (;;) {
      if (i >= str.length) return null;
      const b = str.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) return null;
      result += (b & 0x1f) * mul;
      mul *= 32;
      if (b < 0x20) break;
    }
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };
  while (i < str.length) {
    const dLat = next();
    const dLon = next();
    if (dLat === null || dLon === null) break;
    lat += dLat;
    lon += dLon;
    out.push([lat / f, lon / f]);
  }
  return out;
}

/* ---------------------------------------------------------------- prepared */

/** Polyline with cumulative along-route metres, ready for projection/sampling. */
export interface Polyline {
  n: number;
  lat: Float64Array;
  lon: Float64Array;
  /** cum[i] = metres from the start to vertex i (segMeters sum) */
  cum: Float64Array;
  length: number;
}

/** Drops non-finite points and consecutive near-duplicates; null if < 2 remain. */
export function preparePolyline(pts: ReadonlyArray<readonly [number, number]>): Polyline | null {
  const la: number[] = [];
  const lo: number[] = [];
  for (const p of pts) {
    const a = p[0];
    const b = p[1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const k = la.length;
    if (k > 0 && segMeters(la[k - 1], lo[k - 1], a, b) < 0.05) continue;
    la.push(a);
    lo.push(b);
  }
  const n = la.length;
  if (n < 2) return null;
  const lat = Float64Array.from(la);
  const lon = Float64Array.from(lo);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + segMeters(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  return { n, lat, lon, cum, length: cum[n - 1] };
}

/** Index of the segment containing along-distance s (clamped to [0, n-2]). */
export function segmentAt(pl: Polyline, s: number, hint = -1): number {
  const last = pl.n - 2;
  if (hint >= 0 && hint <= last && pl.cum[hint] <= s && s <= pl.cum[hint + 1]) return hint;
  if (s <= 0) return 0;
  if (s >= pl.length) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pl.cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface PointAt {
  lat: number;
  lon: number;
  seg: number;
}

/** Point at along-distance s (clamped to the polyline). Writes into `out` when given. */
export function pointAt(pl: Polyline, s: number, hint = -1, out?: PointAt): PointAt {
  const r = out ?? { lat: 0, lon: 0, seg: 0 };
  const i = segmentAt(pl, s, hint);
  const segLen = pl.cum[i + 1] - pl.cum[i];
  const t = segLen > 0 ? Math.min(1, Math.max(0, (s - pl.cum[i]) / segLen)) : 0;
  r.lat = pl.lat[i] + (pl.lat[i + 1] - pl.lat[i]) * t;
  r.lon = pl.lon[i] + (pl.lon[i + 1] - pl.lon[i]) * t;
  r.seg = i;
  return r;
}

const tmpA: PointAt = { lat: 0, lon: 0, seg: 0 };
const tmpB: PointAt = { lat: 0, lon: 0, seg: 0 };

/** Travel direction at s, measured over [s-back, s+ahead] so OSRM micro-segments
 *  don't flip the heading arrow. */
export function tangentBearing(pl: Polyline, s: number, back = 5, ahead = 15): number | null {
  pointAt(pl, s - back, -1, tmpA);
  pointAt(pl, s + ahead, -1, tmpB);
  return planarBearing(tmpA.lat, tmpA.lon, tmpB.lat, tmpB.lon);
}

export interface Projection {
  /** along-route metres of the projected point */
  s: number;
  /** perpendicular distance from the query point, metres */
  d: number;
  seg: number;
}

/**
 * Project (lat, lon) onto the part of the polyline with s in [sMin, sMax].
 * Among candidates within `slackM` of the best distance, the one closest to
 * `hint` wins (keeps the opposite leg of an out-and-back from stealing the fix).
 */
export function projectOnPolyline(
  pl: Polyline,
  lat: number,
  lon: number,
  sMin = 0,
  sMax = Infinity,
  opts: { hint?: number; slackM?: number } = {},
): Projection | null {
  const lo = Math.max(0, sMin);
  const hi = Math.min(pl.length, sMax);
  if (!(hi >= lo)) return null;
  const slack = opts.slackM ?? 15;
  const hint = opts.hint;
  let bestD = Infinity;
  const cand: Projection[] = [];
  for (let i = segmentAt(pl, lo); i < pl.n - 1 && pl.cum[i] <= hi; i++) {
    const aLat = pl.lat[i];
    const aLon = pl.lon[i];
    const kx = M_PER_DEG * Math.cos(((aLat + pl.lat[i + 1]) / 2) * RAD);
    const dx = (pl.lon[i + 1] - aLon) * kx;
    const dy = (pl.lat[i + 1] - aLat) * M_PER_DEG;
    const px = (lon - aLon) * kx;
    const py = (lat - aLat) * M_PER_DEG;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
    t = Math.min(1, Math.max(0, t));
    const segLen = pl.cum[i + 1] - pl.cum[i];
    let s = pl.cum[i] + t * segLen;
    if (s < lo || s > hi) {
      s = Math.min(hi, Math.max(lo, s));
      t = segLen > 0 ? (s - pl.cum[i]) / segLen : 0;
    }
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < bestD) bestD = d;
    if (d <= bestD + slack) cand.push({ s, d, seg: i });
  }
  if (!cand.length) return null;
  let best: Projection | null = null;
  for (const c of cand) {
    if (c.d > bestD + slack) continue;
    if (!best) {
      best = c;
      continue;
    }
    if (hint !== undefined) {
      if (Math.abs(c.s - hint) < Math.abs(best.s - hint)) best = c;
    } else if (c.d < best.d) {
      best = c;
    }
  }
  return best;
}

/**
 * Along-route distances of an ordered stop list (nulls allowed). Monotone: each
 * stop is searched from the previous stop's distance onwards and the EARLIEST
 * good candidate wins, so loop routes whose first and last stop coincide get
 * ≈0 and ≈length. Stops further than maxOffM from the route (e.g. stops a
 * detour bypasses) yield null.
 */
export function projectStopsAlong(
  pl: Polyline,
  stops: ReadonlyArray<readonly [number, number] | null>,
  maxOffM = 80,
): Array<number | null> {
  const out: Array<number | null> = [];
  let sPrev = 0;
  for (const st of stops) {
    if (!st || !Number.isFinite(st[0]) || !Number.isFinite(st[1])) {
      out.push(null);
      continue;
    }
    const lo = Math.max(0, sPrev - 20);
    // collect all segment candidates, keep the earliest close-enough one
    let bestD = Infinity;
    const cands: Array<{ s: number; d: number }> = [];
    for (let i = segmentAt(pl, lo); i < pl.n - 1; i++) {
      const p = projectSegment(pl, i, st[0], st[1]);
      if (p.s < lo) continue;
      if (p.d < bestD) bestD = p.d;
      cands.push(p);
    }
    const limit = Math.min(bestD + 15, maxOffM);
    let pick: number | null = null;
    for (const c of cands) {
      if (c.d <= limit) {
        pick = c.s;
        break;
      }
    }
    if (pick === null) {
      out.push(null);
      continue;
    }
    const s = Math.max(sPrev, pick);
    out.push(s);
    sPrev = s;
  }
  return out;
}

function projectSegment(pl: Polyline, i: number, lat: number, lon: number): { s: number; d: number } {
  const aLat = pl.lat[i];
  const aLon = pl.lon[i];
  const kx = M_PER_DEG * Math.cos(((aLat + pl.lat[i + 1]) / 2) * RAD);
  const dx = (pl.lon[i + 1] - aLon) * kx;
  const dy = (pl.lat[i + 1] - aLat) * M_PER_DEG;
  const px = (lon - aLon) * kx;
  const py = (lat - aLat) * M_PER_DEG;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
  return { s: pl.cum[i] + t * (pl.cum[i + 1] - pl.cum[i]), d: Math.hypot(px - t * dx, py - t * dy) };
}

/** Part of the polyline between along-distances s0 < s1 (endpoints interpolated). */
export function slicePolyline(pl: Polyline, s0: number, s1: number): LatLng[] {
  const a = Math.max(0, Math.min(s0, s1));
  const b = Math.min(pl.length, Math.max(s0, s1));
  const p0 = pointAt(pl, a);
  const p1 = pointAt(pl, b);
  const out: LatLng[] = [[p0.lat, p0.lon]];
  for (let i = p0.seg + 1; i <= p1.seg; i++) out.push([pl.lat[i], pl.lon[i]]);
  out.push([p1.lat, p1.lon]);
  return out;
}

/* ---------------------------------------------------------------- cleanup */

/** Douglas-Peucker in local planar metres; endpoints always kept. */
export function simplifyPolyline(pts: ReadonlyArray<LatLng>, tolM = 2): LatLng[] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  let latSum = 0;
  for (const p of pts) latSum += p[0];
  const kx = M_PER_DEG * Math.cos((latSum / n) * RAD);
  const x = (i: number): number => pts[i][1] * kx;
  const y = (i: number): number => pts[i][0] * M_PER_DEG;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = x(a);
    const ay = y(a);
    const dx = x(b) - ax;
    const dy = y(b) - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = x(i) - ax;
      const py = y(i) - ay;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolM) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Remove short out-and-back stubs (a routing artifact: a stop snapped to the
 * wrong carriageway makes OSRM drive past it and U-turn back). A stub is a
 * detour of ≤ maxLenM out whose return path stays within tolM of the outbound
 * path. Stubs whose far end is near a `protect` point (a real stop/waypoint,
 * e.g. a dead-end terminus) are kept.
 */
export function pruneSpurs(
  pts: ReadonlyArray<LatLng>,
  protect: ReadonlyArray<readonly [number, number]> = [],
  maxLenM = 150,
  tolM = 10,
): LatLng[] {
  let cur = pts.slice();
  for (let guard = 0; guard < 50; guard++) {
    const cut = findSpur(cur, protect, maxLenM, tolM);
    if (!cut) break;
    cur = [...cur.slice(0, cut[0] + 1), ...cur.slice(cut[1])];
  }
  return cur;
}

function findSpur(
  pts: ReadonlyArray<LatLng>,
  protect: ReadonlyArray<readonly [number, number]>,
  maxLenM: number,
  tolM: number,
): [number, number] | null {
  const n = pts.length;
  for (let a = 0; a < n - 2; a++) {
    let path = 0;
    let far = a;
    let farD = 0;
    for (let b = a + 1; b < n; b++) {
      path += segMeters(pts[b - 1][0], pts[b - 1][1], pts[b][0], pts[b][1]);
      if (path > 2 * maxLenM + 2 * tolM) break;
      const dFromA = segMeters(pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (dFromA > farD) {
        farD = dFromA;
        far = b;
      }
      if (b - a < 2 || farD < 3 * tolM || farD > maxLenM) continue;
      if (dFromA > tolM) continue;
      // b is back near a after going out to `far`: is the return hugging the outbound?
      let hugs = true;
      for (let k = far + 1; k < b && hugs; k++) {
        if (distToPath(pts, a, far, pts[k]) > tolM) hugs = false;
      }
      if (!hugs) continue;
      const fp = pts[far];
      if (protect.some((p) => segMeters(p[0], p[1], fp[0], fp[1]) < 25)) continue;
      return [a, b];
    }
  }
  return null;
}

function distToPath(pts: ReadonlyArray<LatLng>, from: number, to: number, q: LatLng): number {
  let best = Infinity;
  for (let i = from; i < to; i++) {
    const aLat = pts[i][0];
    const aLon = pts[i][1];
    const kx = M_PER_DEG * Math.cos(((aLat + pts[i + 1][0]) / 2) * RAD);
    const dx = (pts[i + 1][1] - aLon) * kx;
    const dy = (pts[i + 1][0] - aLat) * M_PER_DEG;
    const px = (q[1] - aLon) * kx;
    const py = (q[0] - aLat) * M_PER_DEG;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
  }
  return best;
}
