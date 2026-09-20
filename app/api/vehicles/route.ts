import { upstreamError } from "@/lib/api-helpers";
import { getCombinedVehicles, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/vehicles — live vehicle positions as JSON. */
export async function GET(req: Request): Promise<Response> {
  try {
    await startPoller();
    const url = new URL(req.url);
    const op = url.searchParams.get("operator");
    return Response.json(getCombinedVehicles(op), {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    });
  } catch (err) {
    return upstreamError("vehicles", err);
  }
}
