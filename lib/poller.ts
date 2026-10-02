/**
 * Live vehicle-position poller — TypeScript port of kb_gtfs/rt/poller.py
 * (LivePoller) with full behavioral parity.
 */
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";

import * as config from "./config";
import { bearing, metersBetween } from "./geo";
import { KbApi, asRecord, isRecord, parseIntStrict, pyTruthy } from "./kb-api";
import { log } from "./logger";
import { estimateFixAt, kbDistAlong, nextSpeed, type KbShapeSink } from "./route-info";
import { buildKbPattern, type KbPattern } from "./shape-patterns";
import type { Stop, VehicleJson, VehiclePos, VehiclesResponse } from "./types";

const rt = GtfsRealtimeBindings.transit_realtime;

/**
 * Rough bounding box of the Komunikacja Beskidzka network (Beskidy region:
 * Bielsko-Biała, Żywiec, Andrychów, Kęty, Szczyrk …). Upstream occasionally
 * reports a bogus (0, 0) fix — those land off the coast of Africa, so any
 * position outside this box is rejected as garbage.
 */
const SERVICE_AREA = { minLat: 48.8, maxLat: 50.5, minLon: 18.0, maxLon: 20.5 };
function inServiceArea(lat: number, lon: number): boolean {
  return (
    lat >= SERVICE_AREA.minLat &&
    lat <= SERVICE_AREA.maxLat &&
    lon >= SERVICE_AREA.minLon &&
    lon <= SERVICE_AREA.maxLon
  );
}

/**
 * Seconds since midnight in the agency's timezone (port of _now_secs). Uses
 * AGENCY_TIMEZONE explicitly instead of the process-local clock, so the schedule
 * math (delay, candidate horizon, finished) stays correct when the server runs
 * on UTC (the common container/cloud default) rather than Europe/Warsaw.
 */
export function nowSecs(): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.AGENCY_TIMEZONE,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date());
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
    const n = new Date();
    return n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds();
  }
}

/** "HH:MM[:SS]" -> seconds since midnight, or null (port of _hhmm_to_secs). */
export function hhmmToSecs(hhmm: unknown): number | null {
  if (typeof hhmm !== "string" || hhmm === "" || !hhmm.includes(":")) return null;
  const parts = hhmm.split(":");
  if (parts.length < 2) return null;
  const h = parseIntStrict(parts[0]);
  const m = parseIntStrict(parts[1]);
  if (h === null || m === null) return null;
  return h * 3600 + m * 60;
}

/**
 * Parse a departures row's scheduled time into seconds since midnight.
 * "HH:MM" is absolute; "5 min" / "< 1 min" / null return null so the caller
 * treats the departure as imminent (port of _row_departure_secs).
 */
function rowDepartureSecs(row: Record<string, unknown>): number | null {
  for (const key of ["static_time", "time"]) {
    const val = row[key];
    if (typeof val === "string" && val.includes(":")) {
      const parts = val.split(":");
      if (parts.length >= 2) {
        const h = parseIntStrict(parts[0]);
        const m = parseIntStrict(parts[1]);
        if (h !== null && m !== null) return h * 3600 + m * 60;
      }
    }
  }
  return null;
}

/** Round half-ish like Python's round-for-display; adequate for coords. */
function roundTo(x: number, digits: number): number {
  return Number(x.toFixed(digits));
}

/** Python int(x or default) with a safety fallback. */
function toInt(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isIdx(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Index of the next stop a KB vehicle will arrive at (port of the inline
 * _parse_position logic): next_departure_index, else vehicle_trip_index — and
 * past the stop being served while the bus sits in its zone. Null when out of
 * range.
 */
export function kbNextStopIndex(vti: unknown, ndi: unknown, atStop: boolean, n: number): number | null {
  let targetIdx: number | null = null;
  if (isIdx(ndi) && ndi >= 0 && ndi < n) targetIdx = ndi;
  if (targetIdx === null && isIdx(vti) && vti >= 0 && vti < n) targetIdx = vti;
  if (targetIdx === null) return null;
  const idx = atStop && isIdx(vti) && targetIdx === vti ? targetIdx + 1 : targetIdx;
  return idx >= 0 && idx < n ? idx : null;
}

/** VehiclePos -> wire JSON (port of VehiclePos.to_json). */
export function vehicleToJson(v: VehiclePos): VehicleJson {
  return {
    id: v.execId,
    trip_id: v.tripId,
    route_id: v.routeId,
    line: v.line,
    headsign: v.headsign,
    lat: roundTo(v.lat, 6),
    lon: roundTo(v.lon, 6),
    vehicle_type: v.vehicleType,
    current_stop_sequence: v.currentStopSequence,
    at_stop: v.atStop,
    delay: v.delay,
    bearing: v.bearing !== null ? roundTo(v.bearing, 1) : null,
    next_stop_name: v.nextStopName,
    next_stop_lat: v.nextStopLat !== null ? roundTo(v.nextStopLat, 6) : null,
    next_stop_lon: v.nextStopLon !== null ? roundTo(v.nextStopLon, 6) : null,
    timestamp: v.timestamp,
    updated_at: roundTo(v.updatedAt, 1),
    operator: v.operator ?? "KB",
    ...(v.sideNumber ? { side_number: v.sideNumber } : {}),
    ...(v.model ? { model: v.model } : {}),
    ...(v.features ? { features: v.features } : {}),
  };
}

/** Sleep that resolves early (and clears its timer) when the signal aborts. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      done();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Snapshot of poller liveness/feed state for GET /api/health. */
export interface PollerHealth {
  startedAt: number;
  stops: number;
  scanCount: number;
  lastScan: number;
  lastRefresh: number;
  /** Epoch secs of the last proven upstream contact. */
  lastGoodRefresh: number;
  /** positions.size — includes deliberately hidden ghosts. */
  tracked: number;
  /** liveVehicles().length — what the map shows. */
  live: number;
  loopRestarts: number;
  lastLoopError: string | null;
  lastLoopErrorAt: number;
  /** Epoch secs of the last successful stop-list load. */
  stopsLoadedAt: number;
}

export interface LivePollerOptions {
  scanInterval?: number;
  refreshInterval?: number;
  horizon?: number;
  cache404?: number;
  stopEmptyCache?: number;
  stopFarCache?: number;
  stopFarThreshold?: number;
  smartScanInterval?: number;
  smartScanWindow?: number;
  batchSize?: number;
  /** road-shape store: pattern keys, along-route distance (optional) */
  shapes?: KbShapeSink | null;
}

/**
 * Continuously discovers active trip executions from stop departure boards
 * and polls their live vehicle positions.
 */
export class LivePoller {
  readonly api: KbApi;
  readonly scanInterval: number;
  readonly refreshInterval: number;
  readonly horizon: number;
  readonly cache404: number;
  readonly stopEmptyCache: number;
  readonly stopFarCache: number;
  readonly stopFarThreshold: number;
  readonly smartScanInterval: number;
  readonly smartScanWindow: number;
  readonly batchSize: number;

  stops: Stop[] = [];
  positions = new Map<string, VehiclePos>();
  lastScan = 0;
  lastRefresh = 0;
  scanCount = 0;
  /** Epoch secs when start() succeeded. */
  startedAt = 0;
  /** How many times the background loop crashed and was restarted. */
  loopRestarts = 0;
  lastLoopError: string | null = null;
  /** Epoch secs of the last loop crash (0 = never). */
  lastLoopErrorAt = 0;

  /** Bumped whenever `positions` actually changes; keys the snapshot caches. */
  private snapshotVersion = 0;
  /** Epoch secs of the last proven upstream contact (any successful position
   *  fetch or departures batch) — served as the feed timestamp, so it goes
   *  stale only when the scraper is actually cut off from the upstream. */
  private lastGoodRefresh = Math.floor(Date.now() / 1000);
  private jsonCache: { key: string; value: VehiclesResponse } | null = null;
  private pbCache: { key: string; value: Uint8Array<ArrayBuffer> } | null = null;

  /** exec_id -> epoch secs at which the 404 was observed. */
  private notFound = new Map<string, number>();
  /** stop url_id -> epoch secs before which the stop must not be rescanned. */
  private stopRescanAt = new Map<string, number>();
  /** stop url_id -> earliest scheduled departure (secs since midnight). */
  private stopEarliest = new Map<string, number>();
  private stopsById = new Map<number, Stop>();
  private stopsByUrlId = new Map<string, Stop>();
  /** road-shape store hook (null = no route info on positions) */
  shapes: KbShapeSink | null = null;
  /** stop-list-dependent pattern memo; cleared on every stop reload */
  private patternMemo = new Map<string, KbPattern | null>();
  private routeErrLoggedAt = 0;

  private started = false;
  private stopCtl: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private stopsReloadInFlight = false;
  /** Epoch secs of the last successful stop-list load. */
  stopsLoadedAt = 0;

  constructor(api: KbApi, opts: LivePollerOptions = {}) {
    this.api = api;
    this.scanInterval = opts.scanInterval ?? config.LIVE_FULL_SCAN_INTERVAL;
    this.refreshInterval = opts.refreshInterval ?? config.LIVE_REFRESH_INTERVAL;
    this.horizon = opts.horizon ?? config.LIVE_CANDIDATE_HORIZON_SEC;
    this.cache404 = opts.cache404 ?? config.LIVE_404_CACHE_SEC;
    this.stopEmptyCache = opts.stopEmptyCache ?? config.LIVE_STOP_EMPTY_CACHE_SEC;
    this.stopFarCache = opts.stopFarCache ?? config.LIVE_STOP_FAR_CACHE_SEC;
    this.stopFarThreshold = opts.stopFarThreshold ?? config.LIVE_STOP_FAR_THRESHOLD_SEC;
    this.smartScanInterval = opts.smartScanInterval ?? config.LIVE_SMART_SCAN_INTERVAL;
    this.smartScanWindow = opts.smartScanWindow ?? config.LIVE_SMART_SCAN_WINDOW_SEC;
    this.batchSize = opts.batchSize ?? config.LIVE_BATCH_SIZE;
    this.shapes = opts.shapes ?? null;
  }

  /**
   * Fetch the current stops revision + stop list and swap
   * stops/stopsById/stopsByUrlId atomically (three synchronous assignments, no
   * await in between). An empty or failed fetch keeps the previous list.
   * Returns true when a new list was installed. Single-flight guarded.
   */
  async loadStops(): Promise<boolean> {
    if (this.stopsReloadInFlight) return false;
    this.stopsReloadInFlight = true;
    try {
      const rev = await this.api.fetchRevision();
      const stops = await this.api.fetchStops(rev);
      if (stops.length === 0) {
        log.error("rt", "stops reload: upstream returned an empty list, keeping previous");
        return false;
      }
      const prev = this.stops.length;
      const byId = new Map(stops.map((s) => [s.internalId, s]));
      const byUrlId = new Map(stops.map((s) => [s.urlId, s]));
      this.stops = stops;
      this.stopsById = byId;
      this.stopsByUrlId = byUrlId;
      // pattern keys/coords depend on the stop list
      this.patternMemo.clear();
      // drop scan state for stops that no longer exist so the maps stay bounded;
      // surviving keys are urlIds, their carried state remains valid
      for (const key of [...this.stopRescanAt.keys()]) if (!byUrlId.has(key)) this.stopRescanAt.delete(key);
      for (const key of [...this.stopEarliest.keys()]) if (!byUrlId.has(key)) this.stopEarliest.delete(key);
      this.stopsLoadedAt = Date.now() / 1000;
      if (prev > 0) log.info("rt", `stops reloaded: ${stops.length} (was ${prev}), rev ${rev}`);
      return true;
    } finally {
      this.stopsReloadInFlight = false;
    }
  }

  /** Load stops and start the background polling loop (no-op when running). */
  async start(): Promise<void> {
    if (this.started) return;
    await this.loadStops();
    if (this.stops.length === 0) {
      throw new Error("poller start failed: upstream returned an empty stop list");
    }
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now() / 1000;
    this.stopCtl = new AbortController();
    const signal = this.stopCtl.signal;
    // supervise() never rejects; the catch is a belt-and-braces backstop
    this.runPromise = this.supervise(signal).catch((err: unknown) => {
      log.error("rt", `poller supervisor crashed: ${err}`);
    });
  }

  /**
   * Keeps run() alive: restarts it with capped exponential backoff after a
   * crash (run() only returns normally on abort, so a non-abort return is a
   * crash too). A run that survives >5 min resets the backoff.
   */
  private async supervise(signal: AbortSignal): Promise<void> {
    let backoff = 1_000;
    while (!signal.aborted) {
      const t0 = Date.now();
      try {
        await this.run(signal);
      } catch (err) {
        this.lastLoopError = err instanceof Error ? err.message : String(err);
        this.lastLoopErrorAt = Date.now() / 1000;
        log.error("rt", `poller loop crashed: ${err}`);
      }
      if (signal.aborted) break;
      backoff = Date.now() - t0 > 5 * 60_000 ? 1_000 : Math.min(backoff * 2, 300_000);
      this.loopRestarts += 1;
      log.info("rt", `restarting poller loop in ${Math.round(backoff / 1000)}s (restart #${this.loopRestarts})`);
      await interruptibleSleep(backoff, signal);
    }
  }

  /** Stop the loop cleanly: aborts sleeps, leaves no dangling timers. */
  async stop(): Promise<void> {
    this.stopCtl?.abort();
    this.started = false;
    const p = this.runPromise;
    this.runPromise = null;
    if (p) await p;
  }

  /** Main loop: full scan every scanInterval; between scans, refresh every refreshInterval and smart-scan every smartScanInterval. */
  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (Date.now() / 1000 - this.stopsLoadedAt >= config.STOPS_RELOAD_SEC) {
        try {
          await this.loadStops();
        } catch (err) {
          log.error("rt", `stops reload failed: ${err}`);
          // keep the old list, retry in 30 min instead of hammering every scan
          this.stopsLoadedAt = Date.now() / 1000 - config.STOPS_RELOAD_SEC + 1800;
        }
      }
      try {
        await this.fullScan();
      } catch (err) {
        log.error("rt", `full scan error: ${err}`);
      }
      this.lastScan = Date.now() / 1000;
      this.scanCount += 1;
      const deadline = this.lastScan + this.scanInterval;
      let lastSmart = this.lastScan;
      while (Date.now() / 1000 < deadline && !signal.aborted) {
        const waitSecs = Math.min(this.refreshInterval, Math.max(1, deadline - Date.now() / 1000));
        await interruptibleSleep(waitSecs * 1000, signal);
        if (signal.aborted) break;
        const now = Date.now() / 1000;
        try {
          await this.refreshActive();
        } catch (err) {
          log.error("rt", `refresh error: ${err}`);
        }
        if (now - lastSmart >= this.smartScanInterval) {
          lastSmart = now;
          try {
            await this.smartScan();
          } catch (err) {
            log.error("rt", `smart scan error: ${err}`);
          }
        }
        this.lastRefresh = Date.now() / 1000;
      }
    }
  }

  /** Fetch departures for the given stops in batches and extract trip candidates
   *  (port of _scan_stops_batched). Returns exec_id -> earliest scheduled
   *  departure (secs since midnight). */
  private async scanStopsBatched(
    toScan: Stop[],
    now: number,
    nowTs: number,
    rescanOnEmpty: number,
  ): Promise<Map<string, number>> {
    const perTrip = new Map<string, number>();

    const ids = toScan.map((s) => s.urlId);
    const stopByUrl = new Map(toScan.map((s) => [s.urlId, s]));
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += this.batchSize) batches.push(ids.slice(i, i + this.batchSize));
    const results = await Promise.all(
      batches.map(async (b): Promise<{ ok: boolean; resp: unknown }> => {
        try {
          return { ok: true, resp: await this.api.fetchMultipleDepartures(b) };
        } catch (err) {
          log.error("rt", `departures batch failed: ${err}`);
          return { ok: false, resp: null };
        }
      }),
    );
    // any successful batch proves upstream contact — keeps the feed timestamp
    // honest overnight when there are no vehicles to refresh, while a dead
    // upstream stops advancing it
    if (results.some((r) => r.ok)) this.lastGoodRefresh = Math.floor(nowTs);

    for (let bi = 0; bi < batches.length; bi++) {
      const batchIds = batches[bi];
      const { ok, resp } = results[bi];
      // failed fetch: not a completed scan of these stops — stamp nothing
      if (!ok) continue;
      if (!pyTruthy(resp)) {
        for (const uid of batchIds) {
          const s = stopByUrl.get(uid)!;
          this.stopRescanAt.set(s.urlId, nowTs + rescanOnEmpty);
          this.stopEarliest.delete(s.urlId);
        }
        continue;
      }
      const depsByDesig = new Map<string, Record<string, unknown>>();
      const departures = asRecord(resp).departures;
      for (const depRaw of Array.isArray(departures) ? departures : []) {
        if (!isRecord(depRaw)) continue;
        const desig = depRaw.designator;
        if (desig !== null && desig !== undefined) depsByDesig.set(String(desig), depRaw);
      }

      for (const uid of batchIds) {
        const s = stopByUrl.get(uid)!;
        const depA = depsByDesig.get(s.stopId);
        const dep = pyTruthy(depA) ? depA : depsByDesig.get(uid);
        if (dep === undefined) {
          // Board absent from the reply = truncation (upstream caps the number
          // of boards per request), NOT an empty stop — it returns a board
          // (with empty rows) even for stops with no departures. Stamping the
          // empty-cache here would hide the stop's buses for the cache window;
          // leave its state untouched so the next scan retries it.
          continue;
        }
        const rows = dep.rows;
        if (!pyTruthy(rows)) {
          this.stopRescanAt.set(s.urlId, nowTs + rescanOnEmpty);
          this.stopEarliest.delete(s.urlId);
          continue;
        }
        let earliest: number | null = null;
        for (const rowRaw of Array.isArray(rows) ? rows : []) {
          if (!isRecord(rowRaw)) continue;
          const eidRaw = rowRaw.trip_execution_id;
          if (!pyTruthy(eidRaw)) continue;
          const eid = String(eidRaw);
          let depSec = rowDepartureSecs(rowRaw);
          if (depSec === null) depSec = now;
          if (earliest === null || depSec < earliest) earliest = depSec;
          const cur = perTrip.get(eid);
          if (cur === undefined || depSec < cur) perTrip.set(eid, depSec);
        }
        if (earliest !== null) {
          this.stopEarliest.set(s.urlId, earliest);
          if (earliest > now + this.stopFarThreshold) {
            this.stopRescanAt.set(s.urlId, nowTs + this.stopFarCache);
          } else {
            this.stopRescanAt.set(s.urlId, nowTs);
          }
        } else {
          this.stopRescanAt.set(s.urlId, nowTs + rescanOnEmpty);
          this.stopEarliest.delete(s.urlId);
        }
      }
    }

    return perTrip;
  }

  /** Scan all due stops for departures and fetch candidate positions (port of _full_scan). */
  private async fullScan(): Promise<void> {
    if (this.stops.length === 0) return;
    this.sweepExpired();
    const now = nowSecs();
    const nowTs = Date.now() / 1000;
    const toScan = this.stops.filter(
      (s) =>
        (this.stopRescanAt.get(s.urlId) ?? 0) <= nowTs ||
        (this.stopEarliest.get(s.urlId) ?? 999999) <= now + this.horizon,
    );
    const nBatches = toScan.length > 0 ? Math.ceil(toScan.length / this.batchSize) : 0;
    log.info(
      "rt",
      `full scan: ${toScan.length}/${this.stops.length} stops in ${nBatches} batches (cached ${this.stops.length - toScan.length}), now=${now}s`,
    );

    if (toScan.length === 0) {
      log.info("rt", `all stops cached, ${this.positions.size} active`);
      return;
    }

    const perTrip = await this.scanStopsBatched(toScan, now, nowTs, this.stopEmptyCache);

    const candidates: Array<[string, number]> = [...perTrip.entries()].filter(([, mnd]) => mnd <= now + this.horizon);
    log.info("rt", `discovered ${perTrip.size} trips, ${candidates.length} candidates (${this.positions.size} active)`);

    await this.fetchPositions(candidates);
  }

  /** Re-scan only stops with imminent departures (port of _smart_scan). */
  private async smartScan(): Promise<void> {
    if (this.stops.length === 0) return;
    const now = nowSecs();
    const nowTs = Date.now() / 1000;
    const toScan = this.stops.filter(
      (s) =>
        (this.stopEarliest.get(s.urlId) ?? 999999) <= now + this.smartScanWindow &&
        (this.stopRescanAt.get(s.urlId) ?? 0) <= nowTs,
    );
    if (toScan.length === 0) return;
    const nBatches = Math.ceil(toScan.length / this.batchSize);
    log.info("rt", `smart scan: ${toScan.length} stops in ${nBatches} batches (departures within ${this.smartScanWindow}s)`);

    const perTrip = await this.scanStopsBatched(toScan, now, nowTs, this.smartScanInterval);

    const candidates: Array<[string, number]> = [...perTrip.entries()].filter(
      ([eid, mnd]) => mnd <= now + this.horizon && !this.positions.has(eid),
    );
    if (candidates.length > 0) {
      await this.fetchPositions(candidates);
    }
  }

  /** Re-fetch positions of all currently tracked vehicles (port of _refresh_active). */
  private async refreshActive(): Promise<void> {
    if (this.positions.size === 0) return;
    const active = [...this.positions.keys()];
    await this.fetchPositions(active.map((eid): [string, number] => [eid, 0]));
  }

  /** Fetch trip executions for candidates, honoring the 404 cache (port of _fetch_positions). */
  private async fetchPositions(candidates: Array<[string, number]>): Promise<void> {
    const nowTs = Math.floor(Date.now() / 1000);
    const cacheCut = nowTs - this.cache404;
    let fetchOk = 0;

    try {
      const results = await Promise.all(
        candidates.map(async ([eid]): Promise<[string, unknown, boolean]> => {
          const nf = this.notFound.get(eid);
          // cached 404 still fresh → skip the fetch, but DON'T re-stamp it below;
          // re-stamping every scan would slide the TTL forever (scanInterval <
          // cache404) and permanently hide a bus that 404'd once (dispatched late).
          if (nf !== undefined && nf > cacheCut && !this.positions.has(eid)) return [eid, null, false];
          try {
            const resp = await this.api.fetchTripExecution(eid, 0);
            fetchOk += 1;
            return [eid, resp, true];
          } catch (err) {
            // fetch error is not a 404: keep the previous position, don't stamp notFound
            log.error("rt", `trip execution fetch failed for ${eid}: ${err}`);
            return [eid, null, false];
          }
        }),
      );

      let changed = false;
      for (const [eid, resp, fetched] of results) {
        if (!fetched) continue; // cached 404 / fetch error: leave existing state untouched
        if (!pyTruthy(resp)) {
          this.notFound.set(eid, nowTs);
          if (this.positions.delete(eid)) changed = true;
          continue;
        }
        const pos = this.parsePosition(eid, asRecord(resp));
        if (pos) {
          // Carry the movement anchor across refreshes: reset it (and mark "moved
          // now") only when the vehicle has travelled past the epsilon; otherwise
          // keep the previous anchor so a slowly-drifting bus still counts as
          // moving while a bit-frozen feed accrues stale time.
          const prev = this.positions.get(eid);
          if (prev) {
            const moved = metersBetween(pos.lat, pos.lon, prev.anchorLat, prev.anchorLon);
            if (moved > config.LIVE_STALE_MOVE_EPS_M) {
              pos.anchorLat = pos.lat;
              pos.anchorLon = pos.lon;
              pos.lastMovedAt = pos.updatedAt;
            } else {
              pos.anchorLat = prev.anchorLat;
              pos.anchorLon = prev.anchorLon;
              pos.lastMovedAt = prev.lastMovedAt;
            }

            // Heading points in the actual direction the vehicle is moving
            const stepDist = metersBetween(pos.lat, pos.lon, prev.lat, prev.lon);
            if (stepDist >= 8) {
              const moveBrg = bearing(prev.lat, prev.lon, pos.lat, pos.lon);
              if (moveBrg !== null) {
                pos.bearing = moveBrg;
              }
            } else if (prev.bearing !== null) {
              // Retain heading while stopped (at a stop, traffic lights, etc.)
              pos.bearing = prev.bearing;
            }
          }
          this.attachRouteInfo(pos, prev, asRecord(resp), "urgent");
          this.positions.set(eid, pos);
          this.notFound.delete(eid);
          changed = true;
        }
      }
      if (changed) this.snapshotVersion += 1;
      // freshness = proven upstream contact: at least one fetch actually
      // succeeded this cycle (a single flaky exec_id must not veto the stamp,
      // and a zero-candidate run proves nothing)
      if (fetchOk > 0) this.lastGoodRefresh = nowTs;
    } finally {
      this.pruneDead(Date.now() / 1000);
    }
  }

  /**
   * Drop vehicles that are no longer live so both `positions` and the
   * refreshActive() workload stay bounded to actually-running buses:
   *  - finished (sitting at/past the last stop),
   *  - a frozen feed (isStale: no delay estimate and not moving),
   *  - not successfully parsed for a long time (e.g. persistent (0,0)/out-of-area
   *    fixes leave the old entry unchanged so updatedAt stops advancing).
   * Upstream keeps returning a dead trip's last position instead of 404ing, so
   * without this they would accumulate all service day and be re-polled forever.
   */
  private pruneDead(nowEpoch: number): void {
    const hardMax = config.LIVE_STALE_VEHICLE_SEC * 3;
    let pruned = false;
    for (const [eid, v] of this.positions) {
      if (v.finished || this.isStale(v, nowEpoch) || nowEpoch - v.updatedAt > hardMax) {
        this.positions.delete(eid);
        pruned = true;
      }
    }
    if (pruned) this.snapshotVersion += 1;
  }

  /** Evict expired 404 markers (keyed by unique per-day exec_id) so the
   *  notFound map doesn't accumulate every never-dispatched trip over time. */
  private sweepExpired(): void {
    const cut = Math.floor(Date.now() / 1000) - this.cache404;
    for (const [eid, ts] of this.notFound) if (ts <= cut) this.notFound.delete(eid);
  }

  /** Resolve lat/lon for a trip time entry from the loaded stops (port of _stop_coords). */
  private stopCoords(t: Record<string, unknown>): [number, number] | null {
    const desig = t.designator;
    if (isIdx(desig)) {
      const s = this.stopsById.get(desig);
      if (s) return [s.lat, s.lon];
    }
    const pid = t.place_id;
    if (typeof pid === "string") {
      const s = this.stopsByUrlId.get(pid);
      if (s) return [s.lat, s.lon];
    }
    return null;
  }

  /** Exact port of _parse_position: delay, bearing, next stop, trip id fallbacks. */
  private parsePosition(eid: string, resp: Record<string, unknown>): VehiclePos | null {
    const trip = asRecord(resp.trip);
    const vehicle = asRecord(resp.vehicle);
    const latRaw = vehicle.lat;
    const lonRaw = vehicle.lon;
    if (latRaw === null || latRaw === undefined || lonRaw === null || lonRaw === undefined) return null;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // drop bogus fixes (e.g. upstream's (0, 0)) so no bus teleports to the ocean
    if (!inServiceArea(lat, lon)) return null;

    const line = asRecord(trip.line);
    const lineName = pyTruthy(line.name) ? String(line.name) : "";
    const times: unknown[] = Array.isArray(trip.times) ? trip.times : [];
    const vti = resp.vehicle_trip_index;
    const ndi = resp.next_departure_index;
    const atStop = pyTruthy(resp.at_stop);

    // ---- delay from estimates[0].arrival_abs vs scheduled departure ----
    let delay: number | null = null;
    let ests: unknown = resp.estimates;
    let targetIdx: number | null = null;
    if (isIdx(ndi) && ndi >= 0 && ndi < times.length) targetIdx = ndi;
    if (targetIdx === null && isIdx(vti) && vti >= 0 && vti < times.length) targetIdx = vti;
    if (isRecord(ests)) ests = [ests];
    if (Array.isArray(ests) && ests.length > 0 && targetIdx !== null) {
      const first = asRecord(ests[0]);
      const arr = first.arrival_abs;
      const entry = times[targetIdx];
      const sched = isRecord(entry) ? hhmmToSecs(entry.departure_time) : null;
      const arrSec = hhmmToSecs(arr);
      if (arrSec !== null && sched !== null) {
        let raw = arrSec - sched;
        // wrap around midnight
        if (raw > 43200) raw -= 86400;
        else if (raw < -43200) raw += 86400;
        delay = Math.trunc(raw);
      }
    }
    // fallback: per-stop estimate.time_diff on the current time entry
    if (delay === null && isIdx(vti) && vti >= 0 && vti < times.length) {
      const entry = times[vti];
      if (isRecord(entry)) {
        const est = asRecord(entry.estimate);
        const td = est.time_diff;
        if (typeof td === "number" && Number.isFinite(td)) delay = Math.trunc(td);
      }
    }

    // Next stop information (heading is determined by actual vehicle movement, not route line)
    const brg: number | null = null;
    let nextName: string | null = null;
    let nextLat: number | null = null;
    let nextLon: number | null = null;
    const nextIdx = kbNextStopIndex(vti, ndi, atStop, times.length);
    if (nextIdx !== null) {
      const entry = times[nextIdx];
      if (isRecord(entry)) {
        const c = this.stopCoords(entry);
        if (c !== null) {
          const [clat, clon] = c;
          nextName = pyTruthy(entry.stop_name) ? String(entry.stop_name) : "";
          nextLat = clat;
          nextLon = clon;
        }
      }
    }

    let tripId = "";
    if (isIdx(vti) && vti >= 0 && vti < times.length) {
      const entry = times[vti];
      if (isRecord(entry)) {
        const cand = pyTruthy(entry.trip_id) ? entry.trip_id : pyTruthy(resp.trip_id) ? resp.trip_id : "";
        tripId = String(cand);
      }
    }
    if (!tripId) {
      // Mirrors Python's precedence: str((resp["trip_id"] or eid.split(":")[1]) if ":" in eid else eid)
      tripId = eid.includes(":") ? String(pyTruthy(resp.trip_id) ? resp.trip_id : eid.split(":")[1]) : eid;
    }

    const vtVal = pyTruthy(resp.vehicle_type) ? resp.vehicle_type : pyTruthy(trip.vehicle_type) ? trip.vehicle_type : 0;
    const tsVal = pyTruthy(resp.timestamp) ? resp.timestamp : null;
    const nowEpoch = Date.now() / 1000;
    // course over once the bus is sitting at (or past) its last scheduled stop:
    // upstream keeps reporting it there with a delay that only grows, so hide it
    const lastIdx = times.length - 1;
    const finished = isIdx(vti) && lastIdx >= 0 && vti >= lastIdx && atStop;
    return {
      execId: eid,
      tripId,
      routeId: lineName ? "L_" + lineName : "",
      line: lineName,
      headsign: pyTruthy(trip.direction) ? String(trip.direction) : "",
      lat,
      lon,
      vehicleType: toInt(vtVal, 0),
      currentStopSequence: isIdx(vti) ? vti : null,
      atStop,
      delay,
      timestamp: tsVal !== null ? toInt(tsVal, Math.floor(nowEpoch)) : Math.floor(nowEpoch),
      updatedAt: nowEpoch,
      bearing: brg,
      nextStopName: nextName,
      nextStopLat: nextLat,
      nextStopLon: nextLon,
      // movement defaults; fetchPositions carries the anchor across refreshes
      lastMovedAt: nowEpoch,
      anchorLat: lat,
      anchorLon: lon,
      finished,
      nextStopSeq: nextIdx,
    };
  }

  /** Resolve a trip times entry to its physical stop (same rules as stopCoords). */
  private resolveStop(t: Record<string, unknown>): { id: string; lat: number; lon: number } | null {
    const desig = t.designator;
    let s: Stop | undefined;
    if (isIdx(desig)) s = this.stopsById.get(desig);
    if (!s && typeof t.place_id === "string") s = this.stopsByUrlId.get(t.place_id);
    return s ? { id: s.stopId, lat: s.lat, lon: s.lon } : null;
  }

  /** Road-shape pattern for a trip's times (memoized per stop list). */
  kbPatternFor(times: readonly unknown[], line: string, dir: string): KbPattern | null {
    const sig =
      `${line}\u0001${dir}\u0001` +
      times
        .map((t) => {
          const r = isRecord(t) ? t : {};
          return isIdx(r.designator) ? String(r.designator) : typeof r.place_id === "string" ? `p${r.place_id}` : "?";
        })
        .join(",");
    if (this.patternMemo.has(sig)) return this.patternMemo.get(sig) ?? null;
    const p = buildKbPattern(times, line, dir, (t) => this.resolveStop(t));
    if (this.patternMemo.size >= 4000) this.patternMemo.clear();
    this.patternMemo.set(sig, p);
    return p;
  }

  /**
   * Route info for the client motion engine: shape key, fix time, along-route
   * distance and cruise speed. Isolated per vehicle — a bug here must never
   * abort a refresh (the vehicle just ships without route info).
   */
  private attachRouteInfo(
    pos: VehiclePos,
    prev: VehiclePos | undefined,
    resp: Record<string, unknown>,
    prio: "urgent" | "background",
  ): void {
    try {
      const moved = !prev || Math.abs(pos.lat - prev.lat) > 1e-7 || Math.abs(pos.lon - prev.lon) > 1e-7;
      pos.fixAt = estimateFixAt(prev, pos.updatedAt, moved, Math.max(30, 3 * this.refreshInterval));
      const shapes = this.shapes;
      let geomRev: string | undefined;
      if (shapes) {
        const trip = asRecord(resp.trip);
        const times: unknown[] = Array.isArray(trip.times) ? trip.times : [];
        const pattern = this.kbPatternFor(times, pos.line, pos.headsign);
        pos.shapeKey = pattern?.key ?? null;
        if (pattern) shapes.touchKb(pattern, prio);
        const geom = pos.shapeKey ? shapes.geometry(pos.shapeKey) : null;
        geomRev = geom?.rev;
        const sameShape = !!prev && prev.shapeKey === pos.shapeKey && prev.distRev === geomRev;
        if (geom && (moved || !sameShape)) {
          const hint = sameShape && prev?.distM != null ? prev.distM : undefined;
          pos.distM = kbDistAlong(geom, pos.lat, pos.lon, pos.currentStopSequence, pos.nextStopSeq ?? null, hint);
          pos.distRev = geom.rev;
        } else if (geom && prev) {
          pos.distM = prev.distM;
          pos.distRev = prev.distRev;
        }
      }
      if (!prev) return;
      if (!moved) {
        pos.moveDs = prev.moveDs;
        pos.speed = prev.speed;
        pos.speedAt = prev.speedAt;
        return;
      }
      const along =
        pos.distM != null && prev.distM != null && prev.shapeKey === pos.shapeKey && prev.distRev === pos.distRev;
      const ds = along ? pos.distM! - prev.distM! : metersBetween(prev.lat, prev.lon, pos.lat, pos.lon);
      const prevFix = prev.fixAt ?? prev.updatedAt;
      const v = nextSpeed(prev.speed, prev.moveDs, ds, pos.fixAt - prevFix, prev.updatedAt - prevFix, prev.atStop || pos.atStop);
      pos.moveDs = ds;
      pos.speed = v ?? prev.speed;
      pos.speedAt = v !== null ? pos.fixAt : prev.speedAt;
    } catch (err) {
      pos.shapeKey = null;
      pos.distM = null;
      const now = Date.now();
      if (now - this.routeErrLoggedAt > 60_000) {
        this.routeErrLoggedAt = now;
        log.error("rt", `route info failed for ${pos.execId}: ${err}`);
      }
    }
  }

  /** A vehicle whose feed has frozen: no live delay estimate and not moving. */
  private isStale(v: VehiclePos, nowEpoch: number): boolean {
    return v.delay === null && nowEpoch - v.lastMovedAt > config.LIVE_STALE_VEHICLE_SEC;
  }

  /** Live vehicles shown on the map: not frozen (stale feed), not finished,
   *  and successfully fetched recently (an upstream outage must not serve
   *  last-known positions as live indefinitely). */
  liveVehicles(nowEpoch: number): VehiclePos[] {
    return [...this.positions.values()].filter(
      (v) =>
        !v.finished &&
        !this.isStale(v, nowEpoch) &&
        nowEpoch - v.updatedAt <= config.LIVE_STALE_VEHICLE_SEC,
    );
  }

  /**
   * Immediately register candidate trip execution IDs to discover and track,
   * e.g. when stop departures are requested by a client.
   */
  addCandidates(eids: string[]): void {
    const needed = eids.filter((eid) => eid && !this.positions.has(eid));
    if (needed.length === 0) return;
    void this.fetchPositions(needed.map((eid): [string, number] => [eid, 0])).catch((err) => {
      log.error("rt", `addCandidates background fetch failed: ${err}`);
    });
  }

  /**
   * Immediately ingest a trip execution record into live positions,
   * e.g. when a client opens a live trip execution.
   */
  ingestTripExecution(eid: string, resp: Record<string, unknown>): VehiclePos | null {
    if (!pyTruthy(resp)) return null;
    const pos = this.parsePosition(eid, resp);
    if (!pos) return null;
    const nowTs = Math.floor(Date.now() / 1000);
    const prev = this.positions.get(eid);
    if (prev) {
      const moved = metersBetween(pos.lat, pos.lon, prev.anchorLat, prev.anchorLon);
      if (moved > config.LIVE_STALE_MOVE_EPS_M) {
        pos.anchorLat = pos.lat;
        pos.anchorLon = pos.lon;
        pos.lastMovedAt = pos.updatedAt;
      } else {
        pos.anchorLat = prev.anchorLat;
        pos.anchorLon = prev.anchorLon;
        pos.lastMovedAt = prev.lastMovedAt;
      }
      const stepDist = metersBetween(pos.lat, pos.lon, prev.lat, prev.lon);
      if (stepDist >= 8) {
        const moveBrg = bearing(prev.lat, prev.lon, pos.lat, pos.lon);
        if (moveBrg !== null) pos.bearing = moveBrg;
      } else if (prev.bearing !== null) {
        pos.bearing = prev.bearing;
      }
    }
    this.attachRouteInfo(pos, prev, resp, "urgent");
    this.positions.set(eid, pos);
    this.notFound.delete(eid);
    this.lastGoodRefresh = nowTs;
    this.snapshotVersion += 1;
    return pos;
  }

  /** Count of vehicles currently shown on the map (excludes frozen ghosts). */
  liveCount(): number {
    return this.liveVehicles(Date.now() / 1000).length;
  }

  /** Internal state snapshot for GET /api/health — no private references leak. */
  healthSnapshot(): PollerHealth {
    return {
      startedAt: this.startedAt,
      stops: this.stops.length,
      scanCount: this.scanCount,
      lastScan: this.lastScan,
      lastRefresh: this.lastRefresh,
      lastGoodRefresh: this.lastGoodRefresh,
      tracked: this.positions.size,
      live: this.liveCount(),
      loopRestarts: this.loopRestarts,
      lastLoopError: this.lastLoopError,
      lastLoopErrorAt: this.lastLoopErrorAt,
      stopsLoadedAt: this.stopsLoadedAt,
    };
  }

  /** Cache key: positions version + coarse 5s time bucket (the live filter is
   *  time-dependent, so ghosts still age out between buckets). */
  private snapshotKey(nowEpoch: number): string {
    return `${this.snapshotVersion}:${Math.floor(nowEpoch / 5)}`;
  }

  /** Snapshot of all live vehicles for GET /api/vehicles (frozen ghosts hidden). */
  toJson(): VehiclesResponse {
    const nowEpoch = Date.now() / 1000;
    const key = this.snapshotKey(nowEpoch);
    if (this.jsonCache !== null && this.jsonCache.key === key) return this.jsonCache.value;
    const live = this.liveVehicles(nowEpoch);
    const value: VehiclesResponse = {
      timestamp: this.lastGoodRefresh,
      scan_count: this.scanCount,
      last_scan: this.lastScan,
      count: live.length,
      vehicles: live.map(vehicleToJson),
    };
    this.jsonCache = { key, value };
    return value;
  }

  /** GTFS-Realtime VehiclePositions FeedMessage (binary; frozen ghosts hidden). */
  toProtobuf(): Uint8Array<ArrayBuffer> {
    const nowEpoch = Date.now() / 1000;
    const key = this.snapshotKey(nowEpoch);
    if (this.pbCache !== null && this.pbCache.key === key) return this.pbCache.value;
    const entity: transit_realtime.IFeedEntity[] = [];
    for (const v of this.liveVehicles(nowEpoch)) {
      const vehicle: transit_realtime.IVehiclePosition = {
        position: {
          latitude: v.lat,
          longitude: v.lon,
          ...(v.bearing !== null ? { bearing: v.bearing } : {}),
        },
        timestamp: v.timestamp,
        trip: {
          ...(v.routeId ? { routeId: v.routeId } : {}),
          ...(v.tripId ? { tripId: v.tripId } : {}),
          scheduleRelationship: rt.TripDescriptor.ScheduleRelationship.SCHEDULED,
        },
        ...(v.currentStopSequence !== null ? { currentStopSequence: v.currentStopSequence } : {}),
        currentStatus: v.atStop
          ? rt.VehiclePosition.VehicleStopStatus.STOPPED_AT
          : rt.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO,
        vehicle: {
          ...(v.line ? { label: v.line } : {}),
          id: v.execId,
        },
      };
      entity.push({ id: v.execId, vehicle });
    }
    const message: transit_realtime.IFeedMessage = {
      header: {
        gtfsRealtimeVersion: "2.0",
        incrementality: rt.FeedHeader.Incrementality.FULL_DATASET,
        timestamp: this.lastGoodRefresh,
      },
      entity,
    };
    const value = new Uint8Array(rt.FeedMessage.encode(message).finish());
    this.pbCache = { key, value };
    return value;
  }
}
