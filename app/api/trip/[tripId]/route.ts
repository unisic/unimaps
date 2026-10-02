import { badRequest, isValidId, upstreamError } from "@/lib/api-helpers";
import { parseIntStrict, pyTruthy } from "@/lib/kb-api";
import { getApi, kbShapeRef, startPoller } from "@/lib/poller-singleton";
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
      if (!mzkTrip) {
        return Response.json({}, { headers: { "Cache-Control": "public, max-age=300" } });
      }
      const tripObj = {
        ...(mzkTrip.trip as Record<string, unknown>),
        shape: mzkTrip.shape,
        ...(mzkTrip.shape_id ? { shape_id: mzkTrip.shape_id } : {}),
        shape_status: mzkTrip.shape_status,
      };
      return Response.json(tripObj, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }
    const data = await getApi().fetchTripRaw(tripId, index);
    if (!pyTruthy(data) || !data || typeof data !== "object") {
      return Response.json({}, { headers: { "Cache-Control": "public, max-age=3600" } });
    }
    // `data` is the shared 4 h cache object — spread, never mutate
    const ref = kbShapeRef(data);
    return Response.json(
      { ...(data as Record<string, unknown>), ...ref },
      // a pending road shape is usually ready within minutes — don't pin the status for an hour
      { headers: { "Cache-Control": `public, max-age=${ref.shape_status === "pending" ? 300 : 3600}` } },
    );
  } catch (err) {
    return upstreamError("trip", err);
  }
}
