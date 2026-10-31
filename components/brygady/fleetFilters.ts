import type { FleetFuelType } from "@/lib/shared/fleet";

export type StatusFilter = "all" | "active" | "waiting" | "depot";
export type FleetSort = "line" | "side" | "delay" | "km";

export interface FleetFilters {
  q: string;
  status: StatusFilter;
  fuel: "all" | FleetFuelType;
  /** "" = every line */
  line: string;
  sort: FleetSort;
}

export const DEFAULT_FILTERS: FleetFilters = { q: "", status: "all", fuel: "all", line: "", sort: "line" };

export function hasActiveFilters(f: FleetFilters): boolean {
  return f.q.trim() !== "" || f.status !== "all" || f.fuel !== "all" || f.line !== "";
}
