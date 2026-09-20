import { badRequest, isValidId, upstreamError } from "@/lib/api-helpers";
import { pyTruthy } from "@/lib/kb-api";
import { getFleetDetails } from "@/lib/mzk-fleet";
import { getApi, getMzkApi, getMzkPoller, getPoller, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

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
  try {
    await startPoller();

    const poller = getPoller();
    const mzkPoller = getMzkPoller();
    const { getMergedStop, mergeStops } = await import("@/lib/stop-merge");
    type WireStop = import("@/lib/types").WireStop;
    let mergedStop = getMergedStop(designator);
    if (!mergedStop && (poller.stops.length > 0 || mzkPoller.stops.length > 0)) {
      const kbFormatted: WireStop[] = poller.stops.map((s) => ({
        id: s.stopId,
        designator: s.urlId,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        operator: "KB",
        dirs: s.dirs,
        isStation: s.isStation,
        showPlatforms: s.showPlatforms,
      }));
      const mzkFormatted: WireStop[] = mzkPoller.stops.map((s) => ({
        id: s.stopId,
        designator: s.urlId,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        operator: "MZK",
        symbol: s.symbol,
        isStation: s.isStation,
        onRequest: s.onRequest,
        gettingOut: s.gettingOut,
      }));
      mergeStops(kbFormatted, mzkFormatted);
      mergedStop = getMergedStop(designator);
    }

    const fetchMzk = async (symbol: string) => {
      const mzkApi = getMzkApi();
      const rt = await mzkApi.fetchRealtime(symbol);
      return (rt.departures || []).map((d) => {
        const fleet = d.vehicleId
          ? getFleetDetails(d.vehicleId, mzkPoller.staticVehicles.get(d.vehicleId))
          : undefined;

        const date = new Date(d.scheduledDeparture);
        const hh = String(date.getHours()).padStart(2, "0");
        const mm = String(date.getMinutes()).padStart(2, "0");
        const staticTime = `${hh}:${mm}`;

        let time = staticTime;
        let timeDiff = 0;
        let isEstimated = false;
        if (d.realDeparture && !d.lack) {
          timeDiff = Math.round((d.realDeparture - d.scheduledDeparture) / 1000);
          const rDate = new Date(d.realDeparture);
          time = `${String(rDate.getHours()).padStart(2, "0")}:${String(rDate.getMinutes()).padStart(2, "0")}`;
          isEstimated = Math.abs(timeDiff) >= 10;
        }

        return {
          trip_execution_id: `mzk:${d.courseId}:${d.vehicleId || ""}`,
          trip_id: d.courseId,
          static_time: staticTime,
          time,
          time_diff: timeDiff,
          is_estimated: isEstimated,
          direction: d.directionName,
          line_name: d.lineName,
          operator: "MZK" as const,
          symbol: d.vehicleId,
          side_number: d.vehicleId,
          model: fleet?.model,
          features: fleet?.features,
        };
      });
    };

    const fetchKb = async (kbDesig: string) => {
      const data = await getApi().fetchDepartures(kbDesig);
      if (pyTruthy(data) && typeof data === "object" && data !== null) {
        const rec = data as {
          rows?: Array<{
            trip_execution_id?: string;
            operator?: string;
            time?: string;
            static_time?: string;
            [key: string]: unknown;
          }>;
        };
        if (Array.isArray(rec.rows)) {
          rec.rows.forEach((r) => {
            r.operator = "KB";
          });
          const eids = rec.rows
            .map((r) => r?.trip_execution_id)
            .filter((eid): eid is string => Boolean(eid));
          if (eids.length > 0) {
            getPoller().addCandidates(eids);
          }
          return rec.rows;
        }
      }
      return [];
    };

    const parseRowSecs = (row: { time?: unknown; static_time?: unknown }) => {
      const t = typeof row.time === "string" ? row.time : typeof row.static_time === "string" ? row.static_time : "";
      if (!t) return 999999;
      if (t.includes(":")) {
        const parts = t.split(":");
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        if (!isNaN(h) && !isNaN(m)) return h * 3600 + m * 60;
      }
      const minMatch = t.match(/(\d+)\s*min/);
      if (minMatch) {
        const now = new Date();
        const curSec = now.getHours() * 3600 + now.getMinutes() * 60;
        return curSec + parseInt(minMatch[1], 10) * 60;
      }
      return 999999;
    };

    if (mergedStop?.operator === "BOTH" && mergedStop.mzkSymbol && mergedStop.kbDesignator) {
      const [mzkRes, kbRes] = await Promise.allSettled([
        fetchMzk(mergedStop.mzkSymbol),
        fetchKb(mergedStop.kbDesignator),
      ]);
      const mzkRows = mzkRes.status === "fulfilled" ? mzkRes.value : [];
      const kbRows = kbRes.status === "fulfilled" ? kbRes.value : [];
      const combined = [...mzkRows, ...kbRows].sort((a, b) => parseRowSecs(a) - parseRowSecs(b));
      return Response.json(
        { rows: combined },
        {
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            Pragma: "no-cache",
          },
        },
      );
    }

    if (designator.startsWith("mzk:")) {
      const symbol = designator.slice(4);
      const rows = await fetchMzk(symbol);
      return Response.json(
        { rows },
        {
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            Pragma: "no-cache",
          },
        },
      );
    }

    const kbRows = await fetchKb(designator);
    return Response.json({ rows: kbRows }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    });
  } catch (err) {
    return upstreamError("departures", err);
  }
}

