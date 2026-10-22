/**
 * Client data hooks for the /brygady page (MZK fleet). The wire types live in
 * lib/shared/fleet.ts, shared with the server that builds them.
 */
import { useEffect, useRef } from "react";
import useSWR from "swr";
import { fetchJSON, HttpError } from "./api";
import type { FleetStats, FleetSummaryItem, FleetTimelinePoint, FleetVehicleDetail, VehiclePhoto } from "../shared/fleet";

export type * from "../shared/fleet";

export interface FleetApiResponse {
  stats: FleetStats;
  count: number;
  vehicles: FleetSummaryItem[];
  /** server epoch s when the body was built */
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
const fleetFetcher = (url: string): Promise<FleetApiResponse> =>
  fetcher<FleetApiResponse>(url).then((d) => ({ ...d, receivedAt: Date.now() / 1000 }));

/**
 * The whole fleet (~150 rows, filtered on the client so typing never waits for the network).
 * The server state changes with the MZK poller every ~5 s; SWR pauses while the tab is hidden.
 * `background`: the list is covered by a vehicle card. It then refreshes once a minute (the
 * header clock stays under its 90 s "stale" mark) and catches up the moment the card closes.
 */
export function useFleet(background = false) {
  const swr = useSWR<FleetApiResponse>("/api/fleet", fleetFetcher, {
    refreshInterval: background ? 60_000 : 10_000,
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
export function useVehicleDetail(sideNumber: string | null) {
  const clean = sideNumber?.replace(/^#/, "").trim();
  return useSWR<VehicleDetailApiResponse>(clean ? `/api/fleet/${encodeURIComponent(clean)}` : null, fetcher, {
    refreshInterval: detailRefreshMs,
    dedupingInterval: 2_000,
    revalidateOnFocus: true,
    // a 404 does not heal by retrying
    shouldRetryOnError: (err: unknown) => !isNotFound(err),
  });
}

/** Today's punctuality timeline: one slot per 5 minutes, so a minute's refresh is plenty (mostly 304). */
export function useFleetTimeline(enabled: boolean) {
  return useSWR<FleetTimelineResponse>(enabled ? "/api/fleet/timeline" : null, fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
    revalidateOnFocus: true,
  });
}

/** The vehicle's phototrans photos: fetched once per card, the server caches them for a day. */
export function useVehiclePhotos(sideNumber: string | null) {
  return useSWR<{ photos: VehiclePhoto[] }>(sideNumber ? `/api/fleet/${encodeURIComponent(sideNumber)}/photo` : null, fetcher, {
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });
}
