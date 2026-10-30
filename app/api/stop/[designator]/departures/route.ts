import { badRequest, internalError, isValidId, notFound, upstreamError, warming, zbEnabled, zbIdCity } from "@/lib/api-helpers";
import { getZb, startZb } from "@/lib/gzm";
import { startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { stopBoard } from "@/lib/stop-board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/stop/[designator]/departures — upstream departures passthrough for KB & MZK. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ designator: string }> },
): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const { designator } = await ctx.params;
  if (!isValidId(designator)) return badRequest("Invalid stop designator");
  const slug = zbIdCity(designator);
  if (slug) {
    if (!zbEnabled(slug)) return notFound();
    void startZb(slug);
    try {
      // built from the local feed + the live join: no upstream leg, so never `warnings`
      const board = getZb(slug).departures(designator);
      if (board === null) return warming();
      if (board === "unknown") return notFound("Unknown stop");
      return Response.json(board, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" } });
    } catch (err) {
      return internalError("gzm-departures", err);
    }
  }
  try {
    await startPoller();
    const board = await stopBoard(designator);
    // every upstream leg failed: an honest 502, not a 200 "no departures" that blanks a populated list
    if (board.failedLegs >= board.legs) throw new Error(`all ${board.legs} upstream leg(s) failed (${board.failed.join(",")})`);
    return Response.json(
      { rows: board.rows, server_ts: Date.now() / 1000, ...(board.failed.length ? { warnings: board.failed } : {}) },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" } },
    );
  } catch (err) {
    return upstreamError("departures", err);
  }
}
