import { badRequest, jsonWithEtag, notFound, parseCity, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { GZM_SIDE_RE, getGzmFleetTracker } from "@/lib/gzm-fleet";
import { startGzm } from "@/lib/gzm";
import { startPoller } from "@/lib/poller-singleton";

/**
 * GET /api/fleet/[sideNumber]/history: the vehicle's past days (MZK up to 28, GZM up to 14),
 * newest first, each with its courses by scheduled start. Changes once a day, so the ETag
 * answers most requests with a 304. `complete: false` while the day files are still being read.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ sideNumber: string }> },
): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (city !== "bb" && city !== "gzm") return notFound();
  try {
    const { sideNumber } = await params;
    if (city === "gzm") {
      if (!GZM_SIDE_RE.test(sideNumber)) return badRequest("Invalid sideNumber");
      void startGzm();
      return jsonWithEtag(req, getGzmFleetTracker().vehicleHistory(sideNumber));
    }
    if (sideNumber.length > 16) return badRequest("Invalid sideNumber");
    await startPoller();
    return jsonWithEtag(req, getFleetTracker().vehicleHistory(sideNumber));
  } catch (err) {
    return upstreamError("fleet-history", err);
  }
}
