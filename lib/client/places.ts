"use client";

/**
 * Saved places (Dom, Praca) and saved routes of the connection search, per
 * city: a module-level localStorage store like favorites.ts. A place is a stop
 * (designator) or a point (an address, or where the rider stood when saving);
 * it never leaves the browser except as the search's own `from=geo:` / `to=geo:` point.
 */
import { useSyncExternalStore } from "react";

import { cityKey, type City } from "@/lib/client/city";

export type Place = { designator: string } | { lat: number; lon: number; label: string };
export type PlaceSlot = "home" | "work";
export interface SavedRoute {
  from: Place;
  to: Place;
}
export interface Places {
  home?: Place;
  work?: Place;
  routes: readonly SavedRoute[];
}

const MAX_ROUTES = 10;
const EMPTY: Places = { routes: [] };
const keyOf = (city: City) => cityKey("kb:places", city);

function isPlace(v: unknown): v is Place {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.designator === "string") return true;
  return Number.isFinite(o.lat) && Number.isFinite(o.lon) && typeof o.label === "string";
}

function load(city: City): Places {
  try {
    const raw = window.localStorage.getItem(keyOf(city));
    if (!raw) return EMPTY;
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object") return EMPTY;
    const { home, work, routes } = o as Record<string, unknown>;
    return {
      ...(isPlace(home) ? { home } : {}),
      ...(isPlace(work) ? { work } : {}),
      routes: Array.isArray(routes)
        ? routes
            // a route saved before points could be destinations ends at a designator string
            .map((r) => (typeof r?.to === "string" ? { ...r, to: { designator: r.to } } : r))
            .filter((r): r is SavedRoute => isPlace(r?.from) && isPlace(r?.to))
            .slice(0, MAX_ROUTES)
        : [],
    };
  } catch {
    return EMPTY;
  }
}

/* one page shows one city for its life, but the store stays keyed by it so a stale
   snapshot can never cross over; each snapshot keeps its reference until a change */
const snapshots = new Map<City, Places>();
const subs = new Set<() => void>();

function getSnapshot(city: City): Places {
  let s = snapshots.get(city);
  if (!s) snapshots.set(city, (s = load(city)));
  return s;
}

function mutate(city: City, next: Places): void {
  snapshots.set(city, next);
  try {
    window.localStorage.setItem(keyOf(city), JSON.stringify(next));
  } catch {
    /* private mode / quota: keep the in-memory state */
  }
  subs.forEach((fn) => fn());
}

function onStorage(e: StorageEvent): void {
  if (e.key === null || e.key.startsWith("kb:places")) {
    snapshots.clear();
    subs.forEach((f) => f());
  }
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (subs.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    subs.delete(fn);
    if (subs.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export const samePlace = (a: Place, b: Place) => JSON.stringify(a) === JSON.stringify(b);
const sameRoute = (a: SavedRoute, b: SavedRoute) => samePlace(a.to, b.to) && samePlace(a.from, b.from);

export function setPlace(city: City, slot: PlaceSlot, place: Place): void {
  mutate(city, { ...getSnapshot(city), [slot]: place });
}

export function hasRoute(places: Places, route: SavedRoute): boolean {
  return places.routes.some((r) => sameRoute(r, route));
}

/** Save the route (newest first, the oldest past MAX_ROUTES drops) or remove it if saved. */
export function toggleRoute(city: City, route: SavedRoute): void {
  const cur = getSnapshot(city);
  const routes = hasRoute(cur, route)
    ? cur.routes.filter((r) => !sameRoute(r, route))
    : [route, ...cur.routes].slice(0, MAX_ROUTES);
  mutate(city, { ...cur, routes });
}

export function usePlaces(city: City): Places {
  return useSyncExternalStore(subscribe, () => getSnapshot(city), () => EMPTY);
}
