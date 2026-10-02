import { badRequest } from "@/lib/api-helpers";
import { getShapes } from "@/lib/poller-singleton";
import { findConnections, type ConnectionItinerary } from "@/lib/router";
import { rawTripId } from "@/lib/shape-patterns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Attach the stored road-shape id to each leg whose trip pattern is routed,
 *  so the client draws legs from server geometry instead of calling OSRM.
 *  Best effort — a store problem just leaves the ids off. */
function attachLegShapes(connections: ConnectionItinerary[]): void {
  try {
    const shapes = getShapes();
    for (const c of connections) {
      for (const leg of c.legs) {
        const key = shapes.keyForRawTrip(rawTripId(String(leg.tripId)));
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

  if (date && !DATE_RE.test(date)) {
    return badRequest("Invalid 'date' parameter (expected YYYY-MM-DD)");
  }

  const directOnly = directParam === "true" || directParam === "1";
  const minTransferSecs = minTransferParam ? Math.max(0, Number.parseInt(minTransferParam, 10) * 60) : undefined;
  const sortBy = sortByParam === "duration" || sortByParam === "arrival" || sortByParam === "departure"
    ? sortByParam
    : undefined;
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

  try {
    const connections = findConnections({
      from,
      to,
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
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
