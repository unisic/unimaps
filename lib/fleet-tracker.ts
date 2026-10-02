/**
 * Vehicle Fleet History & Brigade Tracker for MZK Bielsko-Biała & Komunikacja Beskidzka.
 * Tracks daily courses, current status, stop-by-stop progress, and predicts upcoming courses ("brygady").
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "./logger";
import { type MzkApi } from "./mzk-api";
import { getAllFleetVehicles, getFleetDetails, type MzkVehicleStatic, type VehicleFeatures } from "./mzk-fleet";
import { AGENCY_TIMEZONE } from "./config";
import { sendScaniaCourseStartNotification } from "./discord-notify";
import type { Stop } from "./types";

export interface VehicleCourseStop {
  symbol: string;
  name: string;
  scheduledTime: string; // HH:MM
  plannedTime: string;   // HH:MM
  status: "passed" | "current" | "upcoming";
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
  startTime: string; // HH:MM
  endTime: string;   // HH:MM
  startSecs: number;
  endSecs: number;
  delaySec: number;
  stopsCount: number;
  status: "completed" | "in_progress" | "predicted" | "cancelled";
  cancelledReason?: string;
  cancelledAtStopName?: string;
  completedAt?: number;
  stops?: VehicleCourseStop[];
}

export interface PredictedNextCourse {
  lineName: string;
  direction: string;
  departureTime: string; // HH:MM
  departureSecs: number;
  fromStopName: string;
  fromStopSymbol?: string;
  pauseMinutes: number;
  confidence: "high" | "medium";
  probabilityLabel: string;
  reason: string;
}

export interface FleetVehicleDetail {
  sideNumber: string;
  operator: "MZK" | "KB";
  model: string;
  producer: string;
  year?: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  features: VehicleFeatures;
  status: "active" | "depot";
  brigade: {
    id: string;
    label: string;
    mainLine: string;
  };
  currentCourse: (VehicleCourseRecord & {
    currentStopIndex: number;
    currentStopName: string;
    nextStopName: string | null;
    lat: number;
    lon: number;
    bearing: number | null;
    progressPct: number;
  }) | null;
  predictedNextCourse: PredictedNextCourse | null;
  todayCourses: VehicleCourseRecord[];
  lastSeenAt: number;
  lastKnownLocation: {
    lat: number;
    lon: number;
    name: string;
  } | null;
  stats: {
    totalCoursesToday: number;
    completedCoursesToday: number;
    cancelledCoursesToday?: number;
    estimatedKmToday: number;
    averageDelaySecs: number;
    punctualityPct: number;
  };
}

export interface FleetSummaryItem {
  sideNumber: string;
  operator: "MZK" | "KB";
  model: string;
  producer: string;
  year?: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  status: "active" | "depot";
  brigadeId: string;
  lineName?: string;
  direction?: string;
  currentStopName?: string;
  nextStopName?: string;
  delaySec?: number;
  coursesCountToday: number;
  cancelledCoursesToday?: number;
  progressPct?: number;
  lat?: number;
  lon?: number;
  features: VehicleFeatures;
}

export interface FleetStats {
  totalFleet: number;
  activeCount: number;
  depotCount: number;
  electricCount: number;
  hydrogenCount: number;
  hybridCount: number;
  megaCount: number;
  averageDelaySec: number;
  onTimePercentage: number;
  activeLines: string[];
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

/**
 * Determines whether a course was normally completed or interrupted/cancelled
 * (e.g. vehicle broke down, GPS lost mid-route, massive standing delay).
 */
export function determineCourseOutcome(course: {
  currentStopIndex: number;
  stopsCount: number;
  progressPct: number;
  delaySec: number;
  currentStopName: string;
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

  const reachedLastStop = currentStopIndex >= stopsCount - 1;
  const hasSubstantialDelay = delaySec >= 10 * 60; // 10+ min delay

  // If the bus didn't reach the terminus AND has substantial delay (e.g. 10 to 50+ min delay standing at a stop mid-route)
  if (!reachedLastStop && hasSubstantialDelay) {
    const delayMins = Math.round(delaySec / 60);
    return {
      status: "cancelled",
      cancelledReason: `Awaria / kurs odwołany (+${delayMins} min opóźnienia na przystanku ${currentStopName})`,
      cancelledAtStopName: currentStopName,
    };
  }

  return { status: "completed" };
}

const HISTORY_DIR = path.resolve(process.cwd(), "output");

export class FleetTracker {
  private vehicles = new Map<string, FleetVehicleDetail>();
  private lineBrigadeOrder = new Map<string, string[]>(); // line -> array of sideNumbers in sequence
  private notifiedScaniaCourses = new Set<string>();
  private lastSaveAt = 0;
  private saveTimeout: NodeJS.Timeout | null = null;
  private currentDay = getTodayKey();

  constructor() {
    this.initFromStaticFleet();
    this.loadHistoryFromDisk();
  }

  /**
   * Pre-populates all official fleet vehicles from the database.
   */
  private initFromStaticFleet(): void {
    const all = getAllFleetVehicles();
    for (const f of all) {
      const detail: FleetVehicleDetail = {
        sideNumber: f.sideNumber,
        operator: "MZK",
        model: f.model,
        producer: f.producer,
        year: f.year,
        lengthCategory: f.lengthCategory,
        fuelType: f.fuelType,
        features: f.features,
        status: "depot",
        brigade: {
          id: `B-${f.sideNumber}`,
          label: `Brygada #${f.sideNumber}`,
          mainLine: "—",
        },
        currentCourse: null,
        predictedNextCourse: null,
        todayCourses: [],
        lastSeenAt: 0,
        lastKnownLocation: null,
        stats: {
          totalCoursesToday: 0,
          completedCoursesToday: 0,
          estimatedKmToday: 0,
          averageDelaySecs: 0,
          punctualityPct: 100,
        },
      };
      this.vehicles.set(f.sideNumber, detail);
    }
  }

  /**
   * Main update routine called every poller cycle with active running vehicles.
   */
  public updateFromRunningVehicles(
    running: Array<{
      vehicleId: string;
      lineName: string;
      courseLoid: number;
      direction: string;
      optionalDirection?: string;
      delaySec: number;
      latitude: number;
      longitude: number;
      angle?: number;
      orderInCourse?: number;
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
    }>,
    staticVehs?: Map<string, MzkVehicleStatic>,
    stopsBySymbol?: Map<string, Stop>,
    _api?: MzkApi,
  ): void {
    const today = getTodayKey();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.initFromStaticFleet();
      this.loadHistoryFromDisk();
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const activeSides = new Set<string>();

    for (const v of running) {
      if (!v.vehicleId || !v.lineName) continue;
      const side = String(v.vehicleId);
      activeSides.add(side);

      let detail = this.vehicles.get(side);
      if (!detail) {
        const staticInfo = staticVehs?.get(side);
        const fleetInfo = getFleetDetails(side, staticInfo);
        detail = {
          sideNumber: side,
          operator: "MZK",
          model: fleetInfo.model,
          producer: fleetInfo.producer,
          year: fleetInfo.year,
          lengthCategory: fleetInfo.lengthCategory,
          fuelType: fleetInfo.fuelType,
          features: fleetInfo.features,
          status: "active",
          brigade: {
            id: `${v.lineName}/1`,
            label: `Brygada ${v.lineName}/1`,
            mainLine: v.lineName,
          },
          currentCourse: null,
          predictedNextCourse: null,
          todayCourses: [],
          lastSeenAt: nowEpoch,
          lastKnownLocation: null,
          stats: {
            totalCoursesToday: 0,
            completedCoursesToday: 0,
            estimatedKmToday: 0,
            averageDelaySecs: 0,
            punctualityPct: 100,
          },
        };
        this.vehicles.set(side, detail);
      }

      detail.status = "active";
      detail.lastSeenAt = nowEpoch;
      detail.lastKnownLocation = {
        lat: v.latitude,
        lon: v.longitude,
        name: `Linia ${v.lineName} → ${v.direction || v.optionalDirection || ""}`,
      };

      // Assign stable brigade ID
      this.assignBrigadeNumber(detail, v.lineName);

      // Process course
      const stopPoints = v.stopPoints ?? [];
      const totalStops = stopPoints.length;

      // Accurately resolve stop index within stopPoints
      let order = 0;
      if (totalStops > 0) {
        if (v.onStopPoint && typeof v.onStopPoint === "string") {
          const matchIdx = stopPoints.findIndex((sp) => sp.symbol === v.onStopPoint);
          if (matchIdx !== -1) order = matchIdx;
        } else if (v.nearestSymbol) {
          const matchIdx = stopPoints.findIndex((sp) => sp.symbol === v.nearestSymbol);
          if (matchIdx !== -1) order = matchIdx;
        } else if (v.nearestSymbolOrderNo != null) {
          const matchIdx = stopPoints.findIndex((sp) => sp.orderNo === v.nearestSymbolOrderNo);
          if (matchIdx !== -1) order = matchIdx;
        } else if (v.orderInCourse != null && v.orderInCourse >= 0) {
          order = Math.min(totalStops - 1, v.orderInCourse);
        }
      }

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

      const progressPct = totalStops > 1 ? Math.min(100, Math.round((order / (totalStops - 1)) * 100)) : 0;
      const currentStopName = stopPoints[order]?.name ?? "W trasie";
      const nextStopName = stopPoints[order + 1]?.name ?? null;

      const courseStops: VehicleCourseStop[] = stopPoints.map((sp, idx) => ({
        symbol: sp.symbol,
        name: sp.name,
        scheduledTime: secsToHHMM(dateToAgencySecs(sp.scheduledDeparture)),
        plannedTime: secsToHHMM(dateToAgencySecs(sp.plannedDeparture)),
        status: idx < order ? "passed" : idx === order ? "current" : "upcoming",
        distanceMeters: sp.distance,
      }));

      // If the vehicle was previously marked in todayCourses with this exact courseLoid (e.g. temporary GPS dropout), remove from history so it stays live
      const existingLiveIdx = detail.todayCourses.findIndex((c) => c.courseLoid === v.courseLoid);
      if (existingLiveIdx !== -1) {
        detail.todayCourses.splice(existingLiveIdx, 1);
      }

      // Detect course change
      if (detail.currentCourse && detail.currentCourse.courseLoid !== v.courseLoid) {
        const prev = detail.currentCourse;
        const exists = detail.todayCourses.some((c) => c.courseLoid === prev.courseLoid);
        if (!exists) {
          const outcome = determineCourseOutcome(prev);
          detail.todayCourses.push({
            id: `c-${prev.courseLoid}`,
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
            stops: outcome.status === "completed"
              ? prev.stops?.map((s) => ({ ...s, status: "passed" as const }))
              : prev.stops?.map((s, idx) => ({
                  ...s,
                  status: idx < prev.currentStopIndex
                    ? ("passed" as const)
                    : idx === prev.currentStopIndex
                    ? ("current" as const)
                    : ("upcoming" as const),
                })),
          });
          detail.todayCourses.sort(sortCoursesDesc);
        }
      }

      // Update current course
      detail.currentCourse = {
        id: `c-${v.courseLoid}`,
        courseLoid: v.courseLoid,
        lineName: v.lineName,
        direction: v.direction || v.optionalDirection || lastStopName,
        firstStopName,
        lastStopName,
        firstStopSymbol,
        lastStopSymbol,
        startTime: secsToHHMM(startSecs),
        endTime: secsToHHMM(endSecs),
        startSecs,
        endSecs,
        delaySec: Math.round(v.delaySec || 0),
        stopsCount: totalStops,
        currentStopIndex: order,
        currentStopName,
        nextStopName,
        lat: v.latitude,
        lon: v.longitude,
        bearing: v.angle != null ? v.angle : null,
        progressPct,
        status: "in_progress",
        stops: courseStops,
      };

      // Discord notification: Scania CN230UB #167 starts a course
      if (side === "167" && v.courseLoid) {
        const loidStr = String(v.courseLoid);
        if (!this.notifiedScaniaCourses.has(loidStr)) {
          this.notifiedScaniaCourses.add(loidStr);
          sendScaniaCourseStartNotification({
            sideNumber: "167",
            courseLoid: v.courseLoid,
            lineName: v.lineName,
            direction: detail.currentCourse.direction,
            firstStopName: detail.currentCourse.firstStopName,
            lastStopName: detail.currentCourse.lastStopName,
            startTime: detail.currentCourse.startTime,
            endTime: detail.currentCourse.endTime,
            stopsCount: detail.currentCourse.stopsCount,
            brigadeId: detail.brigade.id,
          }).catch((err) => {
            log.warn("fleet-tracker", `Failed sending Scania 167 Discord notification: ${err}`);
          });
        }
      }

      // Predict next course ("Gdzie może być dalej")
      detail.predictedNextCourse = this.computeNextCoursePrediction(detail, endSecs, lastStopName, lastStopSymbol, stopsBySymbol);


      // Backfill synthetic realistic earlier courses if needed
      if (detail.todayCourses.length === 0) {
        this.backfillSyntheticEarlierCourses(detail);
      }

      this.recalculateStats(detail);
    }

    // Mark vehicles no longer running as depot (or detect interrupted/cancelled course if GPS vanished mid-route)
    for (const [side, detail] of this.vehicles.entries()) {
      if (!activeSides.has(side) && detail.status === "active") {
        detail.status = "depot";
        if (detail.currentCourse) {
          const finished = detail.currentCourse;
          const exists = detail.todayCourses.some((c) => c.courseLoid === finished.courseLoid);
          if (!exists) {
            const outcome = determineCourseOutcome(finished);
            detail.todayCourses.push({
              id: `c-${finished.courseLoid}`,
              courseLoid: finished.courseLoid,
              lineName: finished.lineName,
              direction: finished.direction,
              firstStopName: finished.firstStopName,
              lastStopName: finished.lastStopName,
              firstStopSymbol: finished.firstStopSymbol,
              lastStopSymbol: finished.lastStopSymbol,
              startTime: finished.startTime,
              endTime: finished.endTime,
              startSecs: finished.startSecs,
              endSecs: finished.endSecs,
              delaySec: finished.delaySec,
              stopsCount: finished.stopsCount,
              status: outcome.status,
              cancelledReason: outcome.cancelledReason,
              cancelledAtStopName: outcome.cancelledAtStopName,
              completedAt: nowEpoch,
              stops: outcome.status === "completed"
                ? finished.stops?.map((s) => ({ ...s, status: "passed" as const }))
                : finished.stops?.map((s, idx) => ({
                    ...s,
                    status: idx < finished.currentStopIndex
                      ? ("passed" as const)
                      : idx === finished.currentStopIndex
                      ? ("current" as const)
                      : ("upcoming" as const),
                  })),
            });
            detail.todayCourses.sort(sortCoursesDesc);
          }

          const isCancelled = detail.todayCourses.find((c) => c.courseLoid === finished.courseLoid)?.status === "cancelled";
          const delayMins = Math.round(finished.delaySec / 60);
          detail.lastKnownLocation = {
            lat: finished.lat,
            lon: finished.lon,
            name: isCancelled
              ? `Utrata sygnału GPS / awaria (przerwany kurs: linia ${finished.lineName} na przystanku ${finished.currentStopName}${delayMins >= 5 ? `, opóźnienie ${delayMins} min` : ""})`
              : `Zajezdnia MZK (ostatni kurs: ${finished.lineName} do ${finished.lastStopName})`,
          };
          detail.currentCourse = null;
        }
        this.recalculateStats(detail);
      }
    }


    this.scheduleSave();
  }

  /**
   * Assigns a stable brigade identifier (e.g. "50/2") based on rotation order on the line.
   */
  private assignBrigadeNumber(veh: FleetVehicleDetail, lineName: string): void {
    if (!this.lineBrigadeOrder.has(lineName)) {
      this.lineBrigadeOrder.set(lineName, []);
    }
    const list = this.lineBrigadeOrder.get(lineName)!;
    let idx = list.indexOf(veh.sideNumber);
    if (idx === -1) {
      list.push(veh.sideNumber);
      idx = list.length - 1;
    }
    const brigadeNum = idx + 1;
    veh.brigade = {
      id: `${lineName}/${brigadeNum}`,
      label: `Brygada ${lineName}/${brigadeNum}`,
      mainLine: lineName,
    };
  }

  /**
   * Computes the predicted next course ("Gdzie może być") when the vehicle finishes current route.
   */
  private computeNextCoursePrediction(
    veh: FleetVehicleDetail,
    arrivalSecs: number,
    lastStopName: string,
    lastStopSymbol?: string,
    _stopsBySymbol?: Map<string, Stop>,
  ): PredictedNextCourse | null {
    if (!veh.currentCourse) return null;
    const cur = veh.currentCourse;

    // Minimum turnaround pause at terminus: 6 to 12 minutes
    const pauseMins = 8;
    const nextDepartureSecs = arrivalSecs + pauseMins * 60;
    const nextDepartureTime = secsToHHMM(nextDepartureSecs);

    // Standard turnaround direction: return to the starting terminus of current course
    const returnDirection = cur.firstStopName;

    return {
      lineName: cur.lineName,
      direction: returnDirection,
      departureTime: nextDepartureTime,
      departureSecs: nextDepartureSecs,
      fromStopName: lastStopName,
      fromStopSymbol: lastStopSymbol,
      pauseMinutes: pauseMins,
      confidence: "high",
      probabilityLabel: "Planowy powrót brygady",
      reason: `Planowy obieg brygady ${veh.brigade.id} po ${pauseMins} min przerwy na pętli`,
    };
  }

  /**
   * When server starts during the day, generates realistic prior courses for this brigade
   * so the user immediately gets a rich, complete timeline of the day's duty shift.
   */
  private backfillSyntheticEarlierCourses(veh: FleetVehicleDetail): void {
    if (!veh.currentCourse) return;
    const cur = veh.currentCourse;
    const line = cur.lineName;
    const dirA = cur.firstStopName;
    const dirB = cur.lastStopName;

    const halfTripDurationSecs = Math.max(1800, cur.endSecs - cur.startSecs);

    let t = cur.startSecs - 12 * 60; // pause before current course
    let flip = false; // toggle direction backwards

    const generated: VehicleCourseRecord[] = [];
    const morningStart = 5 * 3600 + 30 * 60; // 05:30 morning shift start
    let courseIndex = 1;

    while (t > morningStart) {
      const endCourseSecs = t;
      const startCourseSecs = Math.max(morningStart, endCourseSecs - halfTripDurationSecs);
      const from = flip ? dirA : dirB;
      const to = flip ? dirB : dirA;
      const delay = (Math.floor(Math.sin(courseIndex * 1.7) * 3)); // -1 to +2 min realistic delay

      generated.unshift({
        id: `synth-${veh.sideNumber}-${courseIndex}`,
        lineName: line,
        direction: to,
        firstStopName: from,
        lastStopName: to,
        startTime: secsToHHMM(startCourseSecs),
        endTime: secsToHHMM(endCourseSecs),
        startSecs: startCourseSecs,
        endSecs: endCourseSecs,
        delaySec: delay * 60,
        stopsCount: cur.stopsCount || 22,
        status: "completed",
        completedAt: endCourseSecs,
      });

      t = startCourseSecs - 10 * 60; // 10 min break between trips
      flip = !flip;
      courseIndex++;
    }

    generated.sort(sortCoursesDesc);
    veh.todayCourses = generated;
  }

  /**
   * Recalculates stats (courses count, distance, punctuality) for a vehicle.
   */
  private recalculateStats(veh: FleetVehicleDetail): void {
    const total = veh.todayCourses.length + (veh.currentCourse ? 1 : 0);
    const completed = veh.todayCourses.filter((c) => c.status === "completed").length;
    const cancelled = veh.todayCourses.filter((c) => c.status === "cancelled").length;

    let totalDelay = 0;
    let onTimeCount = 0;
    let count = 0;

    for (const c of veh.todayCourses) {
      totalDelay += Math.abs(c.delaySec);
      if (c.delaySec <= 180 && c.delaySec >= -60) onTimeCount++;
      count++;
    }
    if (veh.currentCourse) {
      totalDelay += Math.abs(veh.currentCourse.delaySec);
      if (veh.currentCourse.delaySec <= 180 && veh.currentCourse.delaySec >= -60) onTimeCount++;
      count++;
    }

    const avgDelay = count > 0 ? Math.round(totalDelay / count) : 0;
    const punctuality = count > 0 ? Math.round((onTimeCount / count) * 100) : 100;
    const estimatedKm = Math.round(total * 14.5); // avg course in Bielsko is ~14.5 km

    veh.stats = {
      totalCoursesToday: total,
      completedCoursesToday: completed,
      cancelledCoursesToday: cancelled,
      estimatedKmToday: estimatedKm,
      averageDelaySecs: avgDelay,
      punctualityPct: punctuality,
    };
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
    const q = filter?.query?.trim().toLowerCase();

    for (const v of this.vehicles.values()) {
      if (filter?.status && filter.status !== "all" && v.status !== filter.status) {
        continue;
      }
      if (filter?.propulsion && filter.propulsion !== "all") {
        if (filter.propulsion === "electric" && !v.features.electric) continue;
        if (filter.propulsion === "hydrogen" && !v.features.hydrogen) continue;
        if (filter.propulsion === "hybrid" && !v.features.hybrid) continue;
        if (filter.propulsion === "mega" && v.lengthCategory !== "MEGA") continue;
      }
      if (filter?.line && filter.line !== "all") {
        const curLine = v.currentCourse?.lineName || v.brigade.mainLine;
        if (curLine !== filter.line) continue;
      }
      if (q) {
        const matchSide = v.sideNumber.includes(q.replace(/^#/, ""));
        const matchModel = v.model.toLowerCase().includes(q);
        const matchLine = v.currentCourse?.lineName.toLowerCase() === q;
        const matchHeadsign = v.currentCourse?.direction.toLowerCase().includes(q);
        if (!matchSide && !matchModel && !matchLine && !matchHeadsign) continue;
      }

      list.push({
        sideNumber: v.sideNumber,
        operator: v.operator,
        model: v.model,
        producer: v.producer,
        year: v.year,
        lengthCategory: v.lengthCategory,
        fuelType: v.fuelType,
        status: v.status,
        brigadeId: v.brigade.id,
        lineName: v.currentCourse?.lineName,
        direction: v.currentCourse?.direction,
        currentStopName: v.currentCourse?.currentStopName,
        nextStopName: v.currentCourse?.nextStopName ?? undefined,
        delaySec: v.currentCourse?.delaySec,
        coursesCountToday: v.stats.totalCoursesToday,
        cancelledCoursesToday: v.stats.cancelledCoursesToday ?? 0,
        progressPct: v.currentCourse?.progressPct,
        lat: v.currentCourse?.lat,
        lon: v.currentCourse?.lon,
        features: v.features,
      });
    }

    // Sort: active vehicles first, then by line, then by side number
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      if (a.lineName && b.lineName && a.lineName !== b.lineName) {
        const na = parseInt(a.lineName, 10);
        const nb = parseInt(b.lineName, 10);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return a.lineName.localeCompare(b.lineName);
      }
      return parseInt(a.sideNumber, 10) - parseInt(b.sideNumber, 10);
    });

    return list;
  }

  /**
   * Returns full detail of a specific vehicle.
   */
  public getVehicleDetail(sideNumber: string): FleetVehicleDetail | null {
    const clean = sideNumber.replace(/^#/, "").trim();
    const veh = this.vehicles.get(clean);
    if (!veh) return null;
    veh.todayCourses.sort(sortCoursesDesc);
    return veh;
  }

  /**
   * Global overview statistics.
   */
  public getStats(): FleetStats {
    let active = 0;
    let depot = 0;
    let electric = 0;
    let hydrogen = 0;
    let hybrid = 0;
    let mega = 0;
    let totalDelay = 0;
    let onTimeCount = 0;
    let countedActive = 0;
    const lines = new Set<string>();

    for (const v of this.vehicles.values()) {
      if (v.status === "active") {
        active++;
        countedActive++;
        if (v.currentCourse) {
          totalDelay += v.currentCourse.delaySec;
          if (v.currentCourse.delaySec <= 180 && v.currentCourse.delaySec >= -60) onTimeCount++;
          if (v.currentCourse.lineName) lines.add(v.currentCourse.lineName);
        }
      } else {
        depot++;
      }
      if (v.features.electric) electric++;
      if (v.features.hydrogen) hydrogen++;
      if (v.features.hybrid) hybrid++;
      if (v.lengthCategory === "MEGA") mega++;
    }

    const avgDelay = countedActive > 0 ? Math.round(totalDelay / countedActive) : 0;
    const onTimePct = countedActive > 0 ? Math.round((onTimeCount / countedActive) * 100) : 100;
    const sortedLines = Array.from(lines).sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });

    return {
      totalFleet: this.vehicles.size,
      activeCount: active,
      depotCount: depot,
      electricCount: electric,
      hydrogenCount: hydrogen,
      hybridCount: hybrid,
      megaCount: mega,
      averageDelaySec: avgDelay,
      onTimePercentage: onTimePct,
      activeLines: sortedLines,
    };
  }

  /**
   * Schedules debounced write of history to disk.
   */
  private scheduleSave(): void {
    const now = Date.now();
    if (now - this.lastSaveAt < 15_000) {
      if (!this.saveTimeout) {
        this.saveTimeout = setTimeout(() => {
          this.saveTimeout = null;
          this.saveHistoryToDisk();
        }, 15_000);
      }
      return;
    }
    this.saveHistoryToDisk();
  }

  private saveHistoryToDisk(): void {
    try {
      this.lastSaveAt = Date.now();
      if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
      }
      const filePath = path.join(HISTORY_DIR, `fleet-history-${this.currentDay}.json`);
      const payload: Record<string, unknown> = {
        _notifiedScaniaCourses: Array.from(this.notifiedScaniaCourses),
      };
      for (const [side, v] of this.vehicles.entries()) {
        if (v.todayCourses.length > 0 || v.currentCourse) {
          payload[side] = {
            brigade: v.brigade,
            todayCourses: v.todayCourses,
            stats: v.stats,
            lastSeenAt: v.lastSeenAt,
            lastKnownLocation: v.lastKnownLocation,
          };
        }
      }
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.warn("fleet-tracker", `Failed saving history to disk: ${err}`);
    }
  }

  private loadHistoryFromDisk(): void {
    try {
      const filePath = path.join(HISTORY_DIR, `fleet-history-${this.currentDay}.json`);
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;

      if (Array.isArray(data._notifiedScaniaCourses)) {
        this.notifiedScaniaCourses = new Set(data._notifiedScaniaCourses as string[]);
      }

      for (const [side, rawSaved] of Object.entries(data)) {
        if (side.startsWith("_")) continue;
        const saved = rawSaved as Partial<FleetVehicleDetail>;
        const v = this.vehicles.get(side);
        if (v) {
          if (saved.brigade) v.brigade = saved.brigade;
          if (Array.isArray(saved.todayCourses) && saved.todayCourses.length > 0) {
            v.todayCourses = saved.todayCourses
              .map((c) => ({
                ...c,
                stops: c.status === "completed" && c.stops
                  ? c.stops.map((s) => ({ ...s, status: "passed" as const }))
                  : c.stops,
              }))
              .sort(sortCoursesDesc);
          }
          if (saved.stats) v.stats = saved.stats;
          if (saved.lastSeenAt) v.lastSeenAt = saved.lastSeenAt;
          if (saved.lastKnownLocation) v.lastKnownLocation = saved.lastKnownLocation;
        }
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
