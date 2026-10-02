"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetchJSON, vehiclesFetcher } from "@/lib/client/api";
import { nowSecs } from "@/lib/client/format";
import type { LinesResponse, StopsResponse, VehiclesResponse } from "@/lib/client/types";

/** Cached SWR fetcher — honors HTTP Cache-Control headers for static catalogs */
const cachedFetcher = <T>(url: string): Promise<T> => fetchJSON<T>(url);

/** Live vehicle positions, polled every 4 s, never HTTP-cached. */
export function useVehicles() {
  return useSWR<VehiclesResponse>("/api/vehicles", vehiclesFetcher, {
    refreshInterval: 4000,
    dedupingInterval: 1500,
    keepPreviousData: true,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshWhenHidden: true,
  });
}

/** Static stop list (~950 entries) — fetched once per session, HTTP cached. */
export function useStops() {
  return useSWR<StopsResponse>("/api/stops", cachedFetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
  });
}

/** Static GTFS line catalog — fetched once per session, HTTP cached. */
export function useLines() {
  return useSWR<LinesResponse>("/api/lines", cachedFetcher, {
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
        setPos({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy });
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

  return { pos, status, locate, stop };
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
