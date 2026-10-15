/**
 * GPS progress tracking for KB vehicles: "is upstream's stop index stale?".
 *
 * Upstream registers a stop only when one of its GPS samples (6–18 s apart)
 * lands in the stop zone. A bus that drives past a stop without slowing down
 * is never registered, so `vehicle_trip_index` / `next_departure_index` stall,
 * and upstream clamps `estimates[0]` to "now" for the stale stop. The delay
 * `parsePosition` derives from it (`estimates[0] − plan(next stop)`) is then
 * `now − plan(stale stop)` and grows by exactly one minute per minute until the
 * bus happens to stop somewhere (observed live: +5 → +11 min for a bus running
 * on time; +10 min for a bus running 3 min EARLY).
 *
 * This module places the bus on the trip's route from its GPS fix —
 * monotonically, with the stop upstream last registered as a hard lower bound
 * (out-and-back legs and loops overlap on the map, so history is the only way
 * to tell which leg a fix belongs to) — and, only when the bus is already
 * clearly beyond the stop upstream calls "next", replaces the delay by the
 * schedule deviation at the position the bus really is at.
 *
 * Pure: no I/O, no Node imports, relative imports only (node:test loads it).
 * Geometry is the straight stop-to-stop polyline of the trip's own stops, so
 * the result never depends on the OSRM shape store being warm.
 */
import { preparePolyline, projectOnPolyline, projectStopsAlong, type LatLng, type Polyline } from "./shared/polyline";

/** A stop counts as passed when the bus is within this many metres before it. */
export const PASS_TOL_M = 25;
/** The bus is "stale-indexed" once it is this far beyond the stop upstream calls next. */
export const STALE_PAST_M = 120;
/** Upstream registered stop `vti`: the bus is not further than this before it (observed ≥ −100 m). */
export const LOWER_BOUND_TOL_M = 150;
/** A fix this far from the straight polyline is "off the route" (chords cut corners). */
export const STRAIGHT_MAX_OFF_M = 150;
/** Plausible bus speed bound for the monotone window (m/s). */
const V_MAX = 30;
/** Among projection candidates within this many metres of the best one, the one nearest the hint wins. */
const SLACK_M = 25;
/** Previous placement older than this → cold start. */
const WARM_MAX_GAP_S = 180;
/** A stale-flagged bus we cannot place keeps its last GPS delay for this long, then it is "unknown". */
export const HOLD_CARRY_S = 180;
/** Cold start: the alternative (stale-index) candidate wins only when it fits the timetable this much better. */
const COLD_MARGIN_S = 240;
/** Still waiting at the origin: only lateness counts. */
const ORIGIN_TOL_M = 40;
/** A GPS delay beyond this is a mis-placement, not a delay: keep upstream's value. */
export const DEV_MAX_S = 2700;
/** A stale-indexed bus last placed this close to the final stop that is now off the route has left it: course over. */
const END_LEFT_M = 100;
/** ...and "reached the last stop" additionally needs the fix itself this close to the stop (chords overshoot D). */
const END_NEAR_M = 120;

const M_PER_DEG = 111_320;
const RAD = Math.PI / 180;

export interface ProgressGeom {
  pl: Polyline;
  /** along-route metres per `trip.times` index (null = unplaced), non-decreasing */
  stops: ReadonlyArray<number | null>;
  /** perpendicular distance (m) up to which a fix still counts as "on the route" */
  maxOffM: number;
  /** coordinates per `trip.times` index (null = unresolved) — used to confirm the bus is physically at its last stop */
  pts?: ReadonlyArray<LatLng | null>;
}

/** Straight stop-to-stop polyline of a trip's stops (index-aligned with `trip.times`); null if < 2 stops resolve. */
export function straightGeom(stopPts: ReadonlyArray<LatLng | null>): ProgressGeom | null {
  const pts = stopPts.filter((p): p is LatLng => p !== null);
  const pl = preparePolyline(pts);
  if (!pl) return null;
  return { pl, stops: projectStopsAlong(pl, stopPts, STRAIGHT_MAX_OFF_M), maxOffM: STRAIGHT_MAX_OFF_M, pts: stopPts };
}

function wrapSecs(x: number): number {
  return x > 43200 ? x - 86400 : x < -43200 ? x + 86400 : x;
}

function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dy = (bLat - aLat) * M_PER_DEG;
  const dx = (bLon - aLon) * M_PER_DEG * Math.cos(((aLat + bLat) / 2) * RAD);
  return Math.hypot(dx, dy);
}

/** Is the fix within `r` metres of the last placed stop's own coordinates? (true when the coordinates are unknown) */
function nearLastStop(geom: ProgressGeom, lat: number, lon: number, r: number): boolean {
  if (!geom.pts) return true;
  for (let i = geom.stops.length - 1; i >= 0; i--) {
    if (geom.stops[i] === null || geom.stops[i] === undefined) continue;
    const p = geom.pts[i];
    return !p || metresBetween(lat, lon, p[0], p[1]) <= r;
  }
  return true;
}

function finiteAtOrBefore(stops: ReadonlyArray<number | null>, i: number): number | null {
  for (let k = Math.min(i, stops.length - 1); k >= 0; k--) {
    const s = stops[k];
    if (s !== null && s !== undefined) return s;
  }
  return null;
}

function finiteAtOrAfter(stops: ReadonlyArray<number | null>, i: number): number | null {
  for (let k = Math.max(0, i); k < stops.length; k++) {
    const s = stops[k];
    if (s !== null && s !== undefined) return s;
  }
  return null;
}

/**
 * Timetable time (seconds of the agency day) at along-route distance `D`:
 * linear between consecutive placed stops, clamped at both ends. Plan times
 * are "HH:MM" so a drop of more than 12 h between stops means the next day.
 */
export function plannedAt(
  stops: ReadonlyArray<number | null>,
  plan: ReadonlyArray<number | null>,
  D: number,
): number | null {
  let prev: { s: number; p: number } | null = null;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const p = plan[i];
    if (s === null || s === undefined || p === null || p === undefined) continue;
    if (prev === null) {
      if (D <= s) return p;
      prev = { s, p };
      continue;
    }
    let pp = p;
    while (pp < prev.p - 43200) pp += 86400;
    if (D <= s) {
      if (D <= prev.s) return prev.p;
      if (s === prev.s) return pp;
      return prev.p + ((D - prev.s) / (s - prev.s)) * (pp - prev.p);
    }
    prev = { s, p: pp };
  }
  return prev ? prev.p : null;
}

/**
 * Schedule deviation in seconds (+ = late) of a fix taken at agency-local
 * `localSecs` while the bus is at along-route distance `D`. A bus still
 * standing at the origin before its departure time is not "early".
 */
export function scheduleDelay(
  stops: ReadonlyArray<number | null>,
  plan: ReadonlyArray<number | null>,
  D: number,
  localSecs: number,
): number | null {
  const firstIdx = stops.findIndex((s) => s !== null && s !== undefined);
  if (firstIdx < 0 || plan[firstIdx] === null || plan[firstIdx] === undefined) return null;
  const first = stops[firstIdx] as number;
  const T = plannedAt(stops, plan, D);
  if (T === null) return null;
  let dev = wrapSecs(localSecs - T);
  if (D <= first + ORIGIN_TOL_M && dev < 0) dev = 0;
  return dev;
}

export interface Progress {
  /** last stop the bus has passed (−1 = before the first) */
  lastIdx: number;
  /** next stop by GPS (null = past the last placed stop) */
  nextIdx: number | null;
  /** upstream's next stop is behind the bus by more than STALE_PAST_M */
  stale: boolean;
  /** metres the bus is beyond upstream's next stop (null = unknown) */
  pastM: number | null;
}

export function progressAt(stops: ReadonlyArray<number | null>, D: number, nextUp: number | null): Progress {
  let last = -1;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s !== null && s !== undefined && s <= D + PASS_TOL_M) last = i;
  }
  const nextIdx = last + 1 < stops.length ? last + 1 : null;
  let pastM: number | null = null;
  let stale = false;
  if (nextUp !== null) {
    const s = finiteAtOrAfter(stops, nextUp);
    if (s !== null) {
      pastM = D - s;
      stale = pastM > STALE_PAST_M;
    }
  }
  return { lastIdx: last, nextIdx, stale, pastM };
}

interface Candidate {
  s: number;
  d: number;
}

/** One candidate per local distance minimum (= per distinct pass of the same road) within `slack` of the best. */
function collectCandidates(pl: Polyline, lat: number, lon: number, sMin: number, sMax: number, slack: number): Candidate[] {
  const raw: Candidate[] = [];
  let bestD = Infinity;
  for (let i = 0; i < pl.n - 1; i++) {
    if (pl.cum[i + 1] < sMin || pl.cum[i] > sMax) continue;
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
    const s = Math.min(sMax, Math.max(sMin, pl.cum[i] + t * segLen));
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < bestD) bestD = d;
    raw.push({ s, d });
  }
  const out: Candidate[] = [];
  for (const c of raw) {
    if (c.d > bestD + slack) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.s - c.s) < 60) {
      if (c.d < last.d) out[out.length - 1] = c;
    } else out.push(c);
  }
  return out;
}

export interface Track {
  D: number;
  /** epoch secs of the fix D belongs to */
  t: number;
}

export type TrackMode = "cont" | "init" | "hold";

/**
 * Place a fix on the route. Returns null when the fix is not on the route at
 * all; `hold` when it cannot be placed confidently (keep the previous D —
 * never jump, never go backwards).
 *
 *  - `vti` (upstream's last registered stop) is a hard lower bound: the bus has
 *    certainly passed it (this is what removes the outbound leg of a loop).
 *  - Occam first: look for the bus where upstream says it should be (up to a
 *    little beyond its "next" stop); only when it is clearly beyond, accept the
 *    "upstream index is stale" hypothesis and search further along.
 *  - Warm (previous D ≤ 3 min old): monotone window `[D−40, D + v·dt + 150]`.
 *  - Cold: both hypotheses are scored; the stale-index candidate must fit the
 *    timetable COLD_MARGIN_S better than the in-sync one to win.
 */
export function trackAlong(
  geom: ProgressGeom,
  lat: number,
  lon: number,
  tEpoch: number,
  localSecs: number,
  plan: ReadonlyArray<number | null>,
  vti: number | null,
  nextUp: number | null,
  prev: Track | null,
): { D: number; mode: TrackMode } | null {
  const pl = geom.pl;
  const S = geom.stops;
  const maxOff = geom.maxOffM;
  const lbStop = vti !== null && vti >= 0 ? finiteAtOrBefore(S, vti) : null;
  const LB = lbStop !== null ? Math.max(0, lbStop - LOWER_BOUND_TOL_M) : 0;
  const nextStop = nextUp !== null && nextUp >= 0 ? finiteAtOrAfter(S, nextUp) : null;
  const inSyncHi = (nextStop ?? (lbStop !== null ? lbStop + 1500 : Infinity)) + STALE_PAST_M;

  if (prev && tEpoch - prev.t <= WARM_MAX_GAP_S) {
    const dt = Math.max(1, tEpoch - prev.t);
    const hiAll = prev.D + V_MAX * dt + 150;
    // upstream has registered a stop our track has not reached yet: the track is wrong → re-init below
    if (LB <= hiAll) {
      const lo = Math.max(LB, prev.D - 40);
      if (lo <= Math.min(hiAll, inSyncHi)) {
        const p = projectOnPolyline(pl, lat, lon, lo, Math.min(hiAll, inSyncHi), { hint: prev.D, slackM: SLACK_M });
        if (p && p.d <= maxOff) return { D: Math.max(prev.D, Math.round(p.s * 10) / 10), mode: "cont" };
      }
      const lo2 = Math.max(lo, inSyncHi);
      if (lo2 < hiAll) {
        const p2 = projectOnPolyline(pl, lat, lon, lo2, hiAll, { hint: prev.D, slackM: SLACK_M });
        if (p2 && p2.d <= maxOff) return { D: Math.max(prev.D, Math.round(p2.s * 10) / 10), mode: "cont" };
      }
      return { D: prev.D, mode: "hold" };
    }
  }

  // cold start / long gap / track behind upstream's registered stop
  const p1 = projectOnPolyline(pl, lat, lon, LB, inSyncHi, { slackM: SLACK_M });
  const inSync = p1 && p1.d <= maxOff ? p1 : null;
  const beyond = collectCandidates(pl, lat, lon, inSyncHi, Infinity, SLACK_M);
  let alt: Candidate | null = null;
  if (beyond.length) {
    const best = Math.min(...beyond.map((c) => c.d));
    if (best <= maxOff) {
      let pickScore = Infinity;
      for (const c of beyond) {
        if (c.d > best + SLACK_M) continue;
        const T = plannedAt(S, plan, c.s);
        // schedule consistency; tie-break by distance
        const score = (T === null ? 0 : Math.abs(wrapSecs(localSecs - T))) + c.d * 0.5;
        if (score < pickScore) {
          pickScore = score;
          alt = c;
        }
      }
    }
  }
  if (inSync && !alt) return { D: Math.round(inSync.s * 10) / 10, mode: "init" };
  if (!inSync && alt) return { D: Math.round(alt.s * 10) / 10, mode: "init" };
  if (!inSync || !alt) return null;
  const tIn = plannedAt(S, plan, inSync.s);
  const tAlt = plannedAt(S, plan, alt.s);
  const devIn = tIn === null ? 0 : Math.abs(wrapSecs(localSecs - tIn));
  const devAlt = tAlt === null ? 0 : Math.abs(wrapSecs(localSecs - tAlt));
  return { D: Math.round((devAlt + COLD_MARGIN_S < devIn ? alt.s : inSync.s) * 10) / 10, mode: "init" };
}

/* ------------------------------------------------------------------ stateful step */

export interface KbProgState {
  /** along-route metres (straight geometry), monotone */
  D: number;
  /** epoch secs of the last placed fix */
  t: number;
  /** upstream `vti` at which staleness was detected (null = in sync) */
  staleVti: number | null;
  /** last GPS delay (secs) while stale-flagged, and when it was computed */
  robust: number | null;
  robustAt: number;
  /** delay frozen when the bus reached its last stop (a parked bus is not "getting later") */
  endDelay: number | null;
  /** the bus reached (or left right after) its last stop while upstream's index was stale: course over */
  ended: boolean;
}

export interface KbProgIn {
  geom: ProgressGeom;
  /** planned seconds-of-day per `trip.times` index (null = unknown) */
  plan: ReadonlyArray<number | null>;
  lat: number;
  lon: number;
  /** epoch secs of this poll */
  tEpoch: number;
  /** agency-local seconds of the day of this poll */
  localSecs: number;
  /** upstream vehicle_trip_index (null = unknown) */
  vti: number | null;
  /** index of the stop upstream says comes next (kbNextStopIndex) */
  nextUp: number | null;
  /** parsePosition's delay (upstream estimate vs plan), the value to keep while upstream's index is trustworthy */
  delayUp: number | null;
}

export type DelaySrc = "est" | "gps" | "gps-held" | "unknown";

export interface KbProgOut {
  state: KbProgState | null;
  mode: TrackMode | "off";
  D: number | null;
  lastIdx: number | null;
  nextIdx: number | null;
  stale: boolean;
  /** est = keep upstream's value; gps = schedule deviation now; gps-held = last one (bus momentarily unplaceable);
   *  unknown = upstream is known stale and the bus cannot be placed any more → no delay at all */
  src: DelaySrc;
  /** secs; for "est" it is `delayUp` unchanged, for "unknown" null */
  delay: number | null;
  /** a stale-indexed bus has reached its last stop (upstream never registers it): hide it like parsePosition's
   *  own "sitting at the last stop" rule does. Only ever true after warm tracking, never from a cold start. */
  finished: boolean;
  /** schedule deviation at the GPS position whenever the bus was placed (diagnostics: how far upstream's value is off
   *  while its index looks in sync); null when unplaced */
  dev: number | null;
}

export function stepKbProgress(inp: KbProgIn, prev: KbProgState | null): KbProgOut {
  const { geom, plan } = inp;
  const S = geom.stops;
  const wasStale = prev !== null && prev.staleVti !== null && prev.staleVti === inp.vti;

  // course over (latched): the bus reached its last stop while upstream's index was stale — nothing to track any more
  if (wasStale && prev.ended) {
    const pg = progressAt(S, prev.D, inp.nextUp);
    return { state: prev, mode: "hold", D: prev.D, lastIdx: pg.lastIdx, nextIdx: null, stale: true, src: "gps-held", delay: prev.endDelay ?? prev.robust, finished: true, dev: null };
  }

  const tr = trackAlong(
    geom,
    inp.lat,
    inp.lon,
    inp.tEpoch,
    inp.localSecs,
    plan,
    inp.vti,
    inp.nextUp,
    prev ? { D: prev.D, t: prev.t } : null,
  );
  if (tr === null || tr.mode === "hold") {
    const mode: KbProgOut["mode"] = tr === null ? "off" : "hold";
    const pg = prev ? progressAt(S, prev.D, inp.nextUp) : null;
    const base = { mode, D: prev ? prev.D : null, lastIdx: pg ? pg.lastIdx : null, nextIdx: pg ? pg.nextIdx : null };
    if (wasStale && prev) {
      // last placed right at the final stop and off the route now: the bus left after its terminus
      const lastStop = finiteAtOrBefore(S, S.length - 1);
      if (lastStop !== null && prev.D >= lastStop - END_LEFT_M) {
        const delay = prev.endDelay ?? prev.robust;
        const state: KbProgState = { ...prev, endDelay: delay, ended: true };
        return { ...base, state, stale: true, src: "gps-held", delay, finished: true, dev: null };
      }
      if (prev.robust !== null && inp.tEpoch - prev.robustAt <= HOLD_CARRY_S) {
        return { ...base, state: prev, stale: true, src: "gps-held", delay: prev.robust, finished: false, dev: null };
      }
      return { ...base, state: prev, stale: true, src: "unknown", delay: null, finished: false, dev: null };
    }
    return { ...base, state: prev, stale: false, src: "est", delay: inp.delayUp, finished: false, dev: null };
  }

  const D = tr.D;
  const pg = progressAt(S, D, inp.nextUp);
  const dev = scheduleDelay(S, plan, D, inp.localSecs);
  if (pg.stale && dev !== null && Math.abs(dev) <= DEV_MAX_S) {
    let delay = dev;
    let endDelay: number | null = null;
    let ended = false;
    if (pg.nextIdx === null) {
      // at/after the last stop: freeze the arrival delay instead of letting a parked bus get "later"
      endDelay = prev?.endDelay ?? dev;
      delay = endDelay;
      ended = tr.mode === "cont" && nearLastStop(geom, inp.lat, inp.lon, END_NEAR_M);
    }
    const state: KbProgState = { D, t: inp.tEpoch, staleVti: inp.vti, robust: delay, robustAt: inp.tEpoch, endDelay, ended };
    return { state, mode: tr.mode, D, lastIdx: pg.lastIdx, nextIdx: pg.nextIdx, stale: true, src: "gps", delay, finished: ended, dev };
  }
  const state: KbProgState = { D, t: inp.tEpoch, staleVti: null, robust: null, robustAt: 0, endDelay: null, ended: false };
  return { state, mode: tr.mode, D, lastIdx: pg.lastIdx, nextIdx: pg.nextIdx, stale: false, src: "est", delay: inp.delayUp, finished: false, dev };
}

/** Arrival log of one KB execution: `arrived[i]` = epoch secs the bus was first seen at/past times[i]
 *  (array position, like vti); `reached` = highest index seen; `t` = poll time of the last step. */
export interface KbArrivals {
  arrived: (number | null)[];
  reached: number;
  t: number;
}

/** Longest poll gap whose newly reached stop is still stamped (a bus re-acquired after a gap passed it at an
 *  unknown moment inside it). */
const ARRIVAL_GAP_S = 60;
/** Most stops a bus passes between two polls (≤ ARRIVAL_GAP_S apart). A longer jump is a resync (the GPS index
 *  taking over a stale upstream one after a restart), not an arrival seen now. */
const ARRIVAL_MAX_STEP = 2;

/**
 * Upstream drops the times of passed KB stops, so the poller records them itself. The first sighting is only a
 * baseline (stops passed before it stay unknown, never "now"); afterwards the newly reached stop gets `fixAt`.
 * Stops skipped in one step get null: a jump means upstream registered them late or not at all.
 */
export function stepArrivals(prev: KbArrivals | undefined, reached: number, t: number, fixAt: number): KbArrivals {
  if (!prev) return { arrived: [], reached, t };
  if (reached <= prev.reached) return { ...prev, t };
  const arrived = prev.arrived.slice();
  while (arrived.length < reached) arrived.push(null);
  arrived[reached] = t - prev.t <= ARRIVAL_GAP_S && reached - prev.reached <= ARRIVAL_MAX_STEP ? fixAt : null;
  return { arrived, reached, t };
}
