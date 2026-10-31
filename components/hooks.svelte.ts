import { fetchJSON, vehiclesFetcher } from "@/lib/client/api";
import { CITY, cityUrl, getPageCity } from "@/lib/client/city";
import { nowSecs } from "@/lib/client/format";
import { loadOffline, saveOffline } from "@/lib/client/offline";
import { swr } from "@/lib/client/swr.svelte";
import type { LinesResponse, StopsResponse, VehiclesResponse } from "@/lib/client/types";

/* the last complete stop list is kept offline (at most one write per 10 min, focus revalidates up to
   once a minute) and answers when the network fails, so an offline start still has stops and favourites */
const STOPS_SAVE_MS = 10 * 60_000;
let stopsSavedAt = 0;
async function stopsFetcher(url: string): Promise<StopsResponse> {
  // one city per page load, so the shared save throttle never mixes two lists
  const slug = /[?&]city=([a-z]+)/i.exec(url)?.[1];
  const key = slug ? `stops-${slug.toLowerCase()}` : "stops";
  try {
    const body = await fetchJSON<StopsResponse>(url);
    if (!body.partial && Date.now() - stopsSavedAt > STOPS_SAVE_MS) {
      stopsSavedAt = Date.now();
      void saveOffline(key, body);
    }
    return body;
  } catch (e) {
    const saved = await loadOffline<StopsResponse>(key);
    if (saved) return saved;
    throw e;
  }
}

/** Poll pace before the first answer and while the server has had no good upstream poll yet (process start, a
 *  zbiorkom city's first visit); the 1.5 s dedupe makes anything shorter ~2 s anyway. */
const WARMING_MS = 2000;

/** Live vehicle positions, polled every 4 s (GZM: 5 s, ~0.7 MB a poll), never HTTP-cached. Bounded warm-up:
 *  an upstream that keeps failing drops back to the normal pace after 3 attempts. */
export function useVehicles() {
  const city = getPageCity();
  return swr<VehiclesResponse>(() => cityUrl("/api/vehicles", city), vehiclesFetcher, {
    refreshInterval: (d) => (!d || (!d.timestamp && d.scan_count < 3) ? WARMING_MS : CITY[city].vehiclesRefreshMs),
    dedupingInterval: 1500,
  });
}

/**
 * Merged stop list (~1300 entries). Revalidated cheaply (ETag → 304) on focus (at most once a minute) and every 15 min, and
 * every 20 s while the server says one operator's stops are still missing (`partial`): a page that lives for days (iOS PWA)
 * must not keep the list it got while the MZK stops were still loading, or from before an upstream data change.
 * An unchanged payload keeps its identity, so the 4 s heartbeat tree never re-renders for it.
 */
export function useStops() {
  const city = getPageCity();
  return swr<StopsResponse>(() => cityUrl("/api/stops", city), stopsFetcher, {
    focusThrottleInterval: 60_000,
    refreshInterval: (latest) => (latest?.partial ? 20_000 : 15 * 60_000),
  });
}

/** Static GTFS line catalog: fetched once per session, HTTP cached. */
export function useLines() {
  const city = getPageCity();
  return swr<LinesResponse>(() => cityUrl("/api/lines", city), (url) => fetchJSON<LinesResponse>(url), {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
  });
}

export interface GeoPos {
  lat: number;
  lon: number;
  accuracy: number;
  /** degrees clockwise from north, only while moving (the API gives NaN/null standing still) */
  heading?: number;
}

export type GeoStatus = "idle" | "locating" | "active" | "denied" | "error";

/**
 * Browser geolocation as a live watch. Never auto-starts (privacy): the caller triggers `locate()` from a
 * user gesture. Once granted, the position updates continuously (blue dot follows you) until `stop()` or
 * the owning component is destroyed.
 */
export function useGeolocation() {
  let pos = $state.raw<GeoPos | null>(null);
  let status = $state<GeoStatus>("idle");
  let watchId: number | null = null;

  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      status = "error";
      return;
    }
    // already watching: keep the fix, the caller re-centers on the current pos (resync status so a transient
    // error before the first fix doesn't leave the button stuck outside the active/locating states forever)
    if (watchId != null) {
      if (status === "error") status = "locating";
      return;
    }
    status = "locating";
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        const h = p.coords.heading;
        pos = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
          heading: h != null && Number.isFinite(h) ? h : undefined,
        };
        status = "active";
      },
      (err) => {
        // Permission denied is terminal: stop the watch. TIMEOUT and POSITION_UNAVAILABLE are transient:
        // watchPosition can still recover on a later fix, so keep it running (and keep an existing fix "active").
        if (err.code === err.PERMISSION_DENIED) {
          status = "denied";
          if (watchId != null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
          }
          return;
        }
        if (status !== "active") status = "error";
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
  };

  /** Stop the watch and clear the fix: lets the user turn GPS off (battery). */
  const stop = () => {
    if (watchId != null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
    status = "idle";
    pos = null;
  };

  $effect(() => () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
  });

  return {
    get pos() {
      return pos;
    },
    get status() {
      return status;
    },
    locate,
    stop,
  };
}

/** Seconds since midnight, refreshed every `intervalMs`: keeps countdowns fresh. */
export function useNow(intervalMs = 15000): { readonly current: number } {
  let now = $state(nowSecs());
  $effect(() => {
    const id = setInterval(() => (now = nowSecs()), intervalMs);
    return () => clearInterval(id);
  });
  return {
    get current() {
      return now;
    },
  };
}
