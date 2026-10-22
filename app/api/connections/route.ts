import { badRequest, internalError, isValidDate } from "@/lib/api-helpers";
import { getMergedStopsView, getShapes, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { findConnections, type ConnectionItinerary } from "@/lib/router";
import { rawTripId } from "@/lib/shape-patterns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const INT_RE = /^\d{1,4}$/;

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
 * GET /api/connections?from=...&to=...[&time=HH:MM][&date=YYYY-MM-DD][&direct=true][&minTransfer=N][&sortBy=departure|duration][&limit=N]
 *
 * In-memory connection search between two stops.
 */
export async function GET(req: Request): Promise<Response> {
  // the search is synchronous CPU work on the event loop the pollers share
  if (!allowRequest(clientIp(req))) return tooManyRequests();
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

  if (!from || from.length > 100) return badRequest("Missing or invalid 'from' parameter");
  if (!to || to.length > 100) return badRequest("Missing or invalid 'to' parameter");

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

  try {
    // the merged stop list needs both pollers' stops; a failed start still leaves name search working
    await startPoller().catch(() => undefined);
    const connections = findConnections({
      from,
      to,
      fromIds: stopIds(from),
      toIds: stopIds(to),
      afterSecs,
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
