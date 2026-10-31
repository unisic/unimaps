import { badRequest, internalError, isValidId, notFound, upstreamError, warming, zbEnabled, zbIdCity } from "@/lib/api-helpers";
import { getZb, startZb } from "@/lib/gzm";
import { startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { groupBoard, stopBoard, stopGroup } from "@/lib/stop-board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/stop/[designator]/departures[?all=1]: upstream departures passthrough for KB & MZK, local feed for a
 * zbiorkom city. `all=1` = the whole stop (every same-name pole nearby, each row's `pole` says which); `poles` =
 * the stop's pole count, sent when it has more than one.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ designator: string }> },
): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const { designator } = await ctx.params;
  if (!isValidId(designator)) return badRequest("Invalid stop designator");
  const allParam = new URL(req.url).searchParams.get("all");
  if (allParam !== null && allParam !== "1") return badRequest("Invalid all");
  const all = allParam === "1";
  const slug = zbIdCity(designator);
  if (slug) {
    if (!zbEnabled(slug)) return notFound();
    void startZb(slug);
    try {
      // built from the local feed + the live join: no upstream leg, so never `warnings`
      const board = getZb(slug).departures(designator, all);
      if (board === null) return warming();
      if (board === "unknown") return notFound("Unknown stop");
      return Response.json(board, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" } });
    } catch (err) {
      return internalError("gzm-departures", err);
    }
  }
  try {
    await startPoller();
    const group = stopGroup(designator);
    const whole = all && group.length > 1;
    // a whole-stop board asks upstream once per pole: one rate-limit token each
    if (whole && !allowRequest(clientIp(req), group.length - 1)) return tooManyRequests();
    const board = whole ? await groupBoard(group) : await stopBoard(designator);
    // every upstream leg failed: an honest 502, not a 200 "no departures" that blanks a populated list
    if (board.failedLegs >= board.legs) throw new Error(`all ${board.legs} upstream leg(s) failed (${board.failed.join(",")})`);
    return Response.json(
      {
        rows: board.rows,
        server_ts: Date.now() / 1000,
        ...(group.length > 1 ? { poles: group.length } : {}),
        ...(board.failed.length ? { warnings: board.failed } : {}),
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" } },
    );
  } catch (err) {
    return upstreamError("departures", err);
  }
}
