/**
 * MZK Bielsko-Biała static timetable for the connection search (lib/router.ts).
 *
 * OnTime publishes no GTFS feed, so the courses are assembled from the per-stop day schedules
 * (getAtomicSchedule) of every stop, once for each day type that occurs in the next 8 days.
 * The per-stop schedules leave out a course's terminus; one getRealCourse sample per variant
 * supplies it. Built once a day by lib/gtfs-refresh.ts into config.MZK_TIMETABLE_FILE.
 */
import fs from "node:fs";
import path from "node:path";

import pLimit from "p-limit";

import * as config from "./config";
import { log } from "./logger";
import type { MzkApi, MzkAtomicScheduleResponse } from "./mzk-api";

export interface MzkTimetableTrip {
  /** `mzk:<courseId>:<variantId>`, the id the stop timetable route uses (parsed by lib/mzk-trip.ts) */
  id: string;
  line: string;
  headsign: string;
  dayType: string;
  /** [stop symbol, departure secs since the service day's midnight], in course order */
  calls: [string, number][];
}

export interface MzkTimetableFile {
  v: 1;
  builtAt: number;
  /** Warsaw ISO date -> day type symbol, only for the dates the trips cover */
  calendar: Record<string, string>;
  stops: Record<string, [name: string, lat: number, lon: number]>;
  trips: MzkTimetableTrip[];
}

/** One course being assembled from the per-stop schedules of one day type. */
interface CourseAcc {
  courseId: number;
  variantId: number;
  line: string;
  headsign: string;
  startSec: number | null;
  calls: { symbol: string; sec: number; order: number }[];
}

export type CourseAccumulator = Map<number, CourseAcc>;

// ponytail: dates past this window get KB-only results; widen it (more day types, same requests per type) if users plan further ahead
const WINDOW_DAYS = 8;
const CONCURRENCY = 4;
/** More failed stop schedules than this share of all stops = a broken build, keep the old file. */
const MAX_FAILED_SHARE = 0.05;

/**
 * Folds one stop's day schedule into the courses of `dayType`. A response for another day type
 * (OnTime answering with a different calendar day) is ignored; returns whether it was used.
 */
export function addStopSchedule(
  acc: CourseAccumulator,
  symbol: string,
  res: MzkAtomicScheduleResponse,
  dayType: string,
): boolean {
  if (res.dayTypeSymbol && res.dayTypeSymbol !== dayType) return false;
  for (const ls of Object.values(res.lineSchedules ?? {})) {
    for (const d of ls.departures ?? []) {
      if (!Number.isFinite(d.courseId) || !Number.isFinite(d.scheduledDepartureSec)) continue;
      let c = acc.get(d.courseId);
      if (!c) {
        c = {
          courseId: d.courseId,
          variantId: d.variantId,
          line: ls.lineName,
          headsign: d.optionalDirection || ls.destination || "",
          startSec: null,
          calls: [],
        };
        acc.set(d.courseId, c);
      }
      if (c.startSec === null && typeof d.courseStartSec === "number") c.startSec = d.courseStartSec;
      c.calls.push({ symbol, sec: d.scheduledDepartureSec, order: d.orderInCourse ?? c.calls.length });
    }
  }
  return true;
}

/**
 * Turns the accumulated courses into trips: calls in course order, times made monotonic across
 * midnight (a call more than 12 h before the course start belongs to the next calendar day).
 */
export function finishCourses(acc: CourseAccumulator, dayType: string): MzkTimetableTrip[] {
  const trips: MzkTimetableTrip[] = [];
  for (const c of acc.values()) {
    if (c.calls.length < 2) continue;
    c.calls.sort((a, b) => a.order - b.order);
    const start = c.startSec ?? c.calls[0].sec;
    trips.push({
      id: `mzk:${c.courseId}:${c.variantId}`,
      line: c.line,
      headsign: c.headsign,
      dayType,
      calls: c.calls.map((x) => [x.symbol, x.sec < start - 43200 ? x.sec + 86400 : x.sec]),
    });
  }
  return trips;
}

/** Course order of one sampled course: [stop symbol, departure secs]. */
export type VariantSample = [string, number][];

/**
 * Appends the stops a trip lacks after its last call (the terminus), copied from the sample
 * course of its variant with the sample's own run times. Returns how many trips were extended.
 */
// ponytail: run times from one sample per variant, about ±1 min off in the peak; getRealCourse per course if that matters
export function appendTermini(trips: MzkTimetableTrip[], samples: Map<number, VariantSample>): number {
  let n = 0;
  for (const t of trips) {
    const sample = samples.get(variantOf(t.id));
    if (!sample) continue;
    const [lastSym, lastSec] = t.calls[t.calls.length - 1];
    let i = sample.length - 1;
    while (i >= 0 && sample[i][0] !== lastSym) i -= 1;
    if (i < 0 || i === sample.length - 1) continue;
    for (let j = i + 1; j < sample.length; j++) {
      t.calls.push([sample[j][0], lastSec + sample[j][1] - sample[i][1]]);
    }
    n += 1;
  }
  return n;
}

function variantOf(tripId: string): number {
  return Number(tripId.slice(tripId.lastIndexOf(":") + 1));
}

function parseSample(raw: unknown): VariantSample | null {
  const rc = raw && typeof raw === "object" ? (raw as { realCourse?: { stoppings?: unknown } }).realCourse : null;
  if (!rc || !Array.isArray(rc.stoppings)) return null;
  const rows = rc.stoppings
    .filter(
      (s): s is { stopPointSymbol: string; scheduledDepartureSec: number; orderInCourse: number } =>
        typeof s?.stopPointSymbol === "string" && typeof s?.scheduledDepartureSec === "number",
    )
    .sort((a, b) => a.orderInCourse - b.orderInCourse);
  return rows.length >= 2 ? rows.map((s) => [s.stopPointSymbol, s.scheduledDepartureSec]) : null;
}

/**
 * Fetches and assembles the timetable. Throws (so the caller keeps the previous file) when the
 * calendar or stop list is empty, a day type yields no course, or too many stop schedules failed.
 */
export async function buildMzkTimetable(api: MzkApi, today = config.todayLocalISO()): Promise<MzkTimetableFile> {
  const calendar: Record<string, string> = {};
  const days = (await api.fetchCalendar())
    .map((d) => ({ iso: config.todayLocalISO(new Date(d.date)), type: d.dayType?.dayTypeSymbol }))
    .filter((d): d is { iso: string; type: string } => d.iso >= today && !!d.type)
    .sort((a, b) => (a.iso < b.iso ? -1 : 1))
    .slice(0, WINDOW_DAYS);
  const repDate = new Map<string, string>();
  for (const d of days) {
    calendar[d.iso] = d.type;
    if (!repDate.has(d.type)) repDate.set(d.type, d.iso);
  }
  if (!repDate.size) throw new Error("MZK calendar has no day from today on");

  const points = (await api.fetchStops()).filter((s) => s.symbol);
  if (!points.length) throw new Error("MZK stop list is empty");
  const stops: MzkTimetableFile["stops"] = {};
  for (const s of points) stops[s.symbol] = [s.name, s.latitude, s.longitude];

  const limit = pLimit(CONCURRENCY);
  const trips: MzkTimetableTrip[] = [];
  for (const [dayType, iso] of repDate) {
    const acc: CourseAccumulator = new Map();
    let failed = 0;
    let otherDay = 0;
    await Promise.all(
      points.map((s) =>
        limit(async () => {
          try {
            const res = await api.fetchAtomicSchedule(s.symbol, iso, { cache: false });
            if (!addStopSchedule(acc, s.symbol, res, dayType)) otherDay += 1;
          } catch {
            failed += 1;
          }
        }),
      ),
    );
    if (failed > points.length * MAX_FAILED_SHARE) {
      throw new Error(`MZK ${dayType}: ${failed}/${points.length} stop schedules failed`);
    }
    const dayTrips = finishCourses(acc, dayType);
    if (!dayTrips.length) throw new Error(`MZK ${dayType} (${iso}) has no course`);
    log.info("mzk-tt", `${dayType} (${iso}): ${dayTrips.length} courses, ${failed} failed, ${otherDay} other-day stops`);
    trips.push(...dayTrips);
  }

  const firstOfVariant = new Map<number, number>();
  for (const t of trips) {
    const v = variantOf(t.id);
    if (!firstOfVariant.has(v)) firstOfVariant.set(v, Number(t.id.split(":")[1]));
  }
  const samples = new Map<number, VariantSample>();
  await Promise.all(
    [...firstOfVariant].map(([variant, courseId]) =>
      limit(async () => {
        try {
          const s = parseSample(await api.fetchRealCourse(courseId));
          if (s) samples.set(variant, s);
        } catch {
          // a missing sample only leaves that variant's trips without their terminus
        }
      }),
    ),
  );
  const extended = appendTermini(trips, samples);
  for (const t of trips) t.calls = t.calls.filter(([sym]) => sym in stops);
  log.info(
    "mzk-tt",
    `built ${trips.length} courses, ${samples.size}/${firstOfVariant.size} variant samples, ${extended} termini added`,
  );
  return { v: 1, builtAt: Date.now(), calendar, stops, trips: trips.filter((t) => t.calls.length >= 2) };
}

/** Atomic write (tmp + rename): a reader never sees a half-written file. */
export function saveMzkTimetable(tt: MzkTimetableFile, file = config.MZK_TIMETABLE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tt));
  fs.renameSync(tmp, file);
}

/** Warsaw date the timetable file was written, null when there is none (cheap: no parse). */
export function mzkTimetableDate(file = config.MZK_TIMETABLE_FILE): string | null {
  try {
    return config.todayLocalISO(fs.statSync(file).mtime);
  } catch {
    return null;
  }
}

/** Reads the timetable file; null when it is missing or not a v1 timetable. */
export function loadMzkTimetable(file = config.MZK_TIMETABLE_FILE): MzkTimetableFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const tt = JSON.parse(raw) as MzkTimetableFile;
    if (tt?.v !== 1 || !Array.isArray(tt.trips) || !tt.stops || !tt.calendar) throw new Error("not a v1 timetable");
    return tt;
  } catch (err) {
    log.warn("mzk-tt", `ignoring ${file}: ${err}`);
    return null;
  }
}
