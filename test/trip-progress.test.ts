/**
 * Where is a vehicle along its trip? Out-and-back / loop patterns (line 120's Szczyrk Biła loop).
 * Fixture: REAL upstream snapshots captured 2026-10-02 22:57-23:16 (test/fixtures/line120-loop-capture.json).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { kbNextStopIndex } from "../lib/poller";
import { kbAheadM, kbDistAlong } from "../lib/route-info";
import type { ShapeGeometry } from "../lib/shape-store";
import { decodePolyline, preparePolyline, projectStopsAlong, type LatLng } from "../lib/shared/polyline";
import { progressFromVehicle, stopAlongFor, stopsAtChainage } from "../lib/shared/trip-progress";

interface Snap { t: number; lat: number; lon: number; vti: number; ndi: number; at: boolean }
interface Fixture { polyline: string; stops: Array<{ i: number; name: string; lat: number; lon: number }>; snapshots: Snap[] }
const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "line120-loop-capture.json"), "utf8")) as Fixture;

const stopPts: LatLng[] = fx.stops.map((s) => [s.lat, s.lon]);
const routed = decodePolyline(fx.polyline, 6);
const pl = preparePolyline(routed)!;
const along = projectStopsAlong(pl, stopPts);
const N = fx.stops.length;

describe("fixture sanity", () => {
  it("the loop's twin stops are 14-49 m apart but 0.9-2.8 km apart along the route", () => {
    for (const [a, b] of [[20, 27], [21, 26], [22, 25]] as const) {
      const dLat = (fx.stops[a].lat - fx.stops[b].lat) * 111_320;
      const dLon = (fx.stops[a].lon - fx.stops[b].lon) * 111_320 * Math.cos((49.72 * Math.PI) / 180);
      assert.ok(Math.hypot(dLat, dLon) < 50);
      assert.ok(along[b]! - along[a]! > 900);
    }
  });
});

describe("stopAlongFor", () => {
  it("is the server's placement (projectStopsAlong on the same polyline)", () => {
    assert.deepEqual(stopAlongFor(routed, stopPts), along);
  });
  it("needs a drawn road shape", () => {
    assert.equal(stopAlongFor(null, stopPts), null);
    assert.equal(stopAlongFor([[49.8, 19]], stopPts), null);
  });
});

describe("stopsAtChainage", () => {
  const A = [0, 500, null, 1000, 1500, 2000]; // stop 2 is not on the shape
  it("approaching the first stop still ahead; progress runs between the previous placed stop and it", () => {
    assert.deepEqual(stopsAtChainage(A, 250, { vti: 0, atStop: false }), { index: 1, at: false, progress: 0.5 });
    // unplaced stop 2 is skipped: 750 m is between stop 1 (500) and stop 3 (1000)
    assert.deepEqual(stopsAtChainage(A, 750, { vti: 1, atStop: false }), { index: 3, at: false, progress: 0.5 });
  });
  it("a frozen upstream index cannot hold the vehicle back (skipped stops are passed)", () => {
    const r = stopsAtChainage(A, 1700, { vti: 0, atStop: false });
    assert.equal(r?.index, 5);
    assert.equal(r?.at, false);
  });
  it("upstream AT stop vti inside the pole's zone -> at that stop; outside the zone it does not count", () => {
    assert.deepEqual(stopsAtChainage(A, 1040, { vti: 3, atStop: true }), { index: 3, at: true, progress: 1 });
    assert.equal(stopsAtChainage(A, 1040 + 200, { vti: 3, atStop: true })?.at, false);
    assert.equal(stopsAtChainage(A, 1000 - 200, { vti: 3, atStop: true })?.index, 3); // approaching it, not at it
  });
  it("without at_stop information a 35 m pole zone decides", () => {
    assert.deepEqual(stopsAtChainage(A, 1020, null), { index: 3, at: true, progress: 1 });
    assert.equal(stopsAtChainage(A, 1100, undefined)?.at, false);
  });
  it("past the last stop: at the terminus unless upstream says it is not there yet", () => {
    assert.deepEqual(stopsAtChainage(A, 2100, { vti: 4, atStop: false }), { index: 5, at: false, progress: 0.98 });
    assert.equal(stopsAtChainage(A, 2100, null)?.at, true);
  });
  it("degenerate input", () => {
    assert.equal(stopsAtChainage([100, null, null], 50), null);
    assert.equal(stopsAtChainage(A, Number.NaN), null);
  });
  it("twin legs: the return-leg Pod Stroma (26) is 1.6 km past its outbound twin (21) and is never read as the twin", () => {
    assert.equal(stopsAtChainage(along, along[21]!, { vti: 21, atStop: true })?.index, 21);
    assert.equal(stopsAtChainage(along, along[26]!, { vti: 26, atStop: true })?.index, 26);
    const r = stopsAtChainage(along, along[26]! + 200, { vti: 21, atStop: false }); // upstream stuck behind
    assert.equal(r?.index, 27);
    assert.equal(r?.at, false);
  });
});

describe("progressFromVehicle (what TripView calls)", () => {
  const A = [0, 500, 1000, 1500];
  const veh = { shape: "kb:abc.123456", dist_m: 750, at_stop: false };
  it("reads dist_m against the stops when the drawn shape is the vehicle's shape", () => {
    assert.deepEqual(progressFromVehicle(A, "kb:abc.123456", veh, 0), { index: 2, at: false, progress: 0.5 });
  });
  it("null (caller falls back) without a drawn road shape, on another shape/revision, or without dist_m", () => {
    assert.equal(progressFromVehicle(null, "kb:abc.123456", veh, 0), null);
    assert.equal(progressFromVehicle(A, null, veh, 0), null); // browser-routed / straight trip
    assert.equal(progressFromVehicle(A, "kb:abc.999999", veh, 0), null); // re-routed: another revision
    assert.equal(progressFromVehicle(A, "kb:abc.123456", { shape: "kb:abc.123456" }, 0), null);
    assert.equal(progressFromVehicle(A, "kb:abc.123456", { ...veh, dist_m: Number.NaN }, 0), null);
    assert.equal(progressFromVehicle(A, "kb:abc.123456", null, 0), null);
  });
});

/** what upstream really said, as a (stop index, at) pair — the loop pass registered every stop in order */
const expected = (s: Snap) => (s.at ? { index: s.vti, at: true } : { index: Math.min(s.vti + 1, N - 1), at: false });
/** while at a stop the next stop is an equally valid reading (the bus is leaving) */
const sameStop = (got: number, exp: { index: number; at: boolean }) => got === exp.index || (exp.at && got === exp.index + 1);

describe("server chain (kbDistAlong with the previous poll's dist_m as hint + stopsAtChainage) — real line-120 capture", () => {
  const sg: ShapeGeometry = { pl, stops: along, rev: "000000", src: "osrm" };
  /** what attachRouteInfo does per poll; `freezeAt` = upstream's index sticks there once the bus reaches it (a pole passed outside its geofence) */
  function replay(freezeAt: number | null): string[] {
    let hint: number | undefined;
    let prevT: number | null = null;
    const bad: string[] = [];
    for (const s of fx.snapshots) {
      const frozen = freezeAt !== null && s.vti >= freezeAt;
      const vti = frozen ? freezeAt : s.vti;
      const at = frozen ? false : s.at;
      const ndi = frozen ? freezeAt + 1 : s.ndi;
      const gapS = prevT === null ? 0 : (s.t - prevT) / 1000;
      prevT = s.t;
      const d = kbDistAlong(sg, s.lat, s.lon, vti, kbNextStopIndex(vti, ndi, at, N), hint, { aheadM: kbAheadM(gapS) });
      if (d === null) {
        bad.push(`${new Date(s.t).toISOString()} dist_m null`);
        continue;
      }
      hint = d;
      const r = stopsAtChainage(along, d, { vti, atStop: at });
      if (!r || !sameStop(r.index, expected(s))) bad.push(`${new Date(s.t).toISOString()} upstream ${s.vti}${s.at ? "@" : ""} (sent ${vti}) -> ${r?.index}${r?.at ? "@" : ""}`);
    }
    return bad;
  }

  it("upstream right (the live case): index == upstream's at every snapshot, incl. both twin legs", () => {
    assert.deepEqual(replay(null), []);
  });

  for (const K of [17, 19, 20, 21, 22, 23, 24, 25, 26]) {
    it(`upstream index frozen at ${K} (the next pole was passed outside the geofence): the return leg is still counted`, () => {
      assert.deepEqual(replay(K), []);
    });
  }
});
