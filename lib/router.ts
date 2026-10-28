/**
 * Static GTFS connection search / trip planner engine.
 *
 * Runs in-memory routing over the built KB GTFS feed (output/gtfs/{stops,trips,stop_times,calendar}.txt)
 * plus the MZK Bielsko-Biała timetable (lib/mzk-timetable.ts, stops `mzk:<symbol>`, trips active on the
 * dates whose OnTime day type they belong to). The search is range RAPTOR (Delling et al. 2012): one round
 * per ride, walking transfers between any two poles ≤ 350 m apart (KB and MZK alike), and the answer is
 * the Pareto set of (later departure, earlier arrival, fewer transfers) over the departures after the
 * query time. Each searched service day is cut into FIFO routes once and cached (last 4 dates).
 *
 * Cost on the 2026-10 data (1155 KB trips + 6863 MZK courses, 2026-10-21): index + first day table 182 ms
 * and ~17 MB heap, each further day table 15-20 ms and ~0.5 MB; a query 5.5 ms p50, 32 ms p95, 124 ms max (47220 sampled pairs).
 *
 * The Metropolia GZM feed gets its own index (buildRouterIndex, lib/gzm-feed.ts): trips carry their dates and
 * pickup/drop-off flags, poles group by name without the post number. On 2026-10-28 (33733 trips, 7389 poles):
 * index 147 ms / 13 MB, a day table 45 ms / 3 MB, a query 43 ms p50, 331 ms p95, 1185 ms max (200 random pairs,
 * slow ones = rural targets that need the 24 h window).
 */
import fs from "node:fs";
import path from "node:path";

import * as config from "./config";
import { col, NO_DROP_OFF, NO_PICKUP, parseCsvLine, splitLines } from "./gtfs-csv";
import { log } from "./logger";
import { loadMzkTimetable } from "./mzk-timetable";
import { nowSecs } from "./poller";

export interface ConnectionLegStop {
  stopId: string;
  stopName: string;
  arrivalTime: string;
  departureTime: string;
  lat?: number;
  lon?: number;
}

export interface ConnectionLeg {
  line: string;
  tripId: string;
  headsign: string;
  fromStopId: string;
  fromStopName: string;
  toStopId: string;
  toStopName: string;
  departureTime: string;
  arrivalTime: string;
  departureSecs: number;
  arrivalSecs: number;
  durationMins: number;
  stopsCount: number;
  stops?: ConnectionLegStop[];
  /** walk from the previous leg's last pole to this leg's first, minutes (0 = the same stop); absent on the first leg */
  walkMins?: number;
  /** stored road geometry of the leg's trip pattern (GET /api/shapes), when routed */
  shape_id?: string;
  operator?: "KB" | "MZK" | "GZM";
}

export interface ConnectionItinerary {
  type: "direct" | "transfer";
  departureTime: string;
  arrivalTime: string;
  departureSecs: number;
  arrivalSecs: number;
  totalDurationMins: number;
  transfersCount: number;
  transferWaitMins?: number;
  transferStopName?: string;
  walkMinutes?: number;
  date?: string;
  dayLabel?: string;
  arrivesNextDay?: boolean;
  legs: ConnectionLeg[];
}

export interface RouteQuery {
  from: string;
  to: string;
  /** router stop ids of the origin (KB stop id, `mzk:<symbol>`); `from` is the name fallback when none is known */
  fromIds?: string[];
  toIds?: string[];
  afterSecs?: number;
  limit?: number;
  directOnly?: boolean;
  minTransferSecs?: number;
  maxTransferSecs?: number;
  date?: string;
  dayLabel?: string;
  sortBy?: "departure" | "duration" | "arrival";
  /** following days searched when today's query finds nothing (default 3) */
  fallbackDays?: number;
}

interface StopEntry {
  id: string;
  name: string;
  nameKey: string;
  cleanKey: string;
  lat: number;
  lon: number;
}

export interface TripStopEntry {
  stopId: string;
  seq: number;
  arr: number;
  dep: number;
}

export interface TripEntry {
  tripId: string;
  serviceId: string;
  routeId: string;
  line: string;
  headsign: string;
  stops: TripStopEntry[];
  /** MZK only: the OnTime day types the course runs on (KB trips use serviceId + calendar.txt) */
  dayTypes?: Set<string>;
  /** GZM only: the Warsaw dates the trip runs on (checked before dayTypes and calendar.txt; empty = never) */
  dates?: ReadonlySet<string>;
  /** GZM only: per call gtfs-csv pickup bits; NO_PICKUP / NO_DROP_OFF calls are not boarded / alighted */
  flags?: Uint8Array;
  /** stop numbers (RouterIndex.stopIds) in stop order; trips with the same `pattern` share RAPTOR routes */
  nums: Int32Array;
  pattern: string;
}

export interface RouterStopInput {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** name the poles are grouped and searched by, when it differs from `name` (GZM drops the post number) */
  key?: string;
}

export interface RouterInput {
  /** in numbering order */
  stops: RouterStopInput[];
  trips: Map<string, TripEntry>;
  services?: Map<string, number[]>;
  mzkDayTypes?: Map<string, string>;
}

interface Footpath {
  to: number;
  secs: number;
}

/** Trips of one service day with the same stop sequence, none overtaking another (RAPTOR needs FIFO). */
interface Route {
  stops: Int32Array;
  trips: TripEntry[];
  /** [trip * stops.length + position], secs from the searched date's midnight */
  arr: Int32Array;
  dep: Int32Array;
  /** the pattern's blocking pickup bits (part of the pattern key), null when every call is open */
  flags: Uint8Array | null;
}

interface DayTable {
  routes: Route[];
  /** per stop number: flat [route, position, route, position, ...] */
  at: number[][];
}

export interface RouterIndex {
  stops: Map<string, StopEntry>;
  polesByName: Map<string, Set<string>>;
  polesByCleanKey: Map<string, Set<string>>;
  /** stop number -> router stop id */
  stopIds: string[];
  stopNum: Map<string, number>;
  /** walkable poles per stop number */
  foot: Footpath[][];
  /** an MZK course whose calls differ between day types has one entry per variant (`<id>#<n>`) */
  trips: Map<string, TripEntry>;
  services: Map<string, number[]>;
  /** Warsaw ISO date -> MZK day type, for the dates the MZK timetable covers */
  mzkDayTypes: Map<string, string>;
  /** route tables of the last searched dates (bounded by DAY_CACHE) */
  days: Map<string, DayTable>;
}

const WALK_MAX_M = 350;
/** poles closer than this are one stop (the KB and MZK pole of one shelter), no walk; twins of one operator stand >= 5 m apart */
const SAME_STOP_M = 4;
const WALK_MPS = 1.1;
/** slack on top of a walk between poles, so a walking transfer is never tighter than walk + 1.5 min */
const WALK_MARGIN_SECS = 90;
const DEFAULT_CHANGE_SECS = 180;
// ponytail: 5 rides (4 transfers) cover the KB + MZK network; raise it if a pair ever needs more
const MAX_RIDES = 5;
const DAY_CACHE = 4;
const FIRST_WINDOW_SECS = 2 * 3600;
const INF = 0x3fffffff;

const ROUTER_CACHE_KEY = Symbol.for("kb-gtfs.router-cache");
type GlobalWithRouterCache = typeof globalThis & { [ROUTER_CACHE_KEY]?: RouterIndex | null };

function getGlobalCache(): RouterIndex | null {
  return (globalThis as GlobalWithRouterCache)[ROUTER_CACHE_KEY] ?? null;
}

function setGlobalCache(idx: RouterIndex | null): void {
  (globalThis as GlobalWithRouterCache)[ROUTER_CACHE_KEY] = idx;
}

/** Invalidate cached router index across all Next.js module bundles */
export function invalidateRouter(): void {
  setGlobalCache(null);
}

/**
 * Normalizes text for resilient matching:
 * - Lowercases
 * - Removes diacritics (including Polish ł -> l, ą -> a, etc.)
 * - Strips punctuation (commas, dots, hyphens, slashes)
 * - Collapses single-letter acronym spaces (e.g. "d.a." or "d a" -> "da")
 * - Trims extra whitespace
 */
export function cleanText(s: string): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b([a-z0-9])\s+([a-z0-9])\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function parseTimeSecs(hhmmss: string): number {
  const parts = hhmmss.split(":").map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

function formatHHMM(secs: number): string {
  const wrapped = ((Math.floor(secs) % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function weekdayMonday0(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 0;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (dt.getUTCDay() + 6) % 7;
}

export function offsetDate(dateStr: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

const PL_WEEKDAYS = ["Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota", "Niedziela"];

function approxDistMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/** Makes a trip's times non-decreasing: a drop of more than 12 h is a midnight wrap (+24 h), a smaller one is clamped. */
function monotonic(stops: TripStopEntry[]): void {
  let wrap = 0;
  let prev = -Infinity;
  for (const s of stops) {
    let arr = s.arr + wrap;
    if (arr < prev - 43200) {
      wrap += 86400;
      arr += 86400;
    }
    s.arr = Math.max(arr, prev);
    s.dep = Math.max(s.dep + wrap, s.arr);
    prev = s.dep;
  }
}

function sameCalls(a: TripStopEntry[], b: TripStopEntry[]): boolean {
  return a.length === b.length && a.every((s, i) => s.stopId === b[i].stopId && s.dep === b[i].dep);
}

function loadIndex(): RouterIndex | null {
  const dir = config.GTFS_DIR;
  let stopsTxt: string;
  let tripsTxt: string;
  let timesTxt: string;

  try {
    stopsTxt = fs.readFileSync(path.join(dir, "stops.txt"), "utf-8");
    tripsTxt = fs.readFileSync(path.join(dir, "trips.txt"), "utf-8");
    timesTxt = fs.readFileSync(path.join(dir, "stop_times.txt"), "utf-8");
  } catch {
    return null;
  }

  const stopInputs: RouterStopInput[] = [];
  const addStop = (id: string, name: string, lat: number, lon: number): void => {
    stopInputs.push({ id, name, lat, lon });
  };

  const stopLines = splitLines(stopsTxt);
  const stopHdr = parseCsvLine(stopLines[0]);
  const iStopId = col(stopHdr, "stop_id");
  const iStopName = col(stopHdr, "stop_name");
  const iStopLat = col(stopHdr, "stop_lat");
  const iStopLon = col(stopHdr, "stop_lon");

  if (iStopId >= 0 && iStopName >= 0) {
    for (let i = 1; i < stopLines.length; i++) {
      if (!stopLines[i]) continue;
      const f = parseCsvLine(stopLines[i]);
      const id = f[iStopId];
      const name = f[iStopName];
      if (!id || !name) continue;
      const lat = iStopLat >= 0 ? Number(f[iStopLat]) || 0 : 0;
      const lon = iStopLon >= 0 ? Number(f[iStopLon]) || 0 : 0;
      addStop(id, name, lat, lon);
    }
  }

  // MZK stops join the same pole maps, so walking transfers to/from KB poles come for free
  const mzk = loadMzkTimetable();
  if (mzk) {
    for (const [sym, [name, lat, lon]] of Object.entries(mzk.stops)) addStop(`mzk:${sym}`, name, lat, lon);
  }

  const trips = new Map<string, TripEntry>();
  const tripLines = splitLines(tripsTxt);
  const tripHdr = parseCsvLine(tripLines[0]);
  const iTripId = col(tripHdr, "trip_id");
  const iServiceId = col(tripHdr, "service_id");
  const iRouteId = col(tripHdr, "route_id");
  const iHeadsign = col(tripHdr, "trip_headsign");
  const iShortName = col(tripHdr, "trip_short_name");

  if (iTripId >= 0) {
    for (let i = 1; i < tripLines.length; i++) {
      if (!tripLines[i]) continue;
      const f = parseCsvLine(tripLines[i]);
      const tripId = f[iTripId];
      if (!tripId) continue;
      trips.set(tripId, {
        tripId,
        serviceId: iServiceId >= 0 ? f[iServiceId] || "" : "",
        routeId: iRouteId >= 0 ? f[iRouteId] || "" : "",
        headsign: iHeadsign >= 0 ? f[iHeadsign] || "" : "",
        line: (iShortName >= 0 ? f[iShortName] : "") || (iRouteId >= 0 ? (f[iRouteId] ?? "").replace(/^L_/, "") : "") || "—",
        stops: [],
        nums: new Int32Array(0),
        pattern: "",
      });
    }
  }

  const timeLines = splitLines(timesTxt);
  const timeHdr = parseCsvLine(timeLines[0]);
  const iTTimeTrip = col(timeHdr, "trip_id");
  const iTTimeArr = col(timeHdr, "arrival_time");
  const iTTimeDep = col(timeHdr, "departure_time");
  const iTTimeStop = col(timeHdr, "stop_id");
  const iTTimeSeq = col(timeHdr, "stop_sequence");

  if (iTTimeTrip >= 0 && iTTimeStop >= 0 && iTTimeDep >= 0) {
    for (let i = 1; i < timeLines.length; i++) {
      if (!timeLines[i]) continue;
      const f = parseCsvLine(timeLines[i]);
      const tripId = f[iTTimeTrip];
      const trip = trips.get(tripId);
      if (!trip) continue;
      const stopId = f[iTTimeStop];
      const depStr = f[iTTimeDep];
      const arrStr = iTTimeArr >= 0 ? f[iTTimeArr] || depStr : depStr;
      const seq = iTTimeSeq >= 0 ? Number(f[iTTimeSeq]) : trip.stops.length;
      trip.stops.push({
        stopId,
        seq,
        arr: parseTimeSecs(arrStr),
        dep: parseTimeSecs(depStr),
      });
    }
  }

  // one OnTime course id may run different calls on different day types: keep each variant
  for (const t of mzk?.trips ?? []) {
    const calls = t.calls.map(([sym, secs], seq) => ({ stopId: `mzk:${sym}`, seq, arr: secs, dep: secs }));
    let key = t.id;
    let known = trips.get(key);
    for (let v = 1; known && !sameCalls(known.stops, calls); v++) {
      key = `${t.id}#${v}`;
      known = trips.get(key);
    }
    if (known) {
      known.dayTypes?.add(t.dayType);
      continue;
    }
    trips.set(key, {
      tripId: t.id,
      serviceId: `mzk:${t.dayType}`,
      routeId: `mzk:${t.line}`,
      headsign: t.headsign,
      line: t.line,
      stops: calls,
      dayTypes: new Set([t.dayType]),
      nums: new Int32Array(0),
      pattern: "",
    });
  }
  if (mzk) log.info("router", `MZK timetable: ${Object.keys(mzk.stops).length} stops, ${mzk.trips.length} courses`);

  const services = new Map<string, number[]>();
  try {
    const calTxt = fs.readFileSync(path.join(dir, "calendar.txt"), "utf-8");
    const calLines = splitLines(calTxt);
    const calHdr = parseCsvLine(calLines[0]);
    const iSvc = col(calHdr, "service_id");
    const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const iDays = WEEKDAYS.map((w) => col(calHdr, w));
    if (iSvc >= 0) {
      for (let i = 1; i < calLines.length; i++) {
        if (!calLines[i]) continue;
        const f = parseCsvLine(calLines[i]);
        const sId = f[iSvc];
        if (!sId) continue;
        services.set(sId, iDays.map((idx) => (idx >= 0 && f[idx] === "1" ? 1 : 0)));
      }
    }
  } catch {
    // calendar.txt optional
  }

  const mzkDayTypes = new Map(Object.entries(mzk?.calendar ?? {}));
  return buildRouterIndex({ stops: stopInputs, trips, services, mzkDayTypes });
}

/** The calls a trip can't be boarded / alighted at (a first call's NO_DROP_OFF and a last call's NO_PICKUP block nothing). */
function blockFlags(trip: TripEntry): Uint8Array | null {
  const f = trip.flags;
  if (!f) return null;
  let out: Uint8Array | null = null;
  for (let p = 0; p < f.length; p++) {
    let b = f[p] & (NO_PICKUP | NO_DROP_OFF);
    if (p === 0) b &= ~NO_DROP_OFF;
    if (p === f.length - 1) b &= ~NO_PICKUP;
    if (b) (out ??= new Uint8Array(f.length))[p] = b;
  }
  return out;
}

/**
 * Pole maps, stop numbers, trip patterns and walking transfers over the given stops and trips. Sorts, wraps and
 * numbers every trip in place (`stops`, `nums`, `pattern`).
 */
export function buildRouterIndex(input: RouterInput): RouterIndex {
  const stops = new Map<string, StopEntry>();
  const polesByName = new Map<string, Set<string>>();
  const polesByCleanKey = new Map<string, Set<string>>();
  for (const { id, name, lat, lon, key = name } of input.stops) {
    const nameKey = normalizeName(key);
    const cleanKey = cleanText(key);
    stops.set(id, { id, name, nameKey, cleanKey, lat, lon });

    let set1 = polesByName.get(nameKey);
    if (!set1) {
      set1 = new Set();
      polesByName.set(nameKey, set1);
    }
    set1.add(id);

    let set2 = polesByCleanKey.get(cleanKey);
    if (!set2) {
      set2 = new Set();
      polesByCleanKey.set(cleanKey, set2);
    }
    set2.add(id);
  }

  const { trips } = input;
  const stopIds = [...stops.keys()];
  const stopNum = new Map(stopIds.map((id, i) => [id, i]));
  const num = (id: string): number => {
    let n = stopNum.get(id);
    if (n === undefined) {
      n = stopIds.length;
      stopIds.push(id);
      stopNum.set(id, n);
    }
    return n;
  };
  for (const trip of trips.values()) {
    trip.stops.sort((a, b) => a.seq - b.seq);
    monotonic(trip.stops);
    trip.nums = Int32Array.from(trip.stops, (s) => num(s.stopId));
    const blocks = blockFlags(trip);
    trip.pattern = blocks ? `${trip.nums.join(",")}|${blocks.join("")}` : trip.nums.join(",");
  }

  // walking transfers: poles bucketed on a grid of WALK_MAX_M cells, each pole's list in stop-number order
  const foot: Footpath[][] = stopIds.map(() => []);
  const located = stopIds.flatMap((id, i) => {
    const s = stops.get(id);
    return s && s.lat && s.lon ? [{ i, s }] : [];
  });
  const cellLat = WALK_MAX_M / 111320;
  // a degree of longitude is shortest at the highest latitude, so cells sized there hold every pair
  const maxLat = located.reduce((m, p) => Math.max(m, Math.abs(p.s.lat)), 0);
  const cellLon = cellLat / Math.cos(maxLat * (Math.PI / 180));
  const cells = new Map<string, number[]>();
  const cellOf = (lat: number, lon: number): [number, number] => [Math.floor(lat / cellLat), Math.floor(lon / cellLon)];
  located.forEach((p, a) => {
    const [y, x] = cellOf(p.s.lat, p.s.lon);
    const k = `${y},${x}`;
    const c = cells.get(k);
    if (c) c.push(a);
    else cells.set(k, [a]);
  });
  for (let a = 0; a < located.length; a++) {
    const p = located[a];
    const [y, x] = cellOf(p.s.lat, p.s.lon);
    const near: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) for (const b of cells.get(`${y + dy},${x + dx}`) ?? []) if (b > a) near.push(b);
    }
    near.sort((u, v) => u - v);
    for (const b of near) {
      const q = located[b];
      const d = approxDistMeters(p.s.lat, p.s.lon, q.s.lat, q.s.lon);
      if (d > WALK_MAX_M) continue;
      const secs = d < SAME_STOP_M ? 0 : 60 * Math.max(1, Math.ceil(d / WALK_MPS / 60));
      foot[p.i].push({ to: q.i, secs });
      foot[q.i].push({ to: p.i, secs });
    }
  }

  return {
    stops,
    polesByName,
    polesByCleanKey,
    stopIds,
    stopNum,
    foot,
    trips,
    services: input.services ?? new Map(),
    mzkDayTypes: input.mzkDayTypes ?? new Map(),
    days: new Map(),
  };
}

function getIndex(): RouterIndex | null {
  let idx = getGlobalCache();
  if (!idx || idx.trips.size === 0 || idx.stops.size === 0) {
    idx = loadIndex();
    if (idx && idx.trips.size > 0 && idx.stops.size > 0) {
      setGlobalCache(idx);
    }
  }
  return idx;
}

function resolvePoles(input: string, idx: RouterIndex): Set<string> {
  const trimmed = input.trim();
  if (!trimmed) return new Set();

  // 1. Direct numeric stop ID match
  const byId = idx.stops.get(trimmed);
  if (byId) {
    return idx.polesByCleanKey.get(byId.cleanKey) ?? idx.polesByName.get(byId.nameKey) ?? new Set([trimmed]);
  }

  // 2. Exact raw nameKey match
  const rawKey = normalizeName(trimmed);
  const byRaw = idx.polesByName.get(rawKey);
  if (byRaw && byRaw.size > 0) return byRaw;

  // 3. Normalized cleanKey match (punctuation & diacritics stripped)
  const clean = cleanText(trimmed);
  if (!clean) return new Set(); // only punctuation: "" would match every key below
  const byClean = idx.polesByCleanKey.get(clean);
  if (byClean && byClean.size > 0) return byClean;

  // 4. Input starts with known cleanKey followed by extra text (e.g. "KĘTY, D.A. UL. SIENKIEWICZA" -> "KĘTY D.A.")
  for (const [k, poles] of idx.polesByCleanKey) {
    if (clean.startsWith(k + " ")) {
      return poles;
    }
  }

  // 5. Check hub suffixes on input: e.g. "Kęty" -> "Kęty D.A.", "Kęty Centrum"
  const daKey = cleanText(`${clean} d.a.`);
  if (idx.polesByCleanKey.has(daKey)) {
    return idx.polesByCleanKey.get(daKey)!;
  }
  const daKey2 = cleanText(`${clean} da`);
  if (idx.polesByCleanKey.has(daKey2)) {
    return idx.polesByCleanKey.get(daKey2)!;
  }
  const centKey = cleanText(`${clean} centrum`);
  if (idx.polesByCleanKey.has(centKey)) {
    return idx.polesByCleanKey.get(centKey)!;
  }
  const dwKey = cleanText(`${clean} dworzec`);
  if (idx.polesByCleanKey.has(dwKey)) {
    return idx.polesByCleanKey.get(dwKey)!;
  }

  // 6. Combine poles for stops starting with query
  const combined = new Set<string>();
  for (const [k, poles] of idx.polesByCleanKey) {
    if (k.startsWith(clean + " ") || k === clean) {
      for (const p of poles) combined.add(p);
    }
  }
  if (combined.size > 0) return combined;

  // 7. Substring search on clean keys (a 1-2 letter fragment would match half the network)
  if (clean.length < 3) return combined;
  for (const [k, poles] of idx.polesByCleanKey) {
    if (k.includes(clean)) {
      for (const p of poles) combined.add(p);
    }
  }
  return combined;
}

/** Union of the poles of the given stop ids; falls back to resolving `input` by name when none is known. */
function resolveQueryPoles(ids: string[] | undefined, input: string, idx: RouterIndex): Set<string> {
  const poles = new Set<string>();
  for (const id of ids ?? []) {
    if (idx.stops.has(id)) for (const p of resolvePoles(id, idx)) poles.add(p);
  }
  return poles.size > 0 ? poles : resolvePoles(input, idx);
}

/** `date` is the trip's service day (Warsaw ISO), `dayOfWeek` its weekday (Monday = 0). */
function isTripActiveOnDay(trip: TripEntry, dayOfWeek: number, date: string, idx: RouterIndex): boolean {
  if (trip.dates) return trip.dates.has(date);
  if (trip.dayTypes) {
    const type = idx.mzkDayTypes.get(date);
    return type !== undefined && trip.dayTypes.has(type);
  }
  const services = idx.services;
  if (services.size <= 1) return true;
  const days = services.get(trip.serviceId);
  if (!days) return true;
  return days[dayOfWeek] === 1;
}

function buildLegStops(
  trip: TripEntry,
  startIdx: number,
  endIdx: number,
  idx: RouterIndex,
  baseDepSecs: number,
): ConnectionLegStop[] {
  const result: ConnectionLegStop[] = [];
  const tripDep0 = trip.stops[startIdx].dep;
  for (let s = startIdx; s <= endIdx; s++) {
    const ts = trip.stops[s];
    const sEntry = idx.stops.get(ts.stopId);
    const offsetArr = s === startIdx ? 0 : (ts.arr < tripDep0 ? ts.arr + 86400 : ts.arr) - tripDep0;
    const offsetDep = (ts.dep < tripDep0 ? ts.dep + 86400 : ts.dep) - tripDep0;
    result.push({
      stopId: ts.stopId,
      stopName: sEntry?.name || ts.stopId,
      arrivalTime: formatHHMM(baseDepSecs + offsetArr),
      departureTime: formatHHMM(baseDepSecs + offsetDep),
      lat: sEntry?.lat,
      lon: sEntry?.lon,
    });
  }
  return result;
}

interface Instance {
  trip: TripEntry;
  off: number;
}

function overtakes(a: Instance, b: Instance): boolean {
  const x = a.trip.stops;
  const y = b.trip.stops;
  for (let p = 0; p < x.length; p++) {
    if (x[p].dep + a.off < y[p].dep + b.off || x[p].arr + a.off < y[p].arr + b.off) return true;
  }
  return false;
}

/**
 * The FIFO routes of every trip instance that can matter on `date`: the day's own trips, the previous
 * day's trips still running after midnight (-24 h) and the next day's trips (+24 h).
 */
function dayTable(idx: RouterIndex, date: string): DayTable {
  const hit = idx.days.get(date);
  if (hit) return hit;
  const groups = new Map<string, Instance[]>();
  for (let o = -1; o <= 1; o++) {
    const d = offsetDate(date, o);
    const wd = weekdayMonday0(d);
    for (const trip of idx.trips.values()) {
      const n = trip.stops.length;
      if (n < 2 || (o < 0 && trip.stops[n - 1].arr < 86400) || !isTripActiveOnDay(trip, wd, d, idx)) continue;
      let g = groups.get(trip.pattern);
      if (!g) groups.set(trip.pattern, (g = []));
      g.push({ trip, off: o * 86400 });
    }
  }
  const routes: Route[] = [];
  const at: number[][] = idx.stopIds.map(() => []);
  for (const g of groups.values()) {
    g.sort((a, b) => a.trip.stops[0].dep + a.off - (b.trip.stops[0].dep + b.off));
    const split: Instance[][] = [];
    for (const inst of g) {
      const fit = split.find((s) => !overtakes(inst, s[s.length - 1]));
      if (fit) fit.push(inst);
      else split.push([inst]);
    }
    for (const s of split) {
      const seq = s[0].trip.nums;
      const len = seq.length;
      const arr = new Int32Array(s.length * len);
      const dep = new Int32Array(s.length * len);
      s.forEach(({ trip, off }, t) =>
        trip.stops.forEach((st, p) => {
          arr[t * len + p] = st.arr + off;
          dep[t * len + p] = st.dep + off;
        }),
      );
      const r = routes.length;
      routes.push({ stops: seq, trips: s.map((x) => x.trip), arr, dep, flags: blockFlags(s[0].trip) });
      for (let p = 0; p < len; p++) at[seq[p]].push(r, p);
    }
  }
  const table = { routes, at };
  const oldest = idx.days.keys().next().value;
  if (idx.days.size >= DAY_CACHE && oldest !== undefined) idx.days.delete(oldest);
  idx.days.set(date, table);
  return table;
}

export interface StopEvent {
  trip: TripEntry;
  /** call index in trip.stops */
  pos: number;
  /** secs from `date`'s midnight, like every router time */
  arr: number;
  dep: number;
  /** the trip's own service day (the previous day's trips run on at -24 h, the next day's at +24 h) */
  serviceDate: string;
}

/**
 * Boardable calls at the given poles that depart in [from, to) secs of `date`, earliest first. A trip's last call
 * and NO_PICKUP calls are no departures. Secs assume 24 h days, so the window edges slip an hour on a DST day.
 */
export function stopEvents(idx: RouterIndex, poleIds: Iterable<string>, date: string, from: number, to: number, limit = Infinity): StopEvent[] {
  const table = dayTable(idx, date);
  const out: StopEvent[] = [];
  for (const id of poleIds) {
    const n = idx.stopNum.get(id);
    if (n === undefined) continue;
    const list = table.at[n];
    for (let i = 0; i < list.length; i += 2) {
      const route = table.routes[list[i]];
      const p = list[i + 1];
      const len = route.stops.length;
      if (p === len - 1 || (route.flags && route.flags[p] & NO_PICKUP)) continue;
      for (let t = 0; t < route.trips.length; t++) {
        const dep = route.dep[t * len + p];
        if (dep < from || dep >= to) continue;
        const trip = route.trips[t];
        const serviceDate = offsetDate(date, Math.round((dep - trip.stops[p].dep) / 86400));
        out.push({ trip, pos: p, arr: route.arr[t * len + p], dep, serviceDate });
      }
    }
  }
  out.sort((a, b) => a.dep - b.dep);
  return out.length > limit ? out.slice(0, limit) : out;
}

interface Ride {
  route: Route;
  trip: number;
  board: number;
  alight: number;
  /** walk from the previous ride's alighting pole to `board`; 0 = same pole, same stop or first ride */
  walkSecs: number;
}

/**
 * Range RAPTOR: every Pareto-optimal (departure, arrival, rides) journey from `origins` to a target
 * pole that leaves in [after, end). Departures are processed latest first with labels kept between them,
 * so each one only reports journeys that beat everything leaving later; `end` itself is a silent first
 * run, so the window's last departures are judged against the ones right after it.
 */
function rangeSearch(
  idx: RouterIndex,
  table: DayTable,
  origins: number[],
  isTarget: Uint8Array,
  after: number,
  end: number,
  rides: number,
  change: number,
  probe: boolean,
): Ride[][] | null {
  const n = idx.stopIds.length;
  const rounds = (fill: number) => Array.from({ length: rides + 1 }, () => new Int32Array(n).fill(fill));
  // per round k = journeys with exactly k rides: arrival by ride, ready-to-board after a transfer, and parents
  const arr = rounds(INF);
  const rdy = rounds(INF);
  const pRoute = rounds(0);
  const pTrip = rounds(0);
  const pBoard = rounds(0);
  const pAlight = rounds(0);
  const pFrom = rounds(0);
  const tgt = new Int32Array(rides + 1).fill(INF);
  const tgtStop = new Int32Array(rides + 1);
  const qPos = new Int32Array(table.routes.length).fill(-1);
  const isMarked = new Uint8Array(n);
  const isArrived = new Uint8Array(n);

  // running minima the rounds compare against: minArr[k][s] = min arr[1..k][s], minRdy[k][s] = min rdy[0..k][s]
  const minArr = rounds(INF);
  const minRdy = rounds(INF);
  const setArr = (k: number, s: number, a: number): void => {
    arr[k][s] = a;
    for (let j = k; j <= rides; j++) if (a < minArr[j][s]) minArr[j][s] = a;
  };
  const setRdy = (k: number, s: number, v: number): void => {
    rdy[k][s] = v;
    for (let j = k; j <= rides; j++) if (v < minRdy[j][s]) minRdy[j][s] = v;
  };
  const walkSecs = (from: number, to: number): number => idx.foot[from].find((f) => f.to === to)?.secs ?? 0;

  const reconstruct = (k: number, s: number): Ride[] => {
    const out: Ride[] = [];
    for (let round = k, stop = s; ; ) {
      const route = table.routes[pRoute[round][stop]];
      const ride: Ride = {
        route,
        trip: pTrip[round][stop],
        board: pBoard[round][stop],
        alight: pAlight[round][stop],
        walkSecs: 0,
      };
      out.push(ride);
      const b = route.stops[ride.board];
      const d = route.dep[ride.trip * route.stops.length + ride.board];
      // the fewest rides that still made this boarding; labels only ever drop, so one always exists
      let j = 0;
      while (j < round - 1 && rdy[j][b] > d) j++;
      if (j === 0) break;
      const q = pFrom[j][b];
      ride.walkSecs = q === b ? 0 : walkSecs(q, b);
      stop = q;
      round = j;
    }
    return out.reverse();
  };

  const found: Ride[][] = [];
  const run = (tau: number, collect: boolean): void => {
    let marked: number[] = [];
    for (const o of origins) {
      // runs go latest tau first, so this only ever lowers the label
      setRdy(0, o, tau);
      if (!isMarked[o]) {
        isMarked[o] = 1;
        marked.push(o);
      }
    }
    const improved: boolean[] = [];
    for (let k = 1; k <= rides && marked.length > 0; k++) {
      if (tgt[k - 1] < tgt[k]) tgt[k] = tgt[k - 1];
      const queue: number[] = [];
      for (const s of marked) {
        isMarked[s] = 0;
        const list = table.at[s];
        for (let i = 0; i < list.length; i += 2) {
          const r = list[i];
          if (qPos[r] < 0) {
            qPos[r] = list[i + 1];
            queue.push(r);
          } else if (list[i + 1] < qPos[r]) qPos[r] = list[i + 1];
        }
      }
      marked = [];

      const arrived: number[] = [];
      for (const r of queue) {
        const route = table.routes[r];
        const len = route.stops.length;
        const nt = route.trips.length;
        const fl = route.flags;
        let t = -1;
        let bp = -1;
        for (let p = qPos[r]; p < len; p++) {
          const s = route.stops[p];
          if (t >= 0 && !(fl && fl[p] & NO_DROP_OFF)) {
            const a = route.arr[t * len + p];
            if (a < tgt[k] && a < minArr[k][s]) {
              setArr(k, s, a);
              pRoute[k][s] = r;
              pTrip[k][s] = t;
              pBoard[k][s] = bp;
              pAlight[k][s] = p;
              if (!isArrived[s]) {
                isArrived[s] = 1;
                arrived.push(s);
              }
              if (isTarget[s]) {
                tgt[k] = a;
                tgtStop[k] = s;
                improved[k] = true;
              }
            }
          }
          if (p === len - 1) break;
          if (fl && fl[p] & NO_PICKUP) continue;
          const b = minRdy[k - 1][s];
          const upTo = t >= 0 ? t : nt;
          if (b >= INF || (t >= 0 && b > route.dep[t * len + p])) continue;
          // earliest trip leaving p at or after b: FIFO keeps departures at p sorted by trip
          let lo = 0;
          let hi = upTo;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (route.dep[mid * len + p] < b) lo = mid + 1;
            else hi = mid;
          }
          if (lo < upTo) {
            t = lo;
            bp = p;
          }
        }
        qPos[r] = -1;
      }

      const relax = (q: number, from: number, v: number): void => {
        if (v >= tgt[k] || v >= minRdy[k][q]) return;
        setRdy(k, q, v);
        pFrom[k][q] = from;
        if (!isMarked[q]) {
          isMarked[q] = 1;
          marked.push(q);
        }
      };
      for (const s of arrived) {
        isArrived[s] = 0;
        const a = arr[k][s];
        relax(s, s, a + change);
        for (const f of idx.foot[s]) relax(f.to, s, a + Math.max(change, f.secs + WALK_MARGIN_SECS));
      }
    }
    for (const s of marked) isMarked[s] = 0;
    if (!collect) return;
    for (let k = 1; k <= rides; k++) if (improved[k]) found.push(reconstruct(k, tgtStop[k]));
  };

  const departures = new Set<number>();
  for (const o of origins) {
    const list = table.at[o];
    for (let i = 0; i < list.length; i += 2) {
      const route = table.routes[list[i]];
      const len = route.stops.length;
      const p = list[i + 1];
      if (p === len - 1 || (route.flags && route.flags[p] & NO_PICKUP)) continue;
      for (let t = 0; t < route.trips.length; t++) {
        const d = route.dep[t * len + p];
        if (d >= after && d < end) departures.add(d);
      }
    }
  }
  if (probe) {
    // a journey leaving at any tau >= after can also leave at after (waiting at the origin), so a target the
    // earliest-arrival run from `after` misses is out of every window's reach: no need to scan 24 h for nothing
    run(after, false);
    let reached = false;
    for (let k = 1; k <= rides; k++) if (tgt[k] < INF) reached = true;
    if (!reached) return null;
    for (const a of [arr, rdy, minArr, minRdy]) for (const r of a) r.fill(INF);
    tgt.fill(INF);
  }
  run(end, false);
  for (const tau of [...departures].sort((a, b) => b - a)) run(tau, true);
  return found;
}

function toItinerary(
  rides: Ride[],
  idx: RouterIndex,
  date: string,
  dayLabel: string | undefined,
  isToday: boolean,
): ConnectionItinerary {
  const stopName = (id: string): string => idx.stops.get(id)?.name || id;
  const legs = rides.map(({ route, trip: t, board, alight, walkSecs }, i): ConnectionLeg => {
    const trip = route.trips[t];
    const len = route.stops.length;
    const dep = route.dep[t * len + board];
    const arr = route.arr[t * len + alight];
    const fromId = trip.stops[board].stopId;
    const toId = trip.stops[alight].stopId;
    return {
      line: trip.line,
      tripId: trip.tripId,
      headsign: trip.headsign,
      fromStopId: fromId,
      fromStopName: stopName(fromId),
      toStopId: toId,
      toStopName: stopName(toId),
      departureTime: formatHHMM(dep),
      arrivalTime: formatHHMM(arr),
      departureSecs: dep,
      arrivalSecs: arr,
      durationMins: Math.max(1, Math.round((arr - dep) / 60)),
      stopsCount: alight - board,
      stops: buildLegStops(trip, board, alight, idx, dep),
      ...(i > 0 ? { walkMins: Math.round(walkSecs / 60) } : {}),
    };
  });

  let waitSecs = 0;
  let walkMinutes = 0;
  const transfers: string[] = [];
  for (let i = 1; i < legs.length; i++) {
    const a = legs[i - 1];
    const b = legs[i];
    waitSecs += b.departureSecs - a.arrivalSecs;
    const walk = b.walkMins ?? 0;
    walkMinutes += walk;
    if (walk === 0) transfers.push(a.toStopName);
    else if (a.toStopName === b.fromStopName) transfers.push(`${a.toStopName} (pieszo ${walk} min)`);
    else transfers.push(`${a.toStopName} → ${b.fromStopName} (pieszo ${walk} min)`);
  }

  const first = legs[0];
  const last = legs[legs.length - 1];
  // secs stay relative to the searched date; a journey leaving after midnight belongs to the next day
  const dayOff = Math.floor(first.departureSecs / 86400);
  const depDate = dayOff === 0 ? date : offsetDate(date, dayOff);
  return {
    type: legs.length === 1 ? "direct" : "transfer",
    departureTime: first.departureTime,
    arrivalTime: last.arrivalTime,
    departureSecs: first.departureSecs,
    arrivalSecs: last.arrivalSecs,
    totalDurationMins: Math.max(1, Math.round((last.arrivalSecs - first.departureSecs) / 60)),
    transfersCount: legs.length - 1,
    transferWaitMins: legs.length > 1 ? Math.round(waitSecs / 60) : undefined,
    transferStopName: transfers.length > 0 ? transfers.join(" / ") : undefined,
    walkMinutes,
    date: depDate,
    dayLabel:
      dayOff === 0 ? dayLabel : dayOff === 1 && isToday ? "Jutro" : PL_WEEKDAYS[weekdayMonday0(depDate)],
    arrivesNextDay: Math.floor(last.arrivalSecs / 86400) > dayOff,
    legs,
  };
}

/** The Pareto set of one service day from `afterSecs`, over a window doubled until it holds `limit` journeys (24 h max). */
function searchDay(
  query: RouteQuery,
  idx: RouterIndex,
  origins: number[],
  isTarget: Uint8Array,
  afterSecs: number,
  date: string,
  dayLabel: string | undefined,
  isToday: boolean,
  limit: number,
): ConnectionItinerary[] {
  const table = dayTable(idx, date);
  const rides = query.directOnly ? 1 : MAX_RIDES;
  const change = Number.isFinite(query.minTransferSecs) ? query.minTransferSecs! : DEFAULT_CHANGE_SECS;
  const maxWait = query.maxTransferSecs ?? Infinity;
  for (let w = FIRST_WINDOW_SECS; ; w *= 2) {
    const span = Math.min(w, 86400);
    const runs = rangeSearch(idx, table, origins, isTarget, afterSecs, afterSecs + span, rides, change, w === FIRST_WINDOW_SECS);
    if (!runs) return [];
    const found = runs
      .map((r) => toItinerary(r, idx, date, dayLabel, isToday))
      .filter((it) => it.legs.every((l, i) => i === 0 || l.departureSecs - it.legs[i - 1].arrivalSecs <= maxWait));
    if (found.length >= limit || span >= 86400) return found;
  }
}

/**
 * Find the Pareto-optimal connections (direct or with up to MAX_RIDES - 1 transfers, walking between
 * nearby poles and between operators) between two stops.
 */
export function findConnections(query: RouteQuery, idx: RouterIndex | null = getIndex()): ConnectionItinerary[] {
  if (!idx) return [];

  const fromPoles = resolveQueryPoles(query.fromIds, query.from, idx);
  const toPoles = resolveQueryPoles(query.toIds, query.to, idx);
  if (fromPoles.size === 0 || toPoles.size === 0) return [];

  const queryDate = query.date || config.todayLocalISO();
  const isTodaySearch = !query.date || query.date === config.todayLocalISO();

  // If searching for a future date without explicit time, start from the morning (00:00)
  const afterSecs = query.afterSecs ?? (isTodaySearch ? nowSecs() : 0);
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(query.limit!, 20)) : 5;

  const origins = [...fromPoles].flatMap((id) => idx.stopNum.get(id) ?? []);
  const isTarget = new Uint8Array(idx.stopIds.length);
  for (const id of toPoles) {
    const n = idx.stopNum.get(id);
    if (n !== undefined) isTarget[n] = 1;
  }

  let found = searchDay(query, idx, origins, isTarget, afterSecs, queryDate, query.dayLabel, isTodaySearch, limit);

  // Nothing within 24 h of today's query (a line that does not run tomorrow either): try the following days.
  for (let offset = 1; offset <= (query.fallbackDays ?? 3) && found.length === 0 && isTodaySearch; offset++) {
    const nextDate = offsetDate(queryDate, offset);
    const nextLabel = offset === 1 ? "Jutro" : PL_WEEKDAYS[weekdayMonday0(nextDate)];
    found = searchDay(query, idx, origins, isTarget, 0, nextDate, nextLabel, false, limit);
  }

  const byDeparture = (a: ConnectionItinerary, b: ConnectionItinerary): number =>
    a.departureSecs - b.departureSecs || a.arrivalSecs - b.arrivalSecs || a.transfersCount - b.transfersCount;
  if (query.sortBy === "duration") {
    found.sort((a, b) => a.totalDurationMins - b.totalDurationMins || byDeparture(a, b));
  } else if (query.sortBy === "arrival") {
    found.sort((a, b) => a.arrivalSecs - b.arrivalSecs || b.departureSecs - a.departureSecs || a.transfersCount - b.transfersCount);
  } else {
    found.sort(byDeparture);
  }
  return found.slice(0, limit);
}
