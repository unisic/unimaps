/**
 * In-process daily GTFS feed refresh. The standalone Docker image ships no tsx
 * and no scripts/, so the nightly rebuild runs inside the (already long-lived)
 * server process instead of a host cron:
 *  - feed missing entirely -> bootstrap build immediately (fresh deploy/volume);
 *  - feed dated != today and it's past KB_GTFS_BUILD_HOUR agency time -> rebuild.
 * A failed build keeps the old feed (atomic tmp-dir publish in gtfs-builder)
 * and backs off 30 min. After a successful build the process-lifetime caches
 * (stop directions, line catalog) are invalidated so arrows and the palette
 * pick up the new feed without a restart, and `onBuilt` lets the caller
 * re-seed the road-shape store from the fresh stop patterns.
 */
import * as config from "./config";
import { buildGtfs, gtfsFeedDate } from "./gtfs-builder";
import { invalidateLines } from "./lines";
import { log } from "./logger";
import { nowSecs } from "./poller";
import { invalidateRouter } from "./router";
import { invalidateStopDirections } from "./stop-directions";

interface RefreshState {
  building: boolean;
  /** Epoch ms before which no build attempt may start (failure backoff). */
  nextAttemptAt: number;
}

const CHECK_INTERVAL_MS = 10 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const FAIL_BACKOFF_MS = 30 * 60_000;

/** Current hour in the agency timezone — never the server-local clock. */
function warsawHour(): number {
  return Math.floor(nowSecs() / 3600);
}

async function maybeBuild(st: RefreshState, onBuilt?: () => void): Promise<void> {
  if (st.building || Date.now() < st.nextAttemptAt) return;
  const feedDate = gtfsFeedDate();
  const today = config.todayLocalISO();
  const bootstrap = feedDate === null;
  const dailyDue = !bootstrap && feedDate !== today && warsawHour() >= config.GTFS_BUILD_HOUR;
  if (!bootstrap && !dailyDue) return;
  st.building = true;
  try {
    log.info("gtfs", bootstrap ? "no feed found, bootstrap build starting" : `feed dated ${feedDate}, rebuilding for ${today}`);
    await buildGtfs({ date: today, concurrency: config.GTFS_BUILD_CONCURRENCY });
    invalidateStopDirections();
    invalidateLines();
    invalidateRouter();
    log.info("gtfs", `feed rebuilt for ${today}`);
    onBuilt?.();
  } catch (err) {
    st.nextAttemptAt = Date.now() + FAIL_BACKOFF_MS;
    log.error("gtfs", `feed rebuild failed (retry in 30 min): ${err}`);
  } finally {
    st.building = false;
  }
}

const KEY = Symbol.for("kb-gtfs.gtfs-refresh");
type GlobalWithState = typeof globalThis & { [KEY]?: RefreshState };

/** Idempotent; the globalThis guard survives dev-mode HMR (same pattern as the
 *  poller singleton). Timers are unref'd so they never hold the process open. */
export function startGtfsRefresh(onBuilt?: () => void): void {
  if (!config.GTFS_AUTOBUILD) return;
  const g = globalThis as GlobalWithState;
  if (g[KEY]) return;
  const st: RefreshState = { building: false, nextAttemptAt: 0 };
  g[KEY] = st;
  const first = setTimeout(() => {
    void maybeBuild(st, onBuilt);
    const timer = setInterval(() => void maybeBuild(st, onBuilt), CHECK_INTERVAL_MS);
    timer.unref?.();
  }, FIRST_CHECK_DELAY_MS);
  first.unref?.();
  log.info("gtfs", `auto-rebuild armed (daily after ${config.GTFS_BUILD_HOUR}:00 ${config.AGENCY_TIMEZONE}, bootstrap when feed missing)`);
}
