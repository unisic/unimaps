/** The /api/status wire body (backend/src/city_status.rs builds it, components/StatusApp.svelte reads it). */
import type { ZbSlug } from "./cities";

/** ok = positions coming in, empty = upstream answers with no vehicle (normal at night), down = no valid answer */
export type SourceState = "ok" | "empty" | "down";

export interface SourceStatus {
  name: string;
  state: SourceState;
  vehicles: number;
  /** seconds since the newest position (zbiorkom) or the last good poll (BB); null = not known */
  age: number | null;
  /** why it is down: "HTTP <code>", "timeout", "network error" or "invalid response" */
  error?: string;
}

export interface CityStatus {
  city: "bb" | ZbSlug;
  name: string;
  sources: SourceStatus[];
}

export interface StatusBody {
  /** epoch seconds of the sweep */
  checked_at: number;
  cities: CityStatus[];
}
