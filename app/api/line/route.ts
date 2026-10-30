import { badRequest, internalError, isValidDate, isValidId, parseCity, warming } from "@/lib/api-helpers";
import { todayLocalISO } from "@/lib/config";
import { getGzm, startGzm } from "@/lib/gzm";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { lineTimetable } from "@/lib/router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/line?name=<line>[&op=KB|MZK][&date=YYYY-MM-DD][&city=gzm]
 *
 * The line view from the static timetable: every stop pattern the line runs that day, busiest first,
 * with each trip's departure at each stop in minutes from midnight. A scan of the trip table, no upstream call.
 */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const params = new URL(req.url).searchParams;
  const name = params.get("name") ?? "";
  const op = city === "gzm" ? "GZM" : (params.get("op") ?? "KB");
  const date = params.get("date") || todayLocalISO();
  if (!isValidId(name)) return badRequest("Invalid 'name'");
  if (op !== "KB" && op !== "MZK" && op !== "GZM") return badRequest("Invalid 'op' (KB or MZK)");
  if (!isValidDate(date)) return badRequest("Invalid 'date' (expected YYYY-MM-DD)");
  try {
    let variants;
    if (city === "gzm") {
      void startGzm();
      const feed = getGzm().currentFeed();
      if (!feed) return warming();
      variants = lineTimetable(name, op, date, feed.router);
    } else {
      // null: no GTFS feed built yet (a fresh volume builds it at start)
      variants = lineTimetable(name, op, date);
      if (!variants) return warming();
    }
    return Response.json(
      { line: name, operator: op, date, variants: variants ?? [] },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch (err) {
    return internalError("line", err);
  }
}
