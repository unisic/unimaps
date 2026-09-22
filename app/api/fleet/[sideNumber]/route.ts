import { upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/fleet/[sideNumber] — Returns comprehensive brigade and course history for vehicle.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sideNumber: string }> },
): Promise<Response> {
  try {
    await startPoller();
    const { sideNumber } = await params;
    const tracker = getFleetTracker();
    const detail = tracker.getVehicleDetail(sideNumber);

    if (!detail) {
      return Response.json({ error: "Vehicle not found" }, { status: 404 });
    }

    return Response.json(
      { vehicle: detail },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
        },
      },
    );
  } catch (err) {
    return upstreamError("fleet-detail", err);
  }
}
