/**
 * Pure helpers around the vehicle animator: preference resolution, frame
 * scheduling, arrow unwrapping and client-side shape decoding.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fleetIntervalMs, metersPerPixel, unwrapDeg, zoomGateOpen } from "../lib/client/motionSchedule";
import { parseShapePayload } from "../lib/client/shapes";
import { resolveSmoothMotion } from "../lib/client/smoothMotion";
import { encodePolyline } from "../lib/shared/polyline";

describe("resolveSmoothMotion", () => {
  it("an early feature: on only after an explicit opt-in", () => {
    assert.equal(resolveSmoothMotion("1"), true);
    assert.equal(resolveSmoothMotion("0"), false);
    assert.equal(resolveSmoothMotion(null), false);
    assert.equal(resolveSmoothMotion("garbage"), false);
  });
});

describe("metersPerPixel / fleetIntervalMs", () => {
  it("~3.08 m/px at z15 in Bielsko-Biała", () => {
    assert.ok(Math.abs(metersPerPixel(49.8, 15) - 3.08) < 0.02);
  });

  it("≈4 Hz at city zooms, near frame rate only when zoomed right in", () => {
    assert.equal(fleetIntervalMs(metersPerPixel(49.8, 11)), 250);
    assert.ok(Math.abs(fleetIntervalMs(metersPerPixel(49.8, 15)) - 154) < 2);
    assert.equal(fleetIntervalMs(metersPerPixel(49.8, 19)), 33);
  });
});

describe("unwrapDeg", () => {
  it("takes the short way round", () => {
    assert.equal(unwrapDeg(350, 5), 365);
    assert.equal(unwrapDeg(10, 350), -10);
    assert.equal(unwrapDeg(725, 10), 730);
    assert.equal(unwrapDeg(null, 123), 123);
    assert.equal(unwrapDeg(90, 90), 90);
  });
});

describe("zoomGateOpen", () => {
  it("closed during a zoom animation and briefly after zoom events, never sticky", () => {
    assert.equal(zoomGateOpen(1000, 0, true), false);
    assert.equal(zoomGateOpen(1000, 950, false), false);
    assert.equal(zoomGateOpen(1000, 800, false), true);
    // an interrupted flyTo leaves no flag behind: time alone reopens the gate
    assert.equal(zoomGateOpen(5000, 1000, false), true);
  });
});

describe("parseShapePayload", () => {
  it("decodes polyline6 + stops and rejects malformed entries", () => {
    const poly = encodePolyline([
      [49.8, 19.0],
      [49.81, 19.0],
    ]);
    const s = parseShapePayload("kb:0123456789ab.abcdef", { id: "x", poly, stops: [0, 1113.2, "bad"] })!;
    assert.equal(s.id, "kb:0123456789ab.abcdef");
    assert.equal(s.pts.length, 2);
    assert.ok(Math.abs(s.pl.length - 1113.2) < 1);
    assert.deepEqual(s.stops, [0, 1113.2, null]);
    assert.equal(parseShapePayload("a", null), null);
    assert.equal(parseShapePayload("a", { poly: 5 }), null);
    assert.equal(parseShapePayload("a", { poly: "" }), null);
  });
});
