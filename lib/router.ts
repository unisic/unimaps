/**
 * Static GTFS connection search / trip planner engine.
 *
 * Runs in-memory routing over the built GTFS feed (output/gtfs/{stops,trips,stop_times,calendar}.txt).
 * Because Komunikacja Beskidzka has ~950 stops and ~760 daily trips, the entire graph
 * fits in memory (<3 MB) and connection queries (direct, 1-transfer, and 2-transfer) run in single-digit ms.
 */
import fs from "node:fs";
import path from "node:path";

import * as config from "./config";
import { col, parseCsvLine, splitLines } from "./gtfs-csv";
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
  /** stored road geometry of the leg's trip pattern (GET /api/shapes), when routed */
  shape_id?: string;
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
  afterSecs?: number;
  limit?: number;
  directOnly?: boolean;
  minTransferSecs?: number;
  maxTransferSecs?: number;
  date?: string;
  dayLabel?: string;
  sortBy?: "departure" | "duration" | "arrival";
}

export interface NearbyTransfer {
  stopId: string;
  stopName: string;
  nameKey: string;
  cleanKey: string;
  distMeters: number;
  walkSecs: number;
}

interface StopEntry {
  id: string;
  name: string;
  nameKey: string;
  cleanKey: string;
  lat: number;
  lon: number;
}

interface TripStopEntry {
  stopId: string;
  seq: number;
  arr: number;
  dep: number;
}

interface TripEntry {
  tripId: string;
  serviceId: string;
  routeId: string;
  line: string;
  headsign: string;
  stops: TripStopEntry[];
  stopIndices: Map<string, number[]>;
}

interface RouterIndex {
  stops: Map<string, StopEntry>;
  polesByName: Map<string, Set<string>>;
  polesByCleanKey: Map<string, Set<string>>;
  nearbyTransfers: Map<string, NearbyTransfer[]>;
  trips: Map<string, TripEntry>;
  tripsByStopKey: Map<string, Array<{ trip: TripEntry; stopIndex: number }>>;
  tripsByCleanKey: Map<string, Array<{ trip: TripEntry; stopIndex: number }>>;
  services: Map<string, number[]>;
}

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

function offsetDate(dateStr: string, days: number): string {
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

function loadIndex(): RouterIndex | null {
  let dir = config.GTFS_DIR;
  if (!fs.existsSync(path.join(dir, "stops.txt"))) {
    const fixtureDir = path.join(process.cwd(), "test", "fixtures", "gtfs");
    if (fs.existsSync(path.join(fixtureDir, "stops.txt"))) {
      dir = fixtureDir;
    }
  }

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

  const stops = new Map<string, StopEntry>();
  const polesByName = new Map<string, Set<string>>();
  const polesByCleanKey = new Map<string, Set<string>>();

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
      const nameKey = normalizeName(name);
      const cleanKey = cleanText(name);
      const lat = iStopLat >= 0 ? Number(f[iStopLat]) || 0 : 0;
      const lon = iStopLon >= 0 ? Number(f[iStopLon]) || 0 : 0;
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
  }

  // Precompute walkable transfers between nearby stops (within 350m, ~4-5 mins walk)
  const nearbyTransfers = new Map<string, NearbyTransfer[]>();
  const stopList = [...stops.values()];
  for (let i = 0; i < stopList.length; i++) {
    const s1 = stopList[i];
    if (!s1.lat || !s1.lon) continue;
    const list: NearbyTransfer[] = [];
    for (let j = 0; j < stopList.length; j++) {
      if (i === j) continue;
      const s2 = stopList[j];
      if (!s2.lat || !s2.lon || s1.id === s2.id) continue;
      const d = approxDistMeters(s1.lat, s1.lon, s2.lat, s2.lon);
      if (d <= 350) {
        const walkSecs = Math.max(60, Math.round(d / 1.1));
        list.push({
          stopId: s2.id,
          stopName: s2.name,
          nameKey: s2.nameKey,
          cleanKey: s2.cleanKey,
          distMeters: Math.round(d),
          walkSecs,
        });
      }
    }
    if (list.length > 0) {
      list.sort((a, b) => a.distMeters - b.distMeters);
      nearbyTransfers.set(s1.id, list);
    }
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
        line: (iShortName >= 0 ? f[iShortName] : "") || (iRouteId >= 0 ? f[iRouteId] : "") || "—",
        stops: [],
        stopIndices: new Map(),
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

  const tripsByStopKey = new Map<string, Array<{ trip: TripEntry; stopIndex: number }>>();
  const tripsByCleanKey = new Map<string, Array<{ trip: TripEntry; stopIndex: number }>>();

  for (const trip of trips.values()) {
    trip.stops.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < trip.stops.length; i++) {
      const sid = trip.stops[i].stopId;
      let list = trip.stopIndices.get(sid);
      if (!list) {
        list = [];
        trip.stopIndices.set(sid, list);
      }
      list.push(i);

      const sEntry = stops.get(sid);
      if (sEntry) {
        let keyList = tripsByStopKey.get(sEntry.nameKey);
        if (!keyList) {
          keyList = [];
          tripsByStopKey.set(sEntry.nameKey, keyList);
        }
        keyList.push({ trip, stopIndex: i });

        let cleanList = tripsByCleanKey.get(sEntry.cleanKey);
        if (!cleanList) {
          cleanList = [];
          tripsByCleanKey.set(sEntry.cleanKey, cleanList);
        }
        cleanList.push({ trip, stopIndex: i });
      }
    }
  }

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

  return { stops, polesByName, polesByCleanKey, nearbyTransfers, trips, tripsByStopKey, tripsByCleanKey, services };
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

  // 7. Substring search on clean keys
  for (const [k, poles] of idx.polesByCleanKey) {
    if (k.includes(clean)) {
      for (const p of poles) combined.add(p);
    }
  }
  return combined;
}

function isTripActiveOnDay(trip: TripEntry, dayOfWeek: number, services: Map<string, number[]>): boolean {
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

function searchDayConnections(
  query: RouteQuery,
  idx: RouterIndex,
  fromPoles: Set<string>,
  toPoles: Set<string>,
  afterSecs: number,
  searchDate: string,
  searchDayLabel: string | undefined,
  dayOfWeek: number,
): ConnectionItinerary[] {
  const itineraries: ConnectionItinerary[] = [];

  // Pre-filter candidate trips departing from origin poles via index (replaces full network scan)
  const candidateFromTrips: Array<{ trip: TripEntry; fromIdx: number }> = [];
  const seenFromTrips = new Set<string>();
  for (const fId of fromPoles) {
    const sEntry = idx.stops.get(fId);
    if (!sEntry) continue;
    const cands = idx.tripsByCleanKey.get(sEntry.cleanKey);
    if (cands) {
      for (const c of cands) {
        if (fromPoles.has(c.trip.stops[c.stopIndex].stopId)) {
          const k = `${c.trip.tripId}@${c.stopIndex}`;
          if (!seenFromTrips.has(k)) {
            seenFromTrips.add(k);
            candidateFromTrips.push({ trip: c.trip, fromIdx: c.stopIndex });
          }
        }
      }
    }
  }
  candidateFromTrips.sort((a, b) => a.trip.stops[a.fromIdx].dep - b.trip.stops[b.fromIdx].dep);

  // Pre-calculate stops from which toPoles can be reached in 1 leg (for 2-transfer pruning)
  const stopsReachingTo = new Set<string>();
  for (const toId of toPoles) {
    const toEntry = idx.stops.get(toId);
    if (!toEntry) continue;
    const toTrips = idx.tripsByCleanKey.get(toEntry.cleanKey);
    if (toTrips) {
      for (const { trip, stopIndex: toIdx } of toTrips) {
        if (toPoles.has(trip.stops[toIdx].stopId)) {
          for (let s = 0; s < toIdx; s++) {
            const sId = trip.stops[s].stopId;
            const sEntry = idx.stops.get(sId);
            if (sEntry) {
              stopsReachingTo.add(sEntry.cleanKey);
              const near = idx.nearbyTransfers.get(sId);
              if (near) {
                for (const nb of near) stopsReachingTo.add(nb.cleanKey);
              }
            }
          }
        }
      }
    }
  }

  // 1. Direct connections (both current day and next-day wrap if starting late)
  for (const { trip, fromIdx } of candidateFromTrips) {
    const depStop = trip.stops[fromIdx];

    for (let j = fromIdx + 1; j < trip.stops.length; j++) {
      if (toPoles.has(trip.stops[j].stopId)) {
        const arrStop = trip.stops[j];
        const tripDur = (arrStop.arr < depStop.dep ? arrStop.arr + 86400 : arrStop.arr) - depStop.dep;
        const durationMins = Math.max(1, Math.round(tripDur / 60));

        for (const isNextDay of [false, true]) {
          const tripDayOfWeek = isNextDay ? (dayOfWeek + 1) % 7 : dayOfWeek;
          if (!isTripActiveOnDay(trip, tripDayOfWeek, idx.services)) continue;

          const depSecs = isNextDay ? depStop.dep + 86400 : depStop.dep;
          if (depSecs < afterSecs || depSecs > afterSecs + 86400) continue;
          const arrSecs = depSecs + tripDur;
          const arrivesNextDay = arrSecs >= 86400;

          const legStops = buildLegStops(trip, fromIdx, j, idx, depSecs);

          itineraries.push({
            type: "direct",
            departureTime: formatHHMM(depSecs),
            arrivalTime: formatHHMM(arrSecs),
            departureSecs: depSecs,
            arrivalSecs: arrSecs,
            totalDurationMins: durationMins,
            transfersCount: 0,
            walkMinutes: 0,
            date: searchDate,
            dayLabel: searchDayLabel,
            arrivesNextDay,
            legs: [
              {
                line: trip.line,
                tripId: trip.tripId,
                headsign: trip.headsign,
                fromStopId: depStop.stopId,
                fromStopName: idx.stops.get(depStop.stopId)?.name || depStop.stopId,
                toStopId: arrStop.stopId,
                toStopName: idx.stops.get(arrStop.stopId)?.name || arrStop.stopId,
                departureTime: formatHHMM(depSecs),
                arrivalTime: formatHHMM(arrSecs),
                departureSecs: depSecs,
                arrivalSecs: arrSecs,
                durationMins,
                stopsCount: j - fromIdx,
                stops: legStops,
              },
            ],
          });
        }
        break; // found first destination stop for this fromIdx
      }
    }
  }

  // 2. 1-transfer connections (skipped if directOnly)
  if (!query.directOnly) {
    const MIN_TRANSFER_SECS = query.minTransferSecs ?? 180; // default 3 minutes min buffer
    const MAX_TRANSFER_SECS = query.maxTransferSecs ?? 9000; // default 2.5 hours max wait for daytime
    const OVERNIGHT_TRANSFER_SECS = 43200; // allow overnight transfers up to 12h

    for (const { trip: trip1, fromIdx } of candidateFromTrips) {
      if (itineraries.length >= 25) break;
      const dep1Raw = trip1.stops[fromIdx].dep;

      for (const isNextDay1 of [false, true]) {
        const trip1DayOfWeek = isNextDay1 ? (dayOfWeek + 1) % 7 : dayOfWeek;
        if (!isTripActiveOnDay(trip1, trip1DayOfWeek, idx.services)) continue;

        const dep1Secs = isNextDay1 ? dep1Raw + 86400 : dep1Raw;
        if (dep1Secs < afterSecs || dep1Secs > afterSecs + 86400) continue;

        for (let j = fromIdx + 1; j < trip1.stops.length; j++) {
          const transStopId = trip1.stops[j].stopId;
          if (toPoles.has(transStopId)) continue; // direct leg
          const transEntry = idx.stops.get(transStopId);
          if (!transEntry) continue;

          const arr1Raw = trip1.stops[j].arr;
          const dur1 = (arr1Raw < dep1Raw ? arr1Raw + 86400 : arr1Raw) - dep1Raw;
          const leg1Dur = Math.max(1, Math.round(dur1 / 60));
          const arr1Secs = dep1Secs + dur1;

          // Candidates: same stop (walkSecs=0) + nearby walkable stops
          const transferOptions: Array<{ stopId: string; name: string; cleanKey: string; walkSecs: number }> = [
            { stopId: transStopId, name: transEntry.name, cleanKey: transEntry.cleanKey, walkSecs: 0 },
          ];

          const nearby = idx.nearbyTransfers.get(transStopId);
          if (nearby) {
            for (const nb of nearby) {
              if (!transferOptions.some((o) => o.cleanKey === nb.cleanKey)) {
                transferOptions.push({
                  stopId: nb.stopId,
                  name: nb.stopName,
                  cleanKey: nb.cleanKey,
                  walkSecs: nb.walkSecs,
                });
              }
            }
          }

          for (const opt of transferOptions) {
            if (!stopsReachingTo.has(opt.cleanKey)) continue;
            const candidateTrips = idx.tripsByCleanKey.get(opt.cleanKey);
            if (!candidateTrips) continue;

            const minTransferNeeded = opt.walkSecs > 0 ? Math.max(MIN_TRANSFER_SECS, opt.walkSecs + 90) : MIN_TRANSFER_SECS;

                for (const { trip: trip2, stopIndex: transIdx } of candidateTrips) {
                  if (trip2.tripId === trip1.tripId) continue;

                  // Fast destination pre-check: does trip2 visit toPoles after transIdx?
                  let k: number | null = null;
                  for (const toId of toPoles) {
                    const idxList = trip2.stopIndices.get(toId);
                    if (idxList) {
                      for (const sIdx of idxList) {
                        if (sIdx > transIdx && (k === null || sIdx < k)) k = sIdx;
                      }
                    }
                  }
                  if (k === null) continue;

                  const dep2Raw = trip2.stops[transIdx].dep;
                  let dep2Secs = Math.floor(arr1Secs / 86400) * 86400 + dep2Raw;
                  if (dep2Secs < arr1Secs + minTransferNeeded) {
                    dep2Secs += 86400;
                  }

                  const trip2DayOffset = Math.floor(dep2Secs / 86400);
                  const trip2DayOfWeek = (dayOfWeek + trip2DayOffset) % 7;
                  if (!isTripActiveOnDay(trip2, trip2DayOfWeek, idx.services)) continue;

                  const waitSecs = dep2Secs - arr1Secs;
                  if (waitSecs < minTransferNeeded) continue;

                  const isOvernightWait = (arr1Secs % 86400 >= 68400) || (dep2Secs % 86400 <= 32400) || waitSecs > 10800;
                  if (!isOvernightWait && waitSecs > MAX_TRANSFER_SECS) continue;
                  if (isOvernightWait && waitSecs > OVERNIGHT_TRANSFER_SECS) continue;

                  const arr2Raw = trip2.stops[k].arr;
                  const dur2 = (arr2Raw < dep2Raw ? arr2Raw + 86400 : arr2Raw) - dep2Raw;
                  const arr2Secs = dep2Secs + dur2;
                  const leg2Dur = Math.max(1, Math.round(dur2 / 60));
                  const totalDur = Math.max(1, Math.round((arr2Secs - dep1Secs) / 60));
                  const walkMins = opt.walkSecs > 0 ? Math.round(opt.walkSecs / 60) : 0;
                  const transferStopName = opt.walkSecs > 0
                    ? `${transEntry.name} → ${opt.name} (pieszo ${walkMins} min)`
                    : transEntry.name;
                  const arrivesNextDay = arr2Secs >= 86400;

                  const leg1Stops = buildLegStops(trip1, fromIdx, j, idx, dep1Secs);
                  const leg2Stops = buildLegStops(trip2, transIdx, k, idx, dep2Secs);

                  itineraries.push({
                    type: "transfer",
                    departureTime: formatHHMM(dep1Secs),
                    arrivalTime: formatHHMM(arr2Secs),
                    departureSecs: dep1Secs,
                    arrivalSecs: arr2Secs,
                    totalDurationMins: totalDur,
                    transfersCount: 1,
                    transferWaitMins: Math.round(waitSecs / 60),
                    transferStopName,
                    walkMinutes: walkMins,
                    date: searchDate,
                    dayLabel: searchDayLabel,
                    arrivesNextDay,
                    legs: [
                      {
                        line: trip1.line,
                        tripId: trip1.tripId,
                        headsign: trip1.headsign,
                        fromStopId: trip1.stops[fromIdx].stopId,
                        fromStopName: idx.stops.get(trip1.stops[fromIdx].stopId)?.name || trip1.stops[fromIdx].stopId,
                        toStopId: transEntry.id,
                        toStopName: transEntry.name,
                        departureTime: formatHHMM(dep1Secs),
                        arrivalTime: formatHHMM(arr1Secs),
                        departureSecs: dep1Secs,
                        arrivalSecs: arr1Secs,
                        durationMins: leg1Dur,
                        stopsCount: j - fromIdx,
                        stops: leg1Stops,
                      },
                      {
                        line: trip2.line,
                        tripId: trip2.tripId,
                        headsign: trip2.headsign,
                        fromStopId: trip2.stops[transIdx].stopId,
                        fromStopName: idx.stops.get(trip2.stops[transIdx].stopId)?.name || opt.name,
                        toStopId: trip2.stops[k].stopId,
                        toStopName: idx.stops.get(trip2.stops[k].stopId)?.name || trip2.stops[k].stopId,
                        departureTime: formatHHMM(dep2Secs),
                        arrivalTime: formatHHMM(arr2Secs),
                        departureSecs: dep2Secs,
                        arrivalSecs: arr2Secs,
                        durationMins: leg2Dur,
                        stopsCount: k - transIdx,
                        stops: leg2Stops,
                      },
                    ],
                  });
                }
              }
            }
          }
        }
      }

  // 3. 2-transfer connections if needed (when direct + 1-transfer are few)
  if (!query.directOnly && itineraries.length < 5) {
    const MIN_TRANSFER_SECS = query.minTransferSecs ?? 180;
    const MAX_LEG_WAIT_SECS = 7200; // max 2 hours between legs for 2-transfer connections

    for (const { trip: trip1, fromIdx } of candidateFromTrips) {
      if (itineraries.length >= 8) break;
      const dep1Raw = trip1.stops[fromIdx].dep;

          for (const isNextDay1 of [false, true]) {
            const trip1DayOfWeek = isNextDay1 ? (dayOfWeek + 1) % 7 : dayOfWeek;
            if (!isTripActiveOnDay(trip1, trip1DayOfWeek, idx.services)) continue;

            const dep1Secs = isNextDay1 ? dep1Raw + 86400 : dep1Raw;
            if (dep1Secs < afterSecs || dep1Secs > afterSecs + 86400) continue;

            for (let j = fromIdx + 1; j < trip1.stops.length; j++) {
              const transStop1 = idx.stops.get(trip1.stops[j].stopId);
              if (!transStop1 || toPoles.has(transStop1.id)) continue;

              const arr1Raw = trip1.stops[j].arr;
              const dur1 = (arr1Raw < dep1Raw ? arr1Raw + 86400 : arr1Raw) - dep1Raw;
              const arr1Secs = dep1Secs + dur1;

              const transferOptions1 = [
                { stopId: transStop1.id, name: transStop1.name, cleanKey: transStop1.cleanKey, walkSecs: 0 },
              ];
              const near1 = idx.nearbyTransfers.get(transStop1.id);
              if (near1) {
                for (const nb of near1) {
                  if (!transferOptions1.some((o) => o.cleanKey === nb.cleanKey)) {
                    transferOptions1.push({ stopId: nb.stopId, name: nb.stopName, cleanKey: nb.cleanKey, walkSecs: nb.walkSecs });
                  }
                }
              }

              for (const opt1 of transferOptions1) {
                const cand2 = idx.tripsByCleanKey.get(opt1.cleanKey);
                if (!cand2) continue;

                const minWait1 = opt1.walkSecs > 0 ? Math.max(MIN_TRANSFER_SECS, opt1.walkSecs + 90) : MIN_TRANSFER_SECS;

                for (const { trip: trip2, stopIndex: t1Idx } of cand2) {
                  if (trip2.tripId === trip1.tripId) continue;

                  const dep2Raw = trip2.stops[t1Idx].dep;
                  let dep2Secs = Math.floor(arr1Secs / 86400) * 86400 + dep2Raw;
                  if (dep2Secs < arr1Secs + minWait1) dep2Secs += 86400;

                  const trip2DayOffset = Math.floor(dep2Secs / 86400);
                  const trip2DayOfWeek = (dayOfWeek + trip2DayOffset) % 7;
                  if (!isTripActiveOnDay(trip2, trip2DayOfWeek, idx.services)) continue;

                  const wait1 = dep2Secs - arr1Secs;
                  if (wait1 < minWait1 || wait1 > MAX_LEG_WAIT_SECS) continue;

                  for (let m = t1Idx + 1; m < trip2.stops.length; m++) {
                    const transStop2 = idx.stops.get(trip2.stops[m].stopId);
                    if (!transStop2 || toPoles.has(transStop2.id) || transStop2.cleanKey === opt1.cleanKey) continue;
                    if (!stopsReachingTo.has(transStop2.cleanKey)) continue;

                    const arr2Raw = trip2.stops[m].arr;
                    const dur2 = (arr2Raw < dep2Raw ? arr2Raw + 86400 : arr2Raw) - dep2Raw;
                    const arr2Secs = dep2Secs + dur2;

                    const transferOptions2 = [
                      { stopId: transStop2.id, name: transStop2.name, cleanKey: transStop2.cleanKey, walkSecs: 0 },
                    ];
                    const near2 = idx.nearbyTransfers.get(transStop2.id);
                    if (near2) {
                      for (const nb of near2) {
                        if (!transferOptions2.some((o) => o.cleanKey === nb.cleanKey)) {
                          transferOptions2.push({ stopId: nb.stopId, name: nb.stopName, cleanKey: nb.cleanKey, walkSecs: nb.walkSecs });
                        }
                      }
                    }

                    for (const opt2 of transferOptions2) {
                      const cand3 = idx.tripsByCleanKey.get(opt2.cleanKey);
                      if (!cand3) continue;

                      const minWait2 = opt2.walkSecs > 0 ? Math.max(MIN_TRANSFER_SECS, opt2.walkSecs + 90) : MIN_TRANSFER_SECS;

                      for (const { trip: trip3, stopIndex: t2Idx } of cand3) {
                        if (trip3.tripId === trip2.tripId || trip3.tripId === trip1.tripId) continue;

                        // Fast destination pre-check: does trip3 visit toPoles after t2Idx?
                        let k: number | null = null;
                        for (const toId of toPoles) {
                          const idxList = trip3.stopIndices.get(toId);
                          if (idxList) {
                            for (const sIdx of idxList) {
                              if (sIdx > t2Idx && (k === null || sIdx < k)) k = sIdx;
                            }
                          }
                        }
                        if (k === null) continue;

                        const dep3Raw = trip3.stops[t2Idx].dep;
                        let dep3Secs = Math.floor(arr2Secs / 86400) * 86400 + dep3Raw;
                        if (dep3Secs < arr2Secs + minWait2) dep3Secs += 86400;

                        const trip3DayOffset = Math.floor(dep3Secs / 86400);
                        const trip3DayOfWeek = (dayOfWeek + trip3DayOffset) % 7;
                        if (!isTripActiveOnDay(trip3, trip3DayOfWeek, idx.services)) continue;

                        const wait2 = dep3Secs - arr2Secs;
                        if (wait2 < minWait2 || wait2 > MAX_LEG_WAIT_SECS) continue;

                        const arr3Raw = trip3.stops[k].arr;
                            const dur3 = (arr3Raw < dep3Raw ? arr3Raw + 86400 : arr3Raw) - dep3Raw;
                            const arr3Secs = dep3Secs + dur3;
                            const totalDur = Math.max(1, Math.round((arr3Secs - dep1Secs) / 60));

                            const walk1Mins = opt1.walkSecs > 0 ? Math.round(opt1.walkSecs / 60) : 0;
                            const walk2Mins = opt2.walkSecs > 0 ? Math.round(opt2.walkSecs / 60) : 0;
                            const stop1Label = walk1Mins > 0 ? `${transStop1.name} → ${opt1.name}` : transStop1.name;
                            const stop2Label = walk2Mins > 0 ? `${transStop2.name} → ${opt2.name}` : transStop2.name;

                            itineraries.push({
                              type: "transfer",
                              departureTime: formatHHMM(dep1Secs),
                              arrivalTime: formatHHMM(arr3Secs),
                              departureSecs: dep1Secs,
                              arrivalSecs: arr3Secs,
                              totalDurationMins: totalDur,
                              transfersCount: 2,
                              transferWaitMins: Math.round((wait1 + wait2) / 60),
                              transferStopName: `${stop1Label} / ${stop2Label}`,
                              walkMinutes: walk1Mins + walk2Mins,
                              date: searchDate,
                              dayLabel: searchDayLabel,
                              arrivesNextDay: arr3Secs >= 86400,
                              legs: [
                                {
                                  line: trip1.line,
                                  tripId: trip1.tripId,
                                  headsign: trip1.headsign,
                                  fromStopId: trip1.stops[fromIdx].stopId,
                                  fromStopName: idx.stops.get(trip1.stops[fromIdx].stopId)?.name || trip1.stops[fromIdx].stopId,
                                  toStopId: transStop1.id,
                                  toStopName: transStop1.name,
                                  departureTime: formatHHMM(dep1Secs),
                                  arrivalTime: formatHHMM(arr1Secs),
                                  departureSecs: dep1Secs,
                                  arrivalSecs: arr1Secs,
                                  durationMins: Math.round(dur1 / 60),
                                  stopsCount: j - fromIdx,
                                  stops: buildLegStops(trip1, fromIdx, j, idx, dep1Secs),
                                },
                                {
                                  line: trip2.line,
                                  tripId: trip2.tripId,
                                  headsign: trip2.headsign,
                                  fromStopId: trip2.stops[t1Idx].stopId,
                                  fromStopName: opt1.name,
                                  toStopId: transStop2.id,
                                  toStopName: transStop2.name,
                                  departureTime: formatHHMM(dep2Secs),
                                  arrivalTime: formatHHMM(arr2Secs),
                                  departureSecs: dep2Secs,
                                  arrivalSecs: arr2Secs,
                                  durationMins: Math.round(dur2 / 60),
                                  stopsCount: m - t1Idx,
                                  stops: buildLegStops(trip2, t1Idx, m, idx, dep2Secs),
                                },
                                {
                                  line: trip3.line,
                                  tripId: trip3.tripId,
                                  headsign: trip3.headsign,
                                  fromStopId: trip3.stops[t2Idx].stopId,
                                  fromStopName: opt2.name,
                                  toStopId: trip3.stops[k].stopId,
                                  toStopName: idx.stops.get(trip3.stops[k].stopId)?.name || trip3.stops[k].stopId,
                                  departureTime: formatHHMM(dep3Secs),
                                  arrivalTime: formatHHMM(arr3Secs),
                                  departureSecs: dep3Secs,
                                  arrivalSecs: arr3Secs,
                                  durationMins: Math.round(dur3 / 60),
                                  stopsCount: k - t2Idx,
                                  stops: buildLegStops(trip3, t2Idx, k, idx, dep3Secs),
                                },
                              ],
                            });
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }

  return itineraries;
}

/**
 * Find direct, 1-transfer, and 2-transfer connections between two stops.
 */
export function findConnections(query: RouteQuery): ConnectionItinerary[] {
  const idx = getIndex();
  if (!idx) return [];

  const fromPoles = resolvePoles(query.from, idx);
  const toPoles = resolvePoles(query.to, idx);
  if (fromPoles.size === 0 || toPoles.size === 0) return [];

  const queryDate = query.date || config.todayLocalISO();
  const dayOfWeek = weekdayMonday0(queryDate);
  const isTodaySearch = !query.date || query.date === config.todayLocalISO();

  // If searching for a future date without explicit time, start from the morning (00:00)
  const afterSecs = query.afterSecs ?? (isTodaySearch ? nowSecs() : 0);
  const limit = Math.max(1, Math.min(query.limit ?? 5, 20));

  let itineraries = searchDayConnections(
    query,
    idx,
    fromPoles,
    toPoles,
    afterSecs,
    queryDate,
    query.dayLabel,
    dayOfWeek,
  );

  // If no connections found for today (e.g. late at night or weekend query for weekday-only line):
  // Automatically check the next day and label it so the user gets valid connections.
  if (itineraries.length === 0 && isTodaySearch) {
    for (let offset = 1; offset <= 3; offset++) {
      const nextDate = offsetDate(queryDate, offset);
      const nextDayOfWeek = weekdayMonday0(nextDate);
      const nextDayLabel = offset === 1 ? "Jutro" : PL_WEEKDAYS[nextDayOfWeek];
      const nextResults = searchDayConnections(
        query,
        idx,
        fromPoles,
        toPoles,
        0, // start from morning on subsequent day
        nextDate,
        nextDayLabel,
        nextDayOfWeek,
      );
      if (nextResults.length > 0) {
        itineraries = nextResults;
        break;
      }
    }
  }

  // Filter out dominated itineraries, preferring fewer transfers and less walking
  const nonDominated = itineraries.filter((it) => {
    const itWalk = it.walkMinutes ?? 0;
    return !itineraries.some((other) => {
      if (other === it) return false;
      const otherWalk = other.walkMinutes ?? 0;
      const sameTimes = other.departureSecs === it.departureSecs && other.arrivalSecs === it.arrivalSecs;
      // If times and transfers are identical, prefer the one with less or no walking
      if (sameTimes && other.transfersCount === it.transfersCount) {
        return otherWalk < itWalk;
      }
      return (
        other.departureSecs >= it.departureSecs &&
        other.arrivalSecs <= it.arrivalSecs &&
        other.transfersCount <= it.transfersCount &&
        otherWalk <= itWalk &&
        (other.departureSecs > it.departureSecs ||
          other.arrivalSecs < it.arrivalSecs ||
          other.transfersCount < it.transfersCount ||
          otherWalk < itWalk)
      );
    });
  });

  // Sort candidates
  if (query.sortBy === "duration") {
    nonDominated.sort((a, b) => {
      if (a.totalDurationMins !== b.totalDurationMins) return a.totalDurationMins - b.totalDurationMins;
      if (a.departureSecs !== b.departureSecs) return a.departureSecs - b.departureSecs;
      if (a.transfersCount !== b.transfersCount) return a.transfersCount - b.transfersCount;
      return (a.walkMinutes ?? 0) - (b.walkMinutes ?? 0);
    });
  } else if (query.sortBy === "arrival") {
    nonDominated.sort((a, b) => {
      if (a.arrivalSecs !== b.arrivalSecs) return a.arrivalSecs - b.arrivalSecs;
      if (a.departureSecs !== b.departureSecs) return b.departureSecs - a.departureSecs;
      if (a.transfersCount !== b.transfersCount) return a.transfersCount - b.transfersCount;
      return (a.walkMinutes ?? 0) - (b.walkMinutes ?? 0);
    });
  } else {
    // Default: chronological departure
    nonDominated.sort((a, b) => {
      if (a.departureSecs !== b.departureSecs) return a.departureSecs - b.departureSecs;
      if (a.arrivalSecs !== b.arrivalSecs) return a.arrivalSecs - b.arrivalSecs;
      if (a.transfersCount !== b.transfersCount) return a.transfersCount - b.transfersCount;
      return (a.walkMinutes ?? 0) - (b.walkMinutes ?? 0);
    });
  }

  const pruned: ConnectionItinerary[] = [];
  for (const it of nonDominated) {
    const isDup = pruned.some(
      (p) => p.departureSecs === it.departureSecs && p.arrivalSecs === it.arrivalSecs && p.transfersCount === it.transfersCount,
    );
    if (!isDup) {
      pruned.push(it);
      if (pruned.length >= limit) break;
    }
  }

  return pruned;
}
