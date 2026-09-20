/**
 * Process-wide singleton KbApi + LivePoller, cached on globalThis so it
 * survives Next.js dev-mode HMR module reloads.
 */
import { startGtfsRefresh } from "./gtfs-refresh";
import { KbApi } from "./kb-api";
import { log } from "./logger";
import { MzkApi } from "./mzk-api";
import { MzkPoller } from "./mzk-poller";
import { LivePoller, vehicleToJson } from "./poller";
import type { LineInfo, Stop, VehicleJson, VehiclesResponse } from "./types";

interface SingletonState {
  api: KbApi;
  poller: LivePoller;
  mzkApi: MzkApi;
  mzkPoller: MzkPoller;
  startPromise: Promise<void> | null;
  signalsRegistered: boolean;
  /** Epoch ms of the last failed start — gates the retry cooldown. */
  lastStartFailAt: number;
}

/** After a failed start, don't re-attempt loadStops() for this long. */
const START_RETRY_COOLDOWN_MS = 30_000;

const KEY = Symbol.for("kb-gtfs.poller-singleton");

type GlobalWithState = typeof globalThis & { [KEY]?: SingletonState };

function state(): SingletonState {
  const g = globalThis as GlobalWithState;
  if (!g[KEY]) {
    const api = new KbApi();
    const mzkApi = new MzkApi();
    g[KEY] = {
      api,
      poller: new LivePoller(api),
      mzkApi,
      mzkPoller: new MzkPoller(mzkApi),
      startPromise: null,
      signalsRegistered: false,
      lastStartFailAt: 0,
    };
  }
  return g[KEY];
}

/** The shared KB upstream API client. */
export function getApi(): KbApi {
  return state().api;
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
    st.startPromise = Promise.allSettled([
      st.poller.start().then(() => {
        log.info("rt", `KB poller up, ${st.poller.stops.length} stops loaded`);
        startGtfsRefresh();
      }),
      st.mzkPoller.start().then(() => {
        log.info("rt", `MZK poller up, ${st.mzkPoller.stops.length} stops loaded`);
      }),
    ])
      .then((results) => {
        const kbResult = results[0];
        const mzkResult = results[1];
        if (kbResult.status === "rejected") {
          log.warn("rt", `KB poller start warning: ${kbResult.reason}`);
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

/**
 * Returns combined live vehicles from KB and MZK, optionally filtered by operator.
 */
export function getCombinedVehicles(operator?: string | null): VehiclesResponse {
  const st = state();
  const nowEpoch = Date.now() / 1000;
  const op = operator?.toLowerCase();

  const kbLive = op === "mzk" ? [] : st.poller.liveVehicles(nowEpoch);
  const mzkLive = op === "kb" ? [] : Array.from(st.mzkPoller.positions.values());

  const vehicles: VehicleJson[] = [
    ...kbLive.map((v) => ({ ...vehicleToJson(v), operator: "KB" as const })),
    ...mzkLive.map((v) => ({ ...vehicleToJson(v), operator: "MZK" as const })),
  ];

  return {
    timestamp: Math.max(st.poller.healthSnapshot().lastGoodRefresh, st.mzkPoller.lastGoodRefresh),
    scan_count: st.poller.scanCount + st.mzkPoller.scanCount,
    last_scan: Math.max(st.poller.lastScan, st.mzkPoller.lastScan),
    count: vehicles.length,
    vehicles,
  };
}

/**
 * Returns combined stops from KB and MZK.
 */
export function getCombinedStops(): Stop[] {
  const st = state();
  return [...st.poller.stops, ...st.mzkPoller.stops];
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
    void Promise.allSettled([st.poller.stop(), st.mzkPoller.stop()]).catch((err: unknown) => {
      log.error("rt", `poller stop failed: ${err}`);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
