import { createMicroCache } from "./micro-cache";

/** One built departures board (rows are already normalised/pre-sorted, see lib/shared/departures). */
export interface Board {
  rows: Array<Record<string, unknown>>;
  /** upstream legs that failed ("kb" / "mzk") */
  failed: Array<"kb" | "mzk">;
  /** how many upstream fetches failed (a hub's MZK symbols count one each) */
  failedLegs: number;
  /** how many upstream fetches were made (KB + one per MZK symbol) */
  legs: number;
}

/** N viewers of one stop cost one upstream call per 4 s; only complete boards are cached. */
export const departuresBoardCache = createMicroCache<Board>({ ttlMs: 4000, cacheable: (b) => b.failed.length === 0 });
