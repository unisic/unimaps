import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { metersBetween } from "../lib/geo";
import {
  decodePolyline,
  encodePolyline,
  pointAt,
  preparePolyline,
  projectOnPolyline,
  projectStopsAlong,
  pruneSpurs,
  simplifyPolyline,
  slicePolyline,
  tangentBearing,
  type LatLng,
} from "../lib/shared/polyline";

/** Point `east` / `north` metres from (49.8, 19.0). */
const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];

describe("encode/decodePolyline", () => {
  it("matches Google's reference vector at precision 5", () => {
    const pts: LatLng[] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    assert.equal(encodePolyline(pts, 5), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    const back = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    back.forEach((p, i) => {
      assert.ok(Math.abs(p[0] - pts[i][0]) < 1e-9);
      assert.ok(Math.abs(p[1] - pts[i][1]) < 1e-9);
    });
  });

  it("round-trips precision 6 (the wire format), negatives and empty input", () => {
    const pts: LatLng[] = [P(0, 0), P(123.4, -56.7), [-33.123456, 151.654321], P(-5, 5)];
    const back = decodePolyline(encodePolyline(pts));
    assert.equal(back.length, pts.length);
    back.forEach((p, i) => {
      assert.ok(Math.abs(p[0] - pts[i][0]) < 1e-6);
      assert.ok(Math.abs(p[1] - pts[i][1]) < 1e-6);
    });
    assert.deepEqual(decodePolyline(encodePolyline([])), []);
  });

  it("decoding p6 data as p6 never lands 10x off (contract guard)", () => {
    const enc = encodePolyline([P(0, 0), P(100, 0)]);
    const [first] = decodePolyline(enc);
    assert.ok(Math.abs(first[0] - LAT0) < 1e-5);
  });
});

describe("preparePolyline", () => {
  it("cumulative length agrees with metersBetween and drops duplicates", () => {
    const pts = [P(0, 0), P(0, 0), P(300, 0), P(300, 400), [NaN, 1] as LatLng];
    const pl = preparePolyline(pts)!;
    assert.equal(pl.n, 3);
    const want =
      metersBetween(pts[0][0], pts[0][1], pts[2][0], pts[2][1]) +
      metersBetween(pts[2][0], pts[2][1], pts[3][0], pts[3][1]);
    assert.ok(Math.abs(pl.length - want) < 1e-6);
    assert.ok(Math.abs(pl.length - 700) < 1);
  });

  it("returns null for fewer than 2 usable points", () => {
    assert.equal(preparePolyline([P(0, 0)]), null);
    assert.equal(preparePolyline([P(0, 0), P(0, 0)]), null);
  });
});

describe("pointAt / tangentBearing", () => {
  const pl = preparePolyline([P(0, 0), P(300, 0), P(300, 400)])!;

  it("interpolates and clamps", () => {
    const a = pointAt(pl, 150);
    assert.ok(metersBetween(a.lat, a.lon, ...P(150, 0)) < 0.5);
    const b = pointAt(pl, 500);
    assert.ok(metersBetween(b.lat, b.lon, ...P(300, 200)) < 0.5);
    const c = pointAt(pl, -10);
    assert.ok(metersBetween(c.lat, c.lon, ...P(0, 0)) < 0.5);
    const d = pointAt(pl, 1e6);
    assert.ok(metersBetween(d.lat, d.lon, ...P(300, 400)) < 0.5);
  });

  it("heading east then north", () => {
    assert.ok(Math.abs(tangentBearing(pl, 100)! - 90) < 1);
    assert.ok(Math.abs(tangentBearing(pl, 500)! - 0) < 1);
  });
});

describe("projectOnPolyline", () => {
  // out-and-back: east 500 m, then back west 10 m north of the outbound leg
  const pl = preparePolyline([P(0, 0), P(500, 0), P(500, 10), P(0, 10)])!;

  it("respects the window so the opposite leg can't steal the fix", () => {
    const outbound = projectOnPolyline(pl, ...P(200, 6), 0, 500)!;
    assert.ok(Math.abs(outbound.s - 200) < 1);
    const back = projectOnPolyline(pl, ...P(200, 4), 510, pl.length)!;
    assert.ok(Math.abs(back.s - 810) < 1);
  });

  it("hint picks among near-equal candidates", () => {
    const p = projectOnPolyline(pl, ...P(200, 5), 0, Infinity, { hint: 800 })!;
    assert.ok(Math.abs(p.s - 810) < 1);
    const q = projectOnPolyline(pl, ...P(200, 5), 0, Infinity, { hint: 150 })!;
    assert.ok(Math.abs(q.s - 200) < 1);
  });

  it("returns null for an empty window", () => {
    assert.equal(projectOnPolyline(pl, ...P(0, 0), 2000, 3000), null);
  });
});

describe("projectStopsAlong", () => {
  it("is monotone, handles loops and far/null stops", () => {
    // square loop starting and ending at the origin
    const pl = preparePolyline([P(0, 0), P(400, 0), P(400, 400), P(0, 400), P(0, 0)])!;
    const s = projectStopsAlong(pl, [P(0, 3), P(400, 200), null, P(5000, 5000), P(0, 2)]);
    assert.ok(Math.abs(s[0]! - 0) < 5);
    assert.ok(Math.abs(s[1]! - 600) < 1);
    assert.equal(s[2], null);
    assert.equal(s[3], null);
    assert.ok(Math.abs(s[4]! - 1600) < 5, `loop end got ${s[4]}`);
  });

  it("out-and-back: the return-direction stop gets the later distance", () => {
    const pl = preparePolyline([P(0, 0), P(500, 0), P(0, 0)])!;
    const s = projectStopsAlong(pl, [P(100, 5), P(500, 0), P(100, -5)]);
    assert.ok(Math.abs(s[0]! - 100) < 1);
    assert.ok(Math.abs(s[1]! - 500) < 1);
    assert.ok(Math.abs(s[2]! - 900) < 1);
  });
});

describe("simplify / pruneSpurs / slice", () => {
  it("Douglas-Peucker keeps endpoints and drops collinear points", () => {
    const pts = [P(0, 0), P(100, 0.5), P(200, 0), P(300, 0)];
    assert.deepEqual(simplifyPolyline(pts, 2), [pts[0], pts[3]]);
    const corner = [P(0, 0), P(100, 0), P(100, 100)];
    assert.equal(simplifyPolyline(corner, 2).length, 3);
  });

  it("removes a short out-and-back stub but keeps a protected terminus stub", () => {
    const pts = [P(0, 0), P(200, 0), P(200, 80), P(203, 2), P(400, 0)];
    const pruned = pruneSpurs(pts);
    assert.deepEqual(pruned, [pts[0], pts[1], pts[3], pts[4]]);
    assert.ok(!pruned.some((p) => p === pts[2]));
    const kept = pruneSpurs(pts, [P(200, 80)]);
    assert.equal(kept.length, pts.length);
  });

  it("slices between along-distances", () => {
    const pl = preparePolyline([P(0, 0), P(300, 0), P(300, 400)])!;
    const part = slicePolyline(pl, 100, 500);
    assert.equal(part.length, 3);
    assert.ok(metersBetween(...part[0], ...P(100, 0)) < 0.5);
    assert.ok(metersBetween(...part[2], ...P(300, 200)) < 0.5);
  });
});
