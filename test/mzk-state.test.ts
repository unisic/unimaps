/**
 * Lifecycle classification of OnTime running-vehicle records. The fixtures are
 * REAL records captured from getRunningVehicles.json on 2026-10-02 (22:55-23:05,
 * Europe/Warsaw): one per lifecycle state, see test/fixtures/mzk-lifecycle.json.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  clampPlannedMonotone,
  hasPlannedDip,
  isMzkNotStarted,
  MZK_NOT_STARTED_MAX_FROM_FIRST_M,
  MZK_NOT_STARTED_REACHED_M,
  mzkRowTiming,
} from "../lib/mzk-state";

interface Fixture {
  label: string;
  expectNotStarted: boolean;
  note: string;
  record: {
    orderInCourse: number;
    lastStopOrderNo: number | null;
    reachedMeters: number;
    latitude: number;
    longitude: number;
    delaySec: number;
    firstStop: { lat: number; lon: number };
  };
}

const fixtures = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "mzk-lifecycle.json"), "utf-8"),
) as Fixture[];

describe("isMzkNotStarted — real OnTime records", () => {
  for (const f of fixtures) {
    it(`${f.label}: ${f.expectNotStarted ? "not started" : "started"}`, () => {
      assert.equal(isMzkNotStarted(f.record, f.record.firstStop), f.expectNotStarted, f.note);
      // the coordinate guard is a safety net only: without first-stop coords the flags decide
      assert.equal(isMzkNotStarted(f.record, null), f.expectNotStarted, f.note);
    });
  }
});

describe("isMzkNotStarted — rules", () => {
  const at = { latitude: 49.8, longitude: 19.0 };
  const first = { lat: 49.8, lon: 19.0 };

  it("orderInCourse >= 1 is always running, even without lastStopOrderNo (mid-course join)", () => {
    for (const order of [1, 2, 5, 22]) {
      assert.equal(isMzkNotStarted({ orderInCourse: order, lastStopOrderNo: null, reachedMeters: 0, ...at }, first), false);
    }
  });

  it("lastStopOrderNo >= 1 is always running", () => {
    assert.equal(isMzkNotStarted({ orderInCourse: 0, lastStopOrderNo: 1, reachedMeters: 0, ...at }, first), false);
  });

  it("lastStopOrderNo 0 only counts as not-started while the bus has not moved", () => {
    const base = { orderInCourse: 0, lastStopOrderNo: 0, ...at };
    assert.equal(isMzkNotStarted({ ...base, reachedMeters: 0 }, first), true);
    assert.equal(isMzkNotStarted({ ...base, reachedMeters: MZK_NOT_STARTED_REACHED_M - 1 }, first), true);
    assert.equal(isMzkNotStarted({ ...base, reachedMeters: MZK_NOT_STARTED_REACHED_M }, first), false);
    assert.equal(isMzkNotStarted({ ...base, reachedMeters: 464 }, first), false);
    // reachedMeters missing -> treated as 0 (still parked)
    assert.equal(isMzkNotStarted(base, first), true);
  });

  it("a bus far from its first stop has left it, whatever the flags say", () => {
    const farLat = 49.8 + (MZK_NOT_STARTED_MAX_FROM_FIRST_M + 50) / 111_320;
    const v = { orderInCourse: 0, lastStopOrderNo: null, reachedMeters: 0, latitude: farLat, longitude: 19.0 };
    assert.equal(isMzkNotStarted(v, first), false);
    assert.equal(isMzkNotStarted(v, null), true); // no coordinates -> flags only
    const nearLat = 49.8 + 100 / 111_320; // 100 m: a layover pocket
    assert.equal(isMzkNotStarted({ ...v, latitude: nearLat }, first), true);
  });

  it("unknown or garbled input classifies as started (never hides a real delay)", () => {
    assert.equal(isMzkNotStarted({}, first), false);
    // field absent (not an OnTime record): started; explicit null (OnTime: no stop confirmed yet): not started
    assert.equal(isMzkNotStarted({ orderInCourse: 0, ...at }, first), false);
    assert.equal(isMzkNotStarted({ orderInCourse: 0, lastStopOrderNo: null, ...at }, first), true);
    assert.equal(isMzkNotStarted({ orderInCourse: "0" as unknown as number }, first), false);
    assert.equal(isMzkNotStarted({ orderInCourse: null }, first), false);
    assert.equal(isMzkNotStarted({ orderInCourse: NaN }, first), false);
    // a garbled order must not be rescued by a null lastStopOrderNo
    assert.equal(isMzkNotStarted({ orderInCourse: null, lastStopOrderNo: null, ...at }, first), false);
    assert.equal(isMzkNotStarted({ orderInCourse: -1, lastStopOrderNo: null, ...at }, first), false);
    assert.equal(isMzkNotStarted({ orderInCourse: undefined, lastStopOrderNo: null, ...at }, first), false);
  });
});

describe("mzkRowTiming (departure board row)", () => {
  const MIN = 60_000;
  const sec = (h: number, m: number) => h * 3600 + m * 60;
  const ms = (h: number, m: number) => sec(h, m) * 1000;

  it("not started + late: earliest possible time, no delay, not an estimate (screenshot C row #170)", () => {
    // course scheduled 15:05 at the terminus, Andersa 15:12; now 15:22 and the bus still waits
    const r = mzkRowTiming({
      scheduledDepartureSec: sec(15, 12),
      scheduledDeparture: ms(15, 12),
      realDeparture: ms(15, 12) + 16 * MIN, // OnTime's placeholder (+16 min)
      notStarted: true,
      firstScheduledMs: ms(15, 5),
      nowMs: ms(15, 22),
    });
    assert.deepEqual(r, { time: "15:29", timeDiff: 0, isEstimated: false });
  });

  it("not started + early: the schedule (OnTime's -60 s floor is dropped)", () => {
    const r = mzkRowTiming({
      scheduledDepartureSec: sec(23, 16),
      scheduledDeparture: ms(23, 16),
      realDeparture: ms(23, 16) - MIN,
      notStarted: true,
      firstScheduledMs: ms(23, 15),
      nowMs: ms(22, 55),
    });
    assert.deepEqual(r, { time: "23:16", timeDiff: 0, isEstimated: false });
  });

  it("running: unchanged — real minus scheduled, estimated", () => {
    const r = mzkRowTiming({
      scheduledDepartureSec: sec(15, 17),
      scheduledDeparture: ms(15, 17),
      realDeparture: ms(15, 17) + 6 * MIN,
      notStarted: false,
      nowMs: ms(15, 22),
    });
    assert.deepEqual(r, { time: "15:23", timeDiff: 360, isEstimated: true });
  });

  it("no estimate (lack / null): scheduled, not estimated; wraps past midnight", () => {
    assert.deepEqual(
      mzkRowTiming({ scheduledDepartureSec: sec(0, 34), scheduledDeparture: 0, realDeparture: null, lack: true, notStarted: false, nowMs: 0 }),
      { time: "00:34", timeDiff: 0, isEstimated: false },
    );
    // 00:00 scheduled but running 60 s early: used to print "-1:59" (floor of a negative / 3600)
    assert.equal(
      mzkRowTiming({ scheduledDepartureSec: 0, scheduledDeparture: 1_000_000, realDeparture: 1_000_000 - 60_000, notStarted: false, nowMs: 0 }).time,
      "23:59",
    );
  });
});

describe("hasPlannedDip", () => {
  it("flags a stop ahead whose estimate precedes an earlier stop's (screenshot B), not clean data", () => {
    assert.equal(hasPlannedDip([10, 11, 13, 12, 14], 0), true);
    assert.equal(hasPlannedDip([10, 11, 12, 13], 0), false);
    assert.equal(hasPlannedDip([10, null, 12, null, 14], 0), false);
    // dips among already-passed stops are actual times, not estimates: untouched
    assert.equal(hasPlannedDip([10, 9, 8, 12, 13], 2), false);
  });
});

describe("clampPlannedMonotone", () => {
  it("lifts a dip after the passed stops (stale placeholder vs fresh estimate) to its predecessor", () => {
    // screenshot B shape: 15:18 15:19 15:21 15:22 15:23 then an impossible 15:19
    const t = (hh: number, mm: number) => (hh * 60 + mm) * 60_000;
    const planned = [t(15, 18), t(15, 19), t(15, 21), t(15, 22), t(15, 23), t(15, 19), t(15, 27)];
    assert.deepEqual(clampPlannedMonotone(planned, 0), [t(15, 18), t(15, 19), t(15, 21), t(15, 22), t(15, 23), t(15, 23), t(15, 27)]);
  });
  it("never touches passed stops and keeps nulls", () => {
    const planned = [100, null, 90, 80, 120, null, 110];
    assert.deepEqual(clampPlannedMonotone(planned, 3), [100, null, 90, 80, 120, null, 120]);
  });
  it("leaves monotone data alone", () => {
    const planned = [1, 2, 2, 3, 5];
    assert.deepEqual(clampPlannedMonotone(planned, 0), planned);
  });
});
