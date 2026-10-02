/**
 * Lifecycle of an MZK (OnTime) running-vehicle record — pure helpers, no
 * imports of the poller singleton (usable from the poller, the trip resolver,
 * the departures route and the fleet tracker alike).
 *
 * WHY THIS EXISTS. OnTime hands a vehicle its NEXT course the moment the
 * previous one ends at the terminus, so `getRunningVehicles` also lists buses
 * that are merely parked at (or idling next to) the first stop of a course that
 * has not begun. For such a course OnTime has no measurement, so
 *
 *     delaySec                     = max(-60 s, now - scheduled first departure)
 *     stopPoints[i].plannedDeparture = scheduledDeparture + delaySec   (every stop)
 *
 * i.e. a PLACEHOLDER that grows one second per second until the bus really
 * leaves ("+14 min" for a bus that has not moved), and sits on the -60 s floor
 * ("1 min early") for every bus waiting before its time. Measured on the live
 * fleet: ~15 % of running vehicles are in this state on an evening (4-27 %),
 * 67 % of those at the -60 s floor.
 *
 * Signature of "course not begun" (all observed, 800+ samples):
 *   - orderInCourse === 0
 *   - lastStopOrderNo null (never confirmed a stop) — or 0 while the bus has not
 *     moved: OnTime flickers lastStopOrderNo null <-> 0 and onStopPoint on/off
 *     while a bus idles within ~100 m of the first stop (reachedMeters 0..28)
 *   - the bus is within ~105 m of the first stop (parked) or, still arriving through a
 *     terminal loop, up to ~270 m (observed maxima 104 m and 268 m)
 * A bus with orderInCourse >= 1 is running even if lastStopOrderNo is null
 * (it joined the course mid-way; its skipped stops carry -60 s / null planned
 * times — a different data-quality problem, handled by the trip builder).
 */
import { metersBetween } from "./geo";

/** Below this reachedMeters a bus flagged "left stop 0" (lastStopOrderNo 0) is
 *  still idling at the terminus (observed idle values 0..28 m; a real start
 *  reaches 48-120 m within one ping). */
export const MZK_NOT_STARTED_REACHED_M = 30;

/** A bus this far from its first stop has demonstrably left it, whatever the
 *  OnTime flags say. Parked buses were never more than 104 m away; buses still
 *  driving up to the first stop through a terminal loop (course not begun, delay
 *  on the -60 s floor) were seen up to 268 m away — the limit sits above that. */
export const MZK_NOT_STARTED_MAX_FROM_FIRST_M = 400;

export interface MzkLifecycleInput {
  orderInCourse?: unknown;
  lastStopOrderNo?: unknown;
  reachedMeters?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

function finite(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/**
 * True while the vehicle's course has not begun (waiting for its departure,
 * early or late). `firstStop` is the first stop's coordinates when known (safety
 * net: a bus far from it is moving, whatever OnTime flags). Unknown/garbled
 * input — including a missing lastStopOrderNo — classifies as "started" so a
 * real delay is never hidden by mistake.
 */
export function isMzkNotStarted(
  v: MzkLifecycleInput,
  firstStop?: { lat: number; lon: number } | null,
): boolean {
  if (v.orderInCourse !== 0) return false;
  const last = v.lastStopOrderNo;
  // OnTime always sends the field (null = no stop confirmed yet); absent = not an OnTime record we understand
  if (last === undefined) return false;
  if (last !== null) {
    if (last !== 0) return false;
    if ((finite(v.reachedMeters) ?? 0) >= MZK_NOT_STARTED_REACHED_M) return false;
  }
  const lat = finite(v.latitude);
  const lon = finite(v.longitude);
  if (
    firstStop &&
    lat !== null &&
    lon !== null &&
    metersBetween(lat, lon, firstStop.lat, firstStop.lon) > MZK_NOT_STARTED_MAX_FROM_FIRST_M
  ) {
    return false;
  }
  return true;
}

/**
 * Forward-monotone planned times for the stops AFTER `fromIdx`: a later stop
 * cannot be reached before an earlier one, so any dip (stale placeholder next
 * to a fresh estimate) is lifted to its predecessor. Entries <= fromIdx
 * (already passed: actual times) are returned untouched; null stays null.
 */
export function clampPlannedMonotone(
  planned: ReadonlyArray<number | null | undefined>,
  fromIdx: number,
): Array<number | null> {
  const out: Array<number | null> = planned.map((p) => (typeof p === "number" && Number.isFinite(p) ? p : null));
  let floor = -Infinity;
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (p === null) continue;
    if (i > fromIdx) {
      if (p < floor) out[i] = floor;
      else floor = p;
    } else {
      floor = Math.max(floor, p);
    }
  }
  return out;
}

/** True when `clampPlannedMonotone` would change something — OnTime sent a stop ahead an estimate
 *  that precedes an earlier stop's (screenshot B: 15:23 then 15:19). Used to log real occurrences. */
export function hasPlannedDip(planned: ReadonlyArray<number | null | undefined>, fromIdx: number): boolean {
  const clamped = clampPlannedMonotone(planned, fromIdx);
  return clamped.some((p, i) => p !== (typeof planned[i] === "number" && Number.isFinite(planned[i]) ? planned[i] : null));
}

function hhmmFromSecs(secs: number): string {
  const s = ((Math.floor(secs) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

export interface MzkRowTimingInput {
  /** getRealtime: scheduled departure from this stop, seconds since local midnight */
  scheduledDepartureSec: number;
  /** getRealtime: scheduled / real departure from this stop, epoch ms (real null/0 = no estimate) */
  scheduledDeparture: number;
  realDeparture?: number | null;
  lack?: boolean;
  /** the course has not begun (isMzkNotStarted on the running vehicle) */
  notStarted: boolean;
  /** running vehicle's stopPoints[0].scheduledDeparture, epoch ms */
  firstScheduledMs?: number | null;
  nowMs: number;
}

/**
 * Departure-board timing of one MZK row: `time` ("HH:MM", also the server-side
 * sort key), `timeDiff` seconds and `isEstimated`. A course that has not begun
 * has NO estimate — OnTime's realDeparture is the now-minus-start placeholder —
 * so it is shown as the earliest possible time (schedule pushed back by the
 * overstay, a lower bound) with isEstimated false and no delay.
 */
export function mzkRowTiming(i: MzkRowTimingInput): { time: string; timeDiff: number; isEstimated: boolean } {
  if (i.notStarted) {
    // earliest possible time = the schedule pushed back by how long the bus has already overstayed its
    // first departure (it cannot leave before "now"): a LOWER BOUND, never a forecast. The client's
    // notStartedEta() applies the same rule to the trip banner.
    const overstaySec =
      typeof i.firstScheduledMs === "number" && Number.isFinite(i.firstScheduledMs)
        ? Math.max(0, Math.round((i.nowMs - i.firstScheduledMs) / 1000))
        : 0;
    return { time: hhmmFromSecs(i.scheduledDepartureSec + overstaySec), timeDiff: 0, isEstimated: false };
  }
  if (i.realDeparture && !i.lack) {
    const timeDiff = Math.round((i.realDeparture - i.scheduledDeparture) / 1000);
    return { time: hhmmFromSecs(i.scheduledDepartureSec + timeDiff), timeDiff, isEstimated: true };
  }
  return { time: hhmmFromSecs(i.scheduledDepartureSec), timeDiff: 0, isEstimated: false };
}
