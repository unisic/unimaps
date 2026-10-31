import { badRequest, jsonWithEtag, notFound, parseCity, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { GZM_SIDE_RE, getGzmFleetTracker, gzmIdleDetail } from "@/lib/gzm-fleet";
import { getGzm, startGzm } from "@/lib/gzm";
import { startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" };

/**
 * GET /api/fleet/[sideNumber] — one vehicle: the course it runs now, today's courses, day stats
 * and the (estimated) next course. ETag: a vehicle in the depot does not change between polls (304).
 * `?city=gzm`: a Metropolia GZM vehicle, sideNumber "<company code>_<fleet number>".
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
    let detail;
    if (city === "gzm") {
      if (!GZM_SIDE_RE.test(sideNumber)) return badRequest("Invalid sideNumber");
      void startGzm();
      detail = getGzmFleetTracker().getVehicleDetail(sideNumber);
      // on the map but never seen on a course: an idle card instead of "unknown vehicle"
      if (!detail) {
        const live = getGzm().liveVehicle(sideNumber);
        if (live) detail = gzmIdleDetail(sideNumber, live);
      }
    } else {
      await startPoller();
      detail = sideNumber.length <= 16 ? getFleetTracker().getVehicleDetail(sideNumber) : null;
    }

    if (!detail) {
      return Response.json({ error: "Vehicle not found" }, { status: 404, headers: NO_STORE });
    }

    return jsonWithEtag(req, { vehicle: detail });
  } catch (err) {
    return upstreamError("fleet-detail", err);
  }
}
