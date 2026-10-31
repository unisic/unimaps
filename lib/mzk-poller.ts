/**
 * Background poller for MZK Bielsko-Biała live fleet and stops.
 */
import { bearing, metersBetween } from "./geo";
import * as config from "./config";
import { log } from "./logger";
import { MzkApi, type MzkRunningVehicle, type MzkStopPoint, type MzkLine } from "./mzk-api";
import { getFleetDetails, type MzkVehicleStatic } from "./mzk-fleet";
import { getFleetTracker } from "./fleet-tracker";
import { STATION_NAME_RE } from "./merged-stops";
import { hasPlannedDip, isMzkNotStarted } from "./mzk-state";
import { mzkRemapDist, mzkStopIndices } from "./mzk-shape";
import { interruptibleSleep } from "./poller";
import { nextSpeed, schedSpeed } from "./route-info";
import { loadMzkStopDirs, MzkStopDirs, saveMzkStopDirs } from "./mzk-stop-dirs";
import type { ShapeGeometry } from "./shape-store";
import type { LineInfo, Stop, VehiclePos } from "./types";

/** What the MZK poller needs from the shape store. */
export interface MzkShapeSink {
  touchMzk(variantId: number, prio?: "urgent" | "background"): void;
  geometry(key: string): ShapeGeometry | null;
}

/**
 * Converts OnTime Cartesian angle (-180..180 or 0..360, counter-clockwise from East)
 * to standard navigation compass bearing (0..360, clockwise from North).
 */
export function mzkAngleToCompassBearing(angle: number): number {
  const b = (90 - angle) % 360;
  return b < 0 ? b + 360 : b;
}

/** courseLoids are per-day instances: without a cap every day's courses (and every ?date= a client asks for) stay forever */
const COURSE_META_MAX = 20_000;

/** MZK positions are swapped wholesale on every successful 5 s poll; older than this = the OnTime feed is failing. */
export const MZK_STALE_SEC = 60;

export class MzkPoller {
  readonly api: MzkApi;
  readonly refreshIntervalMs: number;

  positions = new Map<string, VehiclePos>();
  lastPositionsByVehicle = new Map<string, VehiclePos>();
  runningVehiclesMap = new Map<string, MzkRunningVehicle>();
  stops: Stop[] = [];
  stopsBySymbol = new Map<string, Stop>();
  /** epoch secs of the last successful getStops load (0 = never) */
  stopsLoadedAt = 0;
  /** when a reload was last ATTEMPTED (success or not) — throttles the unknown-symbol trigger */
  private stopsReloadAttemptAt = 0;
  private stopsReloadInFlight = false;
  /** unknown symbols that the last reload attempt already tried to resolve — only NEW ones trigger the next one */
  private unknownHandled = new Set<string>();
  /** travel direction of every stop, learned from running courses (lib/stop-merge.ts needs it) */
  stopDirs = new MzkStopDirs();
  private stopDirsSavedAt = 0;
  private stopDirsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  lines: LineInfo[] = [];
  staticVehicles = new Map<string, MzkVehicleStatic>();
  /** courseLoid -> line/variant/direction for trip resolution; insertion-ordered, capped by noteCourse() */
  readonly courseMetaMap = new Map<number, { lineName: string; variantId?: number; direction?: string }>();

  lastScan = 0;
  scanCount = 0;
  startedAt = 0;
  lastGoodRefresh = Math.floor(Date.now() / 1000);

  /** road-shape store hook (null = no route info on positions) */
  shapes: MzkShapeSink | null = null;

  /** courseLoid -> last time a non-monotone OnTime estimate was logged (throttle) */
  private dipLoggedAt = new Map<number, number>();
  private started = false;
  private stopCtl: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private routeErrLoggedAt = 0;

  constructor(api?: MzkApi, refreshIntervalMs = 5000) {
    this.api = api ?? new MzkApi();
    this.refreshIntervalMs = refreshIntervalMs;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAt = Math.floor(Date.now() / 1000);
    this.stopCtl = new AbortController();

    this.stopDirs = loadMzkStopDirs(config.MZK_STOP_DIRS_FILE);

    // Initial load of static metadata
    try {
      await Promise.all([this.loadStops(), this.loadLines(), this.loadStaticVehicles()]);
      log.info("mzk-poller", `Loaded ${this.stops.length} stops and ${this.lines.length} lines`);
    } catch (err) {
      log.warn("mzk-poller", `Initial static load failed: ${err}`);
    }

    // Initial running vehicles scan
    try {
      await this.pollOnce();
    } catch (err) {
      log.warn("mzk-poller", `Initial vehicles poll failed: ${err}`);
    }

    // Start background loop
    this.loopPromise = this.runLoop(this.stopCtl.signal);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.flushStopDirs();
    this.stopCtl?.abort();
    try {
      await this.loopPromise;
    } catch {
      /* ignore */
    }
  }

  /**
   * Fetch the stop list and swap it in atomically. An empty or failed fetch keeps the previous
   * list (a transient upstream hiccup must not wipe a good one). Returns true when a list was installed.
   */
  async loadStops(): Promise<boolean> {
    const rawStops = await this.api.fetchStops();
    if (rawStops.length === 0) {
      log.error("mzk-poller", "stops reload: upstream returned an empty list, keeping previous");
      return false;
    }
    const stops: Stop[] = rawStops.map((s: MzkStopPoint) => {
      const isStation = STATION_NAME_RE.test(s.name);
      return {
        urlId: `mzk:${s.symbol}`,
        internalId: s.id,
        name: s.name,
        lon: s.longitude,
        lat: s.latitude,
        onlyDisembarking: s.gettingOut,
        isStation,
        showPlatforms: false,
        stopId: `mzk:${s.symbol}`,
        operator: "MZK",
        symbol: s.symbol,
        onRequest: s.onRequest,
        gettingOut: s.gettingOut,
      };
    });
    const bySymbol = new Map<string, Stop>();
    for (const s of stops) if (s.symbol) bySymbol.set(s.symbol, s);
    const prev = this.stops.length;
    // two synchronous assignments, no await in between
    this.stops = stops;
    this.stopsBySymbol = bySymbol;
    this.stopsLoadedAt = Date.now() / 1000;
    if (prev > 0) log.info("mzk-poller", `stops reloaded: ${stops.length} (was ${prev})`);
    // upstream re-versioned its stop data (a stop moved / vanished): what was learned about it is void
    if (this.stopDirs.reconcile(bySymbol)) log.warn("mzk-poller", "stop data changed, learned stop directions reset");
    return true;
  }

  /**
   * Re-load the stop list when it is a day old, or (at most every 10 min) as soon as a running course
   * references a stop symbol we did not already try to resolve — the sign that upstream re-versioned its
   * stop data while we were up (all 530 stops got stopPointValidity.from = 2026-09-30; this class never
   * reloaded). A symbol that stays unknown after a reload does not trigger another one. Never throws,
   * never overlaps.
   */
  private async maybeReloadStops(unknownSymbols: ReadonlySet<string>): Promise<void> {
    if (this.stopsReloadInFlight) return;
    const nowMs = Date.now();
    const age = nowMs / 1000 - this.stopsLoadedAt;
    const due = age >= config.STOPS_RELOAD_SEC;
    let fresh = 0;
    for (const sym of unknownSymbols) if (!this.unknownHandled.has(sym)) fresh++;
    const stale = fresh > 0 && nowMs - this.stopsReloadAttemptAt >= 10 * 60_000;
    if (!due && !stale) return;
    this.stopsReloadInFlight = true;
    this.stopsReloadAttemptAt = nowMs;
    this.unknownHandled = new Set(unknownSymbols);
    try {
      if (stale) log.warn("mzk-poller", `unknown stop symbols on running courses (${[...unknownSymbols].slice(0, 5).join(",")}), reloading stops`);
      if (await this.loadStops()) {
        // lines and fleet change with the timetable too; a failure keeps the old ones until the next day
        if (due) await Promise.all([this.loadLines(), this.loadStaticVehicles()]).catch((err) => log.warn("mzk-poller", `lines/vehicles reload failed: ${err}`));
        return;
      }
    } catch (err) {
      log.warn("mzk-poller", `stops reload failed: ${err}`);
    } finally {
      this.stopsReloadInFlight = false;
    }
    // failed or empty: keep the old list, forget what was tried; a due reload is retried in 30 min, not every 5 s
    this.unknownHandled.clear();
    if (due) this.stopsLoadedAt = nowMs / 1000 - config.STOPS_RELOAD_SEC + 1800;
  }

  async loadLines(): Promise<void> {
    const rawLines = await this.api.fetchLines();
    if (rawLines.length === 0) return; // keep the previous lines, retried while they are empty
    this.lines = rawLines.map((l: MzkLine) => ({
      id: `mzk:${l.id}`,
      name: l.name,
      terminus: l.longName || "",
      operator: "MZK",
    }));
  }

  async loadStaticVehicles(): Promise<void> {
    const rawVehs = await this.api.fetchVehicles();
    if (rawVehs.length === 0) return; // keep the previous fleet, retried while it is empty
    const next = new Map<string, MzkVehicleStatic>();
    for (const v of rawVehs) next.set(v.sideNumber, v);
    this.staticVehicles = next;
  }

  /** Remember a course's metadata; a re-noted course moves to the young end, the oldest is evicted past COURSE_META_MAX. */
  noteCourse(courseId: number, meta: { lineName: string; variantId?: number; direction?: string }): void {
    this.courseMetaMap.delete(courseId);
    this.courseMetaMap.set(courseId, meta);
    if (this.courseMetaMap.size > COURSE_META_MAX) {
      const oldest = this.courseMetaMap.keys().next().value;
      if (oldest !== undefined) this.courseMetaMap.delete(oldest);
    }
  }

  /** Write a pending trailing save now (shutdown). */
  flushStopDirs(): void {
    if (!this.stopDirsSaveTimer) return;
    clearTimeout(this.stopDirsSaveTimer);
    this.stopDirsSaveTimer = null;
    this.stopDirsSavedAt = Date.now();
    saveMzkStopDirs(config.MZK_STOP_DIRS_FILE, this.stopDirs);
  }

  /** Persist what was learned: at once when the last save is a minute old, else one trailing save (never throws). */
  private persistStopDirs(): void {
    const save = (): void => {
      this.stopDirsSaveTimer = null;
      this.stopDirsSavedAt = Date.now();
      saveMzkStopDirs(config.MZK_STOP_DIRS_FILE, this.stopDirs);
    };
    const wait = 60_000 - (Date.now() - this.stopDirsSavedAt);
    if (wait <= 0) save();
    else if (!this.stopDirsSaveTimer) {
      this.stopDirsSaveTimer = setTimeout(save, wait);
      this.stopDirsSaveTimer.unref?.();
    }
  }

  /** Feed the direction learner and spot symbols missing from the stop list (never throws). */
  private learnFromRunning(running: readonly MzkRunningVehicle[]): void {
    try {
      const unknown = new Set<string>();
      let learned = false;
      for (const v of running) {
        const sp = Array.isArray(v.stopPoints) ? v.stopPoints : [];
        const stops = sp.map((p) => {
          const st = this.stopsBySymbol.get(p.symbol);
          if (!st && p.symbol && p.symbol !== "00") unknown.add(p.symbol); // "00" = depot, never a real stop
          return { symbol: p.symbol, at: st ? { lat: st.lat, lon: st.lon } : null };
        });
        if (typeof v.variantLoid === "number" && this.stopDirs.learn(v.variantLoid, stops)) learned = true;
      }
      if (learned) this.persistStopDirs();
      if (this.stops.length > 0) void this.maybeReloadStops(unknown);
    } catch (err) {
      log.warn("mzk-poller", `learning stop directions failed: ${err}`);
    }
  }

  async pollOnce(): Promise<void> {
    // each missing piece on its own: a failed getVehicles must not wait for stops/lines to be missing too
    const loads: Promise<unknown>[] = [];
    if (this.stops.length === 0) loads.push(this.loadStops());
    if (this.lines.length === 0) loads.push(this.loadLines());
    if (this.staticVehicles.size === 0) loads.push(this.loadStaticVehicles());
    for (const r of await Promise.allSettled(loads)) {
      if (r.status === "rejected") log.warn("mzk-poller", `Reload static metadata failed: ${r.reason}`);
    }

    const running = await this.api.fetchRunningVehicles();
    const nowSecs = Math.floor(Date.now() / 1000);
    this.learnFromRunning(running);
    const newPositions = new Map<string, VehiclePos>();
    const newRunningMap = new Map<string, MzkRunningVehicle>();
    const touchedVariants = new Set<number>();

    for (const v of running) {
      if (!v.longitude || !v.latitude || !v.vehicleId) continue;
      // Filter out invalid GPS coordinates outside service bbox
      if (v.latitude < 48.8 || v.latitude > 50.5 || v.longitude < 18.0 || v.longitude > 20.5) {
        continue;
      }

      if (v.courseLoid) {
        this.noteCourse(v.courseLoid, {
          lineName: v.lineName,
          variantId: v.variantLoid,
          direction: v.direction || v.optionalDirection || "",
        });
      }

      const execId = `mzk:${v.courseLoid}:${v.vehicleId}`;
      const staticInfo = this.staticVehicles.get(v.vehicleId);
      const fleet = getFleetDetails(v.vehicleId, staticInfo);

      // Look up previous vehicle position (by execId or vehicleId across course changes)
      const prev = this.positions.get(execId) || this.lastPositionsByVehicle.get(v.vehicleId);

      // Next stop name and coordinates from current vehicle or stopPoints
      let nextStopName: string | null = null;
      let nextStopLat: number | null = null;
      let nextStopLon: number | null = null;

      // the stop being served / the next one to arrive at (stopPoints[orderInCourse]
      // is usually the stop just passed, so it must not be used as "next")
      const { served, next } = mzkStopIndices(v);
      // course not begun: OnTime's delaySec / plannedDeparture are a placeholder
      // (now - scheduled start, floor -60 s), not a delay — publish "unknown"
      const firstSym = v.stopPoints?.[0]?.symbol;
      const firstStop = firstSym ? this.stopsBySymbol.get(firstSym) : undefined;
      const notStarted = isMzkNotStarted(v, firstStop ? { lat: firstStop.lat, lon: firstStop.lon } : null);
      let targetSymbol: string | null = null;
      if (next !== null && v.stopPoints?.[next]) {
        targetSymbol = v.stopPoints[next].symbol;
        nextStopName = v.stopPoints[next].name;
      } else if (v.nearestSymbol) {
        targetSymbol = v.nearestSymbol;
      }

      if (targetSymbol) {
        const matched = this.stopsBySymbol.get(targetSymbol);
        if (matched) {
          if (!nextStopName) nextStopName = matched.name;
          nextStopLat = matched.lat;
          nextStopLon = matched.lon;
        }
      }

      let computedBearing: number | null = null;

      // 1. Movement-based bearing from real GPS displacement between poll intervals (ground truth)
      if (prev) {
        const stepDist = metersBetween(prev.lat, prev.lon, v.latitude, v.longitude);
        if (stepDist >= 8) {
          const moveBrg = bearing(prev.lat, prev.lon, v.latitude, v.longitude);
          if (moveBrg !== null) {
            computedBearing = moveBrg;
          }
        } else if (prev.bearing !== null) {
          // Bus is stopped (at a bus stop, traffic light, or junction); retain previous heading so arrow stays forward
          computedBearing = prev.bearing;
        }
      }

      // 2. If no movement bearing available, use OnTime telemetry angle (converted from Cartesian to Compass)
      if (computedBearing === null) {
        if (v.angle != null && Number.isFinite(v.angle) && v.angle !== 0) {
          computedBearing = mzkAngleToCompassBearing(v.angle);
        } else {
          // 3. Fallback when vehicle is stationary at terminus (angle == 0 or null, orderInCourse == 0)
          // Compute forward bearing along the route towards the next stop point
          if (nextStopLat !== null && nextStopLon !== null) {
            const distToNext = metersBetween(v.latitude, v.longitude, nextStopLat, nextStopLon);
            if (distToNext >= 15) {
              computedBearing = bearing(v.latitude, v.longitude, nextStopLat, nextStopLon);
            }
          }
          // If still null, try subsequent stop points from stopPoints list
          if (computedBearing === null && v.stopPoints && v.stopPoints.length >= 2) {
            const o = v.orderInCourse != null && v.orderInCourse >= 0 ? v.orderInCourse : 0;
            const curStop = v.stopPoints[o];
            const nextStop = v.stopPoints[o + 1] || v.stopPoints[1];
            if (curStop && nextStop) {
              const s1 = this.stopsBySymbol.get(curStop.symbol);
              const s2 = this.stopsBySymbol.get(nextStop.symbol);
              if (s1 && s2) {
                computedBearing = bearing(s1.lat, s1.lon, s2.lat, s2.lon);
              }
            }
          }
          // Ultimate fallback if angle is exactly 0 and no route stops matched
          if (computedBearing === null && v.angle != null && Number.isFinite(v.angle)) {
            computedBearing = mzkAngleToCompassBearing(v.angle);
          }
        }
      }

      const pos: VehiclePos = {
        execId,
        tripId: String(v.courseLoid),
        routeId: v.lineName,
        line: v.lineName,
        headsign: v.direction || v.optionalDirection || "",
        lat: v.latitude,
        lon: v.longitude,
        vehicleType: 3,
        currentStopSequence: served ?? (v.orderInCourse != null ? v.orderInCourse : null),
        atStop: Boolean(v.onStopPoint),
        delay: !notStarted && v.delaySec != null && Number.isFinite(v.delaySec) ? Math.round(v.delaySec) : null,
        timestamp: v.lastPingDate ? Math.floor(v.lastPingDate / 1000) : nowSecs,
        updatedAt: Date.now() / 1000,
        bearing: computedBearing !== null ? Math.round(computedBearing * 10) / 10 : null,
        nextStopName,
        nextStopLat,
        nextStopLon,
        lastMovedAt: nowSecs,
        anchorLat: v.latitude,
        anchorLon: v.longitude,
        finished: false,
        notStarted,
        operator: "MZK",
        sideNumber: v.vehicleId,
        model: fleet.model,
        features: fleet.features,
        nextStopSeq: next,
      };
      this.attachRouteInfo(pos, v, this.positions.get(execId), nowSecs, touchedVariants);
      this.noteEstimateDip(v);

      newPositions.set(execId, pos);
      this.lastPositionsByVehicle.set(v.vehicleId, pos);
      newRunningMap.set(execId, v);
      newRunningMap.set(String(v.courseLoid), v);
    }

    this.positions = newPositions;
    this.runningVehiclesMap = newRunningMap;
    this.lastScan = nowSecs;
    this.scanCount++;
    this.lastGoodRefresh = nowSecs;

    try {
      getFleetTracker().updateFromRunningVehicles(
        running,
        this.staticVehicles,
        this.stopsBySymbol,
        this.api,
      );
    } catch (err) {
      log.warn("mzk-poller", `FleetTracker update failed: ${err}`);
    }
  }

  /**
   * OnTime estimates that go backwards along the course (a later stop earlier than the previous
   * one) were seen by users but never reproduced in a capture: log each course once per 10 min
   * with the raw per-stop diffs so the next occurrence can be diagnosed from the server log.
   */
  private noteEstimateDip(v: MzkRunningVehicle): void {
    try {
      const sp = Array.isArray(v.stopPoints) ? v.stopPoints : [];
      if (!hasPlannedDip(sp.map((p) => p?.plannedDeparture), v.orderInCourse ?? 0)) return;
      const now = Date.now();
      if (now - (this.dipLoggedAt.get(v.courseLoid) ?? 0) < 600_000) return;
      if (this.dipLoggedAt.size > 500) this.dipLoggedAt.clear();
      this.dipLoggedAt.set(v.courseLoid, now);
      const diffs = sp.map((p) => (p?.plannedDeparture ? Math.round((p.plannedDeparture - p.scheduledDeparture) / 1000) : null));
      log.warn(
        "mzk-poller",
        `non-monotone planned times: course ${v.courseLoid} line ${v.lineName} veh ${v.vehicleId} ord ${v.orderInCourse} lastStopOrderNo ${v.lastStopOrderNo} onStop ${v.onStopPoint} delaySec ${v.delaySec} diffs(s) ${JSON.stringify(diffs)}`,
      );
    } catch {
      /* diagnostics must never break a poll */
    }
  }

  /**
   * Shape key, along-route distance (operator reachedMeters remapped onto our
   * polyline metric), real fix time and cruise speed. Isolated per vehicle so
   * a bug here can never freeze the whole fleet.
   */
  private attachRouteInfo(
    pos: VehiclePos,
    v: MzkRunningVehicle,
    prev: VehiclePos | undefined,
    nowSecs: number,
    touched: Set<number>,
  ): void {
    try {
      // the raw ping time (MZK server clock): clamping it to our "now" would make
      // one ping look like two distinct fixes once the clamp lifts — the client
      // maps it onto its own clock and clamps future fixes there instead
      pos.fixAt = v.lastPingDate ? v.lastPingDate / 1000 : nowSecs;
      const variant = typeof v.variantLoid === "number" && v.variantLoid > 0 ? v.variantLoid : null;
      pos.shapeKey = variant !== null ? `mzk:${variant}` : null;
      const shapes = this.shapes;
      if (shapes && variant !== null) {
        if (!touched.has(variant)) {
          touched.add(variant);
          shapes.touchMzk(variant);
        }
        const geom = shapes.geometry(`mzk:${variant}`);
        const sp = Array.isArray(v.stopPoints) ? v.stopPoints : [];
        // the variant's stops must line up with this course's stopPoints (stop
        // indices on the wire refer to the latter) — otherwise ship no shape
        if (geom && geom.stops.length !== sp.length) pos.shapeKey = null;
        else if (geom && Number.isFinite(v.reachedMeters)) {
          const d = mzkRemapDist(
            v.reachedMeters,
            sp.map((p) => p?.distance),
            geom.stops,
          );
          if (d !== null) {
            pos.distM = Math.round(d * 10) / 10;
            pos.distRev = geom.rev;
            pos.schedSpeed = schedSpeed(geom.stops, sp.map((p) => (p?.scheduledDeparture ? p.scheduledDeparture / 1000 : null)), d);
          }
        }
      }
      if (!prev) return;
      const prevFix = prev.fixAt ?? prev.updatedAt;
      if (pos.fixAt - prevFix < 0.5) {
        // same ping as last poll — not a new fix
        pos.moveDs = prev.moveDs;
        pos.speed = prev.speed;
        pos.speedAt = prev.speedAt;
        return;
      }
      const along = pos.distM != null && prev.distM != null && prev.distRev === pos.distRev;
      const ds = along ? pos.distM! - prev.distM! : metersBetween(prev.lat, prev.lon, pos.lat, pos.lon);
      const s = nextSpeed(prev.speed, prev.moveDs, ds, pos.fixAt - prevFix, 0, prev.atStop || pos.atStop);
      pos.moveDs = ds;
      pos.speed = s ?? prev.speed;
      pos.speedAt = s !== null ? pos.fixAt : prev.speedAt;
    } catch (err) {
      pos.shapeKey = null;
      pos.distM = null;
      const now = Date.now();
      if (now - this.routeErrLoggedAt > 60_000) {
        this.routeErrLoggedAt = now;
        log.error("mzk-poller", `route info failed for ${pos.execId}: ${err}`);
      }
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await interruptibleSleep(this.refreshIntervalMs, signal);

        if (signal.aborted) break;
        await this.pollOnce();
      } catch (err) {
        log.warn("mzk-poller", `Poll loop iteration failed: ${err}`);
      }
    }
  }
}
