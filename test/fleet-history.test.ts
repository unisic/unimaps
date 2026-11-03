import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { courseChain, courseKey, dayKind, FleetHistory } from "../lib/fleet-history";
import { FleetTracker } from "../lib/fleet-tracker";
import type { MzkDayCourse, MzkDaySchedule } from "../lib/mzk-timetable";
import { foldText, type VehicleCourseRecord } from "../lib/shared/fleet";

afterEach(() => mock.timers.reset());

const H = 3600;

function course(line: string, firstSym: string, firstName: string, start: number, lastName: string, end: number): MzkDayCourse {
  return { line, headsign: lastName, firstSym, firstName, start, lastName, end };
}

function schedule(courses: MzkDayCourse[]): MzkDaySchedule {
  const s: MzkDaySchedule = { byKey: new Map(), fromStop: new Map() };
  for (const c of courses.sort((a, b) => a.start - b.start)) {
    s.byKey.set(courseKey(c.line, c.firstSym, c.start), c);
    const k = foldText(c.firstName);
    s.fromStop.set(k, [...(s.fromStop.get(k) ?? []), c]);
  }
  return s;
}

/** The record fields the history reads; the rest of a saved course does not matter here. */
function rec(id: string, c: MzkDayCourse, status: "completed" | "cancelled" = "completed"): VehicleCourseRecord {
  return {
    id,
    lineName: c.line,
    direction: c.headsign,
    firstStopName: c.firstName,
    firstStopSymbol: c.firstSym,
    lastStopName: c.lastName,
    startSecs: c.start,
    endSecs: c.end,
    delaySec: 60,
    status,
    drivenMeters: 5000,
    stopsCount: 10,
  } as VehicleCourseRecord;
}

// 50: Silesia 12:00 -> Karpackie 12:40; history says the bus then runs 16 from Karpackie at 13:00,
// while the timetable rule alone would pick the 50 back at 12:50
const A = course("50", "2375", "Czechowice-Dziedzice Silesia", 12 * H, "Osiedle Karpackie", 12 * H + 2400);
const B = course("16", "307", "Osiedle Karpackie", 13 * H, "Dworzec", 13 * H + 1800);
const C = course("50", "307", "Osiedle Karpackie", 12 * H + 3000, "Czechowice-Dziedzice Silesia", 13 * H + 2400);
const D = course("16", "9", "Dworzec", 13 * H + 2400, "Zajezdnia MZK", 14 * H);
const SCHED = schedule([A, B, C, D]);

describe("fleet-history", () => {
  it("classifies days by weekday", () => {
    assert.deepEqual(["2026-10-05", "2026-10-10", "2026-10-11"].map(dayKind), ["wd", "sat", "sun"]);
  });

  it("packs days, serves them per vehicle and counts successors per day kind", async () => {
    const h = new FleetHistory(28, true);
    h.setToday("2026-10-05");
    // Mon + Tue: A then B; Wed: A then a break (> 45 min), so END; a Saturday never counts for a weekday
    h.addDay("2026-09-28", [["233", [rec("1", B), rec("2", A)]]]);
    h.addDay("2026-09-29", [["233", [rec("3", A), rec("4", B)]]]);
    h.addDay("2026-09-30", [["233", [rec("5", A), rec("6", { ...D, start: 15 * H })]]]);
    h.addDay("2026-10-03", [["233", [rec("7", A), rec("8", C)]]]);
    h.addDay("2026-09-28", [["999", [rec("x", A)]]]); // a date already held is ignored
    h.addDay("2026-08-01", [["999", [rec("y", A)]]]); // older than 28 days
    h.addDay("2026-10-04", [["233", [rec("synth-1", A)]]]); // invented courses never count

    assert.equal(h.successor("wd", courseKey("50", "2375", A.start)), null, "unknown until the files are read");
    await h.load(null);
    assert.deepEqual(h.successor("wd", courseKey("50", "2375", A.start)), { key: courseKey("16", "307", B.start), count: 2, total: 3 });
    assert.deepEqual(h.successor("sat", courseKey("50", "2375", A.start)), { key: courseKey("50", "307", C.start), count: 1, total: 1 });

    const days = h.vehicleDays("233");
    assert.deepEqual(days.map((d) => d.date), ["2026-10-03", "2026-09-30", "2026-09-29", "2026-09-28"]);
    assert.deepEqual(days[3].courses.map((c) => c.lineName), ["50", "16"], "by scheduled start");
    assert.equal(days[3].courses[0].firstStopName, "Czechowice-Dziedzice Silesia");
    assert.deepEqual(h.vehicleDays("999"), []);

    h.setToday("2026-10-30"); // drops what fell out of the 28 days
    assert.deepEqual(h.vehicleDays("233").map((d) => d.date), ["2026-10-03"]);
  });

  it("chains the history successor, then the timetable, until the depot", () => {
    const at = { line: A.line, firstSym: A.firstSym, start: A.start, end: A.end, lastName: A.lastName, arrival: A.end + 120 };
    const seen = (key: string) => (key === courseKey("50", "2375", A.start) ? { key: courseKey("16", "307", B.start), count: 3, total: 3 } : null);
    const chain = courseChain(at, SCHED, seen);
    assert.deepEqual(
      chain.map((s) => [s.course.line, s.course.start, s.source, s.confidence]),
      [
        ["16", B.start, "history", "high"],
        ["16", D.start, "timetable", "medium"],
      ],
      "stops after the course into the depot",
    );
    // no history: the same line from the terminus first, even after another line
    assert.deepEqual(courseChain(at, SCHED, () => null, 1).map((s) => [s.course.line, s.course.start]), [["50", C.start]]);
    // arriving too late for any course within 45 min of the scheduled end
    assert.deepEqual(courseChain({ ...at, arrival: A.end + 50 * 60 }, SCHED, () => null), []);
  });

  it("reads the day files and predicts from history in the tracker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-history-"));
    try {
      for (const [date, courses] of [
        ["2026-09-28", [A, B]],
        ["2026-09-29", [A, B]],
      ] as const) {
        const day = { _v: 2, "233": { todayCourses: courses.map((c, i) => rec(`${date}-${i}`, c)) } };
        fs.writeFileSync(path.join(dir, `fleet-history-${date}.json`), JSON.stringify(day));
      }
      // Monday 2026-10-05 12:10 Warsaw (CEST)
      mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 5, 10, 10, 0) });
      const t = new FleetTracker({ historyDir: dir, staticFleet: null, schedule: () => SCHED, saveDebounceMs: 3_600_000 });
      // the reads go through the libuv pool: under a parallel test run they take more than a few loop turns
      for (let i = 0; i < 400 && !t.vehicleHistory("233").complete; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(t.vehicleHistory("233").complete, "history loaded within 2 s");
      assert.deepEqual(t.vehicleHistory("233").days.map((d) => d.courses.length), [2, 2]);

      const ms = (secs: number) => Date.UTC(2026, 9, 5, 0, 0, 0) - 2 * H * 1000 + secs * 1000;
      t.updateFromRunningVehicles([
        {
          vehicleId: "233",
          lineName: "50",
          courseLoid: 1,
          direction: "Osiedle Karpackie",
          delaySec: 120,
          latitude: 49.93,
          longitude: 19.0,
          orderInCourse: 1,
          stopPoints: [
            { symbol: "2375", name: A.firstName, orderNo: 0, distance: 0, scheduledDeparture: ms(A.start), plannedDeparture: ms(A.start) },
            { symbol: "307", name: A.lastName, orderNo: 1, distance: 9000, scheduledDeparture: ms(A.end), plannedDeparture: ms(A.end) },
          ],
        },
      ]);
      const p = t.getVehicleDetail("233")?.predictedNextCourse;
      assert.equal(p?.source, "history");
      assert.equal(p?.lineName, "16");
      assert.equal(p?.departureTime, "13:00");
      assert.equal(p?.confidence, "high");
      assert.deepEqual(p?.seen, { days: 2, of: 2 });
      assert.equal(p?.pauseMinutes, 18, "arrives 12:42 (+2 min), leaves 13:00");
      assert.deepEqual(p?.later?.map((l) => [l.lineName, l.departureTime, l.confidence]), [["16", "13:40", "medium"]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
