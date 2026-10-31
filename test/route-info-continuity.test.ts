/**
 * kbDistAlong on out-and-back patterns: continuity (the previous poll's dist_m) beats a stale upstream window.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { kbAheadM, kbDistAlong } from "../lib/route-info";
import type { ShapeGeometry } from "../lib/shape-store";
import { decodePolyline, preparePolyline, type LatLng } from "../lib/shared/polyline";

const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];

describe("kbDistAlong — continuity on an out-and-back", () => {
  // 1 km east, back along the same road (10 m north of it); stops 0, 500, 1000 (apex), 1510, 2010
  const pl = preparePolyline([P(0, 0), P(1000, 0), P(1000, 10), P(0, 10)])!;
  const geom: ShapeGeometry = { pl, stops: [0, 500, 1000, 1510, 2010], rev: "abcdef", src: "osrm" };
  const near = (got: number | null, want: number, tol = 1) => assert.ok(got !== null && Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

  it("stale vti (stuck before the apex) + the hint on the return leg: the return leg stays the return leg", () => {
    // bus is on the way back at x=700 (s=1310); upstream still says "last stop 1 (s=500), next 2 (s=1000)": its window
    // [400, 1100] contains the OUTBOUND twin of that position (s=700, 5 m away) but not the return leg
    near(kbDistAlong(geom, ...P(700, 5), 1, 2, 1250), 1310);
    // without the hint upstream's window is all there is -> the outbound twin (the documented cold-start ambiguity)
    near(kbDistAlong(geom, ...P(700, 5), 1, 2), 700);
  });

  it("a fix beyond the forward window falls back to upstream's window (and a wider window accepts it)", () => {
    // hint 0, fix at x=900 outbound: 900 m ahead of the hint
    near(kbDistAlong(geom, ...P(900, 5), 1, 2, 0), 900); // window [-60, 500] misses it -> vti window [400, 1100]
    near(kbDistAlong(geom, ...P(900, 5), 1, 2, 0, { aheadM: 1500 }), 900);
  });

  it("the forward window never walks the bus back more than GPS jitter", () => {
    near(kbDistAlong(geom, ...P(290, 5), 0, 1, 300), 290); // 10 m back: jitter
    // 200 m back is not in [hint-60, ...]: upstream's window decides
    near(kbDistAlong(geom, ...P(100, 5), 0, 1, 300), 100);
  });

  it("no hint, no vti: strict whole-line search (<= 40 m)", () => {
    assert.equal(kbDistAlong(geom, ...P(300, 400), null, null), null);
    near(kbDistAlong(geom, ...P(300, 5), null, null), 300);
  });
});

describe("kbDistAlong: real U-turn (test/fixtures/route-info-uturn-live.json)", () => {
  // GZM 107_5003, line 707: the bus drove on steadily, the old closest-to-hint tie-break kept the outbound twin
  // and walked dist_m back 7468 -> 7359 (one poll per step) before it jumped to 7691
  const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "route-info-uturn-live.json"), "utf8")) as {
    poly: string;
    stops: number[];
    fixes: [number, number, number, number, number][];
  };
  const geom: ShapeGeometry = { pl: preparePolyline(decodePolyline(fx.poly, 6))!, stops: fx.stops, rev: "d8b925", src: "osrm" };

  it("the chain never steps back more than GPS jitter", () => {
    let d: number | undefined;
    let at: number | null = null;
    for (const [lat, lon, vti, next, fixAt] of fx.fixes) {
      const got = kbDistAlong(geom, lat, lon, vti, next, d, { aheadM: kbAheadM(at === null ? 0 : fixAt - at) });
      assert.ok(got !== null, `no chainage at ${fixAt}`);
      if (d !== undefined) assert.ok(got >= d - 15, `${fixAt}: ${d} -> ${got}`);
      d = got;
      at = fixAt;
    }
  });
});

describe("kbAheadM", () => {
  it("500 m at the normal poll cadence, +30 m per second of gap, capped at 2 km", () => {
    assert.equal(kbAheadM(0), 500);
    assert.equal(kbAheadM(12), 510); // 30*12 + 150
    assert.equal(kbAheadM(30), 1050);
    assert.equal(kbAheadM(45), 1500);
    assert.equal(kbAheadM(600), 2000); // gap is capped at 90 s, window at 2 km
  });
  it("garbage gaps (clock steps) fall back to the base window", () => {
    assert.equal(kbAheadM(-5), 500);
    assert.equal(kbAheadM(Number.NaN), 500);
  });
});
