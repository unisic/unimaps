/**
 * Process-wide singleton KbApi + LivePoller, cached on globalThis so it
 * survives Next.js dev-mode HMR module reloads.
 */
import fs from "node:fs";
import path from "node:path";

import * as config from "./config";
import { getFleetTracker } from "./fleet-tracker";
import { startGtfsRefresh } from "./gtfs-refresh";
import { KbApi } from "./kb-api";
import { log } from "./logger";
import { createMergedStopsCache, type MergedView } from "./merged-stops";
import { MzkApi } from "./mzk-api";
import { MZK_STALE_SEC, MzkPoller } from "./mzk-poller";
import { LivePoller, vehicleToJson } from "./poller";
import { vehicleExtras } from "./route-info";
import { readGtfsPatternSeeds } from "./shape-patterns";
import { getStopDirections } from "./stop-directions";
import { getShapeStore as getStoreSingleton, ShapeStore } from "./shape-store";
import type { LineInfo, VehicleJson, VehiclesResponse } from "./types";

interface SingletonState {
  /** client for the passthrough routes; the poller owns a separate one, so route traffic never queues in front of its scans */
  api: KbApi;
  poller: LivePoller;
  mzkApi: MzkApi;
  mzkPoller: MzkPoller;
  shapes: ShapeStore;
  /** memoized merged KB+MZK stop list (see getMergedStopsView) */
  merged?: ReturnType<typeof createMergedStopsCache>;
  /** last /api/vehicles payload per operator filter (at most 3: all, kb, mzk) */
  vehiclesMemo?: Map<string, { kbKey: string; mzkPositions: unknown; value: VehiclesResponse }>;
  startPromise: Promise<void> | null;
  signalsRegistered: boolean;
  /** Epoch ms of the last failed start — gates the retry cooldown. */
  lastStartFailAt: number;
}

/** After a failed start, don't re-attempt loadStops() for this long. */
const START_RETRY_COOLDOWN_MS = 30_000;

/** Passthrough routes: half the poller's upstream concurrency, and at most this many requests waiting for a slot
 *  (a flood is refused with a 502 instead of queueing without bound). */
const routeKbApi = (): KbApi =>
  new KbApi({ concurrency: Math.max(1, Math.floor(config.DEFAULT_CONCURRENCY / 2)), maxPending: 600 });

const KEY = Symbol.for("kb-gtfs.poller-singleton");

type GlobalWithState = typeof globalThis & { [KEY]?: SingletonState };

function state(): SingletonState {
  const g = globalThis as GlobalWithState;
  if (!g[KEY]) {
    const api = routeKbApi();
    const mzkApi = new MzkApi();
    const shapes = getShapeStore(mzkApi);
    const poller = new LivePoller(new KbApi(), { shapes });
    const mzkPoller = new MzkPoller(mzkApi);
    mzkPoller.shapes = shapes;
    g[KEY] = {
      api,
      poller,
      mzkApi,
      mzkPoller,
      shapes,
      startPromise: null,
      signalsRegistered: false,
      lastStartFailAt: 0,
    };
  }
  const st = g[KEY];
  // dev HMR: a singleton created by older code has no shape store yet
  if (!st.shapes) {
    st.shapes = getShapeStore(st.mzkApi);
    st.poller.shapes = st.shapes;
    st.mzkPoller.shapes = st.shapes;
  }
  return st;
}

/** The process-wide road-shape store (lib/shape-store.ts), bound to config. */
function getShapeStore(mzkApi: MzkApi): ShapeStore {
  return getStoreSingleton(
    () =>
      new ShapeStore({
        fetchImpl: globalThis.fetch.bind(globalThis),
        osrmBase: config.OSRM_URL,
        userAgent: config.OSRM_USER_AGENT,
        minIntervalMs: config.OSRM_MIN_INTERVAL_MS,
        maxAgeDays: config.SHAPES_MAX_AGE_DAYS,
        file: config.SHAPES_FILE,
        mzkFetch: (id) => mzkApi.fetchTheoreticalCourse(id),
      }),
  );
}

/** The shared road-shape store. */
export function getShapes(): ShapeStore {
  return state().shapes;
}

/**
 * Queue every stop pattern of the built GTFS feed for background routing, so
 * most shapes are road-following before a vehicle on them is ever seen.
 */
function seedShapesFromGtfs(st: SingletonState): void {
  try {
    if (!fs.existsSync(path.join(config.GTFS_DIR, "stop_times.txt"))) return;
    let n = 0;
    const seeds = readGtfsPatternSeeds(config.GTFS_DIR);
    if (seeds.length) st.shapes.clearRawTrips();
    for (const seed of seeds) {
      const p = st.poller.kbPatternFor(seed.times, seed.line, seed.dir);
      if (!p) continue;
      st.shapes.registerRawTrips(seed.rawTripIds, p.key);
      st.shapes.touchKb(p, "background");
      n += 1;
    }
    log.info("shapes", `seeded ${n} GTFS stop patterns`);
  } catch (err) {
    log.error("shapes", `GTFS seeding failed: ${err}`);
  }
}

/**
 * `shape_id` + `shape_status` for a KB trip object (upstream `trip` shape:
 * times / line.name / direction). Touches the store so an unseen pattern gets
 * queued for routing. Never throws.
 */
export function kbShapeRef(
  trip: unknown,
  prio: "urgent" | "background" = "urgent",
): { shape_id?: string; shape_status: "road" | "pending" | "none" } {
  try {
    const st = state();
    const t = trip && typeof trip === "object" ? (trip as Record<string, unknown>) : {};
    const times: unknown[] = Array.isArray(t.times) ? t.times : [];
    const lineRec = t.line && typeof t.line === "object" ? (t.line as Record<string, unknown>) : {};
    const line = lineRec.name ? String(lineRec.name) : "";
    const dir = t.direction ? String(t.direction) : "";
    const p = st.poller.kbPatternFor(times, line, dir);
    if (!p) return { shape_status: "none" };
    st.shapes.touchKb(p, prio);
    const id = st.shapes.wireId(p.key);
    return { ...(id ? { shape_id: id } : {}), shape_status: st.shapes.status(p.key) };
  } catch (err) {
    log.error("shapes", `kbShapeRef failed: ${err}`);
    return { shape_status: "none" };
  }
}

/** The KB upstream API client for the passthrough routes (not the poller's). */
export function getApi(): KbApi {
  return state().api;
}

/** Shared "no learned MZK directions" Map — a stable identity so the memoized merge is not recomputed per call. */
const NO_MZK_DIRS: ReadonlyMap<string, readonly number[]> = new Map();

/**
 * The merged KB+MZK stop list, its JSON body and the alias lookup — ONE memoized source shared by
 * GET /api/stops, the stop departures/timetable routes and /api/health (they used to re-merge ad hoc and
 * overwrite a process-global registry). Recomputed exactly when a poller swaps its stop list, the KB
 * direction map is rebuilt or a learned MZK stop direction changed.
 */
export function getMergedStopsView(): MergedView {
  const st = state();
  st.merged ??= createMergedStopsCache();
  return st.merged({
    kb: st.poller.stops,
    mzk: st.mzkPoller.stops,
    kbDirs: getStopDirections(),
    // dev HMR: an MzkPoller instance created by older code has no direction learner yet
    mzkDirs: st.mzkPoller.stopDirs?.dirs() ?? NO_MZK_DIRS,
  });
}

/** The shared KB poller; lazily kicks off startPoller() when not yet started. */
export function getPoller(): LivePoller {
  const st = state();
  if (!st.startPromise) {
    void startPoller().catch((err: unknown) => {
      log.error("rt", `background poller start failed: ${err}`);
    });
  }
  return st.poller;
}

/** The shared MZK upstream API client. */
export function getMzkApi(): MzkApi {
  return state().mzkApi;
}

/** The shared MZK poller. */
export function getMzkPoller(): MzkPoller {
  const st = state();
  if (!st.startPromise) {
    void startPoller().catch((err: unknown) => {
      log.error("rt", `background poller start failed: ${err}`);
    });
  }
  return st.mzkPoller;
}

/**
 * Idempotently start both singleton pollers (KB and MZK).
 * A failed start resets so the next call retries.
 */
export function startPoller(): Promise<void> {
  const st = state();
  if (!st.startPromise) {
    if (Date.now() - st.lastStartFailAt < START_RETRY_COOLDOWN_MS) {
      return Promise.reject(new Error("poller start failed recently, retry pending"));
    }
    st.shapes.start();
    st.startPromise = Promise.allSettled([
      startKb(st),
      st.mzkPoller.start().then(() => {
        log.info("rt", `MZK poller up, ${st.mzkPoller.stops.length} stops loaded`);
      }),
    ])
      .then((results) => {
        const kbResult = results[0];
        const mzkResult = results[1];
        if (kbResult.status === "rejected") {
          log.warn("rt", `KB poller start warning: ${kbResult.reason}`);
          // MZK up keeps startPromise resolved, so nothing would ever call start() again
          if (mzkResult.status === "fulfilled") retryKbStart(st);
        }
        if (mzkResult.status === "rejected") {
          log.warn("rt", `MZK poller start warning: ${mzkResult.reason}`);
        }
        // If both failed, treat as error
        if (kbResult.status === "rejected" && mzkResult.status === "rejected") {
          throw new Error("Both KB and MZK poller starts failed");
        }
      })
      .catch((err: unknown) => {
        st.lastStartFailAt = Date.now();
        st.startPromise = null;
        throw err;
      });
    registerSignalHandlers(st);
  }
  return st.startPromise;
}

function startKb(st: SingletonState): Promise<void> {
  return st.poller.start().then(() => {
    log.info("rt", `KB poller up, ${st.poller.stops.length} stops loaded`);
    startGtfsRefresh(() => seedShapesFromGtfs(st), st.mzkApi);
    const t = setTimeout(() => seedShapesFromGtfs(st), 3 * 60_000);
    t.unref?.();
  });
}

/** Retry a failed KB start every START_RETRY_COOLDOWN_MS until it succeeds (one timer at a time). */
function retryKbStart(st: SingletonState): void {
  const t = setTimeout(() => {
    startKb(st).catch((err: unknown) => {
      log.warn("rt", `KB poller start retry failed: ${err}`);
      retryKbStart(st);
    });
  }, START_RETRY_COOLDOWN_MS);
  t.unref?.();
}

/**
 * Returns combined live vehicles from KB and MZK, optionally filtered by operator.
 */
export function getCombinedVehicles(operator?: string | null): VehiclesResponse {
  const st = state();
  const nowEpoch = Date.now() / 1000;
  const op = operator?.toLowerCase();
  // every client polls every 4 s: rebuild only when the KB snapshot (5 s bucket included) or the MZK map changed
  const memoKey = op === "kb" || op === "mzk" ? op : "";
  const kbKey = st.poller.snapshotKey(nowEpoch);
  const memo = (st.vehiclesMemo ??= new Map()).get(memoKey);
  if (memo && memo.kbKey === kbKey && memo.mzkPositions === st.mzkPoller.positions) return memo.value;

  const kbLive = op === "mzk" ? [] : st.poller.liveVehicles(nowEpoch);
  const mzkLive = op === "kb" ? [] : Array.from(st.mzkPoller.positions.values()).filter((v) => nowEpoch - v.updatedAt <= MZK_STALE_SEC);

  const vehicles: VehicleJson[] = [
    ...kbLive.map((v) => ({ ...vehicleToJson(v), ...vehicleExtras(v, st.shapes, nowEpoch), operator: "KB" as const })),
    ...mzkLive.map((v) => ({ ...vehicleToJson(v), ...vehicleExtras(v, st.shapes, nowEpoch), operator: "MZK" as const })),
  ];

  const value: VehiclesResponse = {
    timestamp: Math.max(st.poller.lastGoodRefresh, st.mzkPoller.lastGoodRefresh),
    scan_count: st.poller.scanCount + st.mzkPoller.scanCount,
    last_scan: Math.max(st.poller.lastScan, st.mzkPoller.lastScan),
    count: vehicles.length,
    vehicles,
  };
  st.vehiclesMemo.set(memoKey, { kbKey, mzkPositions: st.mzkPoller.positions, value });
  return value;
}

/**
 * Returns combined lines from KB and MZK.
 */
export function getCombinedLines(kbLines: LineInfo[] = []): LineInfo[] {
  const st = state();
  return [...kbLines, ...st.mzkPoller.lines];
}

/** Register SIGTERM/SIGINT handlers once for graceful shutdown. */
function registerSignalHandlers(st: SingletonState): void {
  if (st.signalsRegistered) return;
  st.signalsRegistered = true;
  const shutdown = (sig: string): void => {
    log.info("rt", `${sig} received, stopping pollers`);
    try {
      st.shapes.stop(); // flushes the shape store synchronously
    } catch (err) {
      log.error("shapes", `store stop failed: ${err}`);
    }
    try {
      getFleetTracker().flushSync(); // the debounced save would otherwise drop up to 30 s of history
    } catch (err) {
      log.error("fleet", `history flush failed: ${err}`);
    }
    void Promise.allSettled([st.poller.stop(), st.mzkPoller.stop()]).catch((err: unknown) => {
      log.error("rt", `poller stop failed: ${err}`);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
