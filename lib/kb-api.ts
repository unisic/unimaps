/**
 * Async client for the kiedyprzyjedzie.pl upstream API — TypeScript port of
 * kb_gtfs/api.py (KbApi) using native fetch + p-limit.
 */
import pLimit from "p-limit";

import * as config from "./config";
import type { Stop, Trip, TripStop, UpstreamRecord } from "./types";

const RE_REVISION = /data-stops-revision="(\d+)"/;

/** Python-style truthiness: null/undefined/false/0/NaN/""/[]/{} are falsy. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python int() semantics: numbers truncate, strings must be pure integers. */
export function parseIntStrict(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  return parseInt(t, 10);
}

/** Python float() for numbers and strings; null for anything else. */
export function pyFloat(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Narrow an unknown to a plain object record (else empty object). */
export function asRecord(v: unknown): UpstreamRecord {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as UpstreamRecord) : {};
}

/** True when `v` is a plain (non-array) object. */
export function isRecord(v: unknown): v is UpstreamRecord {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** base64 of the raw trip_execution_id (port of b64_exec_id). */
export function b64ExecId(tripExecutionId: string): string {
  return Buffer.from(tripExecutionId, "utf-8").toString("base64");
}

/**
 * Path-segment-safe form of b64ExecId. Standard base64 may contain '/' (a path
 * separator — would rewrite the upstream URL) and '+'; escape only those two so
 * every id that worked before is byte-identical on the wire ('=' padding stays
 * raw), while the HTTP server still percent-decodes back to plain base64 for
 * the upstream app. (base64url would be cleaner but we can't verify the
 * upstream decoder accepts its alphabet.)
 */
export function execIdPathSegment(tripExecutionId: string): string {
  return b64ExecId(tripExecutionId).replace(/\+/g, "%2B").replace(/\//g, "%2F");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Port of api.parse_stops: positional arrays, dedupe by internal id. */
export function parseStops(raw: unknown): Stop[] {
  const out: Stop[] = [];
  const seen = new Set<number>();
  const rawStops = asRecord(raw).stops;
  const rows: unknown[] = Array.isArray(rawStops) ? rawStops : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const internalId = parseIntStrict(row[1]);
    const lonRaw = pyFloat(row[3]);
    const latRaw = pyFloat(row[4]);
    if (internalId === null || lonRaw === null || latRaw === null) continue;
    if (seen.has(internalId)) continue;
    seen.add(internalId);
    out.push({
      urlId: String(row[0]),
      internalId,
      name: String(row[2]),
      lon: lonRaw / 1_000_000,
      lat: latRaw / 1_000_000,
      onlyDisembarking: row.length > 5 ? pyTruthy(row[5]) : false,
      isStation: row.length > 6 ? pyTruthy(row[6]) : false,
      showPlatforms: row.length > 7 ? pyTruthy(row[7]) : false,
      stopId: String(internalId),
    });
  }
  return out;
}

/** Port of api.parse_trip. */
export function parseTrip(raw: unknown, tripId: string): Trip {
  const r = asRecord(raw);
  const times: TripStop[] = [];
  const rawTimes = Array.isArray(r.times) ? r.times : [];
  for (const entry of rawTimes) {
    const t = asRecord(entry);
    times.push({
      stopName: t.stop_name == null ? "" : String(t.stop_name),
      designator: typeof t.designator === "number" ? Math.trunc(t.designator) : null,
      placeId: typeof t.place_id === "string" ? t.place_id : null,
      departureTime: t.departure_time == null ? "" : String(t.departure_time),
      index: parseIntStrict(t.index ?? 0) ?? 0,
      platform: t.platform == null ? null : String(t.platform),
    });
  }
  const line = asRecord(r.line);
  return {
    tripId: String(tripId),
    times,
    direction: r.direction == null ? "" : String(r.direction),
    lineName: line.name == null ? "" : String(line.name),
    lineType: typeof line.type === "string" ? line.type : null,
    showName: "show_name" in line ? pyTruthy(line.show_name) : true,
    vehicleType: typeof r.vehicle_type === "number" ? Math.trunc(r.vehicle_type) : null,
    currentStationId: typeof r.current_station_id === "number" ? Math.trunc(r.current_station_id) : null,
  };
}

type AttemptResult = { ok: true; body: unknown } | { ok: false; error: unknown };

/**
 * HTTP client for komunikacjabeskidzka.kiedyprzyjedzie.pl with a global
 * concurrency limit, retries with backoff and 404 -> null semantics.
 */
export class KbApi {
  readonly base: string;
  readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly headers: Record<string, string>;
  /** New requests are refused once this many wait for a slot (a client-driven flood sheds, never queues unboundedly). */
  private readonly maxPending: number;
  /** Last successfully scraped stops revision — a transient scrape failure
   *  falls back here instead of the hardcoded cold-start default. */
  private lastGoodRevision: string | null = null;

  constructor(opts: { concurrency?: number; timeout?: number; maxPending?: number } = {}) {
    this.base = config.BASE_URL;
    this.concurrency = opts.concurrency ?? config.DEFAULT_CONCURRENCY;
    this.timeoutMs = (opts.timeout ?? config.HTTP_TIMEOUT) * 1000;
    this.limit = pLimit(this.concurrency);
    this.maxPending = opts.maxPending ?? Infinity;
    this.headers = { "User-Agent": config.USER_AGENT, Accept: "application/json" };
  }

  private readonly tripCache = new Map<string, { data: unknown; expiresAt: number }>();
  private readonly timetableCache = new Map<string, { data: unknown; expiresAt: number }>();

  /**
   * GET a JSON path. 404 -> null. Network errors / non-2xx statuses are
   * retried up to `retries` extra times with 0.4s*(attempt+1) backoff; the
   * last error is thrown when all attempts fail.
   */
  private async get(path: string, retries = 2): Promise<unknown> {
    const url = `${this.base}${path}`;
    // checked once: a retry re-queues an admitted caller, so pending stays <= maxPending + concurrency
    if (this.limit.pendingCount >= this.maxPending) throw new Error(`KB request queue full (${this.maxPending} pending)`);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await this.limit(() => this.attemptGet(url, attempt));
      if (res.ok) return res.body;
      lastErr = res.error;
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** One attempt: fetch + read body. Backoff sleep happens inside the limiter slot (like the Python semaphore). */
  private async attemptGet(url: string, attempt: number): Promise<AttemptResult> {
    let text: string;
    try {
      const resp = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
      if (resp.status === 404) return { ok: true, body: null };
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      text = await resp.text();
    } catch (error) {
      await sleep(400 * (attempt + 1));
      return { ok: false, error };
    }
    // JSON parse errors propagate immediately (not retried), like Python.
    return { ok: true, body: text === "" ? null : (JSON.parse(text) as unknown) };
  }

  /** Scrape data-stops-revision from the homepage HTML (15s timeout, falls back to the default). */
  async fetchRevision(): Promise<string> {
    try {
      const resp = await fetch(`${this.base}/`, {
        headers: this.headers,
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      const html = await resp.text();
      const m = RE_REVISION.exec(html);
      if (m) {
        this.lastGoodRevision = m[1];
        return m[1];
      }
    } catch {
      // fall through to the last known / default revision
    }
    return this.lastGoodRevision ?? config.DEFAULT_STOPS_REVISION;
  }

  /** Fetch and parse the full stop list for a stops revision. */
  async fetchStops(revision?: string): Promise<Stop[]> {
    const rev = revision ?? (await this.fetchRevision());
    const raw = await this.get(`/stops?rev=${rev}`);
    if (!pyTruthy(raw)) return [];
    return parseStops(raw);
  }

  /** GET /api/timetables/<stopUrlId>?date=YYYY-MM-DD (raw passthrough with 15-min in-memory cache). */
  async fetchTimetable(stopUrlId: string, date: string): Promise<unknown> {
    const key = `${stopUrlId}:${date}`;
    const hit = this.timetableCache.get(key);
    const now = Date.now();
    if (hit && hit.expiresAt > now) {
      return hit.data;
    }
    const data = await this.get(`/api/timetables/${stopUrlId}?date=${date}`);
    if (pyTruthy(data)) {
      if (this.timetableCache.size >= 1000) {
        const oldest = this.timetableCache.keys().next().value;
        if (oldest) this.timetableCache.delete(oldest);
      }
      this.timetableCache.set(key, { data, expiresAt: now + 15 * 60 * 1000 });
    }
    return data;
  }

  /** Fetch and parse one trip detail. */
  async fetchTrip(tripId: string, index = 0): Promise<Trip | null> {
    const raw = await this.fetchTripRaw(tripId, index);
    if (!pyTruthy(raw)) return null;
    return parseTrip(raw, tripId);
  }

  /** GET /api/trip/<tripId>/<index> (raw passthrough with 4h in-memory cache). */
  async fetchTripRaw(tripId: string, index = 0): Promise<unknown> {
    const key = `${tripId}:${index}`;
    const hit = this.tripCache.get(key);
    const now = Date.now();
    if (hit && hit.expiresAt > now) {
      return hit.data;
    }
    const data = await this.get(`/api/trip/${tripId}/${index}`);
    if (pyTruthy(data)) {
      if (this.tripCache.size >= 5000) {
        const oldest = this.tripCache.keys().next().value;
        if (oldest) this.tripCache.delete(oldest);
      }
      this.tripCache.set(key, { data, expiresAt: now + 4 * 3600 * 1000 });
    }
    return data;
  }

  /** True when fetchTripRaw would answer from the cache without an upstream request. */
  hasCachedTrip(tripId: string, index = 0): boolean {
    const hit = this.tripCache.get(`${tripId}:${index}`);
    return hit !== undefined && hit.expiresAt > Date.now();
  }

  /**
   * Batch resolves multiple trips through the in-memory cache and shared p-limit.
   * `failed` counts ids whose fetch threw (as opposed to 404/empty = no such trip).
   */
  async fetchTripsBatch(tripIds: readonly string[], index = 0): Promise<{ trips: Record<string, unknown>; failed: number }> {
    const unique = Array.from(new Set(tripIds));
    let failed = 0;
    const entries = await Promise.all(
      unique.map(async (tid): Promise<[string, unknown]> => {
        try {
          const raw = await this.fetchTripRaw(tid, index);
          return [tid, pyTruthy(raw) ? raw : null];
        } catch {
          failed += 1;
          return [tid, null];
        }
      }),
    );
    const trips: Record<string, unknown> = {};
    for (const [id, data] of entries) {
      if (data !== null) trips[id] = data;
    }
    return { trips, failed };
  }

  /** GET /api/departures/<stopUrlId> (raw passthrough). */
  async fetchDepartures(stopUrlId: string): Promise<unknown> {
    return this.get(`/api/departures/${stopUrlId}`);
  }

  /** GET /api/departures?places=id1,id2,... (raw passthrough). */
  async fetchMultipleDepartures(stopUrlIds: string[]): Promise<unknown> {
    const places = stopUrlIds.join(",");
    return this.get(`/api/departures?places=${places}`);
  }

  /** GET /api/announcements[?ah=<hash>] (raw passthrough). */
  async fetchAnnouncements(hash?: string): Promise<unknown> {
    const params = hash ? `?ah=${hash}` : "";
    return this.get(`/api/announcements${params}`);
  }

  /** GET /api/trip_execution/<base64(execId)>/<index> (raw passthrough). */
  async fetchTripExecution(tripExecutionId: string, index = 0): Promise<unknown> {
    return this.get(`/api/trip_execution/${execIdPathSegment(tripExecutionId)}/${index}`);
  }

  /**
   * Run `fn` over all items through the shared limiter; individual failures
   * yield null instead of rejecting the whole batch.
   */
  async fetchMany<T, R>(fn: (item: T) => Promise<R>, items: readonly T[]): Promise<Array<[T, R | null]>> {
    return Promise.all(
      items.map(async (x): Promise<[T, R | null]> => {
        try {
          return [x, await fn(x)];
        } catch {
          return [x, null];
        }
      }),
    );
  }
}
