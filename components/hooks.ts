"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { fetchJSON, vehiclesFetcher } from "@/lib/client/api";
import { CITY, CityContext, cityUrl } from "@/lib/client/city";
import { nowSecs } from "@/lib/client/format";
import { loadOffline, saveOffline } from "@/lib/client/offline";
import type { LinesResponse, StopsResponse, VehiclesResponse } from "@/lib/client/types";

/** Cached SWR fetcher — honors HTTP Cache-Control headers for static catalogs */
const cachedFetcher = <T>(url: string): Promise<T> => fetchJSON<T>(url);

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

/** Live vehicle positions, polled every 4 s (GZM: 5 s, ~0.7 MB a poll), never HTTP-cached. */
export function useVehicles() {
  const city = useContext(CityContext);
  // stable identity: SWR restarts its timer whenever this option changes. Bounded: an upstream that keeps failing
  // drops back to the normal pace after 3 attempts
  const refreshInterval = useCallback(
    (d?: VehiclesResponse) => (!d || (!d.timestamp && d.scan_count < 3) ? WARMING_MS : CITY[city].vehiclesRefreshMs),
    [city],
  );
  return useSWR<VehiclesResponse>(cityUrl("/api/vehicles", city), vehiclesFetcher, {
    refreshInterval,
    dedupingInterval: 1500,
    keepPreviousData: true,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    // a background tab stops downloading the fleet; focus/visibility revalidation catches up at once
    refreshWhenHidden: false,
  });
}

/**
 * Merged stop list (~1300 entries). Revalidated cheaply (ETag → 304) on focus (at most once a minute) and every 15 min — and every 20 s
 * while the server says one operator's stops are still missing (`partial`): a page that lives for days (iOS PWA)
 * must not keep the list it got while the MZK stops were still loading, or from before an upstream data change.
 * SWR ignores focus events during the first `focusThrottleInterval` after mount, hence the interval refresh.
 * An unchanged payload keeps its identity (SWR compares deeply), so the 4 s heartbeat tree never re-renders for it.
 */
export function useStops() {
  const city = useContext(CityContext);
  return useSWR<StopsResponse>(cityUrl("/api/stops", city), stopsFetcher, {
    revalidateOnFocus: true,
    focusThrottleInterval: 60_000,
    revalidateOnReconnect: true,
    refreshInterval: (latest) => (latest?.partial ? 20_000 : 15 * 60_000),
    keepPreviousData: true,
  });
}

/** Static GTFS line catalog — fetched once per session, HTTP cached. */
export function useLines() {
  const city = useContext(CityContext);
  return useSWR<LinesResponse>(cityUrl("/api/lines", city), cachedFetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
  });
}

/** md breakpoint as state — drives sheet-vs-panel layout decisions in JS. */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
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
 * Browser geolocation as a live watch. Never auto-starts (privacy) — the caller
 * triggers `locate()` from a user gesture. Once granted, the position updates
 * continuously (blue dot follows you) until the component unmounts.
 */
export function useGeolocation() {
  const [pos, setPos] = useState<GeoPos | null>(null);
  const [status, setStatus] = useState<GeoStatus>("idle");
  const watchId = useRef<number | null>(null);

  const locate = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("error");
      return;
    }
    // already watching → keep the fix, caller re-centers on the current pos
    // (resync status so a transient error before the first fix doesn't leave
    //  the button stuck outside the active/locating states forever)
    if (watchId.current != null) {
      setStatus((s) => (s === "error" ? "locating" : s));
      return;
    }
    setStatus("locating");
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        const h = p.coords.heading;
        setPos({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
          heading: h != null && Number.isFinite(h) ? h : undefined,
        });
        setStatus("active");
      },
      (err) => {
        // Permission denied is terminal — stop the watch. TIMEOUT and
        // POSITION_UNAVAILABLE are transient: watchPosition can still recover
        // on a later fix, so keep it running (and keep an existing fix "active").
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
          if (watchId.current != null) {
            navigator.geolocation.clearWatch(watchId.current);
            watchId.current = null;
          }
          return;
        }
        setStatus((s) => (s === "active" ? "active" : "error"));
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
  }, []);

  /** Stop the watch and clear the fix — lets the user turn GPS off (battery). */
  const stop = useCallback(() => {
    if (watchId.current != null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId.current);
    }
    watchId.current = null;
    setStatus("idle");
    setPos(null);
  }, []);

  useEffect(
    () => () => {
      if (watchId.current != null && typeof navigator !== "undefined" && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId.current);
      }
    },
    [],
  );

  // stable while nothing changes: callers' useCallback([geo]) props stay memo()-safe across polls
  return useMemo(() => ({ pos, status, locate, stop }), [pos, status, locate, stop]);
}

/** Seconds since midnight, refreshed every `intervalMs` — keeps countdowns fresh. */
export function useNow(intervalMs = 15000): number {
  const [now, setNow] = useState(nowSecs());
  useEffect(() => {
    const id = setInterval(() => setNow(nowSecs()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
