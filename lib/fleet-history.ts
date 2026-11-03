/**
 * The past days of a fleet tracker (lib/fleet-tracker.ts), kept compact in memory: per day one
 * string table and per vehicle one Int32Array of its courses (FIELDS ints each, by scheduled
 * start). Feeds the vehicle history (/api/fleet/<side>/history) and, for MZK, the successor
 * index of the next-course prediction: which course a vehicle ran right after a given course on
 * past days of the same kind. MZK publishes no duty rosters, but its buses run the same duty
 * on the same course every working day, so what followed a course before mostly follows it again.
 *
 * Filled from the day files at start (async, one file per event-loop turn) and by the tracker
 * at every rollover with the day that just ended.
 */
import fs from "node:fs";
import path from "node:path";

import { log } from "./logger";
import type { MzkDayCourse, MzkDaySchedule } from "./mzk-timetable";
import { foldText, type FleetHistoryCourse, type FleetHistoryDay, type PredictedNextCourse, type VehicleCourseRecord } from "./shared/fleet";

const START = 0;
const END = 1;
const LINE = 2;
const DIR = 3;
const FIRST = 4;
const FIRST_SYM = 5;
const LAST = 6;
const BRIG = 7;
const DELAY = 8;
const STATUS = 9;
const DRIVEN = 10;
const AT = 11;
const FIELDS = 12;

/** A course followed by one that starts later than this after its end is the vehicle's last before a break. */
export const MAX_GAP_SEC = 45 * 60;
/** The next course may start this much before the scheduled end of the previous one (a late arrival). */
const OVERLAP_SEC = 5 * 60;
/** The shortest turnaround the timetable rule assumes after the expected arrival. */
const MIN_TURN_SEC = 60;
const END_KEY = "END";

export type DayKind = "wd" | "sat" | "sun";

const KIND_GEN: Record<DayKind, string> = { wd: "dni roboczych", sat: "sobót", sun: "niedziel" };

// ponytail: weekday only, a public holiday counts as its weekday; the successor must exist in today's
// timetable, which drops most of what that gets wrong. Upgrade: the MZK calendar's day type per date.
export function dayKind(date: string): DayKind {
  const w = new Date(`${date}T12:00:00Z`).getUTCDay();
  return w === 0 ? "sun" : w === 6 ? "sat" : "wd";
}

/** A course the same on every day of its day type: the tracker's records and the MZK timetable share it. */
export function courseKey(line: string, firstSym: string | undefined, start: number): string {
  return `${line}|${firstSym ?? ""}|${start}`;
}

function minusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

interface PackedDay {
  date: string;
  kind: DayKind;
  str: string[];
  bySide: Map<string, Int32Array>;
}

export interface Successor {
  key: string;
  /** observations of this successor */
  count: number;
  /** observations of the course, every successor and the end of a run included */
  total: number;
}

export class FleetHistory {
  /** newest first */
  private days: PackedDay[] = [];
  private succ = new Map<string, Map<string, number>>();
  private succDirty = true;
  private loaded = false;
  private today = "";
  private cutoff = "";

  /** keepDays = past days held; successors = build the successor index (MZK) */
  constructor(
    private readonly keepDays: number,
    private readonly successors: boolean,
  ) {}

  /** Whether the day files have been read: until then the history is partial and no successor is known. */
  get complete(): boolean {
    return this.loaded;
  }

  /** Days before `today` and within keepDays stay. */
  setToday(today: string): void {
    this.today = today;
    this.cutoff = minusDays(today, this.keepDays);
    const kept = this.days.filter((d) => d.date >= this.cutoff && d.date < today);
    if (kept.length !== this.days.length) this.succDirty = true;
    this.days = kept;
  }

  /** Adds a finished day (no-op for a date already held or out of range). Only finished and broken-off courses count. */
  addDay(date: string, vehicles: Iterable<readonly [string, readonly VehicleCourseRecord[] | undefined]>): void {
    if (date < this.cutoff || date >= this.today || this.days.some((d) => d.date === date)) return;
    const str: string[] = [];
    const ids = new Map<string, number>();
    const id = (s: string | undefined): number => {
      if (!s) return -1;
      let i = ids.get(s);
      if (i === undefined) {
        i = str.length;
        str.push(s);
        ids.set(s, i);
      }
      return i;
    };
    const bySide = new Map<string, Int32Array>();
    for (const [side, courses] of vehicles) {
      if (!Array.isArray(courses)) continue;
      const list = courses
        .filter(
          (c) =>
            c &&
            (c.status === "completed" || c.status === "cancelled") &&
            // files written before 2026-10-04 carry invented "synth-*" courses: never real
            !String(c.id).startsWith("synth-") &&
            Number.isFinite(c.startSecs) &&
            Number.isFinite(c.endSecs),
        )
        .sort((a, b) => a.startSecs - b.startSecs);
      if (list.length === 0) continue;
      const a = new Int32Array(list.length * FIELDS);
      list.forEach((c, i) => {
        const o = i * FIELDS;
        a[o + START] = c.startSecs;
        a[o + END] = c.endSecs;
        a[o + LINE] = id(c.lineName);
        a[o + DIR] = id(c.direction);
        a[o + FIRST] = id(c.firstStopName);
        a[o + FIRST_SYM] = id(c.firstStopSymbol);
        a[o + LAST] = id(c.lastStopName);
        a[o + BRIG] = id(c.brigade);
        a[o + DELAY] = Math.round(c.delaySec || 0);
        a[o + STATUS] = c.status === "cancelled" ? 1 : 0;
        a[o + DRIVEN] = Math.round(c.drivenMeters ?? 0);
        a[o + AT] = id(c.cancelledAtStopName);
      });
      bySide.set(side, a);
    }
    if (bySide.size === 0) return;
    this.days.push({ date, kind: dayKind(date), str, bySide });
    this.days.sort((x, y) => (x.date < y.date ? 1 : -1));
    this.succDirty = true;
  }

  /**
   * Reads the day files in `dir` (null = none), newest first, one per event-loop turn: a GZM day is
   * a few MB of JSON. `normalize` maps each saved course (the tracker re-judges old "cancelled" ones).
   */
  async load(dir: string | null, normalize: (c: VehicleCourseRecord) => VehicleCourseRecord = (c) => c): Promise<void> {
    try {
      if (!dir) return;
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        return;
      }
      const dates = names
        .map((f) => /^fleet-history-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1])
        .filter((d): d is string => !!d && d >= this.cutoff && d < this.today)
        .sort()
        .reverse();
      for (const date of dates) {
        try {
          const data = JSON.parse(await fs.promises.readFile(path.join(dir, `fleet-history-${date}.json`), "utf8")) as Record<
            string,
            { todayCourses?: VehicleCourseRecord[] } | unknown
          >;
          const entries: [string, VehicleCourseRecord[]][] = [];
          for (const [side, raw] of Object.entries(data)) {
            if (side.startsWith("_") || !raw || typeof raw !== "object") continue;
            const list = (raw as { todayCourses?: unknown }).todayCourses;
            if (Array.isArray(list)) entries.push([side, (list as VehicleCourseRecord[]).filter(Boolean).map(normalize)]);
          }
          this.addDay(date, entries);
        } catch (err) {
          log.warn("fleet-history", `skipping ${date}: ${err}`);
        }
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      this.loaded = true;
    }
  }

  /** A vehicle's past days, newest first, its courses by scheduled start. */
  vehicleDays(side: string): FleetHistoryDay[] {
    const out: FleetHistoryDay[] = [];
    for (const d of this.days) {
      const a = d.bySide.get(side);
      if (!a) continue;
      const courses: FleetHistoryCourse[] = [];
      const s = (i: number): string => (i >= 0 ? d.str[i] : "");
      for (let o = 0; o < a.length; o += FIELDS) {
        courses.push({
          lineName: s(a[o + LINE]),
          direction: s(a[o + DIR]),
          firstStopName: s(a[o + FIRST]),
          lastStopName: s(a[o + LAST]),
          startSecs: a[o + START],
          endSecs: a[o + END],
          ...(a[o + BRIG] >= 0 ? { brigade: s(a[o + BRIG]) } : {}),
          delaySec: a[o + DELAY],
          status: a[o + STATUS] === 1 ? "cancelled" : "completed",
          drivenMeters: a[o + DRIVEN],
          ...(a[o + AT] >= 0 ? { cancelledAtStopName: s(a[o + AT]) } : {}),
        });
      }
      out.push({ date: d.date, courses });
    }
    return out;
  }

  /** The course most often run right after `key` on past days of `kind`; null before the files are read. */
  successor(kind: DayKind, key: string): Successor | null {
    if (!this.successors || !this.loaded) return null;
    if (this.succDirty) this.rebuild();
    const m = this.succ.get(`${kind}|${key}`);
    if (!m) return null;
    let total = 0;
    let best: Successor | null = null;
    for (const [k, n] of m) {
      total += n;
      if (k !== END_KEY && (!best || n > best.count)) best = { key: k, count: n, total: 0 };
    }
    return best && { ...best, total };
  }

  /** O(courses held): MZK 28 days ~ 80 000 courses, tens of ms, once per day and after the load. */
  private rebuild(): void {
    this.succ.clear();
    this.succDirty = false;
    for (const d of this.days) {
      const keyAt = (a: Int32Array, o: number): string =>
        courseKey(d.str[a[o + LINE]] ?? "", a[o + FIRST_SYM] >= 0 ? d.str[a[o + FIRST_SYM]] : undefined, a[o + START]);
      for (const a of d.bySide.values()) {
        for (let o = 0; o < a.length; o += FIELDS) {
          const n = o + FIELDS;
          const next =
            n < a.length && a[n + START] - a[o + END] <= MAX_GAP_SEC && a[n + START] >= a[o + END] - OVERLAP_SEC
              ? keyAt(a, n)
              : END_KEY;
          const k = `${d.kind}|${keyAt(a, o)}`;
          let m = this.succ.get(k);
          if (!m) this.succ.set(k, (m = new Map()));
          m.set(next, (m.get(next) ?? 0) + 1);
        }
      }
    }
  }
}

/** Where a course ends: the start of a next-course search. */
export interface CourseEnd {
  line: string;
  firstSym?: string;
  start: number;
  end: number;
  lastName: string;
  /** expected arrival at the terminus, agency seconds */
  arrival: number;
}

export interface ChainStep {
  course: MzkDayCourse;
  source: "history" | "timetable";
  confidence: PredictedNextCourse["confidence"];
  seen?: { days: number; of: number };
}

/**
 * The next course after `at`: the history successor when today's timetable runs it, else the first
 * timetable course from a same-name stop at least MIN_TURN_SEC after the arrival and within
 * MAX_GAP_SEC of the scheduled end, the same line first. On 2026-10 MZK days the successor was
 * right 100% of the time it was known (28% of courses), the timetable rule 73%, both 78%.
 */
export function nextCourse(at: CourseEnd, sched: MzkDaySchedule, successor: (key: string) => Successor | null): ChainStep | null {
  const h = successor(courseKey(at.line, at.firstSym, at.start));
  const hc = h ? sched.byKey.get(h.key) : undefined;
  if (h && hc && hc.start > at.start) {
    const share = h.count / h.total;
    return {
      course: hc,
      source: "history",
      confidence: h.count >= 2 && share >= 0.75 ? "high" : share >= 0.4 ? "medium" : "low",
      seen: { days: h.count, of: h.total },
    };
  }
  let other: MzkDayCourse | null = null;
  for (const c of sched.fromStop.get(foldText(at.lastName)) ?? []) {
    if (c.start < at.arrival + MIN_TURN_SEC) continue;
    if (c.start > at.end + MAX_GAP_SEC) break;
    if (c.line === at.line) return { course: c, source: "timetable", confidence: "medium" };
    other ??= c;
  }
  return other && { course: other, source: "timetable", confidence: "low" };
}

/** Up to `max` courses in a row from `at`, stopping at a course into the depot. */
export function courseChain(
  at: CourseEnd,
  sched: MzkDaySchedule,
  successor: (key: string) => Successor | null,
  max = 5,
): ChainStep[] {
  const out: ChainStep[] = [];
  let from = at;
  while (out.length < max) {
    const step = nextCourse(from, sched, successor);
    if (!step) break;
    out.push(step);
    const c = step.course;
    if (foldText(c.lastName).includes("zajezdnia")) break;
    from = { line: c.line, firstSym: c.firstSym, start: c.start, end: c.end, lastName: c.lastName, arrival: c.end };
  }
  return out;
}

/** "Po tym kursie pojazd jechał dalej tym kursem w 5 z 6 poprzednich dni roboczych." */
export function historyReason(seen: { days: number; of: number }, kind: DayKind): string {
  return `Po tym kursie pojazd jechał dalej tym kursem w ${seen.days} z ${seen.of} poprzednich ${KIND_GEN[kind]}.`;
}
