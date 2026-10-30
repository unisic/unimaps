import { jsonWithEtag, notFound, parseCity, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { getGzmFleetTracker } from "@/lib/gzm-fleet";
import { startGzm } from "@/lib/gzm";
import { startPoller } from "@/lib/poller-singleton";
import { TIMELINE_SLOT_SECS } from "@/lib/shared/fleet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/fleet/timeline — today's punctuality of the running MZK fleet in 5-minute slots
 * (`points[].t` = agency seconds since midnight). A slot with no sample (night, server down)
 * is simply absent: the chart draws a gap, never an interpolated line.
 * Only the current slot moves, so most polls are a 304 (no poll timestamp in the body for that reason).
 * `?city=gzm`: the Metropolia GZM fleet.
 */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (city !== "bb" && city !== "gzm") return notFound();
  try {
    if (city === "gzm") {
      void startGzm();
      return jsonWithEtag(req, { slotSecs: TIMELINE_SLOT_SECS, points: getGzmFleetTracker().getTimeline() });
    }
    await startPoller();
    return jsonWithEtag(req, { slotSecs: TIMELINE_SLOT_SECS, points: getFleetTracker().getTimeline() });
  } catch (err) {
    return upstreamError("fleet-timeline", err);
  }
}
