import * as config from "@/lib/config";
import { upstreamError } from "@/lib/api-helpers";
import { getMergedStopsView, getMzkPoller, getPoller, getShapes, startPoller } from "@/lib/poller-singleton";
import type { HealthResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Shape-store counters; a store problem must never break the healthcheck. */
function safeShapesHealth(): Record<string, unknown> | undefined {
  try {
    return getShapes().health();
  } catch {
    return undefined;
  }
}

/** Merged-stop counters; like the shape store, a problem here must never break the healthcheck. */
function safeStopsHealth(): Pick<HealthResponse, "mzk_stops" | "mzk_stops_loaded_at" | "merged_stops"> {
  try {
    const mzk = getMzkPoller();
    const view = getMergedStopsView();
    return {
      mzk_stops: mzk.stops.length,
      mzk_stops_loaded_at: mzk.stopsLoadedAt,
      merged_stops: {
        both: view.summary.both,
        kb: view.summary.kb,
        mzk: view.summary.mzk,
        partial: view.partial,
        mzk_dir_stops: view.summary.mzkDirStops,
        built_at: view.summary.builtAt,
      },
    };
  } catch {
    return {};
  }
}

/**
 * GET /api/health — status + counters. Returns "degraded" with HTTP 503 (which
 * flips the Docker healthcheck) when the scan loop has stalled or the last
 * proven upstream contact is older than KB_HEALTH_STALE_SEC. Deliberately no
 * vehicle-count condition: 0 vehicles overnight is normal (~4:30–22:00 service).
 */
export async function GET(): Promise<Response> {
  try {
    await startPoller();
    const poller = getPoller();
    const h = poller.healthSnapshot();
    const now = Date.now() / 1000;
    // lastScan stamps once per loop iteration even when the scan throws, and the
    // supervisor restarts a crashed loop within <=300s — so 2 intervals + slack
    // of genuine silence means the loop is really stuck
    const loopStalled = h.scanCount > 0 && now - h.lastScan > 2 * poller.scanInterval + 120;
    const feedStale = now - h.lastGoodRefresh > config.HEALTH_STALE_SEC;
    const degraded = loopStalled || feedStale;
    const body: HealthResponse = {
      status: degraded ? "degraded" : "ok",
      stops: h.stops,
      scan_count: h.scanCount,
      last_scan: h.lastScan,
      vehicles: h.live,
      tracked: h.tracked,
      last_refresh: h.lastRefresh,
      last_good_refresh: h.lastGoodRefresh,
      feed_age_secs: Math.round(now - h.lastGoodRefresh),
      loop_restarts: h.loopRestarts,
      last_loop_error: h.lastLoopError,
      stops_loaded_at: h.stopsLoadedAt,
      ...safeStopsHealth(),
      shapes: safeShapesHealth(),
      stale_index: h.staleIndex,
      gps_polls: h.gpsPolls,
      gps_disagree: h.gpsDisagree,
    };
    return Response.json(body, { status: degraded ? 503 : 200 });
  } catch (err) {
    return upstreamError("health", err);
  }
}
