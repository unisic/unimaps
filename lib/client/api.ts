import type { City } from "./city";
import type { ConnectionItinerary, ConnectionsResponse, LatLng, Trip, VehiclesResponse } from "./types";

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** 503 "Data is loading": the server is still loading the GZM feed (seconds after a start). Transient. */
export function isWarming(err: unknown): boolean {
  return err instanceof HttpError && err.status === 503;
}

export async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new HttpError(r.status, url);
  return (await r.json()) as T;
}

/**
 * Receive time (performance.now) and server clock (X-Server-Time, epoch ms) of
 * each /api/vehicles payload, keyed by its `vehicles` array — the motion
 * engine maps the server's fix times onto the local clock with it. A side
 * table rather than a body field, so unchanged payloads still dedupe in SWR.
 */
export const vehiclesClock = new WeakMap<object, { recvPerf: number; serverMs: number | null }>();

export async function vehiclesFetcher(url: string): Promise<VehiclesResponse> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new HttpError(r.status, url);
  const recvPerf = performance.now();
  const st = Number(r.headers.get("x-server-time"));
  const body = (await r.json()) as VehiclesResponse;
  if (body && Array.isArray(body.vehicles)) {
    vehiclesClock.set(body.vehicles, { recvPerf, serverMs: Number.isFinite(st) && st > 0 ? st : null });
  }
  return body;
}

/* ---------- trip cache (dedupes concurrent + repeated fetches) ---------- */

/** Cap a Map to `max` entries, evicting oldest-inserted keys (cheap FIFO). */
function capMap<V>(m: Map<string, V>, max: number): void {
  if (m.size <= max) return;
  for (const k of m.keys()) {
    if (m.size <= max) break;
    m.delete(k);
  }
}

const tripCache = new Map<string, Promise<Trip | null>>();
const TRIP_CACHE_MAX = 1500;
/* ids whose last fetch got a 503 (GZM feed still loading), so the trip view can say so; only filled
   during those first seconds, cleared on the next answer */
const warmingTrips = new Set<string>();
const WARMING_MAX = 200;

/** True when the last getTrip of this id failed because the server is still loading its data. */
export function tripWarming(tripId: string | number): boolean {
  return warmingTrips.has(String(tripId));
}

export function getTrip(tripId: string | number, signal?: AbortSignal): Promise<Trip | null> {
  const key = String(tripId);
  const hit = tripCache.get(key);
  if (hit) return hit;
  // This promise is SHARED by every concurrent caller. Never let it reject: a
  // rethrown AbortError from the first caller's signal would poison the promise
  // for everyone else awaiting it (e.g. leaving MapApp's trip stuck loading).
  // Retry transient 429 (rate-limited) bursts with backoff, resolve null on
  // final failure and drop the key so a later caller retries.
  const fetchWithRetry = async (retries = 2, delayMs = 150): Promise<Trip | null> => {
    try {
      const tr = await fetchJSON<Trip>(`/api/trip/${encodeURIComponent(key)}`, { signal });
      warmingTrips.delete(key);
      // a still-routing road shape will be ready soon — don't pin "pending" for the session
      if (!tr?.times?.length || tr.shape_status === "pending") tripCache.delete(key);
      return tr;
    } catch (err: unknown) {
      if (retries > 0 && err instanceof HttpError && err.status === 429 && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return fetchWithRetry(retries - 1, delayMs * 2);
      }
      tripCache.delete(key);
      if (!isWarming(err)) warmingTrips.delete(key);
      else if (warmingTrips.size < WARMING_MAX) warmingTrips.add(key);
      return null;
    }
  };
  const p = fetchWithRetry();
  tripCache.set(key, p);
  capMap(tripCache, TRIP_CACHE_MAX);
  return p;
}

interface TripsBatchResponse {
  count: number;
  trips: Record<string, Trip>;
}

/**
 * Resolves multiple trips in a single network round-trip via /api/trips,
 * falling back to individual getTrip on network/5xx errors (not on abort or 429:
 * ids left unresolved are simply absent from the map).
 */
export async function getTripsBatch(
  tripIds: Array<string | number>,
  signal?: AbortSignal,
): Promise<Map<string, Trip | null>> {
  const result = new Map<string, Trip | null>();
  const missing: string[] = [];

  for (const tid of tripIds) {
    const key = String(tid);
    const hit = tripCache.get(key);
    if (hit) {
      result.set(key, await hit);
    } else {
      missing.push(key);
    }
  }

  if (!missing.length) return result;

  const BATCH_SIZE = 100;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    if (signal?.aborted) break;
    const chunk = missing.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetchJSON<TripsBatchResponse>(
        `/api/trips?ids=${chunk.map(encodeURIComponent).join(",")}`,
        { signal },
      );
      for (const id of chunk) {
        const tr = res.trips?.[id] ?? null;
        if (tr && tr.shape_status !== "pending") tripCache.set(id, Promise.resolve(tr));
        result.set(id, tr);
      }
    } catch (err) {
      // abort: the caller is gone; 429: one getTrip per id would multiply the throttled requests
      if (signal?.aborted || (err instanceof HttpError && err.status === 429)) break;
      await Promise.all(
        chunk.map(async (id) => {
          const tr = await getTrip(id, signal);
          result.set(id, tr);
        }),
      );
    }
  }

  capMap(tripCache, TRIP_CACHE_MAX);
  return result;
}

/* ---------- OSRM road-following segments ---------- */

const OSRM = "https://router.project-osrm.org/route/v1/driving";
const routeCache = new Map<string, Promise<LatLng[] | null>>();
const ROUTE_CACHE_MAX = 200;
/** the public demo host can accept a socket and never answer; the cached promise must settle */
const OSRM_TIMEOUT_MS = 8_000;

interface OsrmResponse {
  routes?: Array<{ geometry?: { coordinates?: Array<[number, number]> } }>;
}

async function fetchChunkRoute(points: LatLng[]): Promise<LatLng[]> {
  if (points.length < 2) return points;
  const key = points.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(";");
  const hit = routeCache.get(key);
  if (hit) {
    const res = await hit;
    if (res && res.length >= 2) return res;
  }
  const p = (async (): Promise<LatLng[] | null> => {
    const coords = points.map((pt) => `${pt[1]},${pt[0]}`).join(";");

    // Standard road routing with continue_straight=true to prevent unnatural U-turns
    // at intermediate bus stops, without artificial bearing constraints that force
    // routes onto parallel residential alleys and detour loops at turns (e.g. line 115).
    try {
      const d = await fetchJSON<OsrmResponse>(
        `${OSRM}/${coords}?overview=full&geometries=geojson&continue_straight=true`,
        { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) },
      );
      const line = d.routes?.[0]?.geometry?.coordinates;
      if (line && line.length) return line.map((c): LatLng => [c[1], c[0]]);
    } catch {
      // continue_straight fallback
    }

    // Fallback: standard OSRM call
    try {
      const d = await fetchJSON<OsrmResponse>(`${OSRM}/${coords}?overview=full&geometries=geojson`, {
        signal: AbortSignal.timeout(OSRM_TIMEOUT_MS),
      });
      const line = d.routes?.[0]?.geometry?.coordinates;
      if (line && line.length) return line.map((c): LatLng => [c[1], c[0]]);
    } catch {
      // fall back to straight line for this chunk
    }
    routeCache.delete(key);
    return null;
  })();
  routeCache.set(key, p);
  capMap(routeCache, ROUTE_CACHE_MAX);
  const res = await p;
  return res && res.length >= 2 ? res : points;
}

/**
 * Road geometry through `points` ([lat, lon]). Splits longer routes into
 * overlapping chunks (max 12 waypoints) so OSRM URL limits and waypoint limits
 * are never exceeded. If any chunk fails, only that segment falls back to
 * straight lines instead of breaking the entire route.
 */
export async function fetchRoute(points: LatLng[]): Promise<LatLng[] | null> {
  if (points.length < 2) return null;
  const CHUNK_SIZE = 12;
  if (points.length <= CHUNK_SIZE) {
    const res = await fetchChunkRoute(points);
    return res.length >= 2 ? res : null;
  }

  const chunks: LatLng[][] = [];
  for (let i = 0; i < points.length; i += CHUNK_SIZE - 1) {
    const slice = points.slice(i, i + CHUNK_SIZE);
    if (slice.length >= 2) chunks.push(slice);
    if (i + CHUNK_SIZE >= points.length) break;
  }

  const results = await Promise.all(chunks.map((ch) => fetchChunkRoute(ch)));
  const merged: LatLng[] = [];
  for (const part of results) {
    if (merged.length === 0) {
      merged.push(...part);
    } else {
      const start =
        part.length > 0 &&
        Math.abs(part[0][0] - merged[merged.length - 1][0]) < 1e-5 &&
        Math.abs(part[0][1] - merged[merged.length - 1][1]) < 1e-5
          ? 1
          : 0;
      merged.push(...part.slice(start));
    }
  }

  return merged.length >= 2 ? merged : points;
}

export interface GetConnectionsOptions {
  time?: string;
  date?: string;
  dayLabel?: string;
  directOnly?: boolean;
  minTransfer?: number;
  sortBy?: "departure" | "duration" | "arrival";
  limit?: number;
  /** walk radius of a search from or to a point (`geo:`), metres */
  walk?: number;
  /** `time` is the latest arrival */
  arriveBy?: boolean;
  signal?: AbortSignal;
  /** only "gzm" adds a param: BB keeps its original URL */
  city?: City;
}

/** A street, address or place from /api/geocode. */
export interface GeoHit {
  name: string;
  /** street and town of a place, town of a street */
  detail: string;
  lat: number;
  lon: number;
}

/** Address search for a connection origin. Throws on HTTP errors (404 = search off) and aborts. */
export async function geocode(q: string, city: City, signal?: AbortSignal): Promise<GeoHit[]> {
  const p = new URLSearchParams({ q });
  if (city === "gzm") p.set("city", "gzm");
  return (await fetchJSON<{ results: GeoHit[] }>(`/api/geocode?${p.toString()}`, { signal })).results;
}

export async function getConnections(
  from: string,
  to: string,
  optionsOrTime?: GetConnectionsOptions | string,
  maybeSignal?: AbortSignal,
): Promise<ConnectionItinerary[]> {
  const p = new URLSearchParams({ from, to });
  let signal = maybeSignal;

  if (typeof optionsOrTime === "string") {
    if (optionsOrTime) p.set("time", optionsOrTime);
  } else if (optionsOrTime) {
    if (optionsOrTime.time) p.set("time", optionsOrTime.time);
    if (optionsOrTime.date) p.set("date", optionsOrTime.date);
    if (optionsOrTime.dayLabel) p.set("dayLabel", optionsOrTime.dayLabel);
    if (optionsOrTime.directOnly) p.set("direct", "true");
    if (optionsOrTime.minTransfer != null) p.set("minTransfer", String(optionsOrTime.minTransfer));
    if (optionsOrTime.sortBy) p.set("sortBy", optionsOrTime.sortBy);
    if (optionsOrTime.limit != null) p.set("limit", String(optionsOrTime.limit));
    if (optionsOrTime.walk != null) p.set("walk", String(optionsOrTime.walk));
    if (optionsOrTime.arriveBy) p.set("arriveBy", "true");
    if (optionsOrTime.signal) signal = optionsOrTime.signal;
    if (optionsOrTime.city === "gzm") p.set("city", "gzm");
  }

  // Throws on HTTP/network errors and aborts: a failed search is not "no connections".
  const res = await fetchJSON<ConnectionsResponse>(`/api/connections?${p.toString()}`, {
    signal,
    cache: "no-store",
  });
  return res?.connections ?? [];
}

