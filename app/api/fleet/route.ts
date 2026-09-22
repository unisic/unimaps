import { upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/fleet — Returns fleet stats and vehicles summary or single vehicle by side number.
 * Query params:
 *   - sideNumber: string (e.g. "230", "233")
 *   - status: "all" | "active" | "depot"
 *   - propulsion: "all" | "electric" | "hydrogen" | "hybrid" | "mega"
 *   - line: string
 *   - q: string (search query)
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await startPoller();
    const tracker = getFleetTracker();
    const url = new URL(req.url);

    const sideNumber = url.searchParams.get("sideNumber");
    if (sideNumber) {
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
    }

    const status = url.searchParams.get("status") as "all" | "active" | "depot" | null;
    const propulsion = url.searchParams.get("propulsion") ?? undefined;
    const line = url.searchParams.get("line") ?? undefined;
    const q = url.searchParams.get("q") ?? undefined;

    const stats = tracker.getStats();
    const vehicles = tracker.getFleetSummary({
      status: status ?? "all",
      propulsion,
      line,
      query: q,
    });

    return Response.json(
      {
        stats,
        count: vehicles.length,
        vehicles,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
        },
      },
    );
  } catch (err) {
    return upstreamError("fleet", err);
  }
}
