import { badRequest, internalError, isValidDate, parseCity, warming } from "@/lib/api-helpers";
import { getGzm, startGzm } from "@/lib/gzm";
import { getMergedStopsView, getShapes, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { findConnections, type ConnectionItinerary } from "@/lib/router";
import { rawTripId } from "@/lib/shape-patterns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const INT_RE = /^\d{1,4}$/;
/** RFC 5870 geo URI: `from=geo:LAT,LON` searches from a point (the rider's location, an address), `to=` to one */
const GEO_RE = /^geo:(-?\d{1,2}(?:\.\d{1,7})?),(-?\d{1,3}(?:\.\d{1,7})?)$/;
/** how far the rider walks between a query point and a stop, metres */
const WALK_MIN_M = 200;
const WALK_MAX_M = 1500;
/** GZM's feed is far larger (~22k trips a day): charge a search more so one client can't hold the event loop */
const GZM_COST = 20;

/** A `geo:` param rounded to ~11 m (one memo entry per spot, and no finer trace of the rider); null when malformed. */
function parsePoint(v: string, walkM: number | undefined): { lat: number; lon: number; walkM?: number } | null {
  const m = GEO_RE.exec(v);
  const lat = m ? Number(m[1]) : NaN;
  const lon = m ? Number(m[2]) : NaN;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, ...(walkM ? { walkM } : {}) };
}

/** Router stop ids of a merged stop: its KB pole and every MZK symbol its departures board asks
 *  (a station hub lists several). Undefined for a name the merged list does not know. */
function stopIds(key: string): string[] | undefined {
  const m = getMergedStopsView().lookup(key);
  if (!m) return undefined;
  const syms = m.mzkSymbols ?? (m.mzkSymbol ? [m.mzkSymbol] : []);
  return [...(m.kbId ? [m.kbId] : []), ...syms.map((s) => `mzk:${s}`)];
}

/** Tag each leg with its operator and attach the stored road-shape id of its trip pattern,
 *  so the client draws legs from server geometry instead of calling OSRM.
 *  Best effort — a store problem just leaves the ids off. */
function attachLegShapes(connections: ConnectionItinerary[]): void {
  for (const c of connections) {
    for (const leg of c.legs) leg.operator = String(leg.tripId).startsWith("mzk:") ? "MZK" : "KB";
  }
  try {
    const shapes = getShapes();
    for (const c of connections) {
      for (const leg of c.legs) {
        const tripId = String(leg.tripId);
        // MZK trip ids are mzk:<courseId>:<variantId>; the store keys a variant's shape mzk:<variantId>
        const key =
          leg.operator === "MZK"
            ? `mzk:${tripId.slice(tripId.lastIndexOf(":") + 1)}`
            : shapes.keyForRawTrip(rawTripId(tripId));
        const id = key ? shapes.wireId(key) : null;
        if (id) leg.shape_id = id;
      }
    }
  } catch {
    /* no shapes — legs fall back to client routing */
  }
}

/**
 * GET /api/connections?from=<stop>|geo:LAT,LON&to=<stop>|geo:LAT,LON[&walk=METRES][&time=HH:MM[&arriveBy=true]][&date=YYYY-MM-DD][&direct=true][&minTransfer=N][&sortBy=departure|duration][&limit=N]
 *
 * In-memory connection search between stops or points; `arriveBy` makes `time` the latest arrival.
 */
export async function GET(req: Request): Promise<Response> {
  // the search is synchronous CPU work on the event loop the pollers share
  const city = parseCity(req);
  if (!allowRequest(clientIp(req), city === "gzm" ? GZM_COST : 1)) return tooManyRequests();
  if (city instanceof Response) return city;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return badRequest("Invalid request URL");
  }
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const time = url.searchParams.get("time");
  const date = url.searchParams.get("date");
  const dayLabel = url.searchParams.get("dayLabel") || undefined;
  const directParam = url.searchParams.get("direct") ?? url.searchParams.get("directOnly");
  const minTransferParam = url.searchParams.get("minTransfer");
  const sortByParam = url.searchParams.get("sortBy");
  const limitParam = url.searchParams.get("limit");
  const walkParam = url.searchParams.get("walk");
  const arriveByParam = url.searchParams.get("arriveBy");

  if (!from || from.length > 100) return badRequest("Missing or invalid 'from' parameter");
  if (!to || to.length > 100) return badRequest("Missing or invalid 'to' parameter");
  const walkM = walkParam ? (INT_RE.test(walkParam) ? Number(walkParam) : NaN) : undefined;
  if (walkM !== undefined && !(walkM >= WALK_MIN_M && walkM <= WALK_MAX_M)) {
    return badRequest(`Invalid 'walk' parameter (metres, ${WALK_MIN_M} to ${WALK_MAX_M})`);
  }
  const fromPoint = from.startsWith("geo:") ? parsePoint(from, walkM) : undefined;
  if (fromPoint === null) return badRequest("Invalid 'from' location (expected geo:LAT,LON)");
  const toPoint = to.startsWith("geo:") ? parsePoint(to, walkM) : undefined;
  if (toPoint === null) return badRequest("Invalid 'to' location (expected geo:LAT,LON)");
  const arriveBy = arriveByParam === "true" || arriveByParam === "1";
  if (arriveBy && !time) return badRequest("'arriveBy' needs a 'time'");

  let afterSecs: number | undefined;
  if (time) {
    if (!TIME_RE.test(time)) return badRequest("Invalid 'time' parameter (expected HH:MM 24h format)");
    const [h, m] = time.split(":").map(Number);
    afterSecs = h * 3600 + m * 60;
  }

  if (date && !isValidDate(date)) {
    return badRequest("Invalid 'date' parameter (expected YYYY-MM-DD)");
  }

  // parseInt("abc") is NaN, which the router's defaults and clamps do not catch
  if (minTransferParam && !INT_RE.test(minTransferParam)) return badRequest("Invalid 'minTransfer' parameter (expected minutes)");
  if (limitParam && !INT_RE.test(limitParam)) return badRequest("Invalid 'limit' parameter (expected an integer)");

  const directOnly = directParam === "true" || directParam === "1";
  const minTransferSecs = minTransferParam ? Number.parseInt(minTransferParam, 10) * 60 : undefined;
  const sortBy = sortByParam === "duration" || sortByParam === "arrival" || sortByParam === "departure"
    ? sortByParam
    : undefined;
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

  if (city === "gzm") {
    void startGzm();
    try {
      const connections = getGzm().connections({ from, fromPoint, to, toPoint, afterSecs, arriveBy, limit, directOnly, minTransferSecs, date: date || undefined, dayLabel, sortBy });
      if (!connections) return warming();
      return Response.json({ count: connections.length, connections }, { headers: { "Cache-Control": "public, max-age=60" } });
    } catch (err) {
      return internalError("gzm-connections", err);
    }
  }

  try {
    // the merged stop list needs both pollers' stops; a failed start still leaves name search working
    await startPoller().catch(() => undefined);
    const connections = findConnections({
      from,
      fromPoint,
      to,
      toPoint,
      fromIds: fromPoint ? undefined : stopIds(from),
      toIds: toPoint ? undefined : stopIds(to),
      afterSecs,
      arriveBy,
      limit,
      directOnly,
      minTransferSecs,
      date: date || undefined,
      dayLabel,
      sortBy,
    });
    attachLegShapes(connections);
    return Response.json(
      { count: connections.length, connections },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  } catch (err) {
    return internalError("connections", err);
  }
}
