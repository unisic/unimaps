import type { FleetFuelType } from "@/lib/shared/fleet";

/** "late" is a subset of "active": a running vehicle at least 3 min behind (classifyDelay late or veryLate) */
export type StatusFilter = "all" | "active" | "late" | "waiting" | "depot";
export type FleetSort = "line" | "side" | "delay" | "km" | "built";
/** the vehicle cards, or one row per model */
export type FleetView = "list" | "models";

export interface FleetFilters {
  q: string;
  status: StatusFilter;
  fuel: "all" | FleetFuelType;
  /** "" = every line */
  line: string;
  /** "" = every model, else the exact FleetSummaryItem.model */
  model: string;
  sort: FleetSort;
  view: FleetView;
}

export const DEFAULT_FILTERS: FleetFilters = { q: "", status: "all", fuel: "all", line: "", model: "", sort: "line", view: "list" };

/** What "Wyczyść filtry" resets: the sort and the view stay. */
export const CLEARED: Pick<FleetFilters, "q" | "status" | "fuel" | "line" | "model"> = { q: "", status: "all", fuel: "all", line: "", model: "" };

export function hasActiveFilters(f: FleetFilters): boolean {
  return f.q.trim() !== "" || f.status !== "all" || f.fuel !== "all" || f.line !== "" || f.model !== "";
}
