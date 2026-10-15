/**
 * Fleet ("brygady") wire types + the pure rules both sides must agree on: the punctuality
 * classes, text folding for search, line ordering.
 *
 * Isomorphic and pure (no DOM / Node imports, relative imports only — node:test loads it
 * directly). lib/fleet-tracker.ts builds these shapes; components/brygady/* render them.
 *
 * What the data can and cannot say. OnTime (MZK) publishes running vehicles with their
 * course, stop list (per-segment `distance`, so real course length is known) and delay. It
 * does NOT publish duty rosters, so a vehicle's real brigade number ("50/3") is unknowable:
 * we show the lines a vehicle served today instead of inventing one. Everything in
 * `todayCourses` was observed live; nothing is back-filled.
 */
import type { VehicleFeatures } from "../mzk-fleet";

export type { VehicleFeatures };

export type FleetFuelType = "diesel" | "electric" | "hydrogen" | "hybrid";
export type FleetLengthCategory = "MINI" | "MIDI" | "MAXI" | "MEGA";

export interface VehicleCourseStop {
  symbol: string;
  name: string;
  scheduledTime: string; // HH:MM
  plannedTime: string; // HH:MM
  status: "passed" | "current" | "upcoming";
  /** metres from the previous stop (OnTime per-segment distance; 0 on the first stop) */
  distanceMeters?: number;
}

export interface VehicleCourseRecord {
  id: string;
  courseLoid?: number;
  lineName: string;
  direction: string;
  firstStopName: string;
  lastStopName: string;
  firstStopSymbol?: string;
  lastStopSymbol?: string;
  startTime: string; // HH:MM, scheduled
  endTime: string; // HH:MM, scheduled
  startSecs: number; // agency seconds since midnight, scheduled
  endSecs: number;
  /** last observed delay of the course (≈ arrival delay for a finished one) */
  delaySec: number;
  stopsCount: number;
  status: "completed" | "in_progress" | "cancelled";
  cancelledReason?: string;
  cancelledAtStopName?: string;
  /** epoch secs when the course left the live feed */
  completedAt?: number;
  /** planned course length: sum of the per-segment stop distances */
  lengthMeters?: number;
  /** metres driven on this course: the whole course once completed, up to the last stop reached when interrupted */
  drivenMeters?: number;
  stops?: VehicleCourseStop[];
}

export interface FleetCurrentCourse extends VehicleCourseRecord {
  /** waiting at the first stop; delaySec is 0 and must not be shown or counted */
  notStarted?: boolean;
  /** standing at `currentStopName` (OnTime onStopPoint) */
  atStop?: boolean;
  /** index of the last stop served (the first stop while not started) */
  currentStopIndex: number;
  currentStopName: string;
  nextStopName: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  /** by distance driven when OnTime sent stop distances, else by stop index */
  progressPct: number;
}

export interface PredictedNextCourse {
  lineName: string;
  direction: string;
  departureTime: string; // HH:MM
  departureSecs: number;
  fromStopName: string;
  fromStopSymbol?: string;
  /** minutes between the expected arrival and the estimated departure */
  pauseMinutes: number;
  /** "medium": the vehicle shuttled on this line today (observed); "low": generic assumption */
  confidence: "medium" | "low";
  reason: string;
}

export interface FleetVehicleStats {
  /** courses begun today (finished, interrupted and the running one) */
  totalCoursesToday: number;
  completedCoursesToday: number;
  cancelledCoursesToday: number;
  /** km driven today, from OnTime stop distances */
  kmToday: number;
  /** courses with a measured delay (completed + the running one once begun) */
  measuredCourses: number;
  /** signed mean delay of the measured courses (early cancels late) */
  averageDelaySecs: number;
  /** on-time share of the measured courses; null when none was measured */
  punctualityPct: number | null;
}

export interface FleetVehicleDetail {
  sideNumber: string;
  operator: "MZK" | "KB";
  model: string;
  producer: string;
  year?: string;
  lengthCategory: FleetLengthCategory;
  fuelType: FleetFuelType;
  features: VehicleFeatures;
  /** "active" = in OnTime's running list right now */
  status: "active" | "depot";
  /** lines served today, in order of first service */
  lines: string[];
  /** the line with the most courses today (ties: the latest), null before the first course */
  mainLine: string | null;
  currentCourse: FleetCurrentCourse | null;
  predictedNextCourse: PredictedNextCourse | null;
  /** finished/interrupted courses, newest first */
  todayCourses: VehicleCourseRecord[];
  /** epoch secs of the last live sighting; 0 = not seen today */
  lastSeenAt: number;
  lastKnownLocation: { lat: number; lon: number; name: string } | null;
  stats: FleetVehicleStats;
}

/**
 * One row of /api/fleet, polled every 10 s for the whole fleet: only what the list and the stats
 * show. Equipment, the position and the course id live in the vehicle detail.
 */
export interface FleetSummaryItem {
  sideNumber: string;
  model: string;
  producer: string;
  year?: string;
  lengthCategory: FleetLengthCategory;
  fuelType: FleetFuelType;
  status: "active" | "depot";
  lines: string[];
  lineName?: string;
  direction?: string;
  /** scheduled departure from the first stop of the current course, HH:MM */
  startTime?: string;
  firstStopName?: string;
  currentStopName?: string;
  nextStopName?: string;
  atStop?: boolean;
  /** undefined while the course has not begun (OnTime's delay is a placeholder then) */
  delaySec?: number;
  /** the bus waits at the first stop of a course that has not begun */
  notStarted?: boolean;
  progressPct?: number;
  coursesCountToday: number;
  cancelledCoursesToday: number;
  kmToday: number;
  lastSeenAt: number;
  /** line of the latest course, for a vehicle that is not running now */
  lastLineName?: string;
}

export interface FleetStats {
  totalFleet: number;
  activeCount: number;
  depotCount: number;
  /** running vehicles whose course has not begun */
  waitingCount: number;
  /** running vehicles with a measured delay */
  measuredCount: number;
  electricCount: number;
  hydrogenCount: number;
  hybridCount: number;
  megaCount: number;
  /** signed mean over measured vehicles; 0 when none */
  averageDelaySec: number;
  /** null when no vehicle has a measured delay */
  medianDelaySec: number | null;
  /** 100 when nothing is measured — read it together with measuredCount */
  onTimePercentage: number;
  activeLines: string[];
  /** vehicles seen in service today (running now or earlier) */
  seenTodayCount: number;
  kmToday: number;
  coursesCompletedToday: number;
  coursesCancelledToday: number;
  /** epoch secs of the last poller update; 0 = none since start */
  updatedAt: number;
}

/** Snapshot of the running fleet for one 5-minute slot of the day (the last sample in the slot). */
export interface FleetTimelinePoint {
  /** slot start, agency seconds since midnight */
  t: number;
  waiting: number;
  early: number;
  onTime: number;
  late: number;
  veryLate: number;
}

export const TIMELINE_SLOT_SECS = 300;

/** A phototrans photo of a vehicle: the browser hot-links the 300x200 thumbnail, credited to its
 *  author, both linking back to phototrans. */
export interface VehiclePhoto {
  thumb: string;
  page: string;
  author: string;
  authorPage: string;
  /** YYYY-MM-DD the photo was taken, when phototrans gives one */
  date: string | null;
}

/* ── punctuality ─────────────────────────────────────────────────────────────── */

/** On time = at most 1 min early and at most 3 min late (the usual Polish operator rule). */
export const ON_TIME_MIN_SEC = -60;
export const ON_TIME_MAX_SEC = 180;
export const VERY_LATE_SEC = 600;

export type DelayClass = "early" | "onTime" | "late" | "veryLate";

export function classifyDelay(delaySec: number): DelayClass {
  if (delaySec < ON_TIME_MIN_SEC) return "early";
  if (delaySec <= ON_TIME_MAX_SEC) return "onTime";
  if (delaySec <= VERY_LATE_SEC) return "late";
  return "veryLate";
}

export function isOnTime(delaySec: number): boolean {
  return classifyDelay(delaySec) === "onTime";
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* ── text & ordering ─────────────────────────────────────────────────────────── */

/** Lowercase, diacritics folded (ł included, which NFD leaves alone): "Żywiec" ~ "zywiec". */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Numeric lines first in numeric order ("2" < "10"), then the rest alphabetically. */
export function compareLineNames(a: string, b: string): number {
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  const fa = Number.isFinite(na);
  const fb = Number.isFinite(nb);
  if (fa && fb && na !== nb) return na - nb;
  if (fa !== fb) return fa ? -1 : 1;
  return a.localeCompare(b, "pl");
}

/**
 * Free-text vehicle search: a side number ("#23…" by prefix, or 3+ digits), a line number
 * (exact, current or served today — "1" must not list side numbers 100-199), or a folded
 * substring of model, producer, direction, stop. A bare number is never a text substring:
 * "1" means line 1, not every "Urbino 12".
 */
export function matchesFleetQuery(
  v: Pick<FleetSummaryItem, "sideNumber" | "model" | "producer" | "lines" | "lineName" | "direction" | "currentStopName">,
  query: string,
): boolean {
  const q = foldText(query.trim());
  if (!q) return true;
  const hash = q.startsWith("#");
  const bare = hash ? q.slice(1).trim() : q;
  if (/^\d+$/.test(bare) && (hash || bare.length >= 3) && v.sideNumber.startsWith(bare)) return true;
  if (hash) return false;
  if (v.lineName && foldText(v.lineName) === q) return true;
  if (v.lines.some((l) => foldText(l) === q)) return true;
  if (/^\d+$/.test(q)) return false;
  for (const field of [v.model, v.producer, v.direction, v.currentStopName]) {
    if (field && foldText(field).includes(q)) return true;
  }
  return false;
}
