import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { distinctRoutes, journeySegments, routeKey } from "../lib/client/journey";
import type { ConnectionItinerary, ConnectionLeg } from "../lib/client/types";

const leg = (o: Partial<ConnectionLeg>): ConnectionLeg => ({
  line: "1", tripId: "1", headsign: "", fromStopId: "a", fromStopName: "", toStopId: "b", toStopName: "",
  departureTime: "", arrivalTime: "", departureSecs: 0, arrivalSecs: 0, durationMins: 0, stopsCount: 0, ...o,
});
const trip = (legs: ConnectionLeg[], o: Partial<ConnectionItinerary> = {}): ConnectionItinerary => ({
  type: legs.length > 1 ? "transfer" : "direct", departureTime: "", arrivalTime: "", departureSecs: 0, arrivalSecs: 0,
  totalDurationMins: 0, transfersCount: legs.length - 1, legs, ...o,
});
const H = 8 * 3600;

describe("journeySegments", () => {
  it("lays out access walk, rides, the transfer's walk and wait, egress walk", () => {
    const it2 = trip(
      [
        leg({ line: "T11", departureSecs: H, arrivalSecs: H + 18 * 60 }),
        leg({ line: "663", departureSecs: H + 24 * 60, arrivalSecs: H + 32 * 60, walkMins: 3 }),
      ],
      { accessWalkMins: 4, egressWalkMins: 2 },
    );
    assert.deepEqual(
      journeySegments(it2).map((s) => [s.kind, s.mins]),
      [["walk", 4], ["ride", 18], ["walk", 3], ["wait", 3], ["ride", 8], ["walk", 2]],
    );
  });

  it("a same-stop transfer is a wait only, a ride never rounds to 0", () => {
    const it2 = trip([
      leg({ departureSecs: H, arrivalSecs: H + 20 }),
      leg({ departureSecs: H + 5 * 60, arrivalSecs: H + 9 * 60 }),
    ]);
    assert.deepEqual(journeySegments(it2).map((s) => [s.kind, s.mins]), [["ride", 1], ["wait", 5], ["ride", 4]]);
  });
});

describe("distinctRoutes", () => {
  it("keeps the first itinerary of each route, in order, up to max", () => {
    const t7a = trip([leg({ line: "T7" })], { departureTime: "22:13" });
    const t20 = trip([leg({ line: "T20" })]);
    const t7b = trip([leg({ line: "T7" })], { departureTime: "22:43" });
    const xfer = trip([leg({ line: "T11" }), leg({ line: "663", fromStopId: "c", toStopId: "d" })]);
    assert.equal(routeKey(t7a), routeKey(t7b));
    assert.deepEqual(distinctRoutes([t7a, t20, t7b, xfer], 8), [t7a, t20, xfer]);
    assert.deepEqual(distinctRoutes([t7a, t20, t7b, xfer], 2), [t7a, t20]);
  });
});
