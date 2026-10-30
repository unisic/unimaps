/**
 * One stop's merged KB + MZK departures board, behind the 4 s micro-cache: served by
 * /api/stop/[designator]/departures and read by the web push alerts (lib/push-alerts.ts).
 */
import { pyTruthy } from "@/lib/kb-api";
import { log } from "@/lib/logger";
import { getFleetDetails } from "@/lib/mzk-fleet";
import { isMzkNotStarted, mzkRowTiming } from "@/lib/mzk-state";
import { getApi, getMergedStopsView, getMzkApi, getMzkPoller, getPoller } from "@/lib/poller-singleton";
import { departuresBoardCache, type Board } from "@/lib/departures-board-cache";
import {
  enrichKbRow,
  kbAnchorTs,
  mzkWireFields,
  preSortRows,
  type KbUpstreamRow,
  type TimingRow,
} from "@/lib/shared/departures";

/** The caller has awaited startPoller(). */
export async function stopBoard(designator: string): Promise<Board> {
  // the key carries the merged-stop identity: a late MZK list changes who is asked, so a KB-only board must not be reused
  const m = getMergedStopsView().lookup(designator);
  const key = `${designator}|${m?.operator ?? ""}|${(m?.mzkSymbols ?? (m?.mzkSymbol ? [m.mzkSymbol] : [])).join(",")}`;
  return (await departuresBoardCache.get(key, () => buildBoard(designator))).value;
}

async function buildBoard(designator: string): Promise<Board> {
  {
    const mzkPoller = getMzkPoller();
    // one shared, memoized merge (same list the client got from /api/stops): never an ad hoc re-merge
    const mergedStop = getMergedStopsView().lookup(designator);

    /* a failed upstream fetch used to look exactly like "no departures": a BOTH stop then showed one operator's rows only */
    const failed = new Set<"kb" | "mzk">();
    let failedLegs = 0; // per fetch: a hub asks several MZK symbols, one failed symbol is not a failed operator
    const fetchMzk = async (symbol: string) => {
      try {
        const mzkApi = getMzkApi();
        const rt = await mzkApi.fetchRealtime(symbol);
        return (rt.departures || []).map((d) => {
          const fleet = d.vehicleId
            ? getFleetDetails(d.vehicleId, mzkPoller.staticVehicles.get(d.vehicleId))
            : undefined;

          // Compute static departure in Europe/Warsaw
          const sH = Math.floor(d.scheduledDepartureSec / 3600) % 24;
          const sM = Math.floor((d.scheduledDepartureSec % 3600) / 60);
          const staticTime = `${String(sH).padStart(2, "0")}:${String(sM).padStart(2, "0")}`;

          // the course has not begun (bus waits at its first stop): OnTime's realDeparture is a
          // placeholder (now - scheduled start), not an estimate: show the earliest possible
          // time instead (the schedule pushed back by how long the bus already overstayed its
          // first departure; a lower bound, also the sort key) and no delay
          const running = mzkPoller.runningVehiclesMap.get(String(d.courseId));
          const firstSp = running?.stopPoints?.[0];
          const firstStop = firstSp ? mzkPoller.stopsBySymbol.get(firstSp.symbol) : undefined;
          const notStarted =
            !!running && !!firstSp && isMzkNotStarted(running, firstStop ? { lat: firstStop.lat, lon: firstStop.lon } : null);

          const { time, timeDiff, isEstimated } = mzkRowTiming({
            scheduledDepartureSec: d.scheduledDepartureSec,
            scheduledDeparture: d.scheduledDeparture,
            realDeparture: d.realDeparture,
            lack: d.lack,
            notStarted,
            firstScheduledMs: firstSp?.scheduledDeparture,
            nowMs: Date.now(),
          });

          // Register in courseMetaMap so trip resolution has line/variant/direction
          mzkPoller.noteCourse(d.courseId, {
            lineName: d.lineName,
            variantId: d.variantId,
            direction: d.directionName,
          });

          return {
            trip_execution_id: `mzk:${d.courseId}:${d.vehicleId || ""}`,
            trip_id: d.variantId ? `mzk:${d.courseId}:${d.variantId}` : `mzk:${d.courseId}`,
            static_time: staticTime,
            time,
            time_diff: timeDiff,
            is_estimated: isEstimated,
            ...(notStarted ? { not_started: true } : {}),
            direction: d.directionName,
            line_name: d.lineName,
            operator: "MZK" as const,
            symbol: d.vehicleId,
            side_number: d.vehicleId,
            model: fleet?.model,
            features: fleet?.features,
            // absolute instants (epoch s): the client sorts and counts down on these, never on "HH:MM"
            ...mzkWireFields(d),
            // a course that has not begun has NO measured ETA/delay (OnTime's is a placeholder that grows 1 s/s):
            // earliest possible instant = schedule pushed back by the overstay, never "leaving now"
            ...(notStarted
              ? {
                  eta_ts: d.scheduledDeparture / 1000 + Math.max(0, (Date.now() - (firstSp?.scheduledDeparture ?? d.scheduledDeparture)) / 1000),
                  delay_sec: null,
                  at_stop: false,
                  is_estimated: false,
                }
              : {}),
          };
        });
      } catch (err) {
        failed.add("mzk");
        failedLegs++;
        log.warn("mzk-departures", `Realtime fetch failed for symbol ${symbol}: ${err}`);
        return [];
      }
    };

    const fetchKb = async (kbDesig: string) => {
      try {
        const data = await getApi().fetchDepartures(kbDesig);
        if (pyTruthy(data) && typeof data === "object" && data !== null) {
          const rec = data as { timestamp?: unknown; directions?: unknown; rows?: KbUpstreamRow[] };
          if (Array.isArray(rec.rows)) {
            // KB's "N min" strings are relative to the moment upstream built the board
            const anchorTs = kbAnchorTs(rec.timestamp, Date.now() / 1000);
            const rows = rec.rows.map((r) => enrichKbRow(r, rec.directions, anchorTs));
            const eids = rows
              .map((r) => r?.trip_execution_id)
              .filter((eid): eid is string => Boolean(eid));
            if (eids.length > 0) {
              getPoller().addCandidates(eids);
            }
            return rows;
          }
        }
      } catch (err) {
        failed.add("kb");
        failedLegs++;
        log.warn("kb-departures", `Departures fetch failed for ${kbDesig}: ${err}`);
      }
      return [];
    };

    /* Nearest departure first. The server only pre-sorts (it cannot see the live vehicle delays);
       StopView re-sorts with the same lib/shared/departures rules after enrichment. */
    const respond = (rows: Array<Record<string, unknown>>, legs: number): Board => ({
      rows: preSortRows(rows as TimingRow[], Date.now() / 1000) as Array<Record<string, unknown>>,
      failed: [...failed],
      failedLegs,
      legs,
    });

    if (mergedStop?.operator === "BOTH" && mergedStop.kbDesignator) {
      // a station hub lists several MZK symbols (mzkSymbols); an ordinary stop has just mzkSymbol
      const symbols = mergedStop.mzkSymbols ?? (mergedStop.mzkSymbol ? [mergedStop.mzkSymbol] : []);
      const [kbRes, ...mzkRes] = await Promise.allSettled([
        fetchKb(mergedStop.kbDesignator),
        ...symbols.map((s) => fetchMzk(s)),
      ]);
      const kbRows = kbRes.status === "fulfilled" ? kbRes.value : [];
      const mzkAll = mzkRes.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      // a course can call at two stops of the same hub: keep its earliest departure only
      const seen = new Set<string>();
      const mzkRows = preSortRows(mzkAll as unknown as TimingRow[], Date.now() / 1000).filter((r) => {
        if (symbols.length <= 1) return true;
        const id = String((r as Record<string, unknown>).trip_execution_id);
        return !seen.has(id) && !!seen.add(id);
      });
      return respond([...mzkRows, ...kbRows] as Array<Record<string, unknown>>, 1 + mzkRes.length);
    }

    if (designator.startsWith("mzk:")) {
      const symbol = designator.slice(4);
      return respond(await fetchMzk(symbol), 1);
    }

    return respond(await fetchKb(designator), 1);
  }
}

