/**
 * findActiveStop (the client fallback when the server sent no dist_m) on twin stops and on patterns
 * that revisit the very same stop object. Fixture: REAL line-120 loop capture (2026-10-02).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { findActiveStop } from "../lib/client/geo";

interface Snap { t: number; lat: number; lon: number; vti: number; ndi: number; at: boolean }
interface Fixture { stops: Array<{ i: number; lat: number; lon: number }>; snapshots: Snap[] }
const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "line120-loop-capture.json"), "utf8")) as Fixture;
const stops = fx.stops.map((s) => ({ lat: s.lat, lon: s.lon }));

describe("findActiveStop — twin stops (real line-120 loop)", () => {
  it("while upstream says AT stop vti the answer is vti, not the opposite-side twin that happens to be nearer", () => {
    const wrong: string[] = [];
    let n = 0;
    for (const s of fx.snapshots) {
      if (!s.at) continue;
      n++;
      const r = findActiveStop(stops, { lat: s.lat, lon: s.lon, at_stop: true, current_stop_sequence: s.vti }, s.vti);
      // at the last stop of the trip several fixes sit at the terminus: it is vti there too
      if (r.index !== s.vti || !r.isAtStop) wrong.push(`${new Date(s.t).toISOString()} upstream AT ${s.vti} -> ${r.index}${r.isAtStop ? "@" : ""}`);
    }
    assert.ok(n > 30, "the capture has many AT snapshots");
    assert.deepEqual(wrong, []);
  });

  it("no live at_stop (vehicle dropped off the feed): of two poles about as near, the one nearest the held index", () => {
    // synthetic out-and-back: stop 3 is the return-side twin of stop 1, 15 m across the road
    const LAT0 = 49.8;
    const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
    const P = (east: number, north: number) => ({ lat: LAT0 + north / 111_320, lon: 19 + east / KX });
    const twins = [P(0, 0), P(500, 0), P(1000, 0), P(500, 15), P(0, 15)];
    const bus = P(500, 4); // 4 m from stop 1, 11 m from stop 3
    assert.equal(findActiveStop(twins, { ...bus }, 3).index, 3); // held index: the return visit
    assert.equal(findActiveStop(twins, { ...bus }, 1).index, 1); // held index: the outbound visit
  });
});

describe("findActiveStop — a pattern that revisits the very same stop object (D.A. at both ends)", () => {
  const DA = { lat: 49.83023, lon: 19.04275 };
  const loop = [DA, { lat: 49.826, lon: 19.04 }, { lat: 49.82, lon: 19.03 }, { lat: 49.81, lon: 19.02 }, { lat: 49.82, lon: 19.045 }, DA];
  it("at the terminus the index is the last one, not 0 (the lowest index of equally near stops)", () => {
    assert.equal(findActiveStop(loop, { lat: DA.lat, lon: DA.lon, at_stop: true, current_stop_sequence: 5 }, 5).index, 5);
    // vehicle gone from the feed: no at_stop, the held index is all there is
    assert.equal(findActiveStop(loop, { lat: DA.lat, lon: DA.lon }, 5).index, 5);
  });
  it("at the start it is still 0", () => {
    assert.equal(findActiveStop(loop, { lat: DA.lat, lon: DA.lon, at_stop: true, current_stop_sequence: 0 }, 0).index, 0);
    assert.equal(findActiveStop(loop, { lat: DA.lat, lon: DA.lon }, 0).index, 0);
  });
});
