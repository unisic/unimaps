/**
 * Client data hooks for the /brygady page (MZK fleet, or the Metropolia GZM fleet with
 * `?city=gzm`). The wire types live in lib/shared/fleet.ts, shared with the server that builds them.
 * Every hook takes the city: "bb" keeps the plain URLs, "gzm" adds `city=gzm`.
 */
import { fetchJSON, HttpError } from "./api";
import { loadCity } from "./city";
import type { FleetStats, FleetSummaryItem, FleetTimelinePoint, FleetVehicleDetail } from "../shared/fleet";

export type * from "../shared/fleet";

/** the fleet tracker exists for BB (MZK) and GZM only */
export type FleetCity = "bb" | "gzm";

/**
 * The city /brygady shows: `?city=gzm` first, then the map's stored choice (`kb:city`), else BB.
 * Read once per page load (switching city is a navigation); client only.
 */
export function readBrygadyCity(search: string): FleetCity {
  if (new URLSearchParams(search).get("city") === "gzm") return "gzm";
  return loadCity() === "gzm" ? "gzm" : "bb";
}

/** The city of a side number: GZM keys are "<company code>_<fleet number>", MZK ones digits only. */
export function cityOfSide(side: string): FleetCity {
  return side.includes("_") ? "gzm" : "bb";
}

export interface FleetApiResponse {
  stats: FleetStats;
  count: number;
  vehicles: FleetSummaryItem[];
  /** server epoch s when the body was built (GZM: from the X-Server-Time header, see fleetFetcher) */
  serverNow?: number;
  /** client-only: local epoch s when the body arrived (stamped by fleetFetcher) */
  receivedAt?: number;
}

/** `stats.updatedAt` on this device's clock, so a skewed device clock cannot fake a stale feed. */
export function localUpdatedAt(d: FleetApiResponse): number {
  const { updatedAt } = d.stats;
  return updatedAt > 0 && d.serverNow && d.receivedAt ? updatedAt + (d.receivedAt - d.serverNow) : updatedAt;
}

export interface VehicleDetailApiResponse {
  vehicle: FleetVehicleDetail;
}

export interface FleetTimelineResponse {
  slotSecs: number;
  points: FleetTimelinePoint[];
}

/** A request that hangs must not freeze the refresh cycle (the poll waits for it before the next one). */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * `no-cache`, not `no-store`: the browser keeps the last copy and revalidates it, so an unchanged
 * vehicle card or timeline comes back as a 304 without a body (routes that send an ETag).
 */
export const fetcher = <T>(url: string): Promise<T> =>
  fetchJSON<T>(url, { cache: "no-cache", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
/**
 * The GZM list body is cached on the server and carries no serverNow: the clock comes in the
 * X-Server-Time header (epoch ms), which a 304 refreshes in the browser's stored response.
 */
export const fleetFetcher = async (url: string): Promise<FleetApiResponse> => {
  const r = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!r.ok) throw new HttpError(r.status, url);
  const d = (await r.json()) as FleetApiResponse;
  const serverMs = Number(r.headers.get("x-server-time"));
  return {
    ...d,
    ...(d.serverNow === undefined && serverMs > 0 ? { serverNow: serverMs / 1000 } : {}),
    receivedAt: Date.now() / 1000,
  };
};

/** The server does not know this side number (a mistyped or outdated link). */
export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}
