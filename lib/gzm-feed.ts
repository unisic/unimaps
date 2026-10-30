/**
 * Metropolia GZM static timetable: the zbiorkom.live GTFS zip (ZTM GZM data), kept at output/gzm/gtfs.zip and
 * parsed into one immutable GzmFeed (stops, lines, trips with brigades and dates, road shapes).
 *
 * The zip is ~19 MB packed / ~115 MB of CSV (2026-10-28: 7441 stops, 508 routes, 33733 trips over 4 days,
 * 865k stop_times, 4038 shapes), so it is never unzipped whole: the file is streamed through fflate's Unzip and
 * every CSV is consumed line by line, which also hands the event loop back between read chunks.
 *
 * Refresh: checked every 10 min, downloaded at most once per Warsaw day after 04:00 (If-Modified-Since), into a
 * .tmp file that replaces the kept zip only after it parsed; a failure keeps the old feed and retries in 30 min.
 * Ids carry the `gzm:` prefix everywhere (stops, trips, shapes), so they can never collide with KB/MZK ones.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Unzip, UnzipInflate } from "fflate";

import * as config from "./config";
import { col, parseCsvLine, pickupFlags } from "./gtfs-csv";
import { log } from "./logger";
import { buildRouterIndex, type RouterIndex } from "./router";
import { finalizeShape, type ShapeGeometry, type ShapePayload, type ShapeStatus } from "./shape-store";
import { gzmStopKey } from "./shared/gzm-stop-key";
import { decodePolyline, preparePolyline, type LatLng } from "./shared/polyline";
import type { WireStop } from "./types";

export interface GzmStop {
  /** `gzm:<stop_id>` */
  id: string;
  /** with the post number, e.g. "Pszczelnik Park 02" */
  name: string;
  lat: number;
  lon: number;
}

/** Same fields as the router's TripStopEntry; secs since the service day's origin (may exceed 24 h). */
export interface GzmTripStop {
  stopId: string;
  seq: number;
  arr: number;
  dep: number;
}

export interface GzmTrip {
  /** `gzm:<trip_id>` */
  tripId: string;
  serviceId: string;
  routeId: string;
  /** rider-facing line (route_short_name, e.g. "1N"; trip_short_name is empty in this feed) */
  line: string;
  headsign: string;
  /** in stop_sequence order */
  stops: GzmTripStop[];
  /** filled by the router */
  nums: Int32Array;
  pattern: string;
  /** Warsaw ISO dates the trip runs on; empty = never */
  dates: ReadonlySet<string>;
  /** `gzm:<shape_id>` */
  shapeId: string | null;
  brigade: string;
  dir: number;
  /** per call: gtfs-csv NO_PICKUP | NO_DROP_OFF | *_ON_REQUEST */
  flags: Uint8Array;
  /** per call stop_headsign, null where the trip headsign applies; null when the trip has none */
  stopHeadsigns: ReadonlyArray<string | null> | null;
  /** the brigade's next trip of the same route and service, by first departure */
  next: GzmTrip | null;
}

export interface GzmLine {
  id: string;
  name: string;
  terminus: string;
  /** GTFS route_type: "0" tram, "11" trolleybus, "3" bus */
  type: string;
}

/** A lat/lon box (degrees). */
export interface FeedArea {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

export interface GzmFeed {
  /** zbiorkom slug: the prefix of every id in the feed */
  slug: string;
  /** the stops' extent + 0.05 deg (median-filtered: a misplaced stop does not stretch it): the positions bbox */
  area: FeedArea;
  version: string;
  /** ISO dates from feed_info ("" when absent) */
  startDate: string;
  endDate: string;
  /** stops served by at least one trip, by `gzm:<stop_id>` */
  stops: Map<string, GzmStop>;
  /** GET /api/stops?city=gzm body and its ETag */
  stopsBody: string;
  stopsEtag: string;
  lines: GzmLine[];
  trips: Map<string, GzmTrip>;
  /** by GzmTrip.line (= the live feed's routeName) */
  tripsByLine: Map<string, GzmTrip[]>;
  shapes: GzmShapes;
  /** RAPTOR index over `trips` (poles grouped by gzmStopKey); also serves departures and timetables */
  router: RouterIndex;
  builtAt: number;
  buildMs: number;
  zipBytes: number;
}

interface GzmShapeEntry {
  poly: string;
  len: number;
  stops: Array<number | null>;
  rev: string;
}

// ponytail: ~10 KB per prepared shape, so <= 12 MB; the live fleet touches ~800 shapes at peak
const GEOM_LRU = 1200;

/** The feed's road shapes, served like ShapeStore's (same wire ids, same /api/shapes payload). */
export class GzmShapes {
  private readonly geom = new Map<string, ShapeGeometry>();

  constructor(private readonly entries: ReadonlyMap<string, GzmShapeEntry>) {}

  get size(): number {
    return this.entries.size;
  }

  geometry(key: string): ShapeGeometry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const hit = this.geom.get(key);
    if (hit) {
      this.geom.delete(key);
      this.geom.set(key, hit);
      return hit;
    }
    const pl = preparePolyline(decodePolyline(e.poly));
    if (!pl) return null;
    const g: ShapeGeometry = { pl, stops: e.stops, rev: e.rev, src: "gtfs" };
    this.geom.set(key, g);
    if (this.geom.size > GEOM_LRU) this.geom.delete(this.geom.keys().next().value!);
    return g;
  }

  wireId(key: string): string | null {
    const e = this.entries.get(key);
    return e ? `${key}.${e.rev}` : null;
  }

  status(key: string | null | undefined): ShapeStatus {
    return key && this.entries.has(key) ? "road" : "none";
  }

  lookup(ids: readonly string[]): { shapes: Record<string, ShapePayload>; missing: string[]; exact: boolean } {
    const shapes: Record<string, ShapePayload> = {};
    const missing: string[] = [];
    let exact = true;
    for (const id of ids) {
      const dot = id.lastIndexOf(".");
      const key = dot > 0 && /\.[0-9a-f]{6}$/.test(id) ? id.slice(0, dot) : id;
      const e = this.entries.get(key);
      if (!e) {
        missing.push(id);
        exact = false;
        continue;
      }
      if (key === id || id.slice(dot + 1) !== e.rev) exact = false;
      shapes[id] = { id: `${key}.${e.rev}`, src: "gtfs", poly: e.poly, len: e.len, stops: e.stops };
    }
    return { shapes, missing, exact };
  }
}

/* ---------------- time ---------------- */

const warsawFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.AGENCY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Agency-local wall clock at an instant: ISO date + secs since that date's midnight. */
export function warsawClock(ms: number): { date: string; secs: number } {
  const p: Record<string, string> = {};
  for (const x of warsawFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, secs: (Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}

/** Epoch secs of a service day's GTFS origin ("noon minus 12 h", so DST days and 25:10:00 resolve per the spec). */
export function serviceDayBase(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12) / 1000;
  const offset = warsawClock(noonUtc * 1000).secs - 12 * 3600;
  return noonUtc - offset - 43200;
}

function isoDate(yyyymmdd: string | undefined): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** "HH:MM:SS" (hours may exceed 24) -> secs, or -1. */
function hms(s: string | undefined): number {
  if (!s) return -1;
  const a = s.indexOf(":");
  if (a < 0) return -1;
  const b = s.indexOf(":", a + 1);
  const v = Number(s.slice(0, a)) * 3600 + Number(s.slice(a + 1, b < 0 ? undefined : b)) * 60 + (b < 0 ? 0 : Number(s.slice(b + 1)));
  return Number.isFinite(v) && v >= 0 ? v : -1;
}

/* ---------------- parse ---------------- */

type RowFn = (f: string[]) => void;

/** Bytes of one CSV member -> rows. `open` gets the header and returns the row handler (null = skip the file). */
function csvSink(open: (hdr: string[]) => RowFn | null): (data: Uint8Array, final: boolean) => void {
  const dec = new TextDecoder();
  let rest = "";
  let row: RowFn | null | undefined;
  const line = (s: string): void => {
    if (s.endsWith("\r")) s = s.slice(0, -1);
    if (!s) return;
    const f = s.includes('"') ? parseCsvLine(s) : s.split(",");
    if (row === undefined) row = open(f.map((h) => h.trim()));
    else if (row) row(f);
  };
  return (data, final) => {
    const text = rest + dec.decode(data, { stream: !final });
    let start = 0;
    for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
      line(text.slice(start, nl));
      start = nl + 1;
    }
    rest = text.slice(start);
    if (final) {
      if (rest) line(rest);
      rest = "";
    }
  };
}

interface TimesAcc {
  stops: GzmTripStop[];
  flags: number[];
  /** [row index, stop_headsign] */
  hs: Array<[number, string]> | null;
}

interface TripRow {
  routeId: string;
  serviceId: string;
  shapeId: string | null;
  headsign: string;
  dir: number;
  brigade: string;
}

/** frequencies.txt of one template trip: the raw trip_id and its [start, end, headway] runs */
interface Freq {
  raw: string;
  runs: Array<[number, number, number]>;
}

const EMPTY_DATES: ReadonlySet<string> = new Set();
// ponytail: a calendar row spanning more than this is clipped; the zbiorkom feed spans 4 days
const MAX_CALENDAR_DAYS = 400;
// ponytail: decompressed-size guard against a hostile zip; the real feed is ~115 MB
const MAX_UNZIPPED_BYTES = 512 * 1024 * 1024;
/* frequencies.txt expansion: Warsaw's metro is 16 templates -> 3976 trips (~25 calls each, ~6 MB heap); the cap
   bounds a feed with absurd headways to ~30 MB */
const MIN_HEADWAY_SECS = 60;
const MAX_FREQ_TRIPS = 20_000;

const pause = (): Promise<void> => new Promise((r) => setImmediate(r));

class FeedBuilder {
  /* A field split out of a decoded chunk is a V8 slice that pins the whole chunk (measured: 200 kept 60-char
     fields held 213 MB), so every string the feed keeps is copied out once, through these tables. */
  private readonly pool = new Map<string, string>();
  private readonly ids = new Map<string, string>();

  private readonly routes = new Map<string, GzmLine>();
  private readonly tripRows = new Map<string, TripRow>();
  private readonly stops = new Map<string, GzmStop>();
  private readonly times = new Map<string, TimesAcc>();
  private readonly shapePts = new Map<string, number[]>();
  private readonly calendar: Array<{ svc: string; days: boolean[]; start: string; end: string }> = [];
  private readonly exceptions: Array<{ svc: string; date: string; add: boolean }> = [];
  private readonly freqs = new Map<string, Freq>();
  private freqTrips = 0;
  private info = { version: "", start: "", end: "" };

  constructor(private readonly slug: string) {}

  private str(s: string): string {
    let v = this.pool.get(s);
    if (v === undefined) {
      v = Buffer.from(s).toString();
      this.pool.set(v, v);
    }
    return v;
  }

  /** raw GTFS id -> `<slug>:<id>`, kept inside the API id charset (isValidId): a char outside
   *  [A-Za-z0-9_.-] becomes "_" (0 collisions over the 53 feeds, 2026-10-30), an id too long for 64
   *  keeps its head plus a hash of the raw id */
  private gid(raw: string): string {
    let v = this.ids.get(raw);
    if (v === undefined) {
      let id = raw.replace(/[^A-Za-z0-9_.-]/g, "_");
      const room = 64 - this.slug.length - 1;
      if (id.length > room) id = `${id.slice(0, room - 7)}_${createHash("sha1").update(raw).digest("hex").slice(0, 6)}`;
      v = Buffer.from(`${this.slug}:${id}`).toString();
      this.ids.set(this.str(raw), v);
    }
    return v;
  }

  sink(name: string): ((data: Uint8Array, final: boolean) => void) | null {
    switch (name) {
      case "routes.txt":
        return csvSink((h) => {
          const iId = col(h, "route_id");
          const iShort = col(h, "route_short_name");
          const iLong = col(h, "route_long_name");
          const iType = col(h, "route_type");
          if (iId < 0) return null;
          return (f) => {
            const id = f[iId];
            if (!id) return;
            const r = { id: this.str(id), name: this.str(f[iShort] || id), terminus: this.str(f[iLong] ?? ""), type: this.str(f[iType] || "3") };
            this.routes.set(r.id, r);
          };
        });
      case "trips.txt":
        return csvSink((h) => {
          const iTrip = col(h, "trip_id");
          const iRoute = col(h, "route_id");
          const iSvc = col(h, "service_id");
          const iShape = col(h, "shape_id");
          const iHead = col(h, "trip_headsign");
          const iDir = col(h, "direction_id");
          const iBrig = col(h, "brigade");
          if (iTrip < 0 || iRoute < 0 || iSvc < 0) return null;
          return (f) => {
            if (!f[iTrip]) return;
            this.tripRows.set(this.gid(f[iTrip]), {
              routeId: this.str(f[iRoute] ?? ""),
              serviceId: this.str(f[iSvc] ?? ""),
              shapeId: iShape >= 0 && f[iShape] ? this.gid(f[iShape]) : null,
              headsign: this.str(iHead >= 0 ? f[iHead] ?? "" : ""),
              dir: iDir >= 0 ? Number(f[iDir]) || 0 : 0,
              brigade: this.str(iBrig >= 0 ? f[iBrig] ?? "" : ""),
            });
          };
        });
      case "stops.txt":
        return csvSink((h) => {
          const iId = col(h, "stop_id");
          const iName = col(h, "stop_name");
          const iLat = col(h, "stop_lat");
          const iLon = col(h, "stop_lon");
          const iType = col(h, "location_type");
          if (iId < 0 || iName < 0 || iLat < 0 || iLon < 0) return null;
          return (f) => {
            const lat = Number(f[iLat]);
            const lon = Number(f[iLon]);
            if (!f[iId] || !f[iName] || !lat || !lon || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
            if (iType >= 0 && f[iType] && f[iType] !== "0") return;
            const id = this.gid(f[iId]);
            this.stops.set(id, { id, name: this.str(f[iName]), lat, lon });
          };
        });
      case "stop_times.txt":
        return csvSink((h) => {
          const iTrip = col(h, "trip_id");
          const iArr = col(h, "arrival_time");
          const iDep = col(h, "departure_time");
          const iStop = col(h, "stop_id");
          const iSeq = col(h, "stop_sequence");
          const iPick = col(h, "pickup_type");
          const iDrop = col(h, "drop_off_type");
          const iHs = col(h, "stop_headsign");
          if (iTrip < 0 || iDep < 0 || iStop < 0 || iSeq < 0) return null;
          let lastRaw = "";
          let acc: TimesAcc | null = null;
          return (f) => {
            const raw = f[iTrip];
            if (!raw || !f[iStop]) return;
            if (raw !== lastRaw || !acc) {
              lastRaw = raw;
              const id = this.gid(raw);
              acc = this.times.get(id) ?? null;
              if (!acc) this.times.set(id, (acc = { stops: [], flags: [], hs: null }));
            }
            const dep = hms(f[iDep]);
            const arr = iArr >= 0 && f[iArr] ? hms(f[iArr]) : dep;
            const seq = Number(f[iSeq]);
            if (dep < 0 || arr < 0 || !Number.isFinite(seq)) return;
            const hs = iHs >= 0 ? f[iHs] : "";
            if (hs) (acc.hs ??= []).push([acc.stops.length, this.str(hs)]);
            acc.stops.push({ stopId: this.gid(f[iStop]), seq, arr, dep });
            acc.flags.push(pickupFlags(iPick >= 0 ? f[iPick] : "", iDrop >= 0 ? f[iDrop] : ""));
          };
        });
      case "shapes.txt":
        return csvSink((h) => {
          const iId = col(h, "shape_id");
          const iLat = col(h, "shape_pt_lat");
          const iLon = col(h, "shape_pt_lon");
          const iSeq = col(h, "shape_pt_sequence");
          if (iId < 0 || iLat < 0 || iLon < 0 || iSeq < 0) return null;
          let lastRaw = "";
          let pts: number[] | null = null;
          return (f) => {
            const raw = f[iId];
            if (!raw) return;
            if (raw !== lastRaw || !pts) {
              lastRaw = raw;
              const id = this.gid(raw);
              pts = this.shapePts.get(id) ?? null;
              if (!pts) this.shapePts.set(id, (pts = []));
            }
            const seq = Number(f[iSeq]);
            const lat = Number(f[iLat]);
            const lon = Number(f[iLon]);
            if (Number.isFinite(seq) && lat && lon) pts.push(seq, lat, lon);
          };
        });
      case "calendar.txt":
        return csvSink((h) => {
          const iSvc = col(h, "service_id");
          const iDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => col(h, d));
          const iStart = col(h, "start_date");
          const iEnd = col(h, "end_date");
          if (iSvc < 0 || iStart < 0 || iEnd < 0) return null;
          return (f) => {
            if (!f[iSvc]) return;
            this.calendar.push({
              svc: this.str(f[iSvc]),
              days: iDays.map((i) => i >= 0 && f[i] === "1"),
              start: isoDate(f[iStart]),
              end: isoDate(f[iEnd]),
            });
          };
        });
      case "calendar_dates.txt":
        return csvSink((h) => {
          const iSvc = col(h, "service_id");
          const iDate = col(h, "date");
          const iType = col(h, "exception_type");
          if (iSvc < 0 || iDate < 0 || iType < 0) return null;
          return (f) => {
            const date = isoDate(f[iDate]);
            if (!f[iSvc] || !date || (f[iType] !== "1" && f[iType] !== "2")) return;
            this.exceptions.push({ svc: this.str(f[iSvc]), date, add: f[iType] === "1" });
          };
        });
      case "frequencies.txt":
        return csvSink((h) => {
          const iTrip = col(h, "trip_id");
          const iStart = col(h, "start_time");
          const iEnd = col(h, "end_time");
          const iHw = col(h, "headway_secs");
          if (iTrip < 0 || iStart < 0 || iEnd < 0 || iHw < 0) return null;
          return (f) => {
            const start = hms(f[iStart]);
            const end = hms(f[iEnd]);
            const headway = Number(f[iHw]);
            if (!f[iTrip] || start < 0 || end <= start || !(headway >= MIN_HEADWAY_SECS)) return;
            const id = this.gid(f[iTrip]);
            let freq = this.freqs.get(id);
            if (!freq) this.freqs.set(id, (freq = { raw: this.str(f[iTrip]), runs: [] }));
            freq.runs.push([start, end, headway]);
          };
        });
      case "feed_info.txt":
        return csvSink((h) => {
          const iVer = col(h, "feed_version");
          const iStart = col(h, "feed_start_date");
          const iEnd = col(h, "feed_end_date");
          return (f) => {
            this.info = {
              version: this.str(iVer >= 0 ? f[iVer] ?? "" : ""),
              start: isoDate(iStart >= 0 ? f[iStart] : ""),
              end: isoDate(iEnd >= 0 ? f[iEnd] : ""),
            };
          };
        });
      default:
        return null;
    }
  }

  private serviceDates(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const of = (svc: string): Set<string> => {
      let s = out.get(svc);
      if (!s) out.set(svc, (s = new Set()));
      return s;
    };
    for (const c of this.calendar) {
      const set = of(c.svc);
      if (!c.start || !c.end) continue;
      const [y, m, d] = c.start.split("-").map(Number);
      for (let i = 0; i < MAX_CALENDAR_DAYS; i++) {
        const dt = new Date(Date.UTC(y, m - 1, d + i));
        const iso = dt.toISOString().slice(0, 10);
        if (iso > c.end) break;
        if (c.days[(dt.getUTCDay() + 6) % 7]) set.add(iso);
      }
    }
    for (const e of this.exceptions) {
      if (e.add) of(e.svc).add(e.date);
      else out.get(e.svc)?.delete(e.date);
    }
    return out;
  }

  private buildTrips(): Map<string, GzmTrip> {
    const dates = this.serviceDates();
    const trips = new Map<string, GzmTrip>();
    for (const [tripId, acc] of this.times) {
      const row = this.tripRows.get(tripId);
      const n = acc.stops.length;
      if (!row || n < 2) continue;
      let order: number[] | null = null;
      for (let i = 1; i < n; i++) {
        if (acc.stops[i].seq <= acc.stops[i - 1].seq) {
          order = [...acc.stops.keys()].sort((a, b) => acc.stops[a].seq - acc.stops[b].seq);
          break;
        }
      }
      const pos = order ? new Int32Array(n) : null;
      if (order && pos) order.forEach((o, i) => (pos[o] = i));
      let stopHeadsigns: Array<string | null> | null = null;
      if (acc.hs) {
        stopHeadsigns = new Array<string | null>(n).fill(null);
        for (const [r, h] of acc.hs) if (h !== row.headsign) stopHeadsigns[pos ? pos[r] : r] = h;
        if (stopHeadsigns.every((h) => h === null)) stopHeadsigns = null;
      }
      const trip: GzmTrip = {
        tripId,
        serviceId: row.serviceId,
        routeId: row.routeId,
        line: this.routes.get(row.routeId)?.name || row.routeId,
        headsign: row.headsign,
        stops: order ? order.map((i) => acc.stops[i]) : acc.stops,
        nums: new Int32Array(0),
        pattern: "",
        dates: dates.get(row.serviceId) ?? EMPTY_DATES,
        shapeId: row.shapeId,
        brigade: row.brigade,
        dir: row.dir,
        flags: Uint8Array.from({ length: n }, (_, i) => acc.flags[order ? order[i] : i]),
        stopHeadsigns,
        next: null,
      };
      const freq = this.freqs.get(tripId);
      if (freq) this.expand(trip, freq, trips);
      else trips.set(tripId, trip);
    }
    this.freqs.clear();
    return trips;
  }

  /** A frequencies.txt trip is a template: its stop_times give the run times from the first stop, and every
   *  start_time + k * headway_secs < end_time is a trip of its own (`<trip_id>.<start secs>`). Both exact_times
   *  kinds get exact times: a headway-based run shows its nominal departures. */
  private expand(t: GzmTrip, freq: Freq, out: Map<string, GzmTrip>): void {
    const base = t.stops[0].dep;
    for (const [start, end, headway] of freq.runs) {
      for (let at = start; at < end && this.freqTrips < MAX_FREQ_TRIPS; at += headway, this.freqTrips++) {
        const d = at - base;
        const tripId = this.gid(`${freq.raw}.${at}`);
        out.set(tripId, { ...t, tripId, stops: t.stops.map((s) => ({ ...s, arr: s.arr + d, dep: s.dep + d })) });
      }
    }
  }

  async finish(zipBytes: number, t0: number): Promise<GzmFeed> {
    const trips = this.buildTrips();
    this.times.clear();
    this.tripRows.clear();
    await pause();

    const tripsByLine = new Map<string, GzmTrip[]>();
    const chains = new Map<string, GzmTrip[]>();
    const shapeTrip = new Map<string, GzmTrip>();
    const used = new Set<string>();
    for (const t of trips.values()) {
      let list = tripsByLine.get(t.line);
      if (!list) tripsByLine.set(t.line, (list = []));
      list.push(t);
      if (t.brigade) {
        const k = `${t.routeId}|${t.brigade}|${t.serviceId}`;
        let chain = chains.get(k);
        if (!chain) chains.set(k, (chain = []));
        chain.push(t);
      }
      if (t.shapeId && !shapeTrip.has(t.shapeId)) shapeTrip.set(t.shapeId, t);
      for (const s of t.stops) used.add(s.stopId);
    }
    for (const chain of chains.values()) {
      chain.sort((a, b) => a.stops[0].dep - b.stops[0].dep);
      for (let i = 1; i < chain.length; i++) chain[i - 1].next = chain[i];
    }

    const stops = new Map<string, GzmStop>();
    for (const [id, s] of this.stops) if (used.has(id)) stops.set(id, s);
    const wire: WireStop[] = [...stops.values()].map((s) => ({
      id: s.id,
      designator: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      operator: "GZM",
      operators: ["GZM"],
    }));
    const stopsBody = JSON.stringify({ count: wire.length, stops: wire });

    // one stop pattern per shape in this feed, so the first trip's stops place every trip's stops
    const shapeEntries = new Map<string, GzmShapeEntry>();
    let built = 0;
    for (const [key, flat] of this.shapePts) {
      const trip = shapeTrip.get(key);
      if (!trip || flat.length < 6) continue;
      const idx = Array.from({ length: flat.length / 3 }, (_, i) => i);
      if (idx.some((i) => i > 0 && flat[i * 3] <= flat[(i - 1) * 3])) idx.sort((a, b) => flat[a * 3] - flat[b * 3]);
      const pts: LatLng[] = idx.map((i) => [flat[i * 3 + 1], flat[i * 3 + 2]]);
      const refs = trip.stops.map((s): [number, number] | null => {
        const st = stops.get(s.stopId);
        return st ? [st.lat, st.lon] : null;
      });
      const e = finalizeShape(pts, refs, "gtfs");
      if (e) shapeEntries.set(key, { poly: e.poly, len: e.len, stops: e.stops, rev: e.rev });
      if (++built % 200 === 0) await pause();
    }
    this.shapePts.clear();

    const lines = [...this.routes.values()].sort((a, b) => a.name.localeCompare(b.name, "pl", { numeric: true }));
    const router = buildRouterIndex({
      stops: [...stops.values()].map((st) => ({ ...st, key: gzmStopKey(st.name) })),
      trips,
    });
    return {
      slug: this.slug,
      area: feedArea(stops.values()),
      version: this.info.version,
      startDate: this.info.start,
      endDate: this.info.end,
      stops,
      stopsBody,
      stopsEtag: `"${createHash("sha1").update(stopsBody).digest("base64url").slice(0, 22)}"`,
      lines,
      trips,
      tripsByLine,
      shapes: new GzmShapes(shapeEntries),
      router,
      builtAt: Math.floor(Date.now() / 1000),
      buildMs: Math.round(performance.now() - t0),
      zipBytes,
    };
  }
}

/** The stops' extent + 0.05 deg. A stop > 1.5 deg from the median is a misplaced one (Bolesławiec keeps
 *  8 at lat 25), not the network: skipped. */
export function feedArea(stops: Iterable<{ lat: number; lon: number }>): FeedArea {
  const lats: number[] = [];
  const lons: number[] = [];
  for (const s of stops) {
    lats.push(s.lat);
    lons.push(s.lon);
  }
  const median = (a: number[]): number => a.slice().sort((x, y) => x - y)[a.length >> 1] ?? 0;
  const mLat = median(lats);
  const mLon = median(lons);
  const box = { latMin: Infinity, latMax: -Infinity, lonMin: Infinity, lonMax: -Infinity };
  for (let i = 0; i < lats.length; i++) {
    if (Math.abs(lats[i] - mLat) > 1.5 || Math.abs(lons[i] - mLon) > 1.5) continue;
    box.latMin = Math.min(box.latMin, lats[i]);
    box.latMax = Math.max(box.latMax, lats[i]);
    box.lonMin = Math.min(box.lonMin, lons[i]);
    box.lonMax = Math.max(box.lonMax, lons[i]);
  }
  const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
  return { latMin: r4(box.latMin - 0.05), latMax: r4(box.latMax + 0.05), lonMin: r4(box.lonMin - 0.05), lonMax: r4(box.lonMax + 0.05) };
}

/** Streams a GTFS zip from disk into a GzmFeed whose ids carry `<slug>:`. Throws on a broken zip or a feed without trips. */
export async function parseGzmZip(file: string, slug = "gzm"): Promise<GzmFeed> {
  const t0 = performance.now();
  const b = new FeedBuilder(slug);
  let error: unknown = null;
  let unzipped = 0;
  const unzip = new Unzip((entry) => {
    const sink = b.sink(entry.name.split("/").pop() ?? "");
    // every member is started: fflate buffers the compressed bytes of a member that never is
    entry.ondata = (err, data, final) => {
      if (error) return;
      if (err) {
        error = err;
        return;
      }
      unzipped += data.length;
      if (unzipped > MAX_UNZIPPED_BYTES) {
        error = new Error("GZM zip expands past the size cap");
        return;
      }
      try {
        sink?.(data, final);
      } catch (e) {
        error = e;
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  let zipBytes = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
    zipBytes += (chunk as Buffer).length;
    unzip.push(chunk as Buffer);
    if (error) throw error;
  }
  unzip.push(new Uint8Array(0), true);
  if (error) throw error;
  const feed = await b.finish(zipBytes, t0);
  if (feed.trips.size === 0 || feed.stops.size === 0) throw new Error("GZM feed has no trips or stops");
  return feed;
}

/* ---------------- download ---------------- */

const MAX_ZIP_BYTES = 64 * 1024 * 1024;

export interface DownloadOptions {
  url: string;
  fetchImpl?: typeof fetch;
  /** sends If-Modified-Since from the kept zip's mtime */
  ifModifiedSince?: Date | null;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Downloads the zip next to `file` as `<file>.tmp`. Returns that path, or null on 304. */
export async function downloadGzmZip(file: string, o: DownloadOptions): Promise<{ tmp: string; bytes: number } | null> {
  const max = o.maxBytes ?? MAX_ZIP_BYTES;
  const headers: Record<string, string> = { "User-Agent": config.USER_AGENT, Accept: "application/zip, */*" };
  if (o.ifModifiedSince) headers["If-Modified-Since"] = o.ifModifiedSince.toUTCString();
  const res = await (o.fetchImpl ?? fetch)(o.url, { headers, signal: AbortSignal.timeout(o.timeoutMs ?? 120_000) });
  if (res.status === 304) return null;
  if (!res.ok || !res.body) throw new Error(`GZM GTFS HTTP ${res.status}`);
  if (Number(res.headers.get("content-length")) > max) throw new Error("GZM GTFS zip exceeds the size cap");
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fh = await fs.promises.open(tmp, "w");
  let bytes = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) {
        await reader.cancel();
        throw new Error("GZM GTFS zip exceeds the size cap");
      }
      await fh.write(value);
    }
  } catch (err) {
    await fh.close();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  await fh.close();
  return { tmp, bytes };
}

/* ---------------- refresh ---------------- */

const CHECK_MS = 10 * 60_000;
const RETRY_MS = 30 * 60_000;
const REFRESH_FROM_SECS = 4 * 3600;

export interface RefreshState {
  hasFeed: boolean;
  /** Warsaw date of the last good check made after 04:00 ("" = none) */
  checkedDay: string;
  /** epoch ms; no attempt before (set after a failure) */
  retryAt: number;
}

/** A download is due without a feed, or once per Warsaw day after 04:00. */
export function gzmRefreshDue(s: RefreshState, nowMs: number): boolean {
  if (nowMs < s.retryAt) return false;
  if (!s.hasFeed) return true;
  const w = warsawClock(nowMs);
  return w.date !== s.checkedDay && w.secs >= REFRESH_FROM_SECS;
}

/** Day a check at `ms` counts for: a check before 04:00 doesn't spare that day's refresh. */
function checkedDayAt(ms: number): string {
  const w = warsawClock(ms);
  return w.secs >= REFRESH_FROM_SECS ? w.date : "";
}

interface FeedGlobal extends RefreshState {
  slug: string;
  feed: GzmFeed | null;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
  lastError: string | null;
  downloads: number;
  downloadBytes: number;
}

const KEY = Symbol.for("kb-gtfs.gzm-feed");
type G = typeof globalThis & { [KEY]?: Map<string, FeedGlobal> };

/** one state per zbiorkom slug, created on first use (bounded by the registry), dropped by stopGzmFeed */
function states(): Map<string, FeedGlobal> {
  return ((globalThis as G)[KEY] ??= new Map());
}

function state(slug: string): FeedGlobal {
  const all = states();
  let s = all.get(slug);
  if (!s) {
    s = { slug, feed: null, hasFeed: false, checkedDay: "", retryAt: 0, timer: null, running: null, lastError: null, downloads: 0, downloadBytes: 0 };
    all.set(slug, s);
  }
  return s;
}

export const GZM_ZIP = path.join(config.GZM_DIR, "gtfs.zip");

/** The kept zip: GZM's stays where it was, every other city's sits beside it under its slug. */
export function gzmZipPath(slug: string): string {
  return slug === "gzm" ? GZM_ZIP : path.join(config.GZM_DIR, slug, "gtfs.zip");
}

function feedUrl(slug: string): string {
  return slug === "gzm" ? config.GZM_GTFS_URL : `${config.ZB_API_URL}/${encodeURIComponent(slug)}/gtfs/default`;
}

/** A city's current feed, or null while the first one loads (or after it was dropped). Never starts anything. */
export function getGzmFeed(slug = "gzm"): GzmFeed | null {
  return state(slug).feed;
}

function setFeed(s: FeedGlobal, feed: GzmFeed): void {
  s.feed = feed;
  s.hasFeed = true;
  log.info(
    "gzm-feed",
    `${s.slug}: feed ${feed.version} (${feed.startDate}..${feed.endDate}): ${feed.stops.size} stops, ${feed.trips.size} trips, ` +
      `${feed.shapes.size} shapes, built in ${feed.buildMs} ms`,
  );
}

async function refresh(s: FeedGlobal): Promise<void> {
  const zip = gzmZipPath(s.slug);
  if (!s.feed && fs.existsSync(zip)) {
    try {
      setFeed(s, await parseGzmZip(zip, s.slug));
      s.checkedDay = checkedDayAt(fs.statSync(zip).mtimeMs);
    } catch (err) {
      log.warn("gzm-feed", `${s.slug}: kept zip unreadable, downloading again: ${err}`);
    }
  }
  if (!gzmRefreshDue(s, Date.now())) return;
  try {
    const got = await downloadGzmZip(zip, {
      url: feedUrl(s.slug),
      ifModifiedSince: s.feed ? fs.statSync(zip).mtime : null,
    });
    if (got) {
      s.downloads += 1;
      s.downloadBytes += got.bytes;
      try {
        const feed = await parseGzmZip(got.tmp, s.slug);
        fs.renameSync(got.tmp, zip);
        setFeed(s, feed);
      } catch (err) {
        fs.rmSync(got.tmp, { force: true });
        throw err;
      }
    }
    s.checkedDay = checkedDayAt(Date.now());
    s.lastError = null;
  } catch (err) {
    s.retryAt = Date.now() + RETRY_MS;
    s.lastError = String(err);
    log.warn("gzm-feed", `${s.slug}: refresh failed, keeping the current feed, retry in 30 min: ${err}`);
  }
}

/** Loads a city's kept zip and arms its refresh timer. Idempotent; resolves once the first attempt settled. */
export function startGzmFeed(slug = "gzm"): Promise<void> {
  const s = state(slug);
  if (!s.timer) {
    s.timer = setInterval(() => void runRefresh(s), CHECK_MS);
    s.timer.unref();
  }
  return runRefresh(s);
}

/** Drops a city's feed and refresh timer (idle eviction, lib/gzm.ts); the kept zip stays for the next start. */
export function stopGzmFeed(slug: string): void {
  const all = states();
  const s = all.get(slug);
  if (!s) return;
  if (s.timer) clearInterval(s.timer);
  all.delete(slug);
}

function runRefresh(s: FeedGlobal): Promise<void> {
  return (s.running ??= refresh(s).finally(() => {
    s.running = null;
  }));
}

export function gzmFeedHealth(slug = "gzm"): Record<string, unknown> {
  const s = state(slug);
  const f = s.feed;
  return {
    version: f?.version ?? null,
    start_date: f?.startDate ?? null,
    end_date: f?.endDate ?? null,
    stops: f?.stops.size ?? 0,
    trips: f?.trips.size ?? 0,
    shapes: f?.shapes.size ?? 0,
    built_at: f?.builtAt ?? 0,
    build_ms: f?.buildMs ?? null,
    zip_bytes: f?.zipBytes ?? 0,
    checked_day: s.checkedDay || null,
    downloads: s.downloads,
    download_bytes: s.downloadBytes,
    last_error: s.lastError,
  };
}
