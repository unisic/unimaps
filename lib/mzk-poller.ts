/**
 * Background poller for MZK Bielsko-Biała live fleet and stops.
 */
import { bearing, metersBetween } from "./geo";
import { log } from "./logger";
import { MzkApi, type MzkRunningVehicle, type MzkStopPoint, type MzkLine } from "./mzk-api";
import { getFleetDetails, type MzkVehicleStatic } from "./mzk-fleet";
import { getFleetTracker } from "./fleet-tracker";
import { mzkRemapDist, mzkStopIndices } from "./mzk-shape";
import { nextSpeed } from "./route-info";
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

export class MzkPoller {
  readonly api: MzkApi;
  readonly refreshIntervalMs: number;

  positions = new Map<string, VehiclePos>();
  lastPositionsByVehicle = new Map<string, VehiclePos>();
  runningVehiclesMap = new Map<string, MzkRunningVehicle>();
  stops: Stop[] = [];
  stopsBySymbol = new Map<string, Stop>();
  lines: LineInfo[] = [];
  staticVehicles = new Map<string, MzkVehicleStatic>();
  courseMetaMap = new Map<number, { lineName: string; variantId?: number; direction?: string }>();

  lastScan = 0;
  scanCount = 0;
  startedAt = 0;
  lastGoodRefresh = Math.floor(Date.now() / 1000);

  /** road-shape store hook (null = no route info on positions) */
  shapes: MzkShapeSink | null = null;

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
    this.stopCtl?.abort();
    try {
      await this.loopPromise;
    } catch {
      /* ignore */
    }
  }

  async loadStops(): Promise<void> {
    const rawStops = await this.api.fetchStops();
    const stops: Stop[] = rawStops.map((s: MzkStopPoint) => {
      const isStation = /(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i.test(s.name);
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

    this.stops = stops;
    this.stopsBySymbol.clear();
    for (const s of stops) {
      if (s.symbol) this.stopsBySymbol.set(s.symbol, s);
    }
  }

  async loadLines(): Promise<void> {
    const rawLines = await this.api.fetchLines();
    this.lines = rawLines.map((l: MzkLine) => ({
      id: `mzk:${l.id}`,
      name: l.name,
      terminus: l.longName || "",
      operator: "MZK",
    }));
  }

  async loadStaticVehicles(): Promise<void> {
    const rawVehs = await this.api.fetchVehicles();
    this.staticVehicles.clear();
    for (const v of rawVehs) {
      this.staticVehicles.set(v.sideNumber, v);
    }
  }

  async pollOnce(): Promise<void> {
    if (this.stops.length === 0 || this.lines.length === 0) {
      try {
        if (this.stops.length === 0) await this.loadStops();
        if (this.lines.length === 0) await this.loadLines();
        if (this.staticVehicles.size === 0) await this.loadStaticVehicles();
      } catch (err) {
        log.warn("mzk-poller", `Reload static metadata failed: ${err}`);
      }
    }

    const running = await this.api.fetchRunningVehicles();
    const nowSecs = Math.floor(Date.now() / 1000);
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
        this.courseMetaMap.set(v.courseLoid, {
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
        delay: v.delaySec != null && Number.isFinite(v.delaySec) ? Math.round(v.delaySec) : null,
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
        operator: "MZK",
        sideNumber: v.vehicleId,
        model: fleet.model,
        features: fleet.features,
        nextStopSeq: next,
      };
      this.attachRouteInfo(pos, v, this.positions.get(execId), nowSecs, touchedVariants);

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
        await new Promise((resolve) => {
          if (signal.aborted) return resolve(undefined);
          const t = setTimeout(resolve, this.refreshIntervalMs);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve(undefined);
          }, { once: true });
        });

        if (signal.aborted) break;
        await this.pollOnce();
      } catch (err) {
        log.warn("mzk-poller", `Poll loop iteration failed: ${err}`);
      }
    }
  }
}
