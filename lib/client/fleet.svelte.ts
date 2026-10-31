/**
 * The /brygady polls (lib/client/swr.svelte.ts). Arguments are getters: call these while a component
 * initialises, they follow the arguments for as long as it lives.
 */
import { swr } from "@/lib/client/swr.svelte";

import { cityUrl } from "./city";
import {
  fetcher,
  fleetFetcher,
  isNotFound,
  type FleetApiResponse,
  type FleetCity,
  type FleetTimelineResponse,
  type VehicleDetailApiResponse,
} from "./fleet";

/**
 * The whole fleet (~150 rows, filtered on the client so typing never waits for the network).
 * The server state changes with the MZK poller every ~5 s; the poll pauses while the tab is hidden.
 * `background`: the list is covered by a vehicle card. It then refreshes once a minute (the
 * header clock stays under its 90 s "stale" mark) and catches up the moment the card closes.
 * ponytail: GZM is ~1 350 rows (~0.6 MB uncompressed per changed body), so it polls every 20 s;
 * a delta feed is the upgrade if that ever shows in the traffic.
 */
export function useFleet(background: () => boolean, city: FleetCity = "bb") {
  const fleet = swr<FleetApiResponse>(() => cityUrl("/api/fleet", city), fleetFetcher, {
    refreshInterval: () => (background() ? 60_000 : city === "gzm" ? 20_000 : 10_000),
    dedupingInterval: 4_000,
  });
  // the transition, not an effect cleanup: a cleanup also runs on unmount
  let wasBackground = background();
  $effect(() => {
    const bg = background();
    if (wasBackground && !bg) void fleet.mutate();
    wasBackground = bg;
  });
  return fleet;
}

/**
 * Every 5 s while the vehicle runs (position, delay), every 30 s in the depot, where nothing changes
 * until it leaves (and an unchanged card is a 304).
 */
const detailRefreshMs = (d: VehicleDetailApiResponse | undefined): number => (d && d.vehicle.status !== "active" ? 30_000 : 5_000);

/** One vehicle's day. */
export function useVehicleDetail(sideNumber: () => string | null, city: FleetCity = "bb") {
  const key = () => {
    const clean = sideNumber()?.replace(/^#/, "").trim();
    return clean ? cityUrl(`/api/fleet/${encodeURIComponent(clean)}`, city) : null;
  };
  return swr<VehicleDetailApiResponse>(key, fetcher, {
    refreshInterval: detailRefreshMs,
    dedupingInterval: 2_000,
    // a 404 does not heal by retrying
    shouldRetryOnError: (err: unknown) => !isNotFound(err),
  });
}

/** Today's punctuality timeline: one slot per 5 minutes, so a minute's refresh is plenty (mostly 304). */
export function useFleetTimeline(enabled: () => boolean, city: FleetCity = "bb") {
  return swr<FleetTimelineResponse>(() => (enabled() ? cityUrl("/api/fleet/timeline", city) : null), fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
  });
}

