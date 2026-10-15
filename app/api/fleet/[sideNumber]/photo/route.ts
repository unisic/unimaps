import { badRequest, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { findVehiclePhotos } from "@/lib/phototrans";
import { startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/fleet/[sideNumber]/photo — the vehicle's newest phototrans photos, newest first (`photos: []`
 * when it has none). Only side numbers of the live MZK fleet reach phototrans.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ sideNumber: string }> },
): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const { sideNumber } = await params;
  if (!/^\d{1,5}$/.test(sideNumber)) return badRequest("Invalid side number");
  try {
    await startPoller();
    if (!getFleetTracker().getVehicleDetail(sideNumber)) {
      return Response.json({ error: "Vehicle not found" }, { status: 404 });
    }
    const photos = await findVehiclePhotos(sideNumber);
    return Response.json({ photos }, { headers: { "Cache-Control": "public, max-age=21600" } });
  } catch (err) {
    return upstreamError("phototrans", err);
  }
}
