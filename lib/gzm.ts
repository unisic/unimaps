/**
 * Metropolia GZM live layer: zbiorkom.live vehicle positions joined to the static GZM feed (lib/gzm-feed.ts).
 *
 * zbiorkom refreshes its positions on a 20 s grid (2026-10-28: 1349 of 1363 record timestamps were multiples of
 * 20 s), so one request per 20 s, 3 s after the grid, is all there is to get. Each record names its line, brigade
 * and the next 0-3 calls with their scheduled departures; a vehicle is joined to the one GTFS trip of that line
 * whose calls match ALL of those (sequence, scheduled departure) pairs, the brigade breaking ties. Departures,
 * timetables and trips are answered from the local feed plus that join, never by asking upstream per request.
 *
 * SDIP (sdip.transportgzm.pl, the operator's own map) moves a vehicle every ~5 s (2026-10-28, 150 s sample: per-vehicle
 * change interval p50 5 s vs 20 s, the same position ~8 s before zbiorkom's snapshot). While someone watches GZM
 * it is polled every 5 s and only its POSITION overrides zbiorkom's, never the join; it sends no fix time, so a
 * position counts only once it was seen changing (the midpoint of that poll window).
 *
 * Isolated from the BB pollers: its own singleton, started from instrumentation.ts, and its failure never
 * touches /api/health status. Ids are `gzm:` prefixed (vehicles `gzm:<op>_<fleet>`, trips `gzm:<trip_id>`).
 */
import * as config from "./config";
import { bearing, metersBetween } from "./geo";
import { getGzmFeed, gzmFeedHealth, serviceDayBase, startGzmFeed, warsawClock, type GzmFeed, type GzmTrip } from "./gzm-feed";
import { feedGzmFleet, type GzmFleetSource } from "./gzm-fleet";
import { isRecord } from "./kb-api";
import { stepArrivals } from "./kb-progress";
import { log } from "./logger";
import { interruptibleSleep, vehicleToJson } from "./poller";
import { estimateFixAt, kbAheadM, kbDistAlong, nextSpeed, vehicleExtras } from "./route-info";
import { findConnections, offsetDate, stopEvents, type ConnectionItinerary, type RouteQuery } from "./router";
import type { ShapePayload } from "./shape-store";
import { gzmRowKey, hhmm, preSortRows } from "./shared/departures";
import type { VehiclePos, VehiclesResponse } from "./types";

/* ---------------- zbiorkom records ---------------- */

export interface ZbCall {
  /** GTFS stop_sequence (0-based, = index in GzmTrip.stops) */
  seq: number;
  /** scheduled departure, epoch secs */
  dep: number;
}

export interface ZbRecord {
  /** "<op>_<fleet>" from the record url, unique across companies */
  key: string;
  /** display fleet number (95 of them collide across companies, so never a key) */
  label: string;
  /** GTFS route_type as sent: "0" tram, "11" trolleybus, "3" bus */
  type: string;
  model: string | null;
  line: string;
  brigade: string | null;
  lat: number;
  lon: number;
  /** epoch ms of zbiorkom's snapshot */
  ts: number;
  bearing: number | null;
  /** ms; null when absent */
  delayMs: number | null;
  headsign: string;
  /** sorted by seq */
  upcoming: ZbCall[];
}

// ponytail: fixed GZM bbox (stop extent +-0.05 deg, 2026-10-28); widen if the network grows
const AREA = { latMin: 49.9728, latMax: 50.5791, lonMin: 18.4043, lonMax: 19.4763 };
const KEY_RE = /(?:%3A|:)(\d{1,4}_\d{1,6})$/i;
// ponytail: a record older than 10 min is a vehicle zbiorkom forgot to drop, not a live one
const RECORD_MAX_AGE_MS = 600_000;

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Validated records of one positions response, one per vehicle key (the newest wins). Throws on a foreign shape. */
export function parseZbiorkom(body: unknown, nowMs: number): ZbRecord[] {
  const list = isRecord(body) ? body.positions : null;
  if (!Array.isArray(list)) throw new Error("zbiorkom: response has no positions array");
  const byKey = new Map<string, ZbRecord>();
  for (const r of list) {
    if (!isRecord(r)) continue;
    const key = KEY_RE.exec(str(r.url))?.[1];
    const loc = Array.isArray(r.location) ? r.location : [];
    const lon = finite(loc[0]);
    const lat = finite(loc[1]);
    const ts = finite(r.timestamp);
    if (!key || lat === null || lon === null || ts === null || nowMs - ts > RECORD_MAX_AGE_MS) continue;
    if (lat < AREA.latMin || lat > AREA.latMax || lon < AREA.lonMin || lon > AREA.lonMax) continue;
    const prev = byKey.get(key);
    if (prev && prev.ts >= ts) continue;
    const veh = isRecord(r.vehicle) ? r.vehicle : {};
    const upcoming: ZbCall[] = [];
    for (const u of Array.isArray(r.upcomingStops) ? r.upcomingStops : []) {
      if (!isRecord(u)) continue;
      const seq = finite(u.sequence);
      const dep = finite(u.scheduledDeparture);
      if (seq !== null && dep !== null && Number.isInteger(seq) && seq >= 0) upcoming.push({ seq, dep: Math.round(dep / 1000) });
    }
    upcoming.sort((a, b) => a.seq - b.seq);
    const b = finite(r.bearing);
    byKey.set(key, {
      key,
      label: str(veh.id) || key,
      type: str(veh.type),
      model: str(veh.model) || null,
      line: str(r.routeName),
      brigade: str(r.brigade) || null,
      lat,
      lon,
      ts,
      bearing: b !== null ? ((b % 360) + 360) % 360 : null,
      delayMs: finite(r.delay),
      headsign: str(r.headsign),
      upcoming,
    });
  }
  return [...byKey.values()];
}

/** A vehicle position from SDIP `planner/v` (bearing sent in compass radians). */
export interface SdipPos {
  lat: number;
  lon: number;
  bearing: number | null;
}

const SDIP_KEY_RE = /^\d{1,4}_\d{1,6}$/;

/** SDIP vehicles keyed like zbiorkom (`<op>_<fleet>`). Throws on a foreign shape (an expired session sends HTML). */
export function parseSdip(body: unknown): Map<string, SdipPos> {
  if (!Array.isArray(body)) throw new Error("SDIP: response is not a vehicle list");
  const out = new Map<string, SdipPos>();
  for (const v of body) {
    if (!isRecord(v) || typeof v.id !== "string" || !SDIP_KEY_RE.test(v.id)) continue;
    const lat = finite(v.lat);
    const lon = finite(v.lon);
    if (lat === null || lon === null || lat < AREA.latMin || lat > AREA.latMax || lon < AREA.lonMin || lon > AREA.lonMax) continue;
    const rad = finite(v.bearing);
    out.set(v.id, { lat, lon, bearing: rad !== null ? (((rad * 180) / Math.PI) % 360 + 360) % 360 : null });
  }
  return out;
}

/* ---------------- join ---------------- */

export interface GzmMatch {
  trip: GzmTrip;
  /** the trip's service date */
  date: string;
  /** serviceDayBase(date) */
  base: number;
}

function fits(trip: GzmTrip, base: number, calls: readonly ZbCall[]): boolean {
  for (const c of calls) {
    const st = trip.stops[c.seq];
    if (!st || st.seq !== c.seq || base + st.dep !== c.dep) return false;
  }
  return true;
}

/** The one trip of the record's line whose calls match every upcoming (seq, scheduled departure) pair, or null. */
export function matchTrip(feed: GzmFeed, rec: ZbRecord, days: readonly { date: string; base: number }[]): GzmMatch | null {
  if (!rec.upcoming.length) return null;
  const cands = feed.tripsByLine.get(rec.line);
  if (!cands) return null;
  let hits: GzmMatch[] = [];
  for (const d of days) {
    for (const trip of cands) if (trip.dates.has(d.date) && fits(trip, d.base, rec.upcoming)) hits.push({ trip, date: d.date, base: d.base });
  }
  if (hits.length > 1 && rec.brigade) {
    const same = hits.filter((h) => h.trip.brigade === rec.brigade);
    if (same.length) hits = same;
  }
  return hits.length === 1 ? hits[0] : null;
}

/* ---------------- live state ---------------- */

interface Track {
  rec: ZbRecord;
  pos: VehiclePos;
  feed: GzmFeed | null;
  /** the join result, revalidated each poll */
  match: GzmMatch | null;
  /** the trip shown: the matched one, or its brigade successor while the vehicle lays over */
  trip: GzmTrip | null;
  date: string;
  base: number;
  /** index in trip.stops of the next call */
  next: number;
  notStarted: boolean;
  /** fix time of zbiorkom's position (pos may carry SDIP's newer one) */
  zbFixAt: number;
}

/** A position with its fix time, from either source. */
interface Fix extends SdipPos {
  fixAt: number;
}

interface SdipSample extends SdipPos {
  /** our receive time of the poll that last saw it */
  recv: number;
  /** null until the position was seen changing between two close polls: before that its age is unknown */
  fixAt: number | null;
}

const POLL_MS = 20_000;
const POLL_PHASE_MS = 3_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 16 * 1024 * 1024;
/** a poll older than this empties the map and the live overlay (the MZK stale rule) */
const STALE_SEC = 180;
const AT_STOP_M = 40;
/** mirrors isMzkNotStarted: a bus further than this from its first stop has begun the course */
const NOT_STARTED_M = 400;
const LAYOVER_GRACE_SEC = 120;
/**
 * zbiorkom never closes some trips (the bus parks short of the last stop's zone, or at a depot mid-route): the
 * delay then grows with the clock while the bus stands still. At 2026-10-29 00:00 all 64 delays over 20 min were
 * such vehicles. Standing this long with at least this much delay = the trip is over.
 */
const STUCK_SEC = 600;
const BOARD_ROWS = 40;
const SDIP_MS = 5_000;
const SDIP_TIMEOUT_MS = 4_000;
const SDIP_MAX_BODY = 4 * 1024 * 1024;
/** SDIP runs only while a vehicles request came in this recently */
const WATCH_MS = 120_000;
/** two SDIP polls further apart than this can't date a change */
const SDIP_GAP_SEC = 15;
/** an SDIP fix older than this yields to zbiorkom's */
const SDIP_FRESH_SEC = 60;
const SDIP_PAUSE_MS = 300_000;
const CONN_MEMO = 256;
const CONN_MEMO_MS = 60_000;

/** ms until 3 s past the next 20 s grid point, never under 1 s. */
export function nextPollDelay(nowMs: number): number {
  const d = (POLL_PHASE_MS - (nowMs % POLL_MS) + POLL_MS) % POLL_MS;
  return d < 1000 ? d + POLL_MS : d;
}

/** A response body as text, refused past `max` bytes. */
async function cappedText(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length")) > max) throw new Error("response body exceeds the size cap");
  // ponytail: the cap is checked after text() buffered the body; stream it if upstream ever lies about its length
  const text = await res.text();
  if (text.length > max) throw new Error("response body exceeds the size cap");
  return text;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** "HH:MM" of GTFS service-day secs (may exceed 24 h). */
const clock = (secs: number): string => `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor((secs % 3600) / 60))}`;

export interface GzmLiveOptions {
  fetchImpl?: typeof fetch;
  feed?: () => GzmFeed | null;
  now?: () => number;
  url?: string;
  /** SDIP map page (the session comes from it); null disables the overlay */
  sdipUrl?: string | null;
  /** receives the matched vehicles after every good zbiorkom poll (the /brygady tracker); off by default */
  fleet?: ((sources: GzmFleetSource[]) => void) | null;
}

export class GzmLive {
  tracks = new Map<string, Track>();
  /** `${tripId}|${date}` of the trip shown -> its vehicle */
  private byTrip = new Map<string, Track>();
  private body = "";
  scanCount = 0;
  lastScan = 0;
  lastGood = 0;
  failures = 0;
  lastError: string | null = null;
  pollMs = 0;
  private bytes = 0;
  private readonly startedAt: number;
  private routeErrLoggedAt = 0;
  private abort: AbortController | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly getFeed: () => GzmFeed | null;
  private readonly now: () => number;
  private readonly url: string;
  private readonly sdipUrl: string | null;
  private readonly fleet: ((sources: GzmFleetSource[]) => void) | null;
  private sdip = new Map<string, SdipSample>();
  private sdipCookie = "";
  private sdipFails = 0;
  private sdipPausedUntil = 0;
  private sdipBytes = 0;
  sdipLastGood = 0;
  sdipError: string | null = null;
  /** keys whose SDIP position changed in the last SDIP poll */
  sdipMoved = 0;
  private lastWatch = 0;
  private readonly connMemo = new Map<string, { at: number; feed: GzmFeed; res: ConnectionItinerary[] }>();

  constructor(o: GzmLiveOptions = {}) {
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
    this.getFeed = o.feed ?? getGzmFeed;
    this.now = o.now ?? Date.now;
    this.url = o.url ?? config.GZM_POSITIONS_URL;
    this.sdipUrl = o.sdipUrl !== undefined ? o.sdipUrl : config.GZM_SDIP_ENABLED ? config.GZM_SDIP_URL : null;
    this.fleet = o.fleet ?? null;
    this.startedAt = this.now();
  }

  get running(): boolean {
    return this.abort !== null;
  }

  start(): void {
    if (this.abort) return;
    const ac = (this.abort = new AbortController());
    void (async () => {
      while (!ac.signal.aborted) {
        await this.pollOnce();
        await interruptibleSleep(nextPollDelay(this.now()), ac.signal);
      }
    })();
    if (!this.sdipUrl) return;
    void (async () => {
      while (!ac.signal.aborted) {
        const now = this.now();
        if (now - this.lastWatch <= WATCH_MS && now >= this.sdipPausedUntil) await this.pollSdipOnce();
        await interruptibleSleep(SDIP_MS, ac.signal);
      }
    })();
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** One request; never throws. True when it applied a response. */
  async pollOnce(): Promise<boolean> {
    const t0 = this.now();
    this.scanCount += 1;
    this.lastScan = t0 / 1000;
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { "User-Agent": config.USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await cappedText(res, MAX_BODY);
      this.bytes += text.length;
      this.apply(parseZbiorkom(JSON.parse(text), t0), t0);
      if (this.fleet) {
        // an empty list would close every running course: skip it (feed still loading, or nothing matched)
        const sources = this.fleetSources();
        if (sources.length) this.fleet(sources);
      }
      this.lastGood = t0 / 1000;
      if (this.failures) log.info("gzm", `positions back after ${this.failures} failed polls`);
      this.failures = 0;
      this.lastError = null;
      return true;
    } catch (err) {
      this.failures += 1;
      this.lastError = String(err);
      if (this.failures === 1 || this.failures % 30 === 0) log.warn("gzm", `positions poll failed (${this.failures}x): ${err}`);
      return false;
    } finally {
      this.pollMs = this.now() - t0;
    }
  }

  /** One SDIP request (a fresh session when the old one expired); never throws. True when it applied a response. */
  async pollSdipOnce(): Promise<boolean> {
    if (!this.sdipUrl) return false;
    const t0 = this.now();
    try {
      if (!this.sdipCookie) await this.sdipLogin();
      let list = await this.sdipVehicles();
      if (list === null) {
        await this.sdipLogin();
        list = await this.sdipVehicles();
      }
      if (list === null) throw new Error("SDIP sent no JSON with a fresh session");
      this.applySdip(parseSdip(list), t0);
      this.sdipLastGood = t0 / 1000;
      this.sdipFails = 0;
      this.sdipError = null;
      return true;
    } catch (err) {
      this.sdipError = String(err);
      this.sdipCookie = "";
      if (++this.sdipFails >= 3) {
        this.sdipFails = 0;
        this.sdipPausedUntil = t0 + SDIP_PAUSE_MS;
        log.warn("gzm", `SDIP failed 3x, paused 5 min: ${err}`);
      }
      return false;
    }
  }

  private async sdipLogin(): Promise<void> {
    const res = await this.fetchImpl(this.sdipUrl!, { headers: { "User-Agent": config.USER_AGENT }, signal: AbortSignal.timeout(SDIP_TIMEOUT_MS) });
    await res.body?.cancel();
    const id = res.headers.getSetCookie().map((c) => /^JSESSIONID=[^;]+/.exec(c)?.[0]).find(Boolean);
    if (!res.ok || !id) throw new Error(`SDIP session: HTTP ${res.status}${id ? "" : ", no JSESSIONID"}`);
    this.sdipCookie = id;
  }

  /** The vehicle list, or null when SDIP answered something else than JSON (its expired-session page). */
  private async sdipVehicles(): Promise<unknown> {
    const res = await this.fetchImpl(`${this.sdipUrl}?command=planner&action=v`, {
      headers: { "User-Agent": config.USER_AGENT, Accept: "application/json", Cookie: this.sdipCookie, "X-Requested-With": "XMLHttpRequest" },
      signal: AbortSignal.timeout(SDIP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SDIP vehicles: HTTP ${res.status}`);
    const text = await cappedText(res, SDIP_MAX_BODY);
    this.sdipBytes += text.length;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  /** Dates SDIP positions and moves every tracked vehicle whose SDIP position changed. */
  applySdip(list: ReadonlyMap<string, SdipPos>, nowMs: number): void {
    const recv = nowMs / 1000;
    const next = new Map<string, SdipSample>();
    const days = this.days(nowMs);
    let moved = 0;
    for (const [key, s] of list) {
      const old = this.sdip.get(key);
      const dated = old !== undefined && recv - old.recv <= SDIP_GAP_SEC;
      const changed = !old || old.lat !== s.lat || old.lon !== s.lon;
      const fixAt = !dated ? null : changed ? estimateFixAt({ updatedAt: old.recv }, recv, true, SDIP_GAP_SEC) : old.fixAt;
      const sample: SdipSample = { ...s, recv, fixAt };
      next.set(key, sample);
      if (!changed || fixAt === null) continue;
      moved += 1;
      const t = this.tracks.get(key);
      const fix = t && this.fixFor(key, sample, t.zbFixAt, recv);
      if (!t || !fix || fix.fixAt === t.pos.fixAt) continue;
      const nt = this.track(t.rec, t, t.feed, days, recv, fix, t.zbFixAt);
      this.tracks.set(key, nt);
      if (nt.trip) this.byTrip.set(`${nt.trip.tripId}|${nt.date}`, nt);
    }
    this.sdip = next;
    this.sdipMoved = moved;
    this.rebuildBody(recv);
  }

  /** The newer of zbiorkom's fix and a fresh, dated SDIP one (null: zbiorkom's). */
  private fixFor(key: string, s: SdipSample | undefined, zbFixAt: number, nowS: number): Fix | null {
    s ??= this.sdip.get(key);
    if (!s || s.fixAt === null || s.fixAt <= zbFixAt || nowS - s.fixAt > SDIP_FRESH_SEC) return null;
    return { lat: s.lat, lon: s.lon, bearing: s.bearing, fixAt: s.fixAt };
  }

  private days(nowMs: number): Array<{ date: string; base: number }> {
    const today = warsawClock(nowMs).date;
    return [today, offsetDate(today, -1)].map((date) => ({ date, base: serviceDayBase(date) }));
  }

  /** Replaces the live state with one response's records (prunes every vehicle not in it). */
  apply(recs: readonly ZbRecord[], nowMs: number): void {
    const feed = this.getFeed();
    const nowS = nowMs / 1000;
    const days = this.days(nowMs);
    const tracks = new Map<string, Track>();
    const byTrip = new Map<string, Track>();
    for (const rec of recs) {
      const prev = this.tracks.get(rec.key);
      const tsS = rec.ts / 1000;
      // zbiorkom's timestamp is its 20 s snapshot, so the fix lies inside the window before it: its midpoint
      const zbFixAt = prev ? estimateFixAt({ fixAt: prev.zbFixAt, updatedAt: prev.rec.ts / 1000 }, tsS, rec.ts !== prev.rec.ts, 60) : tsS - POLL_MS / 2000;
      const fix = this.fixFor(rec.key, undefined, zbFixAt, nowS) ?? { lat: rec.lat, lon: rec.lon, bearing: rec.bearing, fixAt: zbFixAt };
      const t = this.track(rec, prev, feed, days, nowS, fix, zbFixAt);
      tracks.set(rec.key, t);
      if (t.trip) byTrip.set(`${t.trip.tripId}|${t.date}`, t);
    }
    this.tracks = tracks;
    this.byTrip = byTrip;
    this.rebuildBody(nowS);
  }

  private rebuildBody(nowS: number): void {
    const vehicles = [...this.tracks.values()].map((t) => ({ ...vehicleToJson(t.pos), ...vehicleExtras(t.pos, t.feed?.shapes ?? null, nowS) }));
    const res: VehiclesResponse = { timestamp: nowS, scan_count: this.scanCount, last_scan: this.lastScan, count: vehicles.length, vehicles };
    this.body = JSON.stringify(res);
  }

  /** A vehicle in the last poll (`<op>_<fleet>`), on a trip or not; null when it is not on the map. */
  liveVehicle(side: string): { label: string; model: string | null; line: string; lat: number; lon: number; fixAt: number } | null {
    const t = this.tracks.get(side);
    if (!t) return null;
    return { label: t.rec.label, model: t.rec.model, line: t.pos.line, lat: t.pos.lat, lon: t.pos.lon, fixAt: Math.floor(t.pos.fixAt ?? t.zbFixAt) };
  }

  /** The vehicles that serve a GTFS trip now, as the fleet tracker reads them. */
  fleetSources(): GzmFleetSource[] {
    const out: GzmFleetSource[] = [];
    for (const t of this.tracks.values()) {
      const { rec, pos, trip, feed } = t;
      if (!trip || !feed) continue;
      const geom = pos.shapeKey ? feed.shapes.geometry(pos.shapeKey) : null;
      const n = trip.next;
      const nFirst = n?.stops[0];
      out.push({
        side: rec.key,
        label: rec.label,
        model: rec.model,
        vehicleType: rec.type,
        line: pos.line,
        brigade: rec.brigade ?? (trip.brigade || null),
        tripId: trip.tripId.slice("gzm:".length),
        headsign: pos.headsign,
        stops: trip.stops.map((s, i) => ({ id: s.stopId, name: feed.stops.get(s.stopId)?.name ?? "", dep: s.dep, distM: geom?.stops[i] ?? null })),
        servedIdx: t.next > 0 ? t.next - 1 : null,
        nextIdx: t.next,
        reachedM: pos.distM ?? null,
        atStop: pos.atStop,
        notStarted: t.notStarted,
        delaySec: pos.delay,
        lat: pos.lat,
        lon: pos.lon,
        bearing: pos.bearing,
        fixAt: pos.fixAt ?? null,
        nextTrip:
          n && nFirst
            ? { line: n.line, headsign: n.headsign, firstStopName: feed.stops.get(nFirst.stopId)?.name ?? "", firstStopId: nFirst.stopId, dep: nFirst.dep }
            : null,
      });
    }
    return out;
  }

  private track(
    rec: ZbRecord,
    prev: Track | undefined,
    feed: GzmFeed | null,
    days: readonly { date: string; base: number }[],
    nowS: number,
    fix: Fix,
    zbFixAt: number,
  ): Track {
    let match: GzmMatch | null = null;
    if (feed) {
      const cached = prev && prev.feed === feed ? prev.match : null;
      if (cached && (!rec.upcoming.length || fits(cached.trip, cached.base, rec.upcoming))) match = cached;
      else match = matchTrip(feed, rec, days);
    }
    const tsS = rec.ts / 1000;
    const delayS = rec.delayMs !== null ? Math.round(rec.delayMs / 1000) : null;
    const { lat, lon } = fix;
    const p = prev?.pos;
    const anchorMoved = !p || metersBetween(p.anchorLat, p.anchorLon, lat, lon) > 15;
    const lastMovedAt = p && !anchorMoved ? p.lastMovedAt : fix.fixAt;
    // ponytail: a bus held 10+ min mid-route by a blockade also reads as stuck (position only until it moves), and a
    // stuck trip comes back while the bus drives to the depot; a cold start needs 10 min to see either
    const stuck = delayS !== null && delayS >= STUCK_SEC && fix.fixAt - lastMovedAt >= STUCK_SEC;

    let trip = match?.trip ?? null;
    let next = rec.upcoming[0]?.seq ?? 0;
    let layover = false;
    if (match && feed) {
      const last = match.trip.stops.length - 1;
      const u = rec.upcoming;
      const end = feed.stops.get(match.trip.stops[last].stopId);
      const atEnd = end !== undefined && metersBetween(lat, lon, end.lat, end.lon) <= AT_STOP_M;
      // the trip is done once the bus stands at its last stop or that stop is behind it: zbiorkom keeps listing it
      // (delay frozen or growing with the clock) or lists nothing; the brigade's next trip is what the vehicle serves now
      layover =
        !u.length ||
        (u.length === 1 && u[0].seq === last && (atEnd || stuck || u[0].dep + (delayS ?? 0) < tsS - LAYOVER_GRACE_SEC));
      if (layover) {
        trip = match.trip.next;
        next = 0;
      } else if (stuck) trip = null;
    }
    if (trip && next >= trip.stops.length) trip = null;

    const stopAt = (i: number) => (trip && feed ? feed.stops.get(trip.stops[i]?.stopId ?? "") : undefined);
    const nextStop = stopAt(next);
    const first = stopAt(0);
    const notStarted = !!trip && next === 0 && (layover || (first !== undefined && metersBetween(lat, lon, first.lat, first.lon) <= NOT_STARTED_M));
    const prevStop = next > 0 ? stopAt(next - 1) : undefined;
    const atStop =
      (nextStop !== undefined && metersBetween(lat, lon, nextStop.lat, nextStop.lon) <= AT_STOP_M) ||
      (prevStop !== undefined && metersBetween(lat, lon, prevStop.lat, prevStop.lon) <= AT_STOP_M);

    const step = p ? metersBetween(p.lat, p.lon, lat, lon) : 0;
    const heading =
      fix.bearing ??
      (p && step >= 8 ? bearing(p.lat, p.lon, lat, lon) : null) ??
      p?.bearing ??
      (nextStop ? bearing(lat, lon, nextStop.lat, nextStop.lon) : null);

    const vt = Number(rec.type);
    const pos: VehiclePos = {
      execId: `gzm:${rec.key}`,
      tripId: trip?.tripId ?? "",
      routeId: trip?.routeId ?? "",
      line: rec.line || trip?.line || "",
      headsign: (layover ? trip?.headsign : rec.headsign || trip?.headsign) ?? "",
      lat,
      lon,
      vehicleType: vt === 0 || vt === 11 ? vt : 3,
      currentStopSequence: trip ? (next > 0 ? next - 1 : 0) : null,
      atStop,
      delay: !trip || notStarted ? null : delayS,
      timestamp: Math.floor(tsS),
      updatedAt: nowS,
      bearing: heading,
      nextStopName: nextStop?.name ?? null,
      nextStopLat: nextStop?.lat ?? null,
      nextStopLon: nextStop?.lon ?? null,
      lastMovedAt,
      anchorLat: p && !anchorMoved ? p.anchorLat : lat,
      anchorLon: p && !anchorMoved ? p.anchorLon : lon,
      finished: false,
      operator: "GZM",
      sideNumber: rec.label,
      ...(rec.model ? { model: rec.model } : {}),
      ...(notStarted ? { notStarted: true } : {}),
      ...(trip ? { schedTripId: trip.tripId, nextStopSeq: next } : {}),
      fixAt: fix.fixAt,
    };
    if (trip && feed) this.attachRouteInfo(pos, trip, next, prev, feed);
    const date = match?.date ?? "";
    // the exec id is the vehicle, not the trip: a new trip (or the same one on another day) starts a new log
    if (trip) {
      const same = prev?.trip === trip && prev.date === date ? p?.arrivals : undefined;
      pos.arrivals = stepArrivals(same, next - 1, nowS, fix.fixAt);
    }
    return { rec, pos, feed, match, trip, date, base: match?.base ?? 0, next, notStarted, zbFixAt };
  }

  /** Shape key, along-route distance and cruise speed (the MzkPoller pattern). Isolated per vehicle. */
  private attachRouteInfo(pos: VehiclePos, trip: GzmTrip, next: number, prev: Track | undefined, feed: GzmFeed): void {
    try {
      const geom = trip.shapeId ? feed.shapes.geometry(trip.shapeId) : null;
      // the shape's stop chainage comes from one trip of that shape; a trip with other calls gets no shape
      pos.shapeKey = geom && geom.stops.length === trip.stops.length ? trip.shapeId : null;
      const p = prev?.pos;
      if (geom && pos.shapeKey) {
        const hint = p && p.tripId === pos.tripId && p.distRev === geom.rev && p.distM != null ? p.distM : undefined;
        const gap = p?.fixAt !== undefined && pos.fixAt !== undefined ? pos.fixAt - p.fixAt : 0;
        const d = kbDistAlong(geom, pos.lat, pos.lon, next > 0 ? next - 1 : 0, next, hint, { aheadM: kbAheadM(gap) });
        if (d !== null) {
          pos.distM = d;
          pos.distRev = geom.rev;
        }
      }
      if (!p || pos.fixAt === undefined) return;
      const prevFix = p.fixAt ?? p.updatedAt;
      if (pos.fixAt - prevFix < 0.5) {
        pos.moveDs = p.moveDs;
        pos.speed = p.speed;
        pos.speedAt = p.speedAt;
        return;
      }
      const along = pos.distM != null && p.distM != null && p.distRev === pos.distRev && p.tripId === pos.tripId;
      const ds = along ? pos.distM! - p.distM! : metersBetween(p.lat, p.lon, pos.lat, pos.lon);
      const s = nextSpeed(p.speed, p.moveDs, ds, pos.fixAt - prevFix, 0, p.atStop || pos.atStop);
      pos.moveDs = ds;
      pos.speed = s ?? p.speed;
      pos.speedAt = s !== null ? pos.fixAt : p.speedAt;
    } catch (err) {
      pos.shapeKey = null;
      pos.distM = null;
      const now = this.now();
      if (now - this.routeErrLoggedAt > 60_000) {
        this.routeErrLoggedAt = now;
        log.error("gzm", `route info failed for ${pos.execId}: ${err}`);
      }
    }
  }

  private fresh(nowS: number): boolean {
    return nowS - this.lastGood <= STALE_SEC;
  }

  /** GET /api/vehicles?city=gzm body (prebuilt per poll; empty once the last good poll is stale). */
  vehiclesBody(): string {
    const nowMs = this.now();
    this.lastWatch = nowMs;
    const nowS = nowMs / 1000;
    if (this.body && this.fresh(nowS)) return this.body;
    const empty: VehiclesResponse = { timestamp: this.lastGood, scan_count: this.scanCount, last_scan: this.lastScan, count: 0, vehicles: [] };
    return JSON.stringify(empty);
  }

  /** Board of one pole from the feed + the live join; null while the feed loads, "unknown" for a pole not in it. */
  departures(stopId: string): { rows: Array<Record<string, unknown>>; server_ts: number } | null | "unknown" {
    const feed = this.getFeed();
    if (!feed) return null;
    if (!feed.stops.has(stopId)) return "unknown";
    const nowMs = this.now();
    const nowS = nowMs / 1000;
    const { date, secs } = warsawClock(nowMs);
    const live = this.fresh(nowS);
    const bases = new Map<string, number>();
    const base = (d: string): number => {
      let b = bases.get(d);
      if (b === undefined) bases.set(d, (b = serviceDayBase(d)));
      return b;
    };
    const rows: Array<Record<string, unknown>> = [];
    // an hour back: a late bus still departs; the row filter below drops what is gone
    for (const e of stopEvents(feed.router, [stopId], date, secs - 3600, secs + 3 * 3600)) {
      const trip = feed.trips.get(e.trip.tripId);
      if (!trip) continue;
      const tr = live ? this.byTrip.get(`${trip.tripId}|${e.serviceDate}`) : undefined;
      if (tr && tr.next > e.pos) continue;
      const b = base(e.serviceDate);
      const plan = b + trip.stops[e.pos].dep;
      let eta: number | null = null;
      let delay: number | null = null;
      if (tr?.notStarted) eta = plan + Math.max(0, nowS - (b + trip.stops[0].dep));
      else if (tr && tr.pos.delay !== null) {
        delay = tr.pos.delay;
        eta = plan + delay;
      }
      if ((eta ?? plan) < nowS - LAYOVER_GRACE_SEC) continue;
      rows.push({
        trip_execution_id: tr ? tr.pos.execId : "",
        trip_id: trip.tripId,
        static_time: hhmm(plan),
        time: hhmm(eta ?? plan),
        time_diff: delay ?? 0,
        is_estimated: delay !== null,
        ...(tr?.notStarted ? { not_started: true } : {}),
        direction: trip.stopHeadsigns?.[e.pos] ?? trip.headsign,
        line_name: trip.line,
        operator: "GZM",
        ...(tr ? { side_number: tr.rec.label, ...(tr.rec.model ? { model: tr.rec.model } : {}) } : {}),
        plan_ts: plan,
        eta_ts: eta,
        delay_sec: delay,
        at_stop: false,
        canceled: false,
        trip_index: e.pos,
        row_key: gzmRowKey(trip.tripId.slice(4), trip.stops[e.pos].seq),
      });
    }
    return { rows: preSortRows(rows, nowS).slice(0, BOARD_ROWS), server_ts: nowS };
  }

  /** A pole's whole-day timetable; null while the feed loads, "unknown" for a pole not in it. */
  timetable(stopId: string, date: string): { departures: Array<Record<string, unknown>> } | null | "unknown" {
    const feed = this.getFeed();
    if (!feed) return null;
    if (!feed.stops.has(stopId)) return "unknown";
    // a day table costs ~100 ms and the router keeps 4: never build one for a date the feed does not cover
    if (feed.startDate && feed.endDate && (date < feed.startDate || date > feed.endDate)) return { departures: [] };
    return {
      departures: stopEvents(feed.router, [stopId], date, 0, 86400).map((e) => {
        const trip = feed.trips.get(e.trip.tripId);
        return {
          trip_id: e.trip.tripId,
          departure: e.dep,
          line: e.trip.line,
          direction: trip?.stopHeadsigns?.[e.pos] ?? e.trip.headsign,
          operator: "GZM",
        };
      }),
    };
  }

  /**
   * Static trip (no live estimates: /api/trip and /api/trips responses are cached); null while the feed loads.
   * Flat like the MZK branch of /api/trip: the trip body with the shape ref beside `times`, not the
   * trip_execution envelope.
   */
  trip(tripId: string): Record<string, unknown> | null | "unknown" {
    const feed = this.getFeed();
    if (!feed) return null;
    const trip = feed.trips.get(tripId);
    if (!trip) return "unknown";
    const { trip: body, shape, shape_id, shape_status } = tripJson(feed, trip, null);
    return { ...(body as Record<string, unknown>), shape, shape_id, shape_status };
  }

  /** The feed in use (null while it loads). */
  currentFeed(): GzmFeed | null {
    return this.getFeed();
  }

  /** Feed road shapes by wire id; every id missing while the feed loads. */
  shapes(ids: readonly string[]): { shapes: Record<string, ShapePayload>; missing: string[]; exact: boolean } {
    return this.getFeed()?.shapes.lookup(ids) ?? { shapes: {}, missing: [...ids], exact: false };
  }

  /**
   * Connection search over the feed alone (no cross-city routing), legs tagged GZM with their shape ids;
   * null while the feed loads. A search costs 100 ms to over 1 s of the loop the pollers share (one 2026-10-28
   * profile), so it is memoized per minute and searches only one fallback day.
   */
  // ponytail: synchronous on the shared event loop; move the GZM index to worker_threads if p95 passes ~300 ms
  connections(q: RouteQuery): ConnectionItinerary[] | null {
    const feed = this.getFeed();
    if (!feed) return null;
    const now = this.now();
    const { date: today, secs } = warsawClock(now);
    const afterSecs = q.afterSecs ?? (!q.date || q.date === today ? secs - (secs % 60) : undefined);
    const query: RouteQuery = { ...q, afterSecs, fromIds: [q.from], toIds: [q.to], fallbackDays: 1 };
    const key = JSON.stringify(query);
    const hit = this.connMemo.get(key);
    if (hit && hit.feed === feed && now - hit.at <= CONN_MEMO_MS) return hit.res;
    const res = findConnections(query, feed.router);
    for (const c of res) {
      for (const leg of c.legs) {
        leg.operator = "GZM";
        const shape = feed.trips.get(leg.tripId)?.shapeId;
        const id = shape ? feed.shapes.wireId(shape) : null;
        if (id) leg.shape_id = id;
      }
    }
    this.connMemo.delete(key);
    this.connMemo.set(key, { at: now, feed, res });
    if (this.connMemo.size > CONN_MEMO) this.connMemo.delete(this.connMemo.keys().next().value!);
    return res;
  }

  /** Live trip of a vehicle (`gzm:<op>_<fleet>`); null when it is not on a known trip or the feed is stale. */
  tripExecution(execId: string): Record<string, unknown> | null {
    if (!execId.startsWith("gzm:") || !this.fresh(this.now() / 1000)) return null;
    const tr = this.tracks.get(execId.slice(4));
    if (!tr?.trip || !tr.feed) return null;
    const delay = tr.notStarted ? null : tr.pos.delay;
    return {
      ...tripJson(tr.feed, tr.trip, delay !== null ? { from: tr.next, diff: delay } : null),
      vehicle: { lat: tr.pos.lat, lon: tr.pos.lon, ...(tr.pos.bearing !== null ? { bearing: tr.pos.bearing } : {}) },
      vehicle_trip_index: tr.next,
      ...(tr.pos.arrivals ? { arrived: tr.pos.arrivals.arrived } : {}),
      ...(tr.notStarted ? { not_started: true } : {}),
    };
  }

  health(): Record<string, unknown> {
    let matched = 0;
    let notStarted = 0;
    let sdipUsed = 0;
    for (const t of this.tracks.values()) {
      if (t.trip) matched += 1;
      if (t.notStarted) notStarted += 1;
      if (t.pos.fixAt !== t.zbFixAt) sdipUsed += 1;
    }
    const now = this.now();
    const hours = Math.max(1 / 60, (now - this.startedAt) / 3_600_000);
    return {
      started: this.running,
      vehicles: this.fresh(now / 1000) ? this.tracks.size : 0,
      matched,
      unmatched: this.tracks.size - matched,
      not_started: notStarted,
      scan_count: this.scanCount,
      last_scan: this.lastScan,
      last_good: this.lastGood,
      last_error: this.lastError,
      failures: this.failures,
      poll_ms: this.pollMs,
      /** decoded body bytes */
      bytes_per_hour: Math.round(this.bytes / hours),
      sdip: {
        enabled: this.sdipUrl !== null,
        watching: now - this.lastWatch <= WATCH_MS,
        last_good: this.sdipLastGood,
        last_error: this.sdipError,
        paused_until: this.sdipPausedUntil > now ? this.sdipPausedUntil / 1000 : null,
        moved: this.sdipMoved,
        vehicles_on_sdip_fix: sdipUsed,
        bytes_per_hour: Math.round(this.sdipBytes / hours),
      },
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1e5) / 10,
      feed: gzmFeedHealth(),
    };
  }
}

function tripJson(feed: GzmFeed, trip: GzmTrip, est: { from: number; diff: number } | null): Record<string, unknown> {
  const shapeId = trip.shapeId ? feed.shapes.wireId(trip.shapeId) : null;
  return {
    trip: {
      times: trip.stops.map((s, i) => ({
        stop_name: feed.stops.get(s.stopId)?.name ?? "",
        designator: null,
        place_id: s.stopId,
        departure_time: clock(s.dep),
        index: i,
        platform: null,
        ...(est && i >= est.from ? { estimate: { time_diff: est.diff } } : {}),
      })),
      direction: trip.headsign,
      line: { name: trip.line },
      lineName: trip.line,
      operator: "GZM",
    },
    vehicle: null,
    vehicle_trip_index: 0,
    // road geometry is fetched by id from /api/shapes (MapApp buildTrip), never inlined
    shape: null,
    ...(shapeId ? { shape_id: shapeId } : {}),
    shape_status: feed.shapes.status(trip.shapeId),
  };
}

/* ---------------- singleton ---------------- */

const KEY = Symbol.for("kb-gtfs.gzm");
type GzmGlobal = typeof globalThis & { [KEY]?: GzmLive };

/** The process-wide GZM live layer (created on first use, polling only after startGzm). */
export function getGzm(): GzmLive {
  const g = globalThis as GzmGlobal;
  return (g[KEY] ??= new GzmLive({ fleet: feedGzmFleet }));
}

/** Starts the feed refresh and the positions loop once per process. Never rejects; a no-op with KB_GZM=0. */
export async function startGzm(): Promise<void> {
  if (!config.GZM_ENABLED) return;
  const live = getGzm();
  if (live.running) return;
  void startGzmFeed().catch((err: unknown) => log.error("gzm", `feed start failed: ${err}`));
  live.start();
}

/** Health block for /api/health; never throws. */
export function safeGzmHealth(): Record<string, unknown> {
  if (!config.GZM_ENABLED) return { enabled: false };
  try {
    return { enabled: true, ...getGzm().health() };
  } catch (err) {
    return { enabled: true, error: String(err) };
  }
}
