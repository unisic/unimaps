/**
 * The ONE place that turns the pollers' KB + MZK stop lists into the merged stop list, its JSON body
 * and the alias lookup. Used by GET /api/stops and by the departures / timetable routes, so they can
 * never disagree about which stops are BOTH (the routes used to re-merge ad hoc with a differently
 * formatted input and overwrite a process-global registry).
 *
 * Memoized on the identity of its inputs: the pollers swap their `stops` arrays atomically on every
 * reload, so a recompute happens exactly when something changed — including "MZK stops arrived late".
 */
import { createHash } from "node:crypto";
import type { Stop, StopsResponse } from "./types";
import { indexMergedStops, mergeStops, type FormattedStop } from "./stop-merge";

/** a bus station by name (KB and MZK classify with the same rule, see MERGE_HUB_M) */
export const STATION_NAME_RE = /(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i;
/** KB has no request-stop flag, its names end in "NŻ" ("na żądanie") instead */
const REQUEST_NAME_RE = /\sNŻ$/iu;

export function formatKbStops(stops: readonly Stop[], dirs: ReadonlyMap<string, number[]>): FormattedStop[] {
  return stops.map((s) => {
    const isStn = s.showPlatforms || STATION_NAME_RE.test(s.name);
    const d = isStn ? undefined : dirs.get(s.stopId);
    return {
      id: s.stopId,
      designator: s.urlId,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      operator: "KB" as const,
      ...(d && d.length ? { dirs: d } : {}),
      ...(isStn ? { isStation: true } : {}),
      ...(s.showPlatforms ? { showPlatforms: true } : {}),
      ...(REQUEST_NAME_RE.test(s.name) ? { onRequest: true } : {}),
    };
  });
}

/** MZK stops carry NO `dirs` on the wire (arrows stay a KB/GTFS feature); learned bearings only steer the pairing. */
export function formatMzkStops(stops: readonly Stop[]): FormattedStop[] {
  return stops.map((s) => ({
    id: s.stopId,
    designator: s.urlId,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    operator: "MZK" as const,
    symbol: s.symbol,
    ...(s.isStation ? { isStation: true } : {}),
    ...(s.onRequest ? { onRequest: true } : {}),
    ...(s.gettingOut ? { gettingOut: true } : {}),
  }));
}

export interface MergedInput {
  kb: readonly Stop[];
  mzk: readonly Stop[];
  /** KB GTFS-derived bearings by stopId (getStopDirections()) */
  kbDirs: ReadonlyMap<string, number[]>;
  /** MZK learned bearings by symbol — MzkStopDirs.dirs(), which keeps its identity until a bearing changes */
  mzkDirs: ReadonlyMap<string, readonly number[]>;
}

export interface MergedSummary {
  both: number;
  kb: number;
  mzk: number;
  /** inputs behind this merge */
  kbStops: number;
  mzkStops: number;
  mzkDirStops: number;
  builtAt: number;
}

export interface MergedView {
  stops: FormattedStop[];
  /** JSON.stringify(StopsResponse) */
  body: string;
  etag: string;
  /** true while one operator's list is still missing — clients must revalidate it every time and re-fetch soon */
  partial: boolean;
  summary: MergedSummary;
  /** by KB designator / id, "mzk:<symbol>", bare MZK symbol (the primary symbol of a station hub) */
  lookup(key: string): FormattedStop | undefined;
}

export function createMergedStopsCache(now: () => number = Date.now): (input: MergedInput) => MergedView {
  let last: { in: MergedInput; view: MergedView } | null = null;
  return (input) => {
    if (
      last &&
      last.in.kb === input.kb &&
      last.in.mzk === input.mzk &&
      last.in.kbDirs === input.kbDirs &&
      last.in.mzkDirs === input.mzkDirs
    ) {
      return last.view;
    }
    const stops = mergeStops(formatKbStops(input.kb, input.kbDirs), formatMzkStops(input.mzk), {
      mzkDirs: input.mzkDirs,
    });
    const partial = input.kb.length === 0 || input.mzk.length === 0;
    const response: StopsResponse = { count: stops.length, stops, ...(partial ? { partial: true } : {}) };
    const body = JSON.stringify(response);
    const index = indexMergedStops(stops);
    const count = (op: string) => stops.reduce((n, s) => n + (s.operator === op ? 1 : 0), 0);
    const view: MergedView = {
      stops,
      body,
      etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`,
      partial,
      summary: {
        both: count("BOTH"),
        kb: count("KB"),
        mzk: count("MZK"),
        kbStops: input.kb.length,
        mzkStops: input.mzk.length,
        mzkDirStops: input.mzkDirs.size,
        builtAt: Math.floor(now() / 1000),
      },
      lookup: (key) => index.get(key),
    };
    last = { in: input, view };
    return view;
  };
}
