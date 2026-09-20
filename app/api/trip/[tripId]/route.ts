import { badRequest, isValidId, upstreamError } from "@/lib/api-helpers";
import { parseIntStrict, pyTruthy } from "@/lib/kb-api";
import { getApi, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/trip/[tripId]?index=0 — upstream trip detail passthrough. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ tripId: string }> },
): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const { tripId } = await ctx.params;
  if (!isValidId(tripId)) return badRequest("Invalid trip id");
  const rawIndex = new URL(req.url).searchParams.get("index");
  const index = rawIndex === null ? 0 : parseIntStrict(rawIndex);
  if (index === null) return badRequest("index must be an integer");
  try {
    await startPoller();
    if (tripId.startsWith("mzk:")) {
      const { resolveMzkTrip } = await import("@/lib/mzk-trip");
      const mzkTrip = await resolveMzkTrip(tripId);
      return Response.json(mzkTrip ? (mzkTrip.trip || {}) : {}, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }
    const data = await getApi().fetchTripRaw(tripId, index);
    return Response.json(pyTruthy(data) ? data : {}, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    return upstreamError("trip", err);
  }
}
