import { jsonWithEtag, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker } from "@/lib/fleet-tracker";
import { startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" };

/**
 * GET /api/fleet — MZK fleet overview: day stats + one summary row per vehicle.
 * The /brygady page fetches the whole fleet (~150 rows) and filters on the client; the
 * optional filters stay for scripts and links.
 * Query params:
 *   - sideNumber: string (e.g. "230") — one vehicle's detail instead (same as /api/fleet/<side>)
 *   - status: "all" | "active" | "depot"
 *   - propulsion: "all" | "electric" | "hydrogen" | "hybrid" | "mega"
 *   - line: string
 *   - q: string (side number, line, model, direction or stop; diacritics folded)
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await startPoller();
    const tracker = getFleetTracker();
    const url = new URL(req.url);

    const sideNumber = url.searchParams.get("sideNumber");
    if (sideNumber) {
      const detail = sideNumber.length <= 16 ? tracker.getVehicleDetail(sideNumber) : null;
      if (!detail) {
        return Response.json({ error: "Vehicle not found" }, { status: 404, headers: NO_STORE });
      }
      return jsonWithEtag(req, { vehicle: detail });
    }

    const status = url.searchParams.get("status");
    const vehicles = tracker.getFleetSummary({
      status: status === "active" || status === "depot" ? status : "all",
      propulsion: url.searchParams.get("propulsion") ?? undefined,
      line: url.searchParams.get("line") ?? undefined,
      query: url.searchParams.get("q")?.slice(0, 64) ?? undefined,
    });

    return Response.json({ stats: tracker.getStats(), count: vehicles.length, vehicles }, { headers: NO_STORE });
  } catch (err) {
    return upstreamError("fleet", err);
  }
}
