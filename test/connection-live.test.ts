import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConnectionLeg, Vehicle } from "../lib/client/types";
import { alightSoon, indexVehicles, legVehicle, transferAtRisk } from "../lib/client/vehicleIndex";

const leg = (o: Partial<ConnectionLeg>): ConnectionLeg => ({
  line: "1", tripId: "1", headsign: "", fromStopId: "", fromStopName: "", toStopId: "", toStopName: "",
  departureTime: "", arrivalTime: "", departureSecs: 0, arrivalSecs: 0, durationMins: 0, stopsCount: 0, ...o,
});
// 2026-10-29 08:00 Europe/Warsaw (CET, UTC+1)
const AT_8 = Date.UTC(2026, 9, 29, 7) / 1000;
const veh = (o: Partial<Vehicle>) => ({ id: "x", delay: 120, updated_at: AT_8, ...o }) as Vehicle;

describe("legVehicle", () => {
  const idx = indexVehicles([
    veh({ id: "kb", operator: "KB", sched_trip_id: "50763989", delay: 180 }),
    veh({ id: "mzk", operator: "MZK", trip_id: "777" }),
    veh({ id: "gzm", operator: "GZM", sched_trip_id: "gzm:ab_1" }),
  ]);
  const at = { departureSecs: 8 * 3600 + 600 };

  it("matches every operator's trip id space", () => {
    assert.equal(legVehicle(leg({ ...at, operator: "KB", tripId: "50763989_KB_WEEKDAY" }), "2026-10-29", idx)?.id, "kb");
    assert.equal(legVehicle(leg({ ...at, operator: "MZK", tripId: "mzk:777:3" }), "2026-10-29", idx)?.id, "mzk");
    assert.equal(legVehicle(leg({ ...at, operator: "GZM", tripId: "gzm:ab_1" }), "2026-10-29", idx)?.id, "gzm");
  });

  it("tomorrow's run of the same trip is not today's bus", () => {
    assert.equal(legVehicle(leg({ ...at, operator: "KB", tripId: "50763989" }), "2026-10-30", idx), null);
    assert.equal(legVehicle(leg({ ...at, operator: "KB", tripId: "50763989" }), undefined, idx), null);
  });
});

describe("transferAtRisk", () => {
  const legs = [leg({ arrivalSecs: 1000 }), leg({ departureSecs: 1300, walkMins: 2 })];

  it("the plan alone never flags a transfer", () => {
    assert.equal(transferAtRisk(legs, [null, null]), false);
  });

  it("a late feeder or an early connection breaks it", () => {
    // 300 s between the buses, 120 s of it on foot: 180 s to spare
    assert.equal(transferAtRisk(legs, [240, null]), true);
    assert.equal(transferAtRisk(legs, [180, null]), false);
    assert.equal(transferAtRisk(legs, [60, -180]), true);
    assert.equal(transferAtRisk(legs, [300, 300]), false, "both late by the same: the next bus waits for nobody but leaves later");
  });
});

describe("alightSoon", () => {
  // the last pole at 49.8, 19.0; the bus's fix is AT_8 = 08:00, the leg arrives 08:10
  const stop = (lat: number) => ({ stopId: "", stopName: "", arrivalTime: "", departureTime: "", lat, lon: 19 });
  const l = leg({ arrivalSecs: 8 * 3600 + 600, stops: [stop(49.7), stop(49.8)] });
  const D = "2026-10-29";

  it("the bus heading for the last pole fires; a twin pole 20 m away does not", () => {
    assert.equal(alightSoon(l, D, veh({ lat: 49.7, lon: 19, next_stop_lat: 49.8, next_stop_lon: 19 })), true);
    assert.equal(alightSoon(l, D, veh({ lat: 49.7, lon: 19, next_stop_lat: 49.80018, next_stop_lon: 19 })), false);
  });

  it("a frozen stop index: near the pole fires only in the last 3 min before the delayed arrival", () => {
    const near = { lat: 49.798, lon: 19, next_stop_lat: 49.7, next_stop_lon: 19 };
    assert.equal(alightSoon(l, D, veh({ ...near, delay: 0 })), false, "10 min early: the way out of a loop");
    assert.equal(alightSoon(l, D, veh({ ...near, delay: -420 })), true);
    assert.equal(alightSoon(l, D, veh({ ...near, lat: 49.79, delay: -420 })), false, "1.1 km away");
    assert.equal(alightSoon(l, undefined, veh({ ...near, delay: -420 })), false);
  });
});
