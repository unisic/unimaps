import { badRequest, isValidDate, isValidId, upstreamError } from "@/lib/api-helpers";
import { todayLocalISO } from "@/lib/config";
import { pyTruthy } from "@/lib/kb-api";
import { log } from "@/lib/logger";
import { getApi, getMzkApi, getMzkPoller, getPoller, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import type { TimetableDeparture, TimetableResponse } from "@/lib/client/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/stop/[designator]/timetable?date=YYYY-MM-DD — upstream timetable passthrough for KB & MZK. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ designator: string }> },
): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const { designator } = await ctx.params;
  if (!isValidId(designator)) return badRequest("Invalid stop designator");
  const date = new URL(req.url).searchParams.get("date") || todayLocalISO();
  if (!isValidDate(date)) return badRequest("date must be YYYY-MM-DD");

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

    const fetchMzk = async (symbol: string): Promise<TimetableDeparture[]> => {
      try {
        const mzkApi = getMzkApi();
        const sched = await mzkApi.fetchAtomicSchedule(symbol, date);
        const departures: TimetableDeparture[] = [];
        const lineSchedules = sched.lineSchedules || {};

        for (const lineData of Object.values(lineSchedules)) {
          const lineName = lineData.lineName;
          const dest = lineData.destination;
          for (const dep of lineData.departures || []) {
            const tripId = `mzk:${dep.courseId}${dep.variantId ? `:${dep.variantId}` : ""}`;
            const direction = dep.optionalDirection || dest || "";
            departures.push({
              trip_id: tripId,
              departure: dep.scheduledDepartureSec,
              line: lineName,
              direction,
              operator: "MZK",
            });
            // Cache metadata for trip detail resolution
            mzkPoller.courseMetaMap.set(dep.courseId, {
              lineName,
              variantId: dep.variantId,
              direction,
            });
          }
        }

        departures.sort((a, b) => a.departure - b.departure);
        return departures;
      } catch (err) {
        log.warn("mzk-timetable", `Atomic schedule fetch failed for symbol ${symbol}: ${err}`);
        return [];
      }
    };

    const fetchKb = async (kbDesig: string): Promise<TimetableResponse> => {
      try {
        const data = await getApi().fetchTimetable(kbDesig, date);
        if (pyTruthy(data) && typeof data === "object" && data !== null) {
          const rec = data as { departures?: TimetableDeparture[]; main_direction?: { name?: string } };
          const deps = (rec.departures || []).map((d) => ({
            ...d,
            operator: "KB" as const,
          }));
          return { departures: deps, main_direction: rec.main_direction };
        }
      } catch (err) {
        log.warn("kb-timetable", `Timetable fetch failed for ${kbDesig}: ${err}`);
      }
      return { departures: [] };
    };

    if (mergedStop?.operator === "BOTH" && mergedStop.mzkSymbol && mergedStop.kbDesignator) {
      const [mzkRes, kbRes] = await Promise.allSettled([
        fetchMzk(mergedStop.mzkSymbol),
        fetchKb(mergedStop.kbDesignator),
      ]);
      const mzkDeps = mzkRes.status === "fulfilled" ? mzkRes.value : [];
      const kbData = kbRes.status === "fulfilled" ? kbRes.value : { departures: [] };
      const kbDeps = kbData.departures || [];
      const combined = [...mzkDeps, ...kbDeps].sort((a, b) => a.departure - b.departure);
      return Response.json(
        { departures: combined, main_direction: kbData.main_direction },
        { headers: { "Cache-Control": "public, max-age=900" } },
      );
    }

    if (designator.startsWith("mzk:")) {
      const symbol = designator.slice(4);
      const departures = await fetchMzk(symbol);
      return Response.json(
        { departures },
        { headers: { "Cache-Control": "public, max-age=900" } },
      );
    }

    const kbData = await fetchKb(designator);
    return Response.json(kbData, {
      headers: { "Cache-Control": "public, max-age=900" },
    });
  } catch (err) {
    return upstreamError("timetable", err);
  }
}
