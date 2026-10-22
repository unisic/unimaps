/**
 * Static single-day GTFS feed builder — TypeScript port of kb_gtfs/build_gtfs.py.
 *
 * Lives in lib/ (not scripts/) so the in-process nightly rebuild
 * (lib/gtfs-refresh.ts) gets bundled into the standalone server image, which
 * ships no tsx and no scripts/. The CLI entry point scripts/build-gtfs.ts is a
 * thin wrapper around buildGtfs().
 */
import fs from "node:fs";
import path from "node:path";

import { zipSync } from "fflate";

import * as config from "./config";
import { col, parseCsvLine, splitLines } from "./gtfs-csv";
import { KbApi, pyTruthy } from "./kb-api";
import type { Stop, Trip } from "./types";

const WEEKDAY_FIELDS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
/** calendar/feed_info validity from the build date; the feed is rebuilt daily, this only bounds a stalled rebuild */
const FEED_VALID_DAYS = 30;
/** share of failed upstream fetches above which a build throws (and the old feed stays) instead of publishing */
const MAX_FAILED_SHARE = 0.1;

type Row = Record<string, string | number>;

/** Strip CR/LF and surrounding whitespace (port of _compact). */
function compact(s: unknown): string {
  return String(s ?? "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

/** "HH:MM" -> seconds since midnight, 0 when unparseable (port of _hhmm_to_seconds). */
function hhmmToSeconds(hhmm: string): number {
  if (!hhmm) return 0;
  const parts = hhmm.split(":");
  if (parts.length < 2) return 0;
  const h = parts[0].trim();
  const m = parts[1].trim();
  if (!/^[+-]?\d+$/.test(h) || !/^[+-]?\d+$/.test(m)) return 0;
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60;
}

/** "HH:MM" -> "HH:MM:SS"; unparseable-but-nonempty values pass through (port of _fmt_time). */
function fmtTime(hhmm: string): string {
  const secs = hhmmToSeconds(hhmm);
  if (secs <= 0 && hhmm) return hhmm;
  const h = Math.floor(secs / 3600);
  const rem = secs % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

const COORD_KEYS = new Set(["shape_pt_lat", "shape_pt_lon", "stop_lat", "stop_lon"]);

/** RFC 4180 field escaping: quote when the field contains , " CR or LF. */
function csvField(s: string): string {
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Port of _write_csv: UTF-8 without BOM, LF line endings, same value coercion. */
function writeCsv(filePath: string, fieldnames: string[], rows: Row[]): void {
  const lines: string[] = [fieldnames.map(csvField).join(",")];
  for (const r of rows) {
    const cells = fieldnames.map((k) => {
      const v = r[k] ?? "";
      let sv: string;
      if (typeof v === "number" && !COORD_KEYS.has(k)) sv = String(v);
      else if (COORD_KEYS.has(k) && v !== "") sv = String(v);
      else sv = v !== "" ? compact(String(v)) : "";
      return csvField(sv);
    });
    lines.push(cells.join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", { encoding: "utf-8" });
}

/** Python date.weekday(): Monday=0 ... Sunday=6. Throws on invalid dates. */
function weekdayMonday0(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid date: ${date} (expected YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`invalid date: ${date}`);
  }
  return (dt.getUTCDay() + 6) % 7;
}

/** `date` (YYYY-MM-DD, already validated) shifted by `days`. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

/** The day each service is sampled on: the weekday service from today (the next Monday on a weekend),
 *  the next Saturday and Sunday (today when it is one). Never a past day: the daily rebuild then picks
 *  up a mid-week timetable change, and one holiday Monday does not stand in for the whole week. */
export function getServiceDates(refDate: string): { weekdayDate: string; saturdayDate: string; sundayDate: string } {
  const dow = (weekdayMonday0(refDate) + 1) % 7; // 0 = Sun, 1 = Mon, ..., 6 = Sat
  return {
    weekdayDate: addDays(refDate, dow === 6 ? 2 : dow === 0 ? 1 : 0),
    saturdayDate: addDays(refDate, (6 - dow + 7) % 7),
    sundayDate: addDays(refDate, (7 - dow) % 7),
  };
}

/** Port of _write_gtfs: same files, column orders and values. */
function writeGtfs(
  outDir: string,
  stops: Stop[],
  routes: Map<string, Row>,
  trips: Row[],
  stopTimes: Row[],
  shapes: Row[],
  calendar: Row[],
  date: string,
): void {
  const dateCompact = date.replace(/-/g, "");

  writeCsv(path.join(outDir, "agency.txt"), ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang"], [
    {
      agency_id: config.AGENCY_ID,
      agency_name: config.AGENCY_NAME,
      agency_url: config.AGENCY_URL,
      agency_timezone: config.AGENCY_TIMEZONE,
      agency_lang: config.AGENCY_LANG,
    },
  ]);

  const stopRows: Row[] = stops.map((s) => ({
    stop_id: s.stopId,
    stop_name: s.name,
    stop_lat: s.lat.toFixed(6),
    stop_lon: s.lon.toFixed(6),
    stop_url: "",
    location_type: (s.showPlatforms || /(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i.test(s.name)) ? "1" : "0",
    parent_station: "",
    stop_timezone: "",
    wheelchair_boarding: "",
  }));
  writeCsv(
    path.join(outDir, "stops.txt"),
    ["stop_id", "stop_name", "stop_lat", "stop_lon", "stop_url", "location_type", "parent_station", "stop_timezone", "wheelchair_boarding"],
    stopRows,
  );

  const routeRows: Row[] = [...routes.values()].map((r) => ({
    ...r,
    route_desc: "",
    route_color: "",
    route_text_color: "",
  }));
  writeCsv(
    path.join(outDir, "routes.txt"),
    ["route_id", "agency_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_url", "route_color", "route_text_color"],
    routeRows,
  );

  writeCsv(
    path.join(outDir, "trips.txt"),
    ["route_id", "service_id", "trip_id", "trip_headsign", "trip_short_name", "direction_id", "block_id", "shape_id"],
    trips,
  );

  writeCsv(
    path.join(outDir, "stop_times.txt"),
    ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "stop_headsign", "pickup_type", "drop_off_type", "shape_dist_traveled"],
    stopTimes,
  );

  writeCsv(path.join(outDir, "calendar.txt"), ["service_id", ...WEEKDAY_FIELDS, "start_date", "end_date"], calendar);

  writeCsv(
    path.join(outDir, "shapes.txt"),
    ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence", "shape_dist_traveled"],
    shapes,
  );

  writeCsv(
    path.join(outDir, "feed_info.txt"),
    ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
    [
      {
        feed_publisher_name: config.AGENCY_NAME,
        feed_publisher_url: config.AGENCY_URL,
        feed_lang: config.AGENCY_LANG,
        feed_start_date: dateCompact,
        feed_end_date: addDays(date, FEED_VALID_DAYS).replace(/-/g, ""),
        feed_version: `KB-GTFS ${date}`,
      },
    ],
  );
}

interface ServiceConfig {
  id: string;
  date: string;
  days: Record<typeof WEEKDAY_FIELDS[number], number>;
}

/** Port of build(): fetch stops + timetables + trips, emit GTFS files. */
async function build(
  date: string,
  outDir: string,
  api: KbApi,
  doZip: boolean,
  fullSchedule: boolean,
): Promise<void> {
  // validate early, like Python's dt.date.fromisoformat in _write_gtfs
  weekdayMonday0(date);
  // Build into a temp sibling and swap in at the end, so a mid-build failure
  // or a concurrent reader never sees a partially written feed. resolve()
  // strips trailing separators, keeping the temp dir a true sibling.
  const finalDir = path.resolve(outDir);
  const tmpDir = `${finalDir}.tmp`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    await buildInto(date, tmpDir, api, doZip, fullSchedule);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
  // Publish by moving the old feed aside instead of deleting it first: any
  // failure leaves either the old feed or the finished temp build on disk.
  const oldDir = `${finalDir}.old`;
  fs.rmSync(oldDir, { recursive: true, force: true });
  if (fs.existsSync(finalDir)) fs.renameSync(finalDir, oldDir);
  try {
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    if (fs.existsSync(oldDir)) fs.renameSync(oldDir, finalDir);
    console.error(`[gtfs] publish failed; built feed left at ${tmpDir}`);
    throw err;
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
  console.log(`[gtfs] published feed to ${finalDir}`);
}

async function buildInto(
  date: string,
  outDir: string,
  api: KbApi,
  doZip: boolean,
  fullSchedule: boolean,
): Promise<void> {
  const rev = await api.fetchRevision();
  console.log(`[gtfs] stops revision: ${rev}`);
  const stops = await api.fetchStops(rev);
  console.log(`[gtfs] loaded ${stops.length} stops`);
  if (stops.length === 0) throw new Error("upstream returned no stops, keeping the old feed");

  // fetchMany turns a failed fetch into null, the same as "no data": count the failures, so a build
  // during an upstream outage or rate limiting throws instead of publishing a partial feed
  let failed = 0;
  const counted = <T, R>(fn: (x: T) => Promise<R>) => (x: T): Promise<R> =>
    fn(x).catch((err: unknown) => {
      failed++;
      throw err;
    });
  const checkFailures = (what: string, total: number): void => {
    if (failed > total * MAX_FAILED_SHARE) throw new Error(`${failed}/${total} ${what} fetches failed, keeping the old feed`);
    failed = 0;
  };

  const stopByUrl = new Map(stops.map((s) => [s.urlId, s]));
  const stopById = new Map(stops.map((s) => [s.internalId, s]));

  const services: ServiceConfig[] = fullSchedule
    ? (() => {
        const { weekdayDate, saturdayDate, sundayDate } = getServiceDates(date);
        return [
          {
            id: "KB_WEEKDAY",
            date: weekdayDate,
            days: { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0 },
          },
          {
            id: "KB_SATURDAY",
            date: saturdayDate,
            days: { monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0 },
          },
          {
            id: "KB_SUNDAY",
            date: sundayDate,
            days: { monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 1 },
          },
        ];
      })()
    : (() => {
        const weekday = weekdayMonday0(date);
        const flags: Record<typeof WEEKDAY_FIELDS[number], number> = {
          monday: 0,
          tuesday: 0,
          wednesday: 0,
          thursday: 0,
          friday: 0,
          saturday: 0,
          sunday: 0,
        };
        WEEKDAY_FIELDS.forEach((f, i) => {
          flags[f] = i === weekday ? 1 : 0;
        });
        return [{ id: "KB_" + date.replace(/-/g, ""), date, days: flags }];
      })();

  const tripToServices = new Map<string, Set<string>>();
  for (const svc of services) {
    console.log(`[gtfs] fetching timetables for ${svc.id} (${svc.date}) ...`);
    const results = await api.fetchMany(counted((s: Stop) => api.fetchTimetable(s.urlId, svc.date)), stops);
    checkFailures(`${svc.id} timetable`, stops.length);
    for (const [, tt] of results) {
      if (!pyTruthy(tt)) continue;
      const departures = (tt as Record<string, unknown>).departures;
      if (!Array.isArray(departures)) continue;
      for (const dep of departures) {
        if (dep === null || typeof dep !== "object") continue;
        const tid = (dep as Record<string, unknown>).trip_id;
        if (tid !== null && tid !== undefined) {
          const tidStr = String(tid);
          let set = tripToServices.get(tidStr);
          if (!set) {
            set = new Set();
            tripToServices.set(tidStr, set);
          }
          set.add(svc.id);
        }
      }
    }
  }
  console.log(`[gtfs] discovered ${tripToServices.size} unique trips across all services`);

  console.log(`[gtfs] fetching trip details ...`);
  const tripResults = await api.fetchMany(counted((t: string) => api.fetchTrip(t, 0)), [...tripToServices.keys()].sort());
  checkFailures("trip", tripToServices.size);

  const routes = new Map<string, Row>();
  const shapesRows: Row[] = [];
  const stopTimesRows: Row[] = [];
  const tripsRows: Row[] = [];
  const seenTrips = new Set<string>();

  for (const [, trip] of tripResults as Array<[string, Trip | null]>) {
    if (!trip || seenTrips.has(trip.tripId)) continue;
    seenTrips.add(trip.tripId);
    const ordered = [...trip.times].sort((a, b) => a.index - b.index);
    if (ordered.length === 0) continue;

    const routeId = "L_" + (trip.lineName || "X");
    const existing = routes.get(routeId);
    if (!existing) {
      routes.set(routeId, {
        route_id: routeId,
        agency_id: config.AGENCY_ID,
        route_short_name: trip.lineName || "",
        route_long_name: trip.direction || "",
        route_type: config.routeTypeFor(trip.lineType, trip.vehicleType),
        route_url: "",
      });
    } else if (trip.direction && !existing.route_long_name) {
      existing.route_long_name = trip.direction;
    }

    const shapeId = `shp_${trip.tripId}`;
    ordered.forEach((ts, seq) => {
      const st = ts.designator != null ? stopById.get(ts.designator) : undefined;
      const stopId = ts.designator != null
        ? String(ts.designator)
        : ts.placeId
          ? stopByUrl.get(ts.placeId)?.stopId
          : undefined;
      if (stopId == null) return;
      stopTimesRows.push({
        trip_id: trip.tripId,
        arrival_time: fmtTime(ts.departureTime),
        departure_time: fmtTime(ts.departureTime),
        stop_id: stopId,
        stop_sequence: seq,
        pickup_type: "",
        drop_off_type: "",
        shape_dist_traveled: "",
      });
      if (st) {
        shapesRows.push({
          shape_id: shapeId,
          shape_pt_lat: st.lat.toFixed(6),
          shape_pt_lon: st.lon.toFixed(6),
          shape_pt_sequence: seq,
        });
      } else if (ts.designator == null && ts.placeId) {
        const ps = stopByUrl.get(ts.placeId);
        if (ps) {
          shapesRows.push({
            shape_id: shapeId,
            shape_pt_lat: ps.lat.toFixed(6),
            shape_pt_lon: ps.lon.toFixed(6),
            shape_pt_sequence: seq,
          });
        }
      }
    });

    const svcs = tripToServices.get(trip.tripId);
    const svcList = svcs && svcs.size > 0 ? [...svcs] : [services[0].id];
    for (const svcId of svcList) {
      tripsRows.push({
        route_id: routeId,
        service_id: svcId,
        trip_id: svcList.length > 1 ? `${trip.tripId}_${svcId}` : trip.tripId,
        raw_trip_id: trip.tripId,
        trip_headsign: compact(trip.direction),
        trip_short_name: trip.showName ? trip.lineName : "",
        direction_id: "",
        shape_id: shapeId,
      });
    }
  }

  const finalStopTimes: Row[] = [];
  const multiMap = new Map<string, string[]>();
  for (const t of tripsRows) {
    const rawId = t.raw_trip_id as string | undefined;
    if (rawId && t.trip_id !== rawId) {
      let list = multiMap.get(rawId);
      if (!list) {
        list = [];
        multiMap.set(rawId, list);
      }
      list.push(t.trip_id as string);
    }
  }
  for (const st of stopTimesRows) {
    finalStopTimes.push(st);
    const extra = multiMap.get(st.trip_id as string);
    if (extra) {
      for (const eid of extra) {
        finalStopTimes.push({ ...st, trip_id: eid });
      }
    }
  }

  const calendarRows: Row[] = services.map((s) => ({
    service_id: s.id,
    monday: s.days.monday,
    tuesday: s.days.tuesday,
    wednesday: s.days.wednesday,
    thursday: s.days.thursday,
    friday: s.days.friday,
    saturday: s.days.saturday,
    sunday: s.days.sunday,
    start_date: date.replace(/-/g, ""),
    end_date: addDays(date, FEED_VALID_DAYS).replace(/-/g, ""),
  }));

  if (tripsRows.length === 0) throw new Error("no trips built, keeping the old feed");

  // outDir is build()'s temp sibling, published by rename only after this returns
  writeGtfs(outDir, stops, routes, tripsRows, finalStopTimes, shapesRows, calendarRows, date);

  if (doZip) {
    const zp = path.join(outDir, "kb_gtfs.zip");
    const files: Record<string, Uint8Array> = {};
    for (const name of fs.readdirSync(outDir)) {
      if (name.endsWith(".txt")) files[name] = new Uint8Array(fs.readFileSync(path.join(outDir, name)));
    }
    fs.writeFileSync(zp, zipSync(files, { level: 6 }));
  }

  console.log(`[gtfs] wrote files to ${outDir}`);
  console.log(`[gtfs] trips=${tripsRows.length} routes=${routes.size} stop_times=${finalStopTimes.length} shapes=${shapesRows.length}`);
}

export interface BuildGtfsOptions {
  /** YYYY-MM-DD reference date; defaults to today in the agency timezone. */
  date?: string;
  /** Defaults to config.GTFS_DIR. */
  outDir?: string;
  concurrency?: number;
  /** Also write kb_gtfs.zip (default true). */
  zip?: boolean;
  /**
   * If true (default), builds all services (weekday, saturday, sunday).
   * If false, builds a single-day feed for the given date.
   */
  fullSchedule?: boolean;
  /** Upstream client (tests inject a fake); defaults to a new KbApi with `concurrency`. */
  api?: KbApi;
}

/** Build and atomically publish a GTFS feed. */
export async function buildGtfs(opts: BuildGtfsOptions = {}): Promise<void> {
  await build(
    opts.date ?? config.todayLocalISO(),
    opts.outDir ?? config.GTFS_DIR,
    opts.api ?? new KbApi({ concurrency: opts.concurrency ?? config.DEFAULT_CONCURRENCY }),
    opts.zip ?? true,
    opts.fullSchedule ?? true,
  );
}

/** The published feed's service date ("YYYY-MM-DD" from feed_info.txt's
 *  feed_start_date), or null when the feed is absent/unreadable. */
export function gtfsFeedDate(dir: string = config.GTFS_DIR): string | null {
  try {
    const text = fs.readFileSync(path.join(dir, "feed_info.txt"), "utf-8");
    const lines = splitLines(text);
    const header = parseCsvLine(lines[0]);
    const i = col(header, "feed_start_date");
    if (i < 0 || !lines[1]) return null;
    const v = parseCsvLine(lines[1])[i];
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v ?? "");
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  } catch {
    return null;
  }
}
