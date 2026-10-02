import { badRequest, isValidDate, isValidId, upstreamError } from "@/lib/api-helpers";
import { todayLocalISO } from "@/lib/config";
import { pyTruthy } from "@/lib/kb-api";
import { log } from "@/lib/logger";
import { getApi, getMergedStopsView, getMzkApi, getMzkPoller, startPoller } from "@/lib/poller-singleton";
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

    const mzkPoller = getMzkPoller();
    // one shared, memoized merge (same list the client got from /api/stops) — never an ad hoc re-merge
    const mergedStop = getMergedStopsView().lookup(designator);

    /* a failed upstream fetch used to look like "no departures today" — and the 200 was cached for 15 min */
    const failed = new Set<"kb" | "mzk">();
    const respond = (body: object): Response =>
      Response.json(
        { ...body, ...(failed.size ? { warnings: [...failed] } : {}) },
        { headers: { "Cache-Control": failed.size ? "no-store" : "public, max-age=900" } },
      );

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
        failed.add("mzk");
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
        failed.add("kb");
        log.warn("kb-timetable", `Timetable fetch failed for ${kbDesig}: ${err}`);
      }
      return { departures: [] };
    };

    if (mergedStop?.operator === "BOTH" && mergedStop.kbDesignator) {
      const symbols = mergedStop.mzkSymbols ?? (mergedStop.mzkSymbol ? [mergedStop.mzkSymbol] : []);
      const [kbRes, ...mzkRes] = await Promise.allSettled([
        fetchKb(mergedStop.kbDesignator),
        ...symbols.map((s) => fetchMzk(s)),
      ]);
      const kbData = kbRes.status === "fulfilled" ? kbRes.value : { departures: [] };
      const kbDeps = kbData.departures || [];
      const seen = new Set<string>();
      const mzkDeps = mzkRes
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .sort((a, b) => a.departure - b.departure)
        // a course can call at two stops of the same hub: keep its earliest departure only
        .filter((d) => (symbols.length > 1 ? !seen.has(String(d.trip_id)) && !!seen.add(String(d.trip_id)) : true));
      const combined = [...mzkDeps, ...kbDeps].sort((a, b) => a.departure - b.departure);
      return respond({ departures: combined, main_direction: kbData.main_direction });
    }

    if (designator.startsWith("mzk:")) {
      const symbol = designator.slice(4);
      const departures = await fetchMzk(symbol);
      return respond({ departures });
    }

    const kbData = await fetchKb(designator);
    return respond(kbData);
  } catch (err) {
    return upstreamError("timetable", err);
  }
}
