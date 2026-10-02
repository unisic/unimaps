import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildKbPattern, rawTripId, readGtfsPatternSeeds, type ResolvedStop } from "../lib/shape-patterns";

const STOPS: Record<number, ResolvedStop> = {
  1: { id: "1", lat: 49.8, lon: 19.0 },
  2: { id: "2", lat: 49.81, lon: 19.01 },
  3: { id: "3", lat: 49.82, lon: 19.02 },
  21181: { id: "21181", lat: 49.703, lon: 19.002 },
  // inside the Piastowska detour trigger area
  10: { id: "10", lat: 49.82, lon: 19.035 },
  11: { id: "11", lat: 49.83, lon: 19.05 },
};
const resolve = (t: Record<string, unknown>): ResolvedStop | null =>
  typeof t.designator === "number" ? STOPS[t.designator] ?? null : null;
const times = (...ds: Array<number | null>) => ds.map((d) => (d === null ? {} : { designator: d }));

describe("buildKbPattern", () => {
  it("is stable and keeps one slot per times entry", () => {
    const a = buildKbPattern(times(1, 2, 3), "103", "X", resolve)!;
    const b = buildKbPattern(times(1, 2, 3), "103", "X", resolve)!;
    assert.match(a.key, /^kb:[0-9a-f]{12}$/);
    assert.equal(a.key, b.key);
    assert.equal(a.wpSig, b.wpSig);
    assert.equal(a.stopPts.length, 3);
  });

  it("unresolved entries become null slots and change the key", () => {
    const p = buildKbPattern(times(1, null, 3), "103", "X", resolve)!;
    assert.equal(p.stopPts[1], null);
    assert.equal(p.waypoints.length, 2);
    assert.notEqual(p.key, buildKbPattern(times(1, 2, 3), "103", "X", resolve)!.key);
  });

  it("different lines on the same stops share a key; an applied detour splits it", () => {
    const plain = buildKbPattern(times(1, 2, 3), "103", "X", resolve)!;
    assert.equal(plain.key, buildKbPattern(times(1, 2, 3), "999", "Y", resolve)!.key);
    const viaArea = buildKbPattern(times(1, 10, 11), "999", "Y", resolve)!;
    const detoured = buildKbPattern(times(1, 10, 11), "121", "HULANKA", resolve)!;
    assert.notEqual(viaArea.key, detoured.key);
    assert.ok(detoured.waypoints.length > viaArea.waypoints.length);
  });

  it("applies stop-pole routing adjustments to waypoints only", () => {
    const p = buildKbPattern(times(1, 21181), "999", "", resolve)!;
    assert.deepEqual(p.stopPts[1], [49.703, 19.002]);
    assert.deepEqual(p.waypoints[1], [49.70298, 19.00137]);
  });

  it("null with fewer than two resolved stops", () => {
    assert.equal(buildKbPattern(times(1, null), "1", "", resolve), null);
  });
});

describe("readGtfsPatternSeeds", () => {
  it("groups the fixture feed into distinct patterns", () => {
    const seeds = readGtfsPatternSeeds(path.join(process.cwd(), "test", "fixtures", "gtfs"));
    assert.ok(seeds.length > 0);
    for (const s of seeds) {
      assert.ok(s.rawTripIds.length >= 1);
      assert.ok(s.times.length >= 1);
    }
    const all = seeds.flatMap((s) => s.rawTripIds);
    assert.equal(new Set(all).size, all.length);
  });

  it("missing feed → []", () => {
    assert.deepEqual(readGtfsPatternSeeds("/nonexistent/dir"), []);
  });

  it("strips the multi-service suffix", () => {
    assert.equal(rawTripId("35678182_KB_SATURDAY"), "35678182");
    assert.equal(rawTripId("35678182"), "35678182");
  });
});
