/**
 * Route-handler level regression for "course not begun" on REAL OnTime records
 * (test/fixtures/mzk-running-vehicles.json, captured 2026-10-02 22:54:42): the real GET handlers of
 * /api/stop/[designator]/departures, /api/trip_execution and /api/trip/[tripId] run against a faked
 * poller singleton (no network, no Next server). Fleet-tracker persistence is redirected to a temp dir
 * (support/tmp-output sets KB_OUTPUT_DIR) so the real output/ is never touched.
 */
import "./support/tmp-output"; // first: KB_OUTPUT_DIR (fleet history) -> a throw-away dir
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { MzkApi, MzkRunningVehicle } from "../lib/mzk-api";
import type { MzkPoller as MzkPollerType } from "../lib/mzk-poller";

type VehKey = "not_started_late" | "not_started_early" | "just_departed" | "running";
interface Fixture {
  vehicles: Record<VehKey, MzkRunningVehicle>;
  stopPoints: unknown[];
}
interface Row {
  trip_execution_id: string;
  static_time: string;
  time: string;
  time_diff: number;
  is_estimated: boolean;
  not_started?: boolean;
}
interface TripJson {
  not_started?: boolean;
  vehicle_trip_index?: number;
  trip: { times: Array<{ estimate?: { time_diff?: number } }> };
}
type RouteGet = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const fx = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "mzk-running-vehicles.json"), "utf-8"),
) as Fixture;
const V = fx.vehicles;
const NOW = Date.parse("2026-10-02T22:54:42+02:00"); // the fixture's capture time
const MIDNIGHT = Date.parse("2026-10-02T00:00:00+02:00");
const SINGLETON = Symbol.for("kb-gtfs.poller-singleton");

const realNow = Date.now;
const realCwd = process.cwd();
let tmp = "";
let departuresGet: RouteGet;
let tripExecutionGet: (req: Request) => Promise<Response>;
let tripStaticGet: RouteGet;

/** getRealtime departure row of one course at one stop of its running record (real OnTime shape). */
function rtRow(v: MzkRunningVehicle, idx: number) {
  const sp = v.stopPoints[idx];
  return {
    courseId: v.courseLoid,
    scheduledDepartureSec: Math.round((sp.scheduledDeparture - MIDNIGHT) / 1000),
    scheduledDeparture: sp.scheduledDeparture,
    realDeparture: sp.plannedDeparture, // OnTime's stop-level number == the running record's (verified on captured pairs)
    vehicleId: v.vehicleId,
    variantId: v.variantLoid,
    orderInCourse: idx,
    passed: false,
    lack: false,
    onStopPoint: idx === 0 && v.orderInCourse === 0,
    lineName: v.lineName,
    directionName: v.direction,
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-not-started-"));
  process.chdir(tmp); // BEFORE the lib modules load
  Date.now = () => NOW;
  const running = [V.not_started_late, V.not_started_early, V.just_departed, V.running];
  const rtBySymbol = new Map<string, ReturnType<typeof rtRow>[]>();
  for (const v of running) {
    v.stopPoints.forEach((sp, idx) => {
      const list = rtBySymbol.get(sp.symbol) ?? [];
      list.push(rtRow(v, idx));
      rtBySymbol.set(sp.symbol, list);
    });
  }
  const api = {
    fetchStops: async () => fx.stopPoints,
    fetchLines: async () => [{ id: 1, name: "29", longName: null, nightLine: false, lineType: "BUS" }],
    fetchVehicles: async () => [],
    fetchRunningVehicles: async () => running,
    fetchRealtime: async (symbol: string) => ({ stopPointSymbol: symbol, departures: rtBySymbol.get(symbol) ?? [] }),
    fetchRealCourse: async () => ({}),
  } as unknown as MzkApi;
  const { MzkPoller } = await import("../lib/mzk-poller");
  const mzkPoller: MzkPollerType = new MzkPoller(api);
  await mzkPoller.pollOnce();
  (globalThis as Record<symbol, unknown>)[SINGLETON] = {
    api: { fetchDepartures: async () => ({ rows: [] }) },
    poller: { stops: [], addCandidates() {}, kbPatternFor: () => null },
    mzkApi: api,
    mzkPoller,
    shapes: { wireId: () => null, status: () => "none", getMzkShape: async () => null, start() {} },
    startPromise: Promise.resolve(),
    signalsRegistered: true,
    lastStartFailAt: 0,
  };
  departuresGet = (await import("../app/api/stop/[designator]/departures/route")).GET as RouteGet;
  tripExecutionGet = (await import("../app/api/trip_execution/route")).GET;
  tripStaticGet = (await import("../app/api/trip/[tripId]/route")).GET as RouteGet;
});

after(() => {
  Date.now = realNow;
  delete (globalThis as Record<symbol, unknown>)[SINGLETON];
  process.chdir(realCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function rowOf(v: MzkRunningVehicle, stopIdx: number): Promise<Row> {
  const symbol = v.stopPoints[stopIdx].symbol;
  const res = await departuresGet(new Request(`http://t/api/stop/mzk:${symbol}/departures`), {
    params: Promise.resolve({ designator: `mzk:${symbol}` }),
  });
  const rows = ((await res.json()) as { rows: Row[] }).rows;
  const row = rows.find((r) => String(r.trip_execution_id).includes(String(v.courseLoid)));
  assert.ok(row, `no board row for ${v.vehicleId} at stop ${stopIdx}`);
  return row;
}

async function liveTrip(v: MzkRunningVehicle): Promise<TripJson> {
  const id = `mzk:${v.courseLoid}:${v.vehicleId}`;
  const res = await tripExecutionGet(new Request(`http://t/api/trip_execution?exec_id=${encodeURIComponent(id)}`));
  return (await res.json()) as TripJson;
}

describe("departures route", () => {
  it("not-started late bus: no estimate, earliest-possible time, flagged (first stop and a later stop)", async () => {
    const r0 = await rowOf(V.not_started_late, 0);
    assert.equal(r0.not_started, true);
    assert.equal(r0.is_estimated, false);
    assert.equal(r0.time_diff, 0);
    assert.equal(r0.time, "22:54"); // scheduled 22:54:00, now 22:54:42: the bus cannot leave before "now"
    const r5 = await rowOf(V.not_started_late, 5);
    assert.equal(r5.not_started, true);
    assert.equal(r5.is_estimated, false);
    assert.ok(r5.time >= r5.static_time, `lower bound ${r5.time} must not precede the schedule ${r5.static_time}`);
  });

  it("not-started early bus: the schedule, never OnTime's -60 s floor", async () => {
    const row = await rowOf(V.not_started_early, 3);
    assert.equal(row.not_started, true);
    assert.equal(row.time_diff, 0);
    assert.equal(row.time, row.static_time);
  });

  it("running bus keeps its estimate", async () => {
    const row = await rowOf(V.running, 5);
    assert.equal(row.not_started, undefined);
    assert.equal(row.is_estimated, true);
  });
});

describe("trip_execution + static trip routes", () => {
  it("live trip of a waiting bus carries no per-stop estimate and the flag", async () => {
    const j = await liveTrip(V.not_started_late);
    assert.equal(j.not_started, true);
    assert.ok(j.trip.times.length > 5);
    assert.ok(j.trip.times.every((t) => t.estimate === undefined));
    assert.equal(j.vehicle_trip_index, 0);
  });

  it("live trip of a running bus keeps estimates and has no flag", async () => {
    const j = await liveTrip(V.running);
    assert.equal(j.not_started, undefined);
    assert.ok(j.trip.times.every((t) => typeof t.estimate?.time_diff === "number"));
  });

  it("static (publicly cached) trip never embeds live estimates", async () => {
    for (const v of [V.running, V.not_started_late]) {
      const tripId = `mzk:${v.courseLoid}:${v.variantLoid}`;
      const res = await tripStaticGet(new Request(`http://t/api/trip/${tripId}`), { params: Promise.resolve({ tripId }) });
      assert.match(res.headers.get("cache-control") ?? "", /public/);
      const j = (await res.json()) as { times: Array<{ estimate?: unknown }> };
      assert.ok(j.times.length > 5);
      assert.ok(j.times.every((t) => t.estimate === undefined), v.vehicleId);
    }
  });
});
