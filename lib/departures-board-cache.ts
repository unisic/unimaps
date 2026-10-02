import { createMicroCache } from "./micro-cache";

/** One built departures board (rows are already normalised/pre-sorted, see lib/shared/departures). */
export interface Board {
  rows: Array<Record<string, unknown>>;
  /** upstream legs that failed ("kb" / "mzk") */
  failed: Array<"kb" | "mzk">;
  /** how many operators were asked (1, or 2 for a BOTH stop) */
  legs: number;
}

/** N viewers of one stop cost one upstream call per 4 s; only complete boards are cached. */
export const departuresBoardCache = createMicroCache<Board>({ ttlMs: 4000, cacheable: (b) => b.failed.length === 0 });
