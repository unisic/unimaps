import { badRequest, internalError, isValidDate, isValidId, parseCity, warming } from "@/lib/api-helpers";
import { todayLocalISO } from "@/lib/config";
import { getZb, startZb } from "@/lib/gzm";
import { lineShapeRef } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { type LineVariant, lineTimetable } from "@/lib/router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/line?name=<line>[&op=KB|MZK][&date=YYYY-MM-DD][&city=gzm]
 *
 * The line view from the static timetable: every stop pattern the line runs that day, busiest first,
 * with each trip's departure at each stop in minutes from midnight. A scan of the trip table, no upstream call.
 * `shape` is the pattern's stored road shape (wire id, null = none), so the map can draw the variant.
 */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const params = new URL(req.url).searchParams;
  const name = params.get("name") ?? "";
  const op = city !== "bb" ? "GZM" : (params.get("op") ?? "KB");
  const date = params.get("date") || todayLocalISO();
  if (!isValidId(name)) return badRequest("Invalid 'name'");
  if (op !== "KB" && op !== "MZK" && op !== "GZM") return badRequest("Invalid 'op' (KB or MZK)");
  if (!isValidDate(date)) return badRequest("Invalid 'date' (expected YYYY-MM-DD)");
  try {
    let variants: Array<Omit<LineVariant, "tripId"> & { shape: string | null }>;
    if (city !== "bb") {
      void startZb(city);
      const feed = getZb(city).currentFeed();
      if (!feed) return warming();
      variants = (lineTimetable(name, op, date, feed.router) ?? []).map(({ tripId, ...v }) => {
        const key = feed.trips.get(tripId)?.shapeId;
        return { ...v, shape: key ? feed.shapes.wireId(key) : null };
      });
    } else {
      // null: no GTFS feed built yet (a fresh volume builds it at start)
      const found = lineTimetable(name, op, date);
      if (!found) return warming();
      variants = found.map(({ tripId, ...v }) => ({
        ...v,
        shape: lineShapeRef(tripId, v.stops.map((s) => s.id), name, v.headsign),
      }));
    }
    return Response.json(
      { line: name, operator: op, date, variants },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch (err) {
    return internalError("line", err);
  }
}
