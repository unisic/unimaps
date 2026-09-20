/**
 * Background poller for MZK Bielsko-Biała live fleet and stops.
 */
import { log } from "./logger";
import { MzkApi, type MzkRunningVehicle, type MzkStopPoint, type MzkLine } from "./mzk-api";
import { getFleetDetails, type MzkVehicleStatic } from "./mzk-fleet";
import type { LineInfo, Stop, VehiclePos } from "./types";

export class MzkPoller {
  readonly api: MzkApi;
  readonly refreshIntervalMs: number;

  positions = new Map<string, VehiclePos>();
  runningVehiclesMap = new Map<string, MzkRunningVehicle>();
  stops: Stop[] = [];
  stopsBySymbol = new Map<string, Stop>();
  lines: LineInfo[] = [];
  staticVehicles = new Map<string, MzkVehicleStatic>();

  lastScan = 0;
  scanCount = 0;
  startedAt = 0;
  lastGoodRefresh = Math.floor(Date.now() / 1000);

  private started = false;
  private stopCtl: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

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
    const running = await this.api.fetchRunningVehicles();
    const nowSecs = Math.floor(Date.now() / 1000);
    const newPositions = new Map<string, VehiclePos>();
    const newRunningMap = new Map<string, MzkRunningVehicle>();

    for (const v of running) {
      if (!v.longitude || !v.latitude || !v.vehicleId) continue;

      const execId = `mzk:${v.courseLoid}:${v.vehicleId}`;
      const staticInfo = this.staticVehicles.get(v.vehicleId);
      const fleet = getFleetDetails(v.vehicleId, staticInfo);

      let bearing: number | null = null;
      if (v.angle != null && Number.isFinite(v.angle)) {
        bearing = v.angle < 0 ? (v.angle + 360) % 360 : v.angle % 360;
      }

      // Next stop name from current vehicle or stopPoints
      let nextStopName: string | null = null;
      if (v.stopPoints && v.orderInCourse != null && v.stopPoints[v.orderInCourse]) {
        nextStopName = v.stopPoints[v.orderInCourse].name;
      } else if (v.nearestSymbol) {
        const matched = this.stopsBySymbol.get(v.nearestSymbol);
        if (matched) nextStopName = matched.name;
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
        currentStopSequence: v.orderInCourse != null ? v.orderInCourse : null,
        atStop: Boolean(v.onStopPoint),
        delay: v.delaySec != null && Number.isFinite(v.delaySec) ? Math.round(v.delaySec) : null,
        timestamp: v.lastPingDate ? Math.floor(v.lastPingDate / 1000) : nowSecs,
        updatedAt: Date.now() / 1000,
        bearing,
        nextStopName,
        nextStopLat: null,
        nextStopLon: null,
        lastMovedAt: nowSecs,
        anchorLat: v.latitude,
        anchorLon: v.longitude,
        finished: false,
        operator: "MZK",
        sideNumber: v.vehicleId,
        model: fleet.model,
        features: fleet.features,
      };

      newPositions.set(execId, pos);
      newRunningMap.set(execId, v);
      newRunningMap.set(String(v.courseLoid), v);
    }

    this.positions = newPositions;
    this.runningVehiclesMap = newRunningMap;
    this.lastScan = nowSecs;
    this.scanCount++;
    this.lastGoodRefresh = nowSecs;
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
