/**
 * Pure per-vehicle route math the pollers attach to positions for the client
 * motion engine: when a fix really happened, how far along its shape it is,
 * and a cruise speed that a dwell can't drag down.
 */
import type { KbPattern } from "./shape-patterns";
import type { ShapeGeometry } from "./shape-store";
import { projectOnPolyline } from "./shared/polyline";
import type { VehicleJson, VehiclePos } from "./types";

/** What the KB poller needs from the shape store (kept narrow for tests). */
export interface KbShapeSink {
  touchKb(p: KbPattern, prio: "urgent" | "background"): void;
  geometry(key: string): ShapeGeometry | null;
}

/**
 * When did the current position first appear upstream? KB sends no fix time,
 * so a change seen at poll `updatedAt` happened somewhere since the previous
 * poll — the midpoint of that window halves the systematic lag (the gap is
 * capped so a long pause doesn't push the estimate far into the past).
 */
export function estimateFixAt(
  prev: { fixAt?: number; updatedAt: number } | undefined,
  updatedAt: number,
  moved: boolean,
  capSec = 30,
): number {
  if (!prev) return updatedAt;
  if (!moved) return prev.fixAt ?? prev.updatedAt;
  const gap = Math.min(Math.max(0, updatedAt - prev.updatedAt), capSec);
  return updatedAt - gap / 2;
}

const MOVING_M = 20;
const SPEED_MAX = 25;
const SPEED_REJECT = 33;
const SPEED_TAU_S = 20;

/**
 * Cruise-speed EMA update from one pair of distinct fixes, or null when the
 * pair is not a "moving pair": both fixes must have moved ≥20 m from their
 * predecessor, the earlier one must not have been sitting still for long
 * (`prevHeldSec` > 30 s means it was a dwell; KB upstream alone can
 * leave a moving bus unchanged for ~25 s), neither may be inside a stop
 * zone (braking/pulling away would drag the cruise speed down) and Δt must be
 * sane. Standing still is the client's hold rule's job — not something to
 * average in.
 */
export function nextSpeed(
  prevSpeed: number | null | undefined,
  prevMoveDs: number | undefined,
  ds: number,
  dt: number,
  prevHeldSec = 0,
  inStopZone = false,
): number | null {
  if (inStopZone) return null;
  // the first-ever fix has no history: its displacement spans an unknown
  // interval (it may have been reported long before we first saw it), so a
  // pair starting there would wildly overestimate the speed
  if (!(prevMoveDs !== undefined && prevMoveDs >= MOVING_M)) return null;
  if (!(ds >= MOVING_M) || !(dt >= 3 && dt <= 45) || prevHeldSec > 30) return null;
  const sample = ds / dt;
  if (sample > SPEED_REJECT) return null;
  const v = Math.min(SPEED_MAX, sample);
  if (prevSpeed == null || !Number.isFinite(prevSpeed)) return v;
  const a = 1 - Math.exp(-dt / SPEED_TAU_S);
  return prevSpeed + a * (v - prevSpeed);
}

function finiteAt(stops: ReadonlyArray<number | null>, from: number, step: 1 | -1): number | null {
  for (let i = from; i >= 0 && i < stops.length; i += step) {
    const s = stops[i];
    if (s !== null && s !== undefined) return s;
  }
  return null;
}

export interface DistOpts {
  /** how far ahead of `hint` the vehicle may have moved since the hint was measured (m); default 500 */
  aheadM?: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Forward window for kbDistAlong's continuity step after `gapS` seconds without a poll: a bus can
 * cover ~30 m/s at most, plus margin; never less than 500 m (the poller's normal 10-16 s cadence)
 * and never more than 2 km (so the opposite leg of a short spur stays out of reach).
 */
export function kbAheadM(gapS: number): number {
  const g = Number.isFinite(gapS) ? Math.min(90, Math.max(0, gapS)) : 0;
  return Math.min(2000, Math.max(500, 30 * g + 150));
}

/**
 * Metres along the shape for a KB fix. Out-and-back / loop patterns run on twin stops and overlapping
 * roads, and upstream's vti freezes for minutes whenever a pole is passed outside its geofence, so
 * the answer is built from what a bus cannot do, in this order:
 *  1. continuity: it moves forward from where it was last poll, [hint-60, hint+aheadM], and a fit
 *     more than 15 m behind the hint yields to one ahead of it within 15 m of fit. This keeps the
 *     return leg on the return leg while vti is stale (the vti window below would accept the
 *     outbound twin, same road, <=60 m) and turns a U-turn forward instead of walking it back;
 *  2. upstream's window between the last reached stop (vti) and the next one (cold start / lost);
 *  3. a strict whole-line search; null when the fix is off-route.
 */
export function kbDistAlong(
  geom: ShapeGeometry,
  lat: number,
  lon: number,
  vti: number | null,
  nextSeq: number | null,
  hint?: number,
  opts: DistOpts = {},
): number | null {
  const maxOff = geom.src === "straight" ? 150 : 60;
  if (hint !== undefined && Number.isFinite(hint)) {
    const hi = hint + (opts.aheadM ?? 500);
    let c = projectOnPolyline(geom.pl, lat, lon, hint - 60, hi, { hint });
    // behind by more than jitter while a twin leg ahead fits about as well (a U-turn, an out-and-back on one road):
    // the bus is on the leg ahead. The closest-to-hint tie-break alone walks it back up to 60 m per poll.
    if (c && c.s < hint - 15) {
      const f = projectOnPolyline(geom.pl, lat, lon, hint, hi);
      if (f && f.d <= Math.min(maxOff, c.d + 15)) c = f;
    }
    if (c && c.d <= maxOff) return round1(c.s);
  }
  if (vti !== null && vti >= 0) {
    const lo = finiteAt(geom.stops, Math.min(vti, geom.stops.length - 1), -1);
    const hiIdx = nextSeq !== null && nextSeq > vti ? nextSeq : vti + 1;
    const hi = finiteAt(geom.stops, hiIdx, 1);
    const p = projectOnPolyline(geom.pl, lat, lon, (lo ?? 0) - 100, (hi ?? geom.pl.length) + 100, { hint });
    if (p && p.d <= maxOff) return round1(p.s);
  }
  const p = projectOnPolyline(geom.pl, lat, lon, 0, Infinity, { hint });
  return p && p.d <= 40 ? round1(p.s) : null;
}

/** Scheduled runs shorter than this are widened: timetable times are whole minutes, so one short leg reads as
 *  0 s or twice its real length. */
const SCHED_MIN_S = 120;

/**
 * Timetable pace (m/s) at chainage `d`: chainage over scheduled time between the timed stops either side of it,
 * widened a stop at a time (forward first) until the run spans SCHED_MIN_S. `times` are seconds, aligned with
 * `stops`; a drop of more than 12 h is the next day. null outside the trip or when the timetable says nothing.
 * O(stops of the trip).
 */
export function schedSpeed(stops: ArrayLike<number | null>, times: ArrayLike<number | null>, d: number): number | null {
  const n = Math.min(stops.length, times.length);
  const ok = (k: number) => stops[k] != null && times[k] != null;
  let i = -1;
  let j = -1;
  for (let k = 0; k < n && j < 0; k++) {
    if (!ok(k)) continue;
    if (stops[k]! <= d) i = k;
    else j = k;
  }
  if (i < 0 || j < 0) return null;
  const span = () => {
    const dt = times[j]! - times[i]!;
    return dt < -43200 ? dt + 86400 : dt;
  };
  while (span() < SCHED_MIN_S) {
    let k = j + 1;
    while (k < n && !ok(k)) k++;
    if (k < n) {
      j = k;
      continue;
    }
    k = i - 1;
    while (k >= 0 && !ok(k)) k--;
    if (k < 0) return null;
    i = k;
  }
  const v = (stops[j]! - stops[i]!) / span();
  return v > 0 && v <= 30 ? v : null;
}

/**
 * Motion extras for the client (kept out of vehicleToJson, the Python port).
 * Never throws: a bad entry just ships the vehicle without them.
 */
export function vehicleExtras(v: VehiclePos, shapes: { wireId(key: string): string | null } | null, nowEpoch: number): Partial<VehicleJson> {
  try {
    const out: Partial<VehicleJson> = {};
    if (v.fixAt != null && Number.isFinite(v.fixAt)) out.fix_at = Math.round(v.fixAt * 10) / 10;
    if (v.nextStopSeq != null) out.next_stop_seq = v.nextStopSeq;
    if (v.delaySrc) out.delay_src = v.delaySrc;
    if (v.geoLastSeq != null && v.geoLastSeq >= 0) out.geo_seq = v.geoLastSeq;
    if (v.notStarted) out.not_started = true;
    if (v.schedTripId) out.sched_trip_id = v.schedTripId;
    if (v.agency) out.agency = v.agency;
    if (v.scheduled) out.scheduled = true;
    // a course not begun is not on its shape yet (a layover, the run from the depot): no along-route motion
    if (v.notStarted) return out;
    if (v.speed != null && Number.isFinite(v.speed) && v.speedAt != null && nowEpoch - v.speedAt <= 90) {
      out.speed = Math.round(v.speed * 10) / 10;
    }
    if (v.schedSpeed != null && Number.isFinite(v.schedSpeed)) out.sched_speed = Math.round(v.schedSpeed * 10) / 10;
    if (shapes && v.shapeKey) {
      const id = shapes.wireId(v.shapeKey);
      if (id) {
        out.shape = id;
        if (v.distM != null && Number.isFinite(v.distM) && v.distRev === id.slice(-6)) out.dist_m = Math.round(v.distM);
      }
    }
    return out;
  } catch {
    return {};
  }
}
