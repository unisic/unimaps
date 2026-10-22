import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adjustStopRoutePoint, getLineDetour, injectDetourPoints } from "../lib/client/detours";
import type { LatLng } from "../lib/client/types";

describe("getLineDetour", () => {
  it("matches line 121 and 134 to Piastowska detour", () => {
    const d121 = getLineDetour("121");
    assert.ok(d121);
    assert.equal(d121?.id, "bielsko-piastowska");

    const d134 = getLineDetour("134");
    assert.ok(d134);
    assert.equal(d134?.id, "bielsko-piastowska");
  });

  it("matches line 141 to Osiek detour", () => {
    const d = getLineDetour("141");
    assert.ok(d);
    assert.equal(d?.id, "osiek-beskidzka");
  });

  it("returns null for unaffected lines", () => {
    assert.equal(getLineDetour("999"), null);
    assert.equal(getLineDetour(""), null);
  });
});

describe("injectDetourPoints", () => {
  it("injects detour waypoints when points pass through affected area", () => {
    // Points starting at Bielsko DA, passing near Piastowska, heading to Hulanka
    const pts: LatLng[] = [
      [49.827, 19.049], // DA
      [49.823, 19.040], // near Piastowska inside box
      [49.818, 19.025], // past Hulanka
    ];
    const res = injectDetourPoints(pts, "121", "Hulanka");
    assert.ok(res.detour);
    assert.ok(res.points.length > pts.length);
    // Contains the Grunwaldzka / Konopnickiej replacement stops
    assert.ok(res.points.some((p) => Math.abs(p[0] - 49.823333) < 1e-4));
  });

  it("preserves all stops on circular line 134 without truncating loop", () => {
    // Line 134 starts at Bielsko DA, visits Słowackiego, Grunwaldzka, Konopnickiej, loops through Grodziec, and returns to Bielsko DA
    const pts: LatLng[] = [
      [49.8302, 19.0427], // DA (start)
      [49.8272, 19.0391], // Słowackiego BCK
      [49.8233, 19.0344], // Grunwaldzka
      [49.8200, 19.0291], // Konopnickiej
      [49.8145, 19.0185], // Hulanka
      [49.8000, 18.9000], // Jaworze / Jasienica / Grodziec (far outside)
      [49.8142, 19.0180], // Hulanka return
      [49.8302, 19.0427], // DA (end)
    ];
    const res = injectDetourPoints(pts, "134", "Grodziec Zagóra");
    assert.ok(res.detour);
    assert.equal(res.detour?.id, "bielsko-piastowska");
    // Middle loop stops must not be deleted!
    assert.equal(res.points.length, pts.length);
    assert.ok(res.points.some((p) => Math.abs(p[0] - 49.8000) < 1e-4));
  });

  it("keeps the reverse direction of the one-way Piastowska detour on its road", () => {
    // Real line 121 towards D.A.: Hulanka -> Piastowska Starostwo -> D.A. (GTFS stops 10361, 10000)
    const pts: LatLng[] = [
      [49.8145, 19.0185],
      [49.825851, 19.032577],
      [49.830227, 19.042746],
    ];
    const res = injectDetourPoints(pts, "121", "BIELSKO-BIAŁA D.A.");
    assert.equal(res.detour, null);
    assert.deepEqual(res.points, pts);
  });

  it("does not turn a single stop inside the area into an out-and-back spur", () => {
    const pts: LatLng[] = [
      [49.92, 19.23],
      [49.965, 19.245], // only stop inside the Osiek area
      [49.98, 19.3],
    ];
    const res = injectDetourPoints(pts, "141");
    assert.equal(res.detour, null);
    assert.deepEqual(res.points, pts);
  });

  it("leaves points unchanged if line has no detour", () => {
    const pts: LatLng[] = [
      [49.827, 19.049],
      [49.818, 19.025],
    ];
    const res = injectDetourPoints(pts, "999");
    assert.equal(res.detour, null);
    assert.equal(res.points.length, pts.length);
  });
});

describe("adjustStopRoutePoint", () => {
  it("adjusts Szczyrk Wodospad 21181 onto DW942 center", () => {
    const original: LatLng = [49.702919, 19.001412];
    const adjusted = adjustStopRoutePoint("21181", original);
    assert.deepEqual(adjusted, [49.70298, 19.00137]);
  });

  it("passes unmapped stops through unmodified", () => {
    const original: LatLng = [49.8, 19.0];
    const adjusted = adjustStopRoutePoint("99999", original);
    assert.deepEqual(adjusted, original);
  });
});
