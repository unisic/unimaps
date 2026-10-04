import { jsonWithEtag, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { startPoller } from "@/lib/poller-singleton";
import { TIMELINE_SLOT_SECS } from "@/lib/shared/fleet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/fleet/timeline — today's punctuality of the running MZK fleet in 5-minute slots
 * (`points[].t` = agency seconds since midnight). A slot with no sample (night, server down)
 * is simply absent: the chart draws a gap, never an interpolated line.
 * Only the current slot moves, so most polls are a 304 (no poll timestamp in the body for that reason).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await startPoller();
    return jsonWithEtag(req, { slotSecs: TIMELINE_SLOT_SECS, points: getFleetTracker().getTimeline() });
  } catch (err) {
    return upstreamError("fleet-timeline", err);
  }
}
