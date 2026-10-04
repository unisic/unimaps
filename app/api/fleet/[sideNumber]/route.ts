import { jsonWithEtag, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" };

/**
 * GET /api/fleet/[sideNumber] — one vehicle: the course it runs now, today's courses, day stats
 * and the (estimated) next course. ETag: a vehicle in the depot does not change between polls (304).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ sideNumber: string }> },
): Promise<Response> {
  try {
    await startPoller();
    const { sideNumber } = await params;
    const detail = sideNumber.length <= 16 ? getFleetTracker().getVehicleDetail(sideNumber) : null;

    if (!detail) {
      return Response.json({ error: "Vehicle not found" }, { status: 404, headers: NO_STORE });
    }

    return jsonWithEtag(req, { vehicle: detail });
  } catch (err) {
    return upstreamError("fleet-detail", err);
  }
}
