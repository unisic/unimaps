import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDirection, placeVehicles, splitDirections } from "../lib/client/lineRoute";
import type { LineVariant, Vehicle } from "../lib/client/types";

/** stops "a".."z" on a north-south line, 0.01° apart */
const stop = (id: string) => ({ id, name: id.toUpperCase(), lat: 50 + (id.charCodeAt(0) - 97) * 0.01, lon: 19 });
const variant = (ids: string, trips: string[], start = 480): LineVariant => ({
  headsign: ids.at(-1)!.toUpperCase(),
  stops: [...ids].map(stop),
  times: trips.map((_, t) => [...ids].map((_, p) => start + t * 30 + p * 2)),
  trips,
});
const veh = (over: Partial<Vehicle>): Vehicle => ({
  id: "v",
  trip_id: "",
  route_id: "",
  line: "1",
  headsign: "",
  lat: 0,
  lon: 19,
  vehicle_type: 3,
  current_stop_sequence: null,
  at_stop: false,
  delay: 0,
  bearing: null,
  next_stop_name: null,
  next_stop_lat: null,
  next_stop_lon: null,
  timestamp: 0,
  updated_at: 0,
  ...over,
});

describe("line directions", () => {
  // there: a-b-c-d (busiest), back: h-g-f (other poles), a short-turn there: x-b-c, a depot run back: g-f
  const vs = [variant("abcd", ["t1", "t2", "t3"]), variant("hgf", ["r1", "r2"]), variant("xbc", ["s1"]), variant("gf", ["d1"])];

  it("splits by the stop order, not the headsign", () => {
    assert.deepEqual(splitDirections(vs), [
      [0, 2],
      [1, 3],
    ]);
  });

  it("keeps a loop and its variants as one direction", () => {
    assert.deepEqual(splitDirections([variant("abcda", ["l1"]), variant("abcd", ["l2"])]), [[0, 1]]);
  });

  it("merges a branch's own stops in before the stop it joins, with every course's departures", () => {
    const d = buildDirection(vs, [0, 2]);
    assert.deepEqual(
      d.rows.map((r) => [r.id, r.trunk]),
      [
        ["x", false],
        ["a", true],
        ["b", true],
        ["c", true],
        ["d", true],
      ],
    );
    assert.deepEqual(d.rowOf, [
      [1, 2, 3, 4],
      [0, 2, 3],
    ]);
    // b: the trunk's three courses plus the short-turn's; c is the short-turn's last stop (an arrival, left out)
    assert.deepEqual(d.rows[2].times, [482, 482, 512, 542]);
    assert.deepEqual(d.rows[3].times, [484, 514, 544]);
    assert.deepEqual(d.rows[4].times, []);
  });

  it("places a vehicle between its last and next stop by its fix, by trip (MZK course without the variant)", () => {
    const d = buildDirection(vs, [0, 2]);
    const beads = placeVehicles(vs, d, [
      veh({ id: "1", trip_id: "t2", next_stop_name: "C", next_stop_seq: 2, lat: 50.015 }),
      veh({ id: "2", trip_id: "s1", not_started: true }),
      veh({ id: "3", trip_id: "r1", next_stop_name: "F" }),
      veh({ id: "4", trip_id: "nope", next_stop_name: "C" }),
    ]);
    assert.deepEqual(
      beads.map((b) => [b.v.id, Math.round(b.at * 100) / 100]),
      [
        ["2", 0],
        ["1", 2.5],
      ],
    );
    const mzk = [{ ...vs[0], trips: ["mzk:77:3"] }];
    const md = buildDirection(mzk, [0]);
    const [b] = placeVehicles(mzk, md, [veh({ operator: "MZK", trip_id: "77", next_stop_name: "B", lat: 50.01 })]);
    assert.equal(b.at, 1);
  });
});
