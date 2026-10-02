/**
 * Client dead-reckoning engine (lib/client/vehicleMotion.ts) — unit pins.
 * All time is synthetic; geometry is built in metres around (49.8, 19.0).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMotionStore,
  makeMotionShape,
  travel,
  type MotionInput,
  type MotionSample,
} from "../lib/client/vehicleMotion";
import { preparePolyline, segMeters, type LatLng } from "../lib/shared/polyline";

const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];
const east = (lat: number, lon: number): number => (lon - LON0) * KX;

const KEY = "kb:000000000000.aaaaaa";
const STOPS = [0, 500, 1000, 1500, 2000, 2500];
const road = () => makeMotionShape(KEY, preparePolyline([P(0, 0), P(2500, 0)])!, STOPS);

/** A KB-like wire record for a bus at `s` metres along the east-west road. */
function V(s: number, o: Partial<MotionInput> & { seq?: number } = {}): MotionInput {
  const seq = o.seq ?? STOPS.filter((x) => x <= s + 40).length - 1;
  const next = STOPS.find((x) => x > s + 15) ?? null;
  const [lat, lon] = P(s, 0);
  return {
    id: "bus",
    lat,
    lon,
    at_stop: false,
    current_stop_sequence: seq,
    bearing: 90,
    next_stop_lat: next !== null ? P(next, 0)[0] : null,
    next_stop_lon: next !== null ? P(next, 0)[1] : null,
    shape: KEY,
    dist_m: s,
    ...o,
  };
}

const out = (): MotionSample => ({ lat: 0, lon: 0, heading: null, moving: false });
const at = (store: ReturnType<typeof createMotionStore>, t: number, id = "bus"): number => {
  const o = out();
  assert.ok(store.sample(id, t, o));
  return east(o.lat, o.lon);
};

describe("travel", () => {
  it("is continuous, ramps down after 0.6H and stops at H", () => {
    const H = 20;
    assert.equal(travel(10, 5, H), 50);
    const t1 = 0.6 * H;
    assert.ok(Math.abs(travel(10, t1 - 1e-6, H) - travel(10, t1 + 1e-6, H)) < 1e-3);
    assert.ok(Math.abs(travel(10, H - 1e-6, H) - travel(10, H, H)) < 1e-3);
    assert.equal(travel(10, H, H), travel(10, H + 100, H));
    assert.equal(travel(10, H, H), 10 * (t1 + (H - t1) / 2));
    assert.equal(travel(0, 5, H), 0);
    assert.equal(travel(10, -1, H), 0);
  });
});

describe("prediction", () => {
  it("without a speed it never extrapolates", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(200)], 0, 0);
    assert.ok(Math.abs(at(m, 0) - 200) < 0.5);
    assert.ok(Math.abs(at(m, 10_000) - 200) < 0.5);
  });

  it("first sight snaps to the extrapolated position (fix age from the server clock)", () => {
    const m = createMotionStore();
    m.setShape(road());
    // server stamped the fix 5 s before "now"; client clock is 1 h off
    m.ingest([V(200, { speed: 10, fix_at: 995 })], 3_600_000, 1_000_000);
    assert.ok(Math.abs(at(m, 3_600_000) - (200 + 9.5 * 5)) < 0.5);
  });

  it("never runs past the next stop", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(460, { speed: 10, fix_at: 0 })], 0, 0);
    assert.ok(Math.abs(at(m, 30_000) - 492) < 0.5);
  });

  it("holds while dwelling, but a bus leaving the stop zone keeps moving", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(495, { at_stop: true, speed: 10, fix_at: 0 })], 0, 0);
    m.ingest([V(498, { at_stop: true, speed: 10, fix_at: 10 })], 10_000, 10_000);
    const p = at(m, 15_000);
    assert.ok(Math.abs(p - 498) < 1, `held at ${p}`);
    // departure fix 40 m past the pole, still inside the stop zone
    m.ingest([V(540, { at_stop: true, speed: 10, fix_at: 20 })], 20_000, 20_000);
    at(m, 20_000);
    const q = at(m, 25_000);
    assert.ok(q > 545, `still moving after the pole, got ${q}`);
  });

  it("an approaching bus in the stop zone runs to the pole, not the next stop", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(380, { speed: 10, fix_at: 0 })], 0, 0);
    m.ingest([V(470, { at_stop: true, speed: 10, fix_at: 10, seq: 1 })], 10_000, 10_000);
    at(m, 10_000);
    const p = at(m, 40_000);
    assert.ok(p <= 500 && p > 490, `got ${p}`);
  });
});

describe("correction", () => {
  it("behind: smooth monotone catch-up that never overtakes the target", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(100, { speed: 10, fix_at: 0 })], 0, 0);
    let prev = at(m, 0);
    for (let t = 16; t < 10_000; t += 16) prev = at(m, t);
    m.ingest([V(300, { speed: 10, fix_at: 10 })], 10_000, 10_000);
    for (let t = 10_016; t < 20_000; t += 16) {
      const p = at(m, t);
      assert.ok(p >= prev - 1e-6, `moved backwards at ${t}`);
      assert.ok(p - prev < 1.0, `jumped ${p - prev} m in one frame at ${t}`);
      prev = p;
    }
  });

  it("ahead: slows/waits, never drives backwards", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(100, { speed: 12, fix_at: 0 })], 0, 0);
    let prev = at(m, 0);
    for (let t = 16; t < 9_000; t += 16) prev = at(m, t);
    // truth was slower: new fix 40 m behind the displayed position
    m.ingest([V(prev - 40, { speed: 8, fix_at: 9 })], 9_000, 9_000);
    for (let t = 9_016; t < 20_000; t += 16) {
      const p = at(m, t);
      assert.ok(p >= prev - 1e-6, `moved backwards by ${prev - p} at ${t}`);
      prev = p;
    }
  });

  it("snaps on a big disagreement instead of racing", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(100, { speed: 10, fix_at: 0 })], 0, 0);
    at(m, 0);
    m.ingest([V(900, { speed: 10, fix_at: 4 })], 4_000, 4_000);
    assert.ok(Math.abs(at(m, 4_000) - 900) < 1);
  });

  it("a ghost (no new fix for long) settles back onto the last fix", () => {
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(100, { speed: 10, fix_at: 0 })], 0, 0);
    let t = 0;
    for (; t < 30_000; t += 100) at(m, t);
    assert.ok(at(m, t) > 200);
    for (; t < 90_000; t += 100) at(m, t);
    assert.ok(Math.abs(at(m, t) - 100) < 5, `got ${at(m, t)}`);
  });
});

describe("straight fallback (no road shape)", () => {
  it("heads for the next stop and stops short of it", () => {
    const m = createMotionStore();
    m.ingest([V(400, { shape: undefined, dist_m: undefined, speed: 10, fix_at: 0 })], 0, 0);
    assert.ok(Math.abs(at(m, 30_000) - 492) < 1);
  });

  it("direction guard: a 'next stop' behind the motion means no extrapolation", () => {
    const m = createMotionStore();
    const back = (s: number, fixAt: number) =>
      V(s, {
        shape: undefined,
        dist_m: undefined,
        speed: 10,
        fix_at: fixAt,
        next_stop_lat: P(0, 0)[0],
        next_stop_lon: P(0, 0)[1],
      });
    m.ingest([back(300, 0)], 0, 0);
    m.ingest([back(400, 10)], 10_000, 10_000);
    at(m, 10_000);
    assert.ok(Math.abs(at(m, 20_000) - 400) < 1);
  });
});

describe("shapes", () => {
  it("a shape arriving later doesn't jump the marker", () => {
    const m = createMotionStore();
    // fix 12 m north of the road: the straight-mode marker sits on the fix
    m.ingest([V(200, { lat: P(200, 12)[0], speed: 0, fix_at: 0 })], 0, 0);
    const o = out();
    m.sample("bus", 0, o);
    assert.deepEqual(m.missingShapes(), [KEY]);
    m.setShape(road());
    const o2 = out();
    m.sample("bus", 16, o2);
    assert.ok(segMeters(o.lat, o.lon, o2.lat, o2.lon) < 1, "no jump when the shape lands");
    // and it then settles onto the road
    const o3 = out();
    m.sample("bus", 3_000, o3);
    assert.ok(Math.abs((o3.lat - LAT0) * 111_320) < 1);
  });

  it("override shape: the fix is projected onto the drawn route", () => {
    const m = createMotionStore();
    m.ingest([V(700, { shape: undefined, dist_m: undefined })], 0, 0);
    m.setShape(makeMotionShape("trip:1", preparePolyline([P(0, 5), P(2500, 5)])!, STOPS));
    m.overrideShape("bus", "trip:1");
    m.snap("bus");
    const o = out();
    m.sample("bus", 0, o);
    assert.ok(Math.abs((o.lat - LAT0) * 111_320 - 5) < 0.5);
    assert.ok(Math.abs(east(o.lat, o.lon) - 700) < 0.5);
  });

  it("heading follows the road round a corner without stepping", () => {
    const m = createMotionStore();
    const l = makeMotionShape(KEY, preparePolyline([P(0, 0), P(500, 0), P(500, 500)])!, [0, 1000]);
    m.setShape(l);
    m.ingest([V(400, { speed: 10, fix_at: 0, seq: 0 })], 0, 0);
    const o = out();
    let prevH: number | null = null;
    for (let t = 0; t < 20_000; t += 16) {
      m.sample("bus", t, o);
      if (prevH !== null && o.heading !== null) {
        const d = Math.abs(((o.heading - prevH + 540) % 360) - 180);
        assert.ok(d < 10, `heading stepped ${d}°`);
      }
      prevH = o.heading;
    }
    assert.ok(o.heading !== null && Math.abs(o.heading - 0) < 5, `ended at ${o.heading}`);
  });
});

describe("store housekeeping", () => {
  it("drops vehicles gone for 30 s unless a view pins them", () => {
    const m = createMotionStore();
    m.ingest([V(100), { ...V(200), id: "pinned" }], 0, 0);
    m.pin("pinned", true);
    m.ingest([], 10_000, 10_000);
    assert.equal(m.size(), 2);
    m.ingest([], 40_000, 40_000);
    assert.equal(m.has("bus"), false);
    assert.equal(m.has("pinned"), true);
  });

  it("is deterministic and re-sampling the same instant is stable", () => {
    const run = () => {
      const m = createMotionStore();
      m.setShape(road());
      m.ingest([V(100, { speed: 9, fix_at: 0 })], 0, 0);
      const xs: number[] = [];
      for (let t = 0; t < 5_000; t += 33) xs.push(at(m, t));
      m.ingest([V(160, { speed: 9, fix_at: 5 })], 5_000, 5_000);
      for (let t = 5_000; t < 9_000; t += 33) xs.push(at(m, t));
      return xs;
    };
    assert.deepEqual(run(), run());
    const m = createMotionStore();
    m.setShape(road());
    m.ingest([V(100, { speed: 9, fix_at: 0 })], 0, 0);
    assert.equal(at(m, 1000), at(m, 1000));
  });
});
