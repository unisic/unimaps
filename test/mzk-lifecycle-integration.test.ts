/**
 * MzkPoller + trip builder + fleet tracker on REAL OnTime records (22:54:42 snapshot of
 * getRunningVehicles.json, test/fixtures/mzk-running-vehicles.json): a bus waiting at the first
 * stop must not publish OnTime's placeholder delay anywhere.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { FleetTracker as FleetTrackerType } from "../lib/fleet-tracker";
import type { MzkApi, MzkRunningVehicle } from "../lib/mzk-api";

// The fleet tracker restores/saves output/fleet-history-<day>.json relative to process.cwd() when its
// module loads: load everything from a temp cwd so this test never reads or clobbers the real brygady history.
const realCwd = process.cwd();
let tmpCwd = "";
let FleetTracker: typeof import("../lib/fleet-tracker").FleetTracker;
let MzkPoller: typeof import("../lib/mzk-poller").MzkPoller;
let buildMzkTimes: typeof import("../lib/mzk-trip").buildMzkTimes;
let vehicleExtras: typeof import("../lib/route-info").vehicleExtras;
let vehicleToJson: typeof import("../lib/poller").vehicleToJson;
before(async () => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lifecycle-"));
  process.chdir(tmpCwd);
  ({ FleetTracker } = await import("../lib/fleet-tracker"));
  ({ MzkPoller } = await import("../lib/mzk-poller"));
  ({ buildMzkTimes } = await import("../lib/mzk-trip"));
  ({ vehicleExtras } = await import("../lib/route-info"));
  ({ vehicleToJson } = await import("../lib/poller"));
});
after(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

const fx = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "mzk-running-vehicles.json"), "utf-8"),
) as {
  vehicles: Record<"not_started_late" | "not_started_early" | "just_departed" | "running", MzkRunningVehicle>;
  stopPoints: Array<Record<string, unknown>>;
};
const V = fx.vehicles;

function fakeApi(running: MzkRunningVehicle[]): MzkApi {
  return {
    fetchStops: async () => fx.stopPoints,
    fetchLines: async () => [{ id: 1, name: "10", longName: null, nightLine: false, lineType: "BUS" }],
    fetchVehicles: async () => [],
    fetchRunningVehicles: async () => running,
  } as unknown as MzkApi;
}

describe("fixture sanity (real OnTime placeholder)", () => {
  it("every stop of a not-started course carries scheduled + delaySec", () => {
    for (const v of [V.not_started_late, V.not_started_early]) {
      for (const sp of v.stopPoints) {
        // delaySec is whole seconds, plannedDeparture carries milliseconds
        assert.ok(Math.abs((sp.plannedDeparture - sp.scheduledDeparture) / 1000 - v.delaySec) < 2, v.vehicleId);
      }
    }
    assert.equal(V.not_started_early.delaySec, -60); // the floor
    assert.ok(V.not_started_late.delaySec > 0);
  });
});

describe("MzkPoller", () => {
  it("publishes delay null + notStarted for buses waiting at the first stop, real delay otherwise", async () => {
    const poller = new MzkPoller(fakeApi([V.not_started_late, V.not_started_early, V.just_departed, V.running]));
    await poller.pollOnce();
    const get = (v: MzkRunningVehicle) => poller.positions.get(`mzk:${v.courseLoid}:${v.vehicleId}`)!;

    for (const v of [V.not_started_late, V.not_started_early]) {
      const p = get(v);
      assert.equal(p.notStarted, true, v.vehicleId);
      assert.equal(p.delay, null, v.vehicleId);
      assert.equal(p.currentStopSequence, 0);
    }
    assert.equal(get(V.just_departed).notStarted, false);
    assert.equal(get(V.just_departed).delay, Math.round(V.just_departed.delaySec));
    assert.equal(get(V.running).notStarted, false);
    assert.equal(get(V.running).delay, Math.round(V.running.delaySec));

    // wire: vehicleToJson (Python port) untouched -> delay null; the flag rides on vehicleExtras
    const p = get(V.not_started_late);
    assert.equal(vehicleToJson(p).delay, null);
    assert.equal(vehicleExtras(p, null, 0).not_started, true);
    assert.equal(vehicleExtras(get(V.running), null, 0).not_started, undefined);
  });
});

describe("buildMzkTimes", () => {
  it("no per-stop estimate for a course that has not begun, estimates for a running one", () => {
    const waiting = buildMzkTimes(V.not_started_late, { live: true, notStarted: true });
    assert.ok(waiting.every((t) => !("estimate" in t)));
    assert.equal(waiting[0].departure_time.length, 5);
    const running = buildMzkTimes(V.running, { live: true, notStarted: false });
    assert.ok(running.every((t) => "estimate" in t));
  });

  it("static callers (cached for minutes) never carry live estimates", () => {
    assert.ok(buildMzkTimes(V.running, { live: false, notStarted: false }).every((t) => !("estimate" in t)));
  });

  it("running course: stops ahead are forward-monotone (screenshot B dip)", () => {
    const v = structuredClone(V.not_started_late);
    v.orderInCourse = 0;
    // stops 0..4 estimated +13 min, stop 5 only +7 min (impossible: it precedes stop 4)
    v.stopPoints = v.stopPoints.slice(0, 7).map((sp, i) => ({
      ...sp,
      plannedDeparture: sp.scheduledDeparture + (i === 5 ? 7 : 13) * 60_000,
    }));
    const times = buildMzkTimes(v, { live: true, notStarted: false });
    const diffs = times.map((t) => (t as { estimate: { time_diff: number } }).estimate.time_diff);
    assert.ok(diffs[5] >= diffs[4] + (v.stopPoints[4].scheduledDeparture - v.stopPoints[5].scheduledDeparture) / 1000);
    const planned = v.stopPoints.map((sp, i) => sp.scheduledDeparture + diffs[i] * 1000);
    for (let i = 1; i < planned.length; i++) assert.ok(planned[i] >= planned[i - 1], `stop ${i}`);
  });
});

describe("FleetTracker (brygady)", () => {
  const asRunning = (v: MzkRunningVehicle) => v as unknown as Parameters<FleetTrackerType["updateFromRunningVehicles"]>[0][number];

  it("a not-started course shows no delay, is not counted in punctuality and is not archived as history", () => {
    const t = new FleetTracker();
    const late = { ...structuredClone(V.not_started_late), delaySec: 14 * 60 }; // the +14 min of screenshot B
    t.updateFromRunningVehicles([asRunning(late)]);
    const d = t.getVehicleDetail(late.vehicleId)!;
    assert.equal(d.currentCourse?.notStarted, true);
    assert.equal(d.currentCourse?.delaySec, 0);
    assert.equal(d.currentCourse?.currentStopIndex, 0);
    assert.equal(d.currentCourse?.stops?.every((s) => s.plannedTime === s.scheduledTime), true);
    const item = t.getFleetSummary({ status: "active" }).find((x) => x.sideNumber === late.vehicleId)!;
    assert.equal(item.delaySec, undefined);
    assert.equal(item.notStarted, true);
    assert.equal(t.getStats().onTimePercentage, 100); // nobody counted -> neutral, not "0 % punctual"
    assert.equal(t.getStats().averageDelaySec, 0);
    assert.equal(t.getStats().activeCount, 1);

    // the bus is reassigned before it ever starts: that course must not become a "completed" history row
    const next = { ...structuredClone(V.running), vehicleId: late.vehicleId, courseLoid: 999_001 };
    t.updateFromRunningVehicles([asRunning(next)]);
    assert.equal(t.getVehicleDetail(late.vehicleId)!.todayCourses.some((c) => c.courseLoid === late.courseLoid), false);
  });

  it("a running vehicle still reports its delay (+ counted)", () => {
    const t = new FleetTracker();
    const run = { ...structuredClone(V.running), delaySec: 120 };
    t.updateFromRunningVehicles([asRunning(run)]);
    const d = t.getVehicleDetail(run.vehicleId)!;
    assert.equal(d.currentCourse?.notStarted, false);
    assert.equal(d.currentCourse?.delaySec, 120);
  });

  it("null plannedDeparture never renders as 00:00", () => {
    const t = new FleetTracker();
    const v = structuredClone(V.running);
    v.stopPoints = v.stopPoints.map((sp, i) => (i < 2 ? { ...sp, plannedDeparture: null as unknown as number } : sp));
    t.updateFromRunningVehicles([asRunning(v)]);
    const stops = t.getVehicleDetail(v.vehicleId)!.currentCourse!.stops!;
    assert.ok(stops.slice(0, 2).every((s) => s.plannedTime === s.scheduledTime && s.plannedTime !== "00:00"));
  });
});
