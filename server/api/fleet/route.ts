import { badRequest, etagMatches, jsonWithEtag, notFound, parseCity, upstreamError } from "@/lib/api-helpers";
import { getFleetTracker, type FleetTracker } from "@/lib/fleet-tracker";
import { GZM_SIDE_RE, getGzmFleetTracker, gzmFleetListBody } from "@/lib/gzm-fleet";
import { startGzm } from "@/lib/gzm";
import { startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" };

const FILTER_PARAMS = ["status", "propulsion", "line", "q"] as const;

function summaryFilter(url: URL): Parameters<FleetTracker["getFleetSummary"]>[0] {
  const status = url.searchParams.get("status");
  return {
    status: status === "active" || status === "depot" ? status : "all",
    propulsion: url.searchParams.get("propulsion") ?? undefined,
    line: url.searchParams.get("line") ?? undefined,
    query: url.searchParams.get("q")?.slice(0, 64) ?? undefined,
  };
}

/**
 * GET /api/fleet — MZK fleet overview: day stats + one summary row per vehicle.
 * The /brygady page fetches the whole fleet (~150 rows) and filters on the client; the
 * optional filters stay for scripts and links.
 * Query params:
 *   - city: "gzm": the Metropolia GZM fleet instead (~1 350 rows, sideNumber "<company>_<fleet>")
 *   - sideNumber: string (e.g. "230") — one vehicle's detail instead (same as /api/fleet/<side>)
 *   - status: "all" | "active" | "depot"
 *   - propulsion: "all" | "electric" | "hydrogen" | "hybrid" | "mega"
 *   - line: string
 *   - q: string (side number, line, model, direction or stop; diacritics folded)
 */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (city !== "bb" && city !== "gzm") return notFound();
  try {
    const url = new URL(req.url);
    if (city === "gzm") {
      void startGzm();
      return gzmFleet(req, url);
    }

    await startPoller();
    const tracker = getFleetTracker();

    const sideNumber = url.searchParams.get("sideNumber");
    if (sideNumber) {
      const detail = sideNumber.length <= 16 ? tracker.getVehicleDetail(sideNumber) : null;
      if (!detail) {
        return Response.json({ error: "Vehicle not found" }, { status: 404, headers: NO_STORE });
      }
      return jsonWithEtag(req, { vehicle: detail });
    }

    const vehicles = tracker.getFleetSummary(summaryFilter(url));

    return Response.json(
      { stats: tracker.getStats(), count: vehicles.length, vehicles, serverNow: Date.now() / 1000 },
      { headers: NO_STORE },
    );
  } catch (err) {
    return upstreamError("fleet", err);
  }
}

/**
 * The unfiltered GZM list is the same body for every client between two poller updates, so it is
 * built and hashed once per update (lib/gzm-fleet.ts). It carries no serverNow (a cached body would
 * hold a stale one): the clock goes in X-Server-Time (epoch ms) on the 200 and on the 304.
 */
function gzmFleet(req: Request, url: URL): Response {
  const tracker = getGzmFleetTracker();
  const sideNumber = url.searchParams.get("sideNumber");
  if (sideNumber) {
    if (!GZM_SIDE_RE.test(sideNumber)) return badRequest("Invalid sideNumber");
    const detail = tracker.getVehicleDetail(sideNumber);
    if (!detail) return Response.json({ error: "Vehicle not found" }, { status: 404, headers: NO_STORE });
    return jsonWithEtag(req, { vehicle: detail });
  }

  if (FILTER_PARAMS.some((k) => url.searchParams.has(k))) {
    const vehicles = tracker.getFleetSummary(summaryFilter(url));
    return jsonWithEtag(req, { stats: tracker.getStats(), count: vehicles.length, vehicles });
  }

  const { body, etag } = gzmFleetListBody();
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    ETag: etag,
    "X-Server-Time": String(Date.now()),
  };
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
