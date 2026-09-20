/**
 * HTTP client for the MZK Bielsko-Biała OnTime API (https://rozklady.bielsko.pl).
 */
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
  onStopPoint: boolean | null;
  orderInCourse: number;
  direction: string;
  lastStopSymbol: string;
  lastStopOrderNo: number;
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

export class MzkApi {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

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
          "User-Agent": "kb-map/1.0 (MZK Bielsko-Biala client)",
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
    return this.requestJson<MzkRealtimeResponse>(
      `getRealtime.json?stopPointSymbol=${encodeURIComponent(symbol)}`,
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
   * Fetches theoretical course details (shape/geometry).
   */
  async fetchTheoreticalCourse(variantId: number): Promise<unknown> {
    return this.requestJson(`getTheoreticalCourseDetails.json?variantId=${variantId}`);
  }
}
