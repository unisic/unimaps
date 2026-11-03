import { upstreamError } from "@/lib/api-helpers";
import { cityStatus } from "@/lib/city-status";
import { startPoller } from "@/lib/poller-singleton";

/** GET /api/status: whether each city's live data is flowing (lib/city-status.ts), swept at most every 2 min. */
export async function GET(): Promise<Response> {
  try {
    await startPoller();
    return Response.json(await cityStatus(), { headers: { "Cache-Control": "no-cache" } });
  } catch (err) {
    return upstreamError("status", err);
  }
}
