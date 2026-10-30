/**
 * Client data hooks for the /brygady page (MZK fleet, or the Metropolia GZM fleet with
 * `?city=gzm`). The wire types live in lib/shared/fleet.ts, shared with the server that builds them.
 * Every hook takes the city: "bb" keeps the plain URLs, "gzm" adds `city=gzm`.
 */
import { useEffect, useRef } from "react";
import useSWR from "swr";
import { fetchJSON, HttpError } from "./api";
import { cityUrl, loadCity } from "./city";
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

/** A request that hangs must not freeze the refresh cycle (SWR waits for it before the next one). */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * `no-cache`, not `no-store`: the browser keeps the last copy and revalidates it, so an unchanged
 * vehicle card or timeline comes back as a 304 without a body (routes that send an ETag).
 */
const fetcher = <T>(url: string): Promise<T> =>
  fetchJSON<T>(url, { cache: "no-cache", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
/**
 * The GZM list body is cached on the server and carries no serverNow: the clock comes in the
 * X-Server-Time header (epoch ms), which a 304 refreshes in the browser's stored response.
 */
const fleetFetcher = async (url: string): Promise<FleetApiResponse> => {
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

/**
 * The whole fleet (~150 rows, filtered on the client so typing never waits for the network).
 * The server state changes with the MZK poller every ~5 s; SWR pauses while the tab is hidden.
 * `background`: the list is covered by a vehicle card. It then refreshes once a minute (the
 * header clock stays under its 90 s "stale" mark) and catches up the moment the card closes.
 * ponytail: GZM is ~1 350 rows (~0.6 MB uncompressed per changed body), so it polls every 20 s;
 * a delta feed is the upgrade if that ever shows in the traffic.
 */
export function useFleet(background = false, city: FleetCity = "bb") {
  const swr = useSWR<FleetApiResponse>(cityUrl("/api/fleet", city), fleetFetcher, {
    refreshInterval: background ? 60_000 : city === "gzm" ? 20_000 : 10_000,
    dedupingInterval: 4_000,
    revalidateOnFocus: true,
  });
  const { mutate } = swr;
  // the transition, not an effect cleanup: a cleanup also runs on unmount and on StrictMode's re-mount
  const wasBackground = useRef(background);
  useEffect(() => {
    if (wasBackground.current && !background) void mutate();
    wasBackground.current = background;
  }, [background, mutate]);
  return swr;
}

/** The server does not know this side number (a mistyped or outdated link). */
export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

/**
 * Every 5 s while the vehicle runs (position, delay), every 30 s in the depot, where nothing changes
 * until it leaves (and an unchanged card is a 304). Module-level on purpose: SWR restarts its timer
 * whenever the function's identity changes, an inline arrow would postpone the poll on every render.
 */
const detailRefreshMs = (d: VehicleDetailApiResponse | undefined): number => (d && d.vehicle.status !== "active" ? 30_000 : 5_000);

/** One vehicle's day. */
export function useVehicleDetail(sideNumber: string | null, city: FleetCity = "bb") {
  const clean = sideNumber?.replace(/^#/, "").trim();
  const key = clean ? cityUrl(`/api/fleet/${encodeURIComponent(clean)}`, city) : null;
  return useSWR<VehicleDetailApiResponse>(key, fetcher, {
    refreshInterval: detailRefreshMs,
    dedupingInterval: 2_000,
    revalidateOnFocus: true,
    // a 404 does not heal by retrying
    shouldRetryOnError: (err: unknown) => !isNotFound(err),
  });
}

/** Today's punctuality timeline: one slot per 5 minutes, so a minute's refresh is plenty (mostly 304). */
export function useFleetTimeline(enabled: boolean, city: FleetCity = "bb") {
  return useSWR<FleetTimelineResponse>(enabled ? cityUrl("/api/fleet/timeline", city) : null, fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
    revalidateOnFocus: true,
  });
}

