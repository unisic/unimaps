import * as config from "@/lib/config";
import { upstreamError } from "@/lib/api-helpers";
import { getPoller, getShapes, startPoller } from "@/lib/poller-singleton";
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
      shapes: safeShapesHealth(),
    };
    return Response.json(body, { status: degraded ? 503 : 200 });
  } catch (err) {
    return upstreamError("health", err);
  }
}
