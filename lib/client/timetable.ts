import { fetchJSON, getTripsBatch } from "@/lib/client/api";
import { getFavorites } from "@/lib/client/favorites";
import { offsetDateISO } from "@/lib/client/format";
import { loadOffline, pruneOffline, saveOffline } from "@/lib/client/offline";
import type { TimetableDeparture, TimetableResponse, Trip } from "@/lib/client/types";
import { warsawDateISO } from "@/lib/shared/departures";

export interface TtRow {
  dp: TimetableDeparture;
  line: string;
  dir: string;
}

export type Warnings = ReadonlyArray<"kb" | "mzk">;
export const NO_WARNINGS: Warnings = [];

/** One day of the stop's timetable. Absent from the map = not requested yet or still fetching.
 *  `offline`: the network failed and this is the copy saved for a favourite stop. */
export type DayLoad =
  | { status: "trips" }
  | { status: "ok"; rows: TtRow[]; warnings: Warnings; offline?: boolean }
  | { status: "error" };

/* complete days only (a day with a failed upstream leg is never cached), FIFO-capped:
   one busy hub is ~450 rows */
const timetableRowCache = new Map<string, TtRow[]>();
const TT_CACHE_MAX = 8;

const ttKey = (designator: string, date: string) => `tt/${encodeURIComponent(designator)}/${date}`;

/** One day of the timetable with every row's line and direction (KB rows carry neither: resolved via /api/trips).
 *  A complete day of a favourite stop is also saved offline and served back when the network fails. */
export async function loadDay(
  designator: string,
  date: string,
  signal: AbortSignal,
  onTrips: () => void,
): Promise<DayLoad> {
  const cacheKey = `${designator}:${date}`;
  const cached = timetableRowCache.get(cacheKey);
  if (cached) return { status: "ok", rows: cached, warnings: NO_WARNINGS };
  try {
    const d = await fetchJSON<TimetableResponse>(
      `/api/stop/${encodeURIComponent(designator)}/timetable?date=${date}`,
      { signal },
    );
    const deps = d.departures ?? [];
    onTrips();
    const neededTripIds = Array.from(
      new Set(
        deps
          .filter((dp) => !dp.line || !dp.direction)
          .map((dp) => dp.trip_id)
          .filter(Boolean),
      ),
    );
    const tripMap =
      neededTripIds.length > 0 ? await getTripsBatch(neededTripIds, signal) : new Map<string, Trip | null>();
    // getTripsBatch stops early on abort: a half-resolved day must not be cached
    if (signal.aborted) return { status: "error" };
    const rows: TtRow[] = deps.map((dp) => {
      const trip = tripMap.get(String(dp.trip_id));
      return {
        dp,
        line: dp.line || trip?.line?.name || "?",
        dir: dp.direction || trip?.direction || d.main_direction?.name || "",
      };
    });
    const warnings = d.warnings ?? NO_WARNINGS;
    if (!warnings.length) {
      timetableRowCache.set(cacheKey, rows);
      for (const k of timetableRowCache.keys()) {
        if (timetableRowCache.size <= TT_CACHE_MAX) break;
        timetableRowCache.delete(k);
      }
      if (getFavorites().includes(designator)) void saveOffline(ttKey(designator, date), rows);
    }
    return { status: "ok", rows, warnings };
  } catch {
    if (signal.aborted) return { status: "error" };
    const saved = await loadOffline<TtRow[]>(ttKey(designator, date));
    return saved ? { status: "ok", rows: saved, warnings: NO_WARNINGS, offline: true } : { status: "error" };
  }
}

const PREFETCH_KEY = "kb:ttPrefetch";
const PREFETCH_MAX = 10;

/**
 * Once a day per browser: save today's and tomorrow's timetable of the first PREFETCH_MAX favourite
 * stops, so they open without network, then drop saved days that are past or no longer favourite.
 * Sequential on purpose: at most 2 x 10 timetable fetches (plus their trip batches) a day, one at a time.
 */
export async function prefetchFavoriteTimetables(): Promise<void> {
  const today = warsawDateISO(Date.now() / 1000);
  try {
    if (window.localStorage.getItem(PREFETCH_KEY) === today) return;
  } catch {
    return; // no storage: no way to keep this to once a day
  }
  const days = [today, offsetDateISO(today, 1)];
  const favs = getFavorites().slice(0, PREFETCH_MAX);
  const signal = new AbortController().signal;
  let ok = true;
  for (const d of favs) {
    for (const date of days) {
      const res = await loadDay(d, date, signal, () => {});
      if (res.status !== "ok" || res.offline) ok = false;
    }
  }
  const keep = new Set(favs.flatMap((d) => days.map((date) => ttKey(d, date))));
  await pruneOffline((key) => !key.startsWith("tt/") || keep.has(key));
  // a failed day retries on the next load instead of waiting for tomorrow
  if (ok) {
    try {
      window.localStorage.setItem(PREFETCH_KEY, today);
    } catch {
      /* storage blocked */
    }
  }
}
