/**
 * Per-vehicle route math (fix time, cruise speed, along-route distance, wire
 * extras) and the MZK geometry/stop-index helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mzkRemapDist, mzkShapeFromCourseDetails, mzkStopIndices } from "../lib/mzk-shape";
import { kbNextStopIndex } from "../lib/poller";
import { estimateFixAt, kbDistAlong, nextSpeed, vehicleExtras } from "../lib/route-info";
import type { ShapeGeometry } from "../lib/shape-store";
import { preparePolyline, type LatLng } from "../lib/shared/polyline";
import type { VehiclePos } from "../lib/types";

const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];

describe("estimateFixAt", () => {
  it("first sight = poll time; unchanged keeps the old estimate; change = window midpoint", () => {
    assert.equal(estimateFixAt(undefined, 1000, true), 1000);
    assert.equal(estimateFixAt({ fixAt: 990, updatedAt: 1000 }, 1010, false), 990);
    assert.equal(estimateFixAt({ updatedAt: 1000 }, 1010, false), 1000);
    assert.equal(estimateFixAt({ fixAt: 990, updatedAt: 1000 }, 1010, true), 1005);
    // long gaps are capped
    assert.equal(estimateFixAt({ updatedAt: 1000 }, 1300, true, 30), 1285);
  });
});

describe("nextSpeed", () => {
  it("takes the first moving pair directly, then smooths", () => {
    assert.equal(nextSpeed(null, 120, 120, 12), 10);
    const v = nextSpeed(10, 120, 60, 12)!;
    assert.ok(v < 10 && v > 5);
  });

  it("ignores dwell pairs, slow creeps, GPS jumps and bad Δt", () => {
    assert.equal(nextSpeed(10, 3, 150, 12), null); // previous fix was standing
    assert.equal(nextSpeed(10, 120, 10, 12), null); // creeping, not cruising
    assert.equal(nextSpeed(10, 120, 150, 12, 40), null); // prev fix sat still 40 s
    assert.equal(nextSpeed(10, 120, 600, 10), null); // 60 m/s jump
    assert.equal(nextSpeed(10, 120, 150, 1), null);
    assert.equal(nextSpeed(10, 120, 150, 120), null);
    assert.equal(nextSpeed(10, 120, 150, 12, 0, true), null); // braking into / leaving a stop zone
    // a first-ever fix has no history: its displacement spans an unknown time
    assert.equal(nextSpeed(null, undefined, 150, 12), null);
  });

  it("clamps to 25 m/s", () => {
    assert.equal(nextSpeed(null, 100, 300, 10), 25);
  });
});

describe("kbDistAlong", () => {
  // out-and-back: 1 km east, back 10 m north of it; stops at 0, 500, 1000(apex), 1510, 2010
  const pl = preparePolyline([P(0, 0), P(1000, 0), P(1000, 10), P(0, 10)])!;
  const geom: ShapeGeometry = { pl, stops: [0, 500, 1000, 1510, 2010], rev: "abcdef", src: "osrm" };

  it("searches between the last reached and the next stop", () => {
    const out = kbDistAlong(geom, ...P(300, 5), 0, 1);
    assert.ok(out !== null && Math.abs(out - 300) < 1, `got ${out}`);
    const back = kbDistAlong(geom, ...P(300, 5), 3, 4);
    assert.ok(back !== null && Math.abs(back - 1710) < 1, `got ${back}`);
  });

  it("off-route → null", () => {
    assert.equal(kbDistAlong(geom, ...P(300, 400), 0, 1), null);
  });
});

describe("vehicleExtras", () => {
  const v = {
    fixAt: 1000.04,
    nextStopSeq: 3,
    speed: 9.87,
    speedAt: 995,
    shapeKey: "kb:0123456789ab",
    distM: 412.6,
    distRev: "abcdef",
  } as VehiclePos;
  const shapes = { wireId: (k: string) => `${k}.abcdef` };

  it("emits only known fields, dist gated on the served rev", () => {
    assert.deepEqual(vehicleExtras(v, shapes, 1000), {
      fix_at: 1000,
      next_stop_seq: 3,
      speed: 9.9,
      shape: "kb:0123456789ab.abcdef",
      dist_m: 413,
    });
    assert.equal(vehicleExtras({ ...v, distRev: "000000" }, shapes, 1000).dist_m, undefined);
    assert.equal(vehicleExtras(v, { wireId: () => null }, 1000).shape, undefined);
    assert.equal(vehicleExtras(v, shapes, 1200).speed, undefined); // stale speed
    assert.deepEqual(vehicleExtras({} as VehiclePos, null, 0), {});
  });

  it("never throws", () => {
    const bad = { wireId: () => { throw new Error("x"); } };
    assert.deepEqual(vehicleExtras(v, bad, 1000), {});
  });

  it("GPS-progress extras (delay_src, geo_seq) only while upstream's stop index is stale", () => {
    assert.equal(vehicleExtras(v, shapes, 1000).geo_seq, undefined);
    assert.equal(vehicleExtras(v, shapes, 1000).delay_src, undefined);
    const stale = vehicleExtras({ ...v, delaySrc: "gps", geoLastSeq: 27 }, shapes, 1000);
    assert.equal(stale.delay_src, "gps");
    assert.equal(stale.geo_seq, 27);
    assert.equal(vehicleExtras({ ...v, delaySrc: "unknown" }, shapes, 1000).delay_src, "unknown");
    assert.equal(vehicleExtras({ ...v, geoLastSeq: -1 }, shapes, 1000).geo_seq, undefined, "before the first stop: no hint");
  });
});

describe("kbNextStopIndex (parsePosition parity)", () => {
  it("ndi first, else vti; skips the stop being served", () => {
    assert.equal(kbNextStopIndex(2, 3, false, 10), 3);
    assert.equal(kbNextStopIndex(2, null, false, 10), 2);
    assert.equal(kbNextStopIndex(2, null, true, 10), 3);
    assert.equal(kbNextStopIndex(2, 2, true, 10), 3);
    assert.equal(kbNextStopIndex(9, null, true, 10), null);
    assert.equal(kbNextStopIndex(null, null, false, 10), null);
    assert.equal(kbNextStopIndex(2, 99, false, 10), 2);
  });
});

describe("MZK helpers", () => {
  const ll = ([latitude, longitude]: LatLng) => ({ latitude, longitude });
  const course = {
    stopPoints: [P(0, 0), P(500, 0), P(1000, 0)].map(ll),
    segments: [{ nodes: [P(0, 0), P(250, 30), P(500, 0)].map(ll) }, { nodes: [P(500, 0), P(1000, 0)].map(ll) }],
  };

  it("segment boundaries become the stop distances", () => {
    const r = mzkShapeFromCourseDetails(course)!;
    assert.equal(r.pts.length, 4);
    assert.equal(r.stops[0], 0);
    const seg1 = Math.hypot(250, 30) * 2;
    assert.ok(Math.abs(r.stops[1]! - seg1) < 1);
    assert.ok(Math.abs(r.stops[2]! - (seg1 + 500)) < 1);
    assert.equal(mzkShapeFromCourseDetails({}), null);
  });

  it("reachedMeters maps piecewise into our metric", () => {
    const stops = [0, 504, 1004];
    assert.equal(mzkRemapDist(250, [0, 500, 500], stops), 252);
    assert.equal(mzkRemapDist(750, [0, 500, 500], stops), 754);
    assert.equal(mzkRemapDist(5000, [0, 500, 500], stops), 1004);
    assert.equal(mzkRemapDist(250, [0, null, 500], stops), null);
  });

  it("stop indices: served stop, upstream next, else after the last passed", () => {
    const sp = [{ symbol: "a" }, { symbol: "b" }, { symbol: "c" }, { symbol: "d" }];
    assert.deepEqual(mzkStopIndices({ onStopPoint: "b", orderInCourse: 1, stopPoints: sp }), { served: 1, next: 2 });
    assert.deepEqual(mzkStopIndices({ onStopPoint: "c", orderInCourse: 1, stopPoints: sp }), { served: 2, next: 3 });
    assert.deepEqual(mzkStopIndices({ orderInCourse: 1, nearestSymbolOrderNo: 2, stopPoints: sp }), { served: null, next: 2 });
    // bogus nearest (behind the bus) is ignored
    assert.deepEqual(mzkStopIndices({ orderInCourse: 2, nearestSymbolOrderNo: 1, stopPoints: sp }), { served: null, next: 3 });
    assert.deepEqual(mzkStopIndices({ orderInCourse: 3, stopPoints: sp }), { served: null, next: null });
    assert.deepEqual(mzkStopIndices({ stopPoints: [] }), { served: null, next: null });
  });
});
