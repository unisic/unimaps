/**
 * HTTP client for the MZK Bielsko-Biała OnTime API (https://rozklady.bielsko.pl).
 */
import { todayLocalISO, USER_AGENT } from "./config";
import { log } from "./logger";
import type { MzkVehicleStatic } from "./mzk-fleet";

export interface MzkRunningStopPoint {
  symbol: string;
  name: string;
  orderNo: number;
  street: string | null;
  distance: number;
  scheduledDeparture: number; // ms timestamp
  plannedDeparture: number; // ms timestamp
}

export interface MzkRunningVehicle {
  lineName: string;
  courseLoid: number;
  externalCourseLoid: string;
  dayCourseLoid: number;
  vehicleId: string; // side number, e.g. "230"
  delaySec: number;
  longitude: number;
  latitude: number;
  angle: number; // heading deg, -180..180 or 0..360
  reachedMeters: number;
  variantLoid: number;
  lastPingDate: number;
  distanceToNearestStopPoint: number;
  distanceFromPassedStopPoint: number;
  nearestSymbol: string;
  nearestSymbolOrderNo: number;
  operator: string;
  /** on the wire: the symbol of the stop being served ("247"), or null */
  onStopPoint: string | boolean | null;
  orderInCourse: number;
  direction: string;
  lastStopSymbol: string;
  /** null until OnTime has confirmed a stop (always present on the wire) */
  lastStopOrderNo: number | null;
  stopPoints: MzkRunningStopPoint[];
  optionalDirection: string;
}

export interface MzkStopPoint {
  id: number;
  longitude: number;
  latitude: number;
  symbol: string;
  name: string;
  street: string | null;
  city: string | null;
  distance: number | null;
  virtual: boolean;
  onRequest: boolean;
  gettingOut: boolean;
}

export interface MzkLine {
  id: number;
  name: string;
  longName: string | null;
  nightLine: boolean;
  lineType: string;
}

export interface MzkRealtimeDeparture {
  courseId: number;
  scheduledDepartureSec: number;
  scheduledDeparture: number; // ms
  realDeparture: number; // ms
  vehicleId: string;
  variantId: number;
  orderInCourse: number;
  passed: boolean;
  lack: boolean;
  onStopPoint: boolean;
  lineName: string;
  directionName: string;
}

export interface MzkRealtimeResponse {
  stopPointSymbol: string;
  stopPointId: number;
  stopPointName: string;
  responseDate: number;
  departures: MzkRealtimeDeparture[];
  error?: string | null;
}

export interface MzkScheduleDeparture {
  scheduledDepartureSec: number;
  courseId: number;
  variantId: number;
  operator?: string | null;
  transportType?: string;
  expectedVehicleType?: string;
  orderInCourse?: number;
  optionalDirection?: string;
  /** scheduled departure of the course from its first stop */
  courseStartSec?: number;
  letter?: string;
  visible?: boolean;
}

export interface MzkLineSchedule {
  lineName: string;
  isGettingOutOnly?: boolean;
  destination: string;
  mainVariantId?: number;
  departures: MzkScheduleDeparture[];
}

export interface MzkAtomicScheduleResponse {
  dayTypeSymbol?: string | null;
  lineSchedules?: Record<string, MzkLineSchedule>;
  scheduleDate?: string | null;
  error?: string | null;
}

export interface MzkCalendarDay {
  /** epoch ms of the day's local midnight */
  date: number;
  dayType?: { dayTypeSymbol?: string | null; description?: string | null } | null;
}

export interface MzkMessage {
  loid: number;
  title: string;
  intro: string;
  stopSymbols: string[];
  lineNames: string[];
  startDate: number;
  endDate: number | null;
}

export interface MzkMessagesResponse {
  version: number;
  messages: MzkMessage[];
}

interface CacheEntry<T> {
  at: number;
  p: Promise<T>;
}

/** getRealtime of one stop changes every few seconds; concurrent viewers (and a station hub's several symbols) share a request. */
export const MZK_REALTIME_TTL_MS = 5_000;
/** A day's schedule of one stop never changes within the day (~165 KB each, so the cache is small and bounded). */
export const MZK_SCHEDULE_TTL_MS = 15 * 60_000;
const MZK_REALTIME_CACHE_MAX = 256;
const MZK_SCHEDULE_CACHE_MAX = 24;

export class MzkApi {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly realtimeCache = new Map<string, CacheEntry<MzkRealtimeResponse>>();
  private readonly scheduleCache = new Map<string, CacheEntry<MzkAtomicScheduleResponse>>();

  constructor(baseUrl = "https://rozklady.bielsko.pl", timeoutMs = 10_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async requestJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": USER_AGENT,
        },
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      log.warn("mzk-api", `Request failed for ${url}: ${err}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * TTL cache + in-flight de-duplication. A failed request is never cached (the entry is dropped as soon as it
   * rejects, so the next caller retries); the map stays bounded (expired entries first, then the oldest).
   */
  private cached<T>(map: Map<string, CacheEntry<T>>, key: string, ttlMs: number, max: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = map.get(key);
    if (hit && now - hit.at < ttlMs) return hit.p;
    const entry: CacheEntry<T> = { at: now, p: load() };
    map.set(key, entry);
    entry.p.catch(() => {
      if (map.get(key) === entry) map.delete(key);
    });
    if (map.size > max) {
      for (const [k, e] of map) if (now - e.at >= ttlMs) map.delete(k);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
    return entry.p;
  }

  /**
   * Fetches all active running vehicles in real-time.
   */
  async fetchRunningVehicles(): Promise<MzkRunningVehicle[]> {
    const res = await this.requestJson<{ vehicles: MzkRunningVehicle[]; offline?: boolean }>(
      "getRunningVehicles.json",
    );
    return res?.vehicles ?? [];
  }

  /**
   * Fetches static vehicle attributes (fleet equipment).
   */
  async fetchVehicles(): Promise<MzkVehicleStatic[]> {
    const res = await this.requestJson<{ vehicles: MzkVehicleStatic[] }>("getVehicles.json");
    return res?.vehicles ?? [];
  }

  /**
   * Fetches all 529 MZK stop points.
   */
  async fetchStops(): Promise<MzkStopPoint[]> {
    const res = await this.requestJson<{ stopPoints: MzkStopPoint[] }>("getStops.json");
    return res?.stopPoints ?? [];
  }

  /**
   * Fetches all MZK lines.
   */
  async fetchLines(): Promise<MzkLine[]> {
    const res = await this.requestJson<{ lines: MzkLine[] }>("getLines.json");
    return res?.lines ?? [];
  }

  /**
   * Fetches live departures for a specific stop symbol (e.g. "341", "2").
   */
  async fetchRealtime(symbol: string): Promise<MzkRealtimeResponse> {
    return this.cached(this.realtimeCache, symbol, MZK_REALTIME_TTL_MS, MZK_REALTIME_CACHE_MAX, () =>
      this.requestJson<MzkRealtimeResponse>(`getRealtime.json?stopPointSymbol=${encodeURIComponent(symbol)}`),
    );
  }

  /**
   * Fetches service announcements.
   */
  async fetchMessages(): Promise<MzkMessage[]> {
    const res = await this.requestJson<MzkMessagesResponse>("getAllMessages.json");
    return res?.messages ?? [];
  }

  /**
   * Fetches real-time course stoppings.
   */
  async fetchRealCourse(courseId: number): Promise<unknown> {
    return this.requestJson(`getRealCourse.json?courseId=${courseId}`);
  }

  /**
   * Fetches full day timetable for a stop symbol and date.
   */
  async fetchAtomicSchedule(
    symbol: string,
    date?: string | number,
    opts: { cache?: boolean } = {},
  ): Promise<MzkAtomicScheduleResponse> {
    let dateParam: string | number;
    if (typeof date === "number") {
      dateParam = date;
    } else {
      // no/odd date: today in Warsaw, not the server's (UTC) calendar day
      const iso = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayLocalISO();
      const [y, m, d] = iso.split("-").map(Number);
      dateParam = Date.UTC(y, m - 1, d, 12, 0, 0);
    }
    const load = () =>
      this.requestJson<MzkAtomicScheduleResponse>(
        `getAtomicSchedule.json?symbol=${encodeURIComponent(symbol)}&date=${dateParam}`,
      );
    // the timetable build reads every stop once; caching it would only evict the stop views' entries
    if (opts.cache === false) return load();
    return this.cached(this.scheduleCache, `${symbol}|${dateParam}`, MZK_SCHEDULE_TTL_MS, MZK_SCHEDULE_CACHE_MAX, load);
  }

  /**
   * Fetches the operator calendar: the day type of each of the next ~90 days.
   */
  async fetchCalendar(): Promise<MzkCalendarDay[]> {
    const res = await this.requestJson<{ days: MzkCalendarDay[] }>("getCalendar.json");
    return res?.days ?? [];
  }

  /**
   * Fetches theoretical course details (shape/geometry).
   */
  async fetchTheoreticalCourse(variantId: number): Promise<unknown> {
    return this.requestJson(`getTheoreticalCourseDetails.json?variantId=${variantId}`);
  }
}
