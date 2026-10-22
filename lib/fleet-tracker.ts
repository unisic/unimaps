/**
 * Vehicle fleet tracker ("brygady") for MZK Bielsko-Biała.
 *
 * Fed by the MZK poller (~5 s) with OnTime's running vehicles; keeps per vehicle the course
 * it runs now and the courses it finished/broke off today, plus a 5-minute punctuality
 * timeline of the running fleet. Everything here was observed live — nothing is
 * back-filled or invented (no brigade numbers: OnTime does not publish them; see
 * lib/shared/fleet.ts). Persisted per day to output/fleet-history-<YYYY-MM-DD>.json so a
 * restart keeps the day.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "./logger";
import { type MzkApi } from "./mzk-api";
import { getAllFleetVehicles, getFleetDetails, type MzkVehicleStatic } from "./mzk-fleet";
import { isMzkNotStarted } from "./mzk-state";
import { mzkStopIndices } from "./mzk-shape";
import { AGENCY_TIMEZONE, FLEET_HISTORY_DAYS as HISTORY_KEEP_DAYS, OUTPUT_DIR } from "./config";
import {
  classifyDelay,
  compareLineNames,
  foldText,
  isOnTime,
  matchesFleetQuery,
  median,
  TIMELINE_SLOT_SECS,
  type FleetCurrentCourse,
  type FleetStats,
  type FleetSummaryItem,
  type FleetTimelinePoint,
  type FleetVehicleDetail,
  type FleetVehicleStats,
  type PredictedNextCourse,
  type VehicleCourseRecord,
  type VehicleCourseStop,
} from "./shared/fleet";
import type { Stop } from "./types";

export type {
  FleetCurrentCourse,
  FleetStats,
  FleetSummaryItem,
  FleetTimelinePoint,
  FleetVehicleDetail,
  PredictedNextCourse,
  VehicleCourseRecord,
  VehicleCourseStop,
};

/** What the tracker reads of an OnTime running-vehicle record (MzkRunningVehicle is assignable). */
export interface FleetRunningInput {
  vehicleId: string;
  lineName: string;
  courseLoid: number;
  direction: string;
  optionalDirection?: string;
  delaySec: number;
  latitude: number;
  longitude: number;
  angle?: number;
  /** epoch ms of the GPS fix (OnTime lastPingDate) */
  lastPingDate?: number;
  orderInCourse?: number;
  lastStopOrderNo?: number | null;
  reachedMeters?: number;
  onStopPoint?: boolean | string | null;
  nearestSymbol?: string;
  nearestSymbolOrderNo?: number;
  stopPoints?: Array<{
    symbol: string;
    name: string;
    orderNo: number;
    distance: number;
    scheduledDeparture: number;
    plannedDeparture: number;
  }>;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function secsToHHMM(s: number): string {
  const norm = ((Math.floor(s) % 86400) + 86400) % 86400;
  const h = Math.floor(norm / 3600);
  const m = Math.floor((norm % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}`;
}

const warsawTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: AGENCY_TIMEZONE,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const warsawDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: AGENCY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateToAgencySecs(ms: number): number {
  if (!ms || Number.isNaN(ms)) return 0;
  try {
    const parts = warsawTimeFmt.formatToParts(new Date(ms));
    let h = 0;
    let m = 0;
    let s = 0;
    for (const p of parts) {
      if (p.type === "hour") h = Number(p.value) % 24;
      else if (p.type === "minute") m = Number(p.value);
      else if (p.type === "second") s = Number(p.value);
    }
    return h * 3600 + m * 60 + s;
  } catch {
    const d = new Date(ms);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
}

function getTodayKey(): string {
  try {
    return warsawDateFmt.format(new Date());
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
}

function finiteNonNeg(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
}

/**
 * Sorts courses descending: from the newest (latest departure/start) to the oldest (earliest departure).
 */
export function sortCoursesDesc(a: VehicleCourseRecord, b: VehicleCourseRecord): number {
  const startA = a.startSecs ?? 0;
  const startB = b.startSecs ?? 0;
  if (startB !== startA) return startB - startA;
  const endA = a.endSecs ?? 0;
  const endB = b.endSecs ?? 0;
  if (endB !== endA) return endB - endA;
  return (b.startTime || "").localeCompare(a.startTime || "");
}

/** A course this close to its planned length (OnTime's reachedMeters) counts as run to the end. */
const END_SLACK_M = 300;

/**
 * Whether a course that left the live feed ran to the end or was broken off.
 *
 * OnTime drops a course on arrival, or hands the bus its next course at the terminus, before
 * the last stop registers: a course that left on its last leg (or within END_SLACK_M of the
 * end) was run, however late (2026-10-19: 236 of 253 "interrupted" courses had exactly one
 * stop left, median 41 m). Leaving earlier while 10+ min late (standing still, typically) is
 * the signature of an interrupted course: breakdown, GPS loss, a course taken off or, when the
 * bus moved straight on to another course (`switched`), cut short by the dispatcher.
 */
export function determineCourseOutcome(course: {
  currentStopIndex: number;
  stopsCount: number;
  delaySec: number;
  currentStopName: string;
  lengthMeters?: number;
  drivenMeters?: number;
  switched?: boolean;
}): {
  status: "completed" | "cancelled";
  cancelledReason?: string;
  cancelledAtStopName?: string;
} {
  const { currentStopIndex, stopsCount, delaySec, currentStopName } = course;

  // Single-stop or no-stop edge cases cannot determine mid-route cancellation
  if (stopsCount <= 1) {
    return { status: "completed" };
  }

  const onLastLeg = currentStopIndex >= stopsCount - 2;
  const length = course.lengthMeters ?? 0;
  const nearEnd = length > 0 && length - (course.drivenMeters ?? 0) <= END_SLACK_M;
  const hasSubstantialDelay = delaySec >= 10 * 60;

  if (!onLastLeg && !nearEnd && hasSubstantialDelay) {
    const delayMins = Math.round(delaySec / 60);
    return {
      status: "cancelled",
      cancelledReason: course.switched
        ? `Kurs skrócony: pojazd przeszedł na kolejny kurs po przystanku ${currentStopName} przy opóźnieniu +${delayMins} min`
        : `Kurs przerwany: pojazd zniknął z systemu na przystanku ${currentStopName} przy opóźnieniu +${delayMins} min (awaria, utrata GPS lub zjazd)`,
      cancelledAtStopName: currentStopName,
    };
  }

  return { status: "completed" };
}

/** A saved "cancelled" course judged again under today's rule: files written before 2026-10-19 flag late arrivals. */
function rejudgeCancelled(c: VehicleCourseRecord): VehicleCourseRecord {
  if (c.status !== "cancelled") return c;
  const outcome = determineCourseOutcome({
    currentStopIndex: c.stops?.findIndex((s) => s.status === "current") ?? -1,
    stopsCount: c.stopsCount,
    delaySec: c.delaySec,
    currentStopName: c.cancelledAtStopName ?? "",
    lengthMeters: c.lengthMeters,
    drivenMeters: c.drivenMeters,
  });
  if (outcome.status === "cancelled") return c;
  return { ...c, status: "completed", cancelledReason: undefined, cancelledAtStopName: undefined, drivenMeters: c.lengthMeters };
}

/** Planned length of a course: sum of OnTime's per-segment stop distances. */
function stopsLengthMeters(stops: ReadonlyArray<{ distanceMeters?: number }> | undefined, uptoIndex?: number): number {
  if (!stops) return 0;
  const last = uptoIndex === undefined ? stops.length - 1 : Math.min(uptoIndex, stops.length - 1);
  let sum = 0;
  for (let i = 0; i <= last; i++) sum += finiteNonNeg(stops[i]?.distanceMeters) ?? 0;
  return sum;
}

/** Metres driven on a finished course (records saved before drivenMeters existed fall back to the stop list). */
export function courseDrivenMeters(c: VehicleCourseRecord): number {
  if (finiteNonNeg(c.drivenMeters) !== null) return c.drivenMeters!;
  if (c.status === "completed") return finiteNonNeg(c.lengthMeters) ?? stopsLengthMeters(c.stops);
  const reached = c.stops?.findIndex((s) => s.status === "current") ?? -1;
  return reached >= 0 ? stopsLengthMeters(c.stops, reached) : 0;
}

/** Typical turnaround at a terminus when this vehicle has not shown its own yet. */
const DEFAULT_LAYOVER_MIN = 8;
/** A late bus still stands this long at the terminus before it leaves again. */
const MIN_LAYOVER_SEC = 3 * 60;
/** Course gaps longer than this are a break/duty change, not a layover. */
const MAX_LAYOVER_SEC = 45 * 60;
/** A persisted live course is resumed after a restart only when it was seen this recently. */
const RESUME_LIVE_MAX_AGE_SEC = 10 * 60;
const SAVE_DEBOUNCE_MS = 30_000;
const HISTORY_FORMAT = 2;

const DEFAULT_HISTORY_DIR = OUTPUT_DIR;

function emptyStats(): FleetVehicleStats {
  return {
    totalCoursesToday: 0,
    completedCoursesToday: 0,
    cancelledCoursesToday: 0,
    kmToday: 0,
    measuredCourses: 0,
    averageDelaySecs: 0,
    punctualityPct: null,
  };
}

interface SavedVehicle {
  todayCourses?: VehicleCourseRecord[];
  currentCourse?: FleetCurrentCourse | null;
  lastSeenAt?: number;
  lastKnownLocation?: FleetVehicleDetail["lastKnownLocation"];
}

export class FleetTracker {
  private vehicles = new Map<string, FleetVehicleDetail>();
  /** side numbers whose features were refreshed from OnTime's getVehicles.json today */
  private liveFeatures = new Set<string>();
  private timeline = new Map<number, FleetTimelinePoint>();
  private updatedAt = 0;
  private lastSaveAt = 0;
  private saveTimeout: NodeJS.Timeout | null = null;
  private currentDay = getTodayKey();
  private readonly historyDir: string | null;

  /** `historyDir: null` keeps everything in memory (tests); default OUTPUT_DIR (`KB_OUTPUT_DIR`, else output/ under the cwd). */
  constructor(opts: { historyDir?: string | null } = {}) {
    this.historyDir = opts.historyDir === undefined ? DEFAULT_HISTORY_DIR : opts.historyDir;
    this.initFromStaticFleet();
    this.loadHistoryFromDisk();
  }

  /**
   * (Re)starts the day: every official fleet vehicle, idle. Vehicles that appeared only live
   * (not in the static list) are dropped and come back when they run again.
   */
  private initFromStaticFleet(): void {
    this.vehicles.clear();
    this.liveFeatures.clear();
    this.timeline.clear();
    for (const f of getAllFleetVehicles()) {
      this.vehicles.set(f.sideNumber, this.newVehicle(f));
    }
  }

  private newVehicle(f: Pick<FleetVehicleDetail, "sideNumber" | "model" | "producer" | "year" | "lengthCategory" | "fuelType" | "features">): FleetVehicleDetail {
    return {
      sideNumber: f.sideNumber,
      operator: "MZK",
      model: f.model,
      producer: f.producer,
      year: f.year,
      lengthCategory: f.lengthCategory,
      fuelType: f.fuelType,
      features: f.features,
      status: "depot",
      lines: [],
      mainLine: null,
      currentCourse: null,
      predictedNextCourse: null,
      todayCourses: [],
      lastSeenAt: 0,
      lastKnownLocation: null,
      stats: emptyStats(),
    };
  }

  private rollOver(today: string): void {
    // the old day's last ~30 s would otherwise be lost (the pending save would land in the new file)
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.saveHistoryToDisk();
    this.currentDay = today;
    this.initFromStaticFleet();
    this.loadHistoryFromDisk();
    this.pruneHistory();
  }

  /** Deletes day files older than HISTORY_KEEP_DAYS (exact name pattern only), once per rollover. */
  private pruneHistory(): void {
    if (!this.historyDir) return;
    try {
      const cutoff = new Date(Date.parse(`${this.currentDay}T00:00:00Z`) - HISTORY_KEEP_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const f of fs.readdirSync(this.historyDir)) {
        const day = /^fleet-history-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1];
        if (day && day < cutoff) fs.unlinkSync(path.join(this.historyDir, f));
      }
    } catch (err) {
      log.warn("fleet-tracker", `Failed pruning old history files: ${err}`);
    }
  }

  /**
   * Main update routine called every poller cycle with active running vehicles.
   */
  public updateFromRunningVehicles(
    running: FleetRunningInput[],
    staticVehs?: Map<string, MzkVehicleStatic>,
    stopsBySymbol?: Map<string, Stop>,
    _api?: MzkApi,
  ): void {
    const today = getTodayKey();
    if (today !== this.currentDay) this.rollOver(today);

    const nowEpoch = Math.floor(Date.now() / 1000);
    this.updatedAt = nowEpoch;
    const activeSides = new Set<string>();

    for (const v of running) {
      if (!v.vehicleId || !v.lineName) continue;
      const side = String(v.vehicleId);
      // OnTime occasionally lists one bus twice in a snapshot: the first record wins
      if (activeSides.has(side)) continue;
      activeSides.add(side);

      const staticInfo = staticVehs?.get(side);
      let detail = this.vehicles.get(side);
      if (!detail) {
        detail = this.newVehicle(getFleetDetails(side, staticInfo));
        this.vehicles.set(side, detail);
        if (staticInfo) this.liveFeatures.add(side);
      } else if (staticInfo && !this.liveFeatures.has(side)) {
        // getVehicles.json knows this bus's real equipment (ticket machine, A/C) — the static list only the model's
        const info = getFleetDetails(side, staticInfo);
        detail.features = info.features;
        detail.fuelType = info.fuelType;
        this.liveFeatures.add(side);
      }

      detail.status = "active";
      detail.lastSeenAt = nowEpoch;

      const stopPoints = v.stopPoints ?? [];
      const totalStops = stopPoints.length;

      // course not begun: OnTime's delay / planned times are a placeholder (lib/mzk-state.ts)
      const firstCoords = totalStops > 0 ? stopsBySymbol?.get(stopPoints[0].symbol) : undefined;
      const notStarted = isMzkNotStarted(v, firstCoords ? { lat: firstCoords.lat, lon: firstCoords.lon } : null);

      // last stop served + the next one (the same reading the map uses, lib/mzk-shape.ts)
      let order = 0;
      let nextIdx: number | null = totalStops > 1 ? 1 : null;
      if (totalStops > 0 && !notStarted) {
        const idx = mzkStopIndices(v);
        order = idx.served ?? (idx.next !== null ? Math.max(0, idx.next - 1) : totalStops - 1);
        nextIdx = idx.next;
      }
      // the same reading as the map's at_stop (lib/mzk-poller.ts)
      const atStop = notStarted || Boolean(v.onStopPoint);

      let firstStopName = "Początek trasy";
      let lastStopName = v.direction || v.optionalDirection || "Koniec trasy";
      let firstStopSymbol: string | undefined;
      let lastStopSymbol: string | undefined;
      let startSecs = 0;
      let endSecs = 0;
      if (totalStops > 0) {
        firstStopName = stopPoints[0].name;
        firstStopSymbol = stopPoints[0].symbol;
        startSecs = dateToAgencySecs(stopPoints[0].scheduledDeparture);
        lastStopName = stopPoints[totalStops - 1].name;
        lastStopSymbol = stopPoints[totalStops - 1].symbol;
        endSecs = dateToAgencySecs(stopPoints[totalStops - 1].scheduledDeparture);
      }

      const courseStops: VehicleCourseStop[] = stopPoints.map((sp, idx) => ({
        symbol: sp.symbol,
        name: sp.name,
        scheduledTime: secsToHHMM(dateToAgencySecs(sp.scheduledDeparture)),
        // no estimate yet (not begun) or none sent (null planned) -> the schedule, never "00:00"
        plannedTime: secsToHHMM(dateToAgencySecs(notStarted || !sp.plannedDeparture ? sp.scheduledDeparture : sp.plannedDeparture)),
        status: idx < order ? "passed" : idx === order ? "current" : "upcoming",
        distanceMeters: finiteNonNeg(sp.distance) ?? undefined,
      }));

      // distance driven: OnTime's reachedMeters, kept between the last stop served and the next one
      const lengthMeters = stopsLengthMeters(courseStops);
      let drivenMeters = 0;
      if (!notStarted && totalStops > 0) {
        const lo = stopsLengthMeters(courseStops, order);
        const hi = nextIdx !== null ? stopsLengthMeters(courseStops, nextIdx) : lengthMeters;
        const reached = finiteNonNeg(v.reachedMeters);
        drivenMeters = Math.round(Math.min(hi, Math.max(lo, reached ?? lo)));
      }
      const progressPct =
        lengthMeters > 0
          ? Math.min(100, Math.round((drivenMeters / lengthMeters) * 100))
          : totalStops > 1
            ? Math.min(100, Math.round((order / (totalStops - 1)) * 100))
            : 0;

      // the bus was archived during a temporary GPS dropout and is back on the same course: it stays live
      const existingLiveIdx = detail.todayCourses.findIndex((c) => c.courseLoid === v.courseLoid);
      if (existingLiveIdx !== -1) detail.todayCourses.splice(existingLiveIdx, 1);

      if (detail.currentCourse && detail.currentCourse.courseLoid !== v.courseLoid) {
        this.archiveCourse(detail, detail.currentCourse, nowEpoch, true);
      }

      const direction = v.direction || v.optionalDirection || lastStopName;
      detail.currentCourse = {
        id: `c-${v.courseLoid}`,
        courseLoid: v.courseLoid,
        lineName: v.lineName,
        direction,
        firstStopName,
        lastStopName,
        firstStopSymbol,
        lastStopSymbol,
        startTime: secsToHHMM(startSecs),
        endTime: secsToHHMM(endSecs),
        startSecs,
        endSecs,
        delaySec: notStarted ? 0 : Math.round(v.delaySec || 0),
        notStarted,
        atStop,
        stopsCount: totalStops,
        currentStopIndex: order,
        currentStopName: stopPoints[order]?.name ?? "W trasie",
        nextStopName: nextIdx !== null ? (stopPoints[nextIdx]?.name ?? null) : null,
        lat: v.latitude,
        lon: v.longitude,
        bearing: typeof v.angle === "number" && Number.isFinite(v.angle) ? v.angle : null,
        ...(v.lastPingDate ? { fixAt: Math.floor(v.lastPingDate / 1000) } : {}),
        progressPct,
        lengthMeters,
        drivenMeters,
        status: "in_progress",
        stops: courseStops,
      };
      detail.lastKnownLocation = {
        lat: v.latitude,
        lon: v.longitude,
        name: `Linia ${v.lineName} → ${direction}`,
      };

      this.recalculateStats(detail);
      detail.predictedNextCourse = this.predictNextCourse(detail);
    }

    // vehicles that left the running list: the course they ran is history now
    for (const [side, detail] of this.vehicles) {
      if (activeSides.has(side) || detail.status !== "active") continue;
      detail.status = "depot";
      detail.predictedNextCourse = null;
      const finished = detail.currentCourse;
      if (finished) {
        const archived = this.archiveCourse(detail, finished, nowEpoch);
        const delayMins = Math.round(finished.delaySec / 60);
        detail.lastKnownLocation = {
          lat: finished.lat,
          lon: finished.lon,
          name: finished.notStarted
            ? `Linia ${finished.lineName} → ${finished.lastStopName} (kurs nie został rozpoczęty)`
            : archived?.status === "cancelled"
              ? `Utrata sygnału GPS na przystanku ${finished.currentStopName} (linia ${finished.lineName}${delayMins >= 5 ? `, opóźnienie ${delayMins} min` : ""})`
              : `Ostatni kurs: linia ${finished.lineName} do ${finished.lastStopName}`,
        };
        detail.currentCourse = null;
      }
      this.recalculateStats(detail);
    }

    this.sampleTimeline(Date.now());
    this.scheduleSave();
  }

  /** Moves a course that left the live feed to the day's history (a course that never began is not history). */
  private archiveCourse(
    detail: FleetVehicleDetail,
    prev: FleetCurrentCourse,
    nowEpoch: number,
    switched = false,
  ): VehicleCourseRecord | null {
    if (prev.notStarted) return null;
    if (detail.todayCourses.some((c) => c.courseLoid === prev.courseLoid)) return null;
    const outcome = determineCourseOutcome({ ...prev, switched });
    const completed = outcome.status === "completed";
    const record: VehicleCourseRecord = {
      id: prev.id,
      courseLoid: prev.courseLoid,
      lineName: prev.lineName,
      direction: prev.direction,
      firstStopName: prev.firstStopName,
      lastStopName: prev.lastStopName,
      firstStopSymbol: prev.firstStopSymbol,
      lastStopSymbol: prev.lastStopSymbol,
      startTime: prev.startTime,
      endTime: prev.endTime,
      startSecs: prev.startSecs,
      endSecs: prev.endSecs,
      delaySec: prev.delaySec,
      stopsCount: prev.stopsCount,
      status: outcome.status,
      cancelledReason: outcome.cancelledReason,
      cancelledAtStopName: outcome.cancelledAtStopName,
      completedAt: nowEpoch,
      lengthMeters: prev.lengthMeters,
      drivenMeters: completed ? prev.lengthMeters : prev.drivenMeters,
      stops: completed
        ? prev.stops?.map((s) => ({ ...s, status: "passed" as const }))
        : prev.stops?.map((s, idx) => ({
            ...s,
            status:
              idx < prev.currentStopIndex
                ? ("passed" as const)
                : idx === prev.currentStopIndex
                  ? ("current" as const)
                  : ("upcoming" as const),
          })),
    };
    detail.todayCourses.push(record);
    detail.todayCourses.sort(sortCoursesDesc);
    return record;
  }

  /**
   * "Where next" once the current course ends — an ESTIMATE, labelled as such: OnTime does not
   * publish duty rosters. Assumes the usual shuttle (same line back from the terminus) after
   * the layover this vehicle showed today (or a typical one), never earlier than a short
   * turnaround after the expected (delayed) arrival. None for a course into the depot.
   */
  private predictNextCourse(detail: FleetVehicleDetail): PredictedNextCourse | null {
    const cur = detail.currentCourse;
    if (!cur || cur.stopsCount < 2 || !cur.endSecs) return null;
    if (foldText(cur.lastStopName).includes("zajezdnia")) return null;

    const chain = detail.todayCourses
      .filter((c) => c.status === "completed")
      .sort((a, b) => a.startSecs - b.startSecs);
    const gaps: number[] = [];
    for (let i = 0; i < chain.length; i++) {
      const next = chain[i + 1] ?? cur;
      const gap = next.startSecs - chain[i].endSecs;
      if (gap >= 0 && gap <= MAX_LAYOVER_SEC) gaps.push(gap);
    }
    const observed = median(gaps);
    const layoverMin = observed !== null ? Math.min(30, Math.max(3, Math.round(observed / 60))) : DEFAULT_LAYOVER_MIN;

    const prev = chain.at(-1);
    const shuttle =
      !!prev &&
      prev.lineName === cur.lineName &&
      foldText(prev.lastStopName) === foldText(cur.firstStopName) &&
      foldText(prev.firstStopName) === foldText(cur.lastStopName);

    const expectedArrival = cur.endSecs + Math.max(0, cur.notStarted ? 0 : cur.delaySec);
    const departureSecs = Math.max(cur.endSecs + layoverMin * 60, expectedArrival + MIN_LAYOVER_SEC);

    return {
      lineName: cur.lineName,
      direction: cur.firstStopName,
      departureTime: secsToHHMM(departureSecs),
      departureSecs,
      fromStopName: cur.lastStopName,
      fromStopSymbol: cur.lastStopSymbol,
      pauseMinutes: Math.round((departureSecs - expectedArrival) / 60),
      confidence: shuttle ? "medium" : "low",
      reason: shuttle
        ? `Pojazd kursuje dziś wahadłowo na linii ${cur.lineName}, postój na pętli ok. ${layoverMin} min.`
        : `MZK nie publikuje obiegów brygad. Zakładamy powrót tą samą linią po ok. ${layoverMin} min postoju.`,
    };
  }

  /** Per-vehicle day figures, served lines and main line — all from observed courses. */
  private recalculateStats(veh: FleetVehicleDetail): void {
    const cur = veh.currentCourse;
    const started = cur && !cur.notStarted ? cur : null;
    let completed = 0;
    let cancelled = 0;
    let meters = 0;
    const measured: number[] = [];
    for (const c of veh.todayCourses) {
      meters += courseDrivenMeters(c);
      if (c.status === "completed") {
        completed++;
        measured.push(c.delaySec);
      } else if (c.status === "cancelled") {
        cancelled++;
      }
    }
    if (started) {
      meters += started.drivenMeters ?? 0;
      measured.push(started.delaySec);
    }

    // lines in order of first service; the assigned (not yet begun) course counts as served
    const byStart = [...veh.todayCourses, ...(cur ? [cur] : [])].sort((a, b) => a.startSecs - b.startSecs);
    const lines: string[] = [];
    const counts = new Map<string, number>();
    const latest = new Map<string, number>();
    for (const c of byStart) {
      if (!counts.has(c.lineName)) lines.push(c.lineName);
      counts.set(c.lineName, (counts.get(c.lineName) ?? 0) + 1);
      latest.set(c.lineName, c.startSecs);
    }
    let mainLine: string | null = null;
    for (const l of lines) {
      if (
        mainLine === null ||
        counts.get(l)! > counts.get(mainLine)! ||
        (counts.get(l) === counts.get(mainLine) && latest.get(l)! > latest.get(mainLine)!)
      ) {
        mainLine = l;
      }
    }
    veh.lines = lines;
    veh.mainLine = mainLine;

    const onTime = measured.filter(isOnTime).length;
    veh.stats = {
      totalCoursesToday: veh.todayCourses.length + (started ? 1 : 0),
      completedCoursesToday: completed,
      cancelledCoursesToday: cancelled,
      kmToday: Math.round(meters / 100) / 10,
      measuredCourses: measured.length,
      averageDelaySecs: measured.length > 0 ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : 0,
      punctualityPct: measured.length > 0 ? Math.round((onTime / measured.length) * 100) : null,
    };
  }

  /** The running fleet by punctuality class, kept as the last sample of each 5-minute slot. */
  private sampleTimeline(nowMs: number): void {
    const secs = dateToAgencySecs(nowMs);
    const t = secs - (secs % TIMELINE_SLOT_SECS);
    const point: FleetTimelinePoint = { t, waiting: 0, early: 0, onTime: 0, late: 0, veryLate: 0 };
    for (const v of this.vehicles.values()) {
      if (v.status !== "active" || !v.currentCourse) continue;
      if (v.currentCourse.notStarted) point.waiting++;
      else point[classifyDelay(v.currentCourse.delaySec)]++;
    }
    this.timeline.set(t, point);
  }

  /**
   * Returns list of summary items for the fleet table / grid.
   */
  public getFleetSummary(filter?: {
    status?: "all" | "active" | "depot";
    propulsion?: string;
    line?: string;
    query?: string;
  }): FleetSummaryItem[] {
    const list: FleetSummaryItem[] = [];
    for (const v of this.vehicles.values()) {
      const item = this.summarize(v);
      if (filter?.status && filter.status !== "all" && v.status !== filter.status) continue;
      if (filter?.propulsion && filter.propulsion !== "all") {
        if (filter.propulsion === "electric" && !v.features.electric) continue;
        if (filter.propulsion === "hydrogen" && !v.features.hydrogen) continue;
        if (filter.propulsion === "hybrid" && !v.features.hybrid) continue;
        if (filter.propulsion === "mega" && v.lengthCategory !== "MEGA") continue;
      }
      if (filter?.line && filter.line !== "all" && item.lineName !== filter.line && !item.lines.includes(filter.line)) continue;
      if (filter?.query && !matchesFleetQuery(item, filter.query)) continue;
      list.push(item);
    }

    // running first (begun before waiting), then by line, then by side number
    const rank = (x: FleetSummaryItem) => (x.status !== "active" ? 2 : x.notStarted ? 1 : 0);
    list.sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      if (a.lineName && b.lineName && a.lineName !== b.lineName) return compareLineNames(a.lineName, b.lineName);
      return Number.parseInt(a.sideNumber, 10) - Number.parseInt(b.sideNumber, 10);
    });
    return list;
  }

  private summarize(v: FleetVehicleDetail): FleetSummaryItem {
    const cur = v.currentCourse;
    return {
      sideNumber: v.sideNumber,
      model: v.model,
      producer: v.producer,
      year: v.year,
      lengthCategory: v.lengthCategory,
      fuelType: v.fuelType,
      status: v.status,
      lines: v.lines,
      lineName: cur?.lineName,
      direction: cur?.direction,
      startTime: cur?.startTime,
      firstStopName: cur?.firstStopName,
      currentStopName: cur?.currentStopName,
      nextStopName: cur?.nextStopName ?? undefined,
      atStop: cur ? cur.atStop : undefined,
      delaySec: cur && !cur.notStarted ? cur.delaySec : undefined,
      notStarted: cur?.notStarted || undefined,
      progressPct: cur?.progressPct,
      coursesCountToday: v.stats.totalCoursesToday,
      cancelledCoursesToday: v.stats.cancelledCoursesToday,
      kmToday: v.stats.kmToday,
      lastSeenAt: v.lastSeenAt,
      lastLineName: cur ? undefined : v.todayCourses[0]?.lineName,
    };
  }

  /**
   * Returns full detail of a specific vehicle.
   */
  public getVehicleDetail(sideNumber: string): FleetVehicleDetail | null {
    const clean = sideNumber.replace(/^#/, "").trim();
    return this.vehicles.get(clean) ?? null;
  }

  /** Today's 5-minute punctuality snapshots of the running fleet, oldest first. */
  public getTimeline(): FleetTimelinePoint[] {
    return [...this.timeline.values()].sort((a, b) => a.t - b.t);
  }

  /**
   * Global overview statistics.
   */
  public getStats(): FleetStats {
    let active = 0;
    let waiting = 0;
    let electric = 0;
    let hydrogen = 0;
    let hybrid = 0;
    let mega = 0;
    let seenToday = 0;
    let km = 0;
    let completed = 0;
    let cancelled = 0;
    const delays: number[] = [];
    const lines = new Set<string>();

    for (const v of this.vehicles.values()) {
      if (v.status === "active") {
        active++;
        const cur = v.currentCourse;
        if (cur) {
          // waiting buses (course not begun) have no delay: out of the punctuality figures
          if (cur.notStarted) waiting++;
          else delays.push(cur.delaySec);
          if (cur.lineName) lines.add(cur.lineName);
        }
      }
      if (v.lastSeenAt > 0) seenToday++;
      km += v.stats.kmToday;
      completed += v.stats.completedCoursesToday;
      cancelled += v.stats.cancelledCoursesToday;
      if (v.features.electric) electric++;
      if (v.features.hydrogen) hydrogen++;
      if (v.features.hybrid) hybrid++;
      if (v.lengthCategory === "MEGA") mega++;
    }

    const med = median(delays);
    return {
      totalFleet: this.vehicles.size,
      activeCount: active,
      depotCount: this.vehicles.size - active,
      waitingCount: waiting,
      measuredCount: delays.length,
      electricCount: electric,
      hydrogenCount: hydrogen,
      hybridCount: hybrid,
      megaCount: mega,
      averageDelaySec: delays.length > 0 ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : 0,
      medianDelaySec: med === null ? null : Math.round(med),
      onTimePercentage: delays.length > 0 ? Math.round((delays.filter(isOnTime).length / delays.length) * 100) : 100,
      activeLines: [...lines].sort(compareLineNames),
      seenTodayCount: seenToday,
      kmToday: Math.round(km * 10) / 10,
      coursesCompletedToday: completed,
      coursesCancelledToday: cancelled,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Debounced write of the day's history (a day's file grows to a few MB: never on every poll).
   */
  private scheduleSave(): void {
    if (!this.historyDir || this.saveTimeout) return;
    const wait = Math.max(0, this.lastSaveAt + SAVE_DEBOUNCE_MS - Date.now());
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveHistoryToDisk();
    }, wait);
    // a pending save must never keep the process (or a test run) alive
    this.saveTimeout.unref?.();
  }

  /** Writes a pending debounced save now (graceful shutdown); a no-op when nothing is pending. */
  flushSync(): void {
    if (!this.saveTimeout) return;
    clearTimeout(this.saveTimeout);
    this.saveTimeout = null;
    this.saveHistoryToDisk();
  }

  private historyFile(day: string): string | null {
    return this.historyDir ? path.join(this.historyDir, `fleet-history-${day}.json`) : null;
  }

  private saveHistoryToDisk(): void {
    const filePath = this.historyFile(this.currentDay);
    if (!filePath) return;
    this.lastSaveAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload: Record<string, unknown> = { _v: HISTORY_FORMAT, _timeline: this.getTimeline() };
      for (const [side, v] of this.vehicles) {
        if (v.todayCourses.length === 0 && !v.currentCourse) continue;
        const saved: SavedVehicle = {
          todayCourses: v.todayCourses,
          currentCourse: v.status === "active" ? v.currentCourse : null,
          lastSeenAt: v.lastSeenAt,
          lastKnownLocation: v.lastKnownLocation,
        };
        payload[side] = saved;
      }
      // write-then-rename: a crash mid-write must not leave a torn file that loses the whole day
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf-8");
      fs.renameSync(tmp, filePath);
    } catch (err) {
      log.warn("fleet-tracker", `Failed saving history to disk: ${err}`);
    }
  }

  private loadHistoryFromDisk(): void {
    const filePath = this.historyFile(this.currentDay);
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      const nowEpoch = Math.floor(Date.now() / 1000);

      if (Array.isArray(data._timeline)) {
        for (const p of data._timeline as FleetTimelinePoint[]) {
          if (p && Number.isFinite(p.t)) this.timeline.set(p.t, p);
        }
      }

      for (const [side, raw] of Object.entries(data)) {
        if (side.startsWith("_") || !raw || typeof raw !== "object") continue;
        const saved = raw as SavedVehicle;
        const v = this.vehicles.get(side);
        if (!v) continue;
        if (Array.isArray(saved.todayCourses)) {
          v.todayCourses = saved.todayCourses
            // files written before 2026-10-04 carry invented "synth-*" courses (back-filled to 05:30): never real
            .filter((c) => c && typeof c.id === "string" && !c.id.startsWith("synth-"))
            .map(rejudgeCancelled)
            .map((c) => ({
              ...c,
              stops: c.status === "completed" && c.stops ? c.stops.map((s) => ({ ...s, status: "passed" as const })) : c.stops,
            }))
            .sort(sortCoursesDesc);
        }
        if (typeof saved.lastSeenAt === "number") v.lastSeenAt = saved.lastSeenAt;
        if (saved.lastKnownLocation) v.lastKnownLocation = saved.lastKnownLocation;
        // a course live at the last save resumes (the next poll continues or archives it) — unless that was long ago
        if (saved.currentCourse && nowEpoch - v.lastSeenAt <= RESUME_LIVE_MAX_AGE_SEC) {
          v.currentCourse = saved.currentCourse;
          v.status = "active";
        }
        this.recalculateStats(v);
        if (v.status === "active") v.predictedNextCourse = this.predictNextCourse(v);
      }
      log.info("fleet-tracker", `Restored fleet history from ${filePath}`);
    } catch (err) {
      log.warn("fleet-tracker", `Failed restoring history from disk: ${err}`);
    }
  }
}

// Global process-wide singleton
const TRACKER_KEY = Symbol.for("kb-gtfs.fleet-tracker");
type GlobalWithTracker = typeof globalThis & { [TRACKER_KEY]?: FleetTracker };

export function getFleetTracker(): FleetTracker {
  const g = globalThis as GlobalWithTracker;
  if (!g[TRACKER_KEY]) {
    g[TRACKER_KEY] = new FleetTracker();
  }
  return g[TRACKER_KEY];
}
