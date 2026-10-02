/**
 * Closed-loop simulation of the whole motion pipeline:
 *   true bus (accelerate / cruise / brake, dwells, a red light)
 *   → upstream position updates every 6–18 s
 *   → server poll every ~10 s (midpoint fix_at, moving-pair cruise speed — the
 *     real lib/route-info functions)
 *   → client poll every 4 s with network jitter
 *   → 60 Hz frames through the real motion store.
 * Pins the user-visible properties: no backward driving, no big jumps in
 * steady state, and staying reasonably close to the truth.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMotionStore,
  makeMotionShape,
  type MotionConfig,
  type MotionInput,
  type MotionSample,
} from "../lib/client/vehicleMotion";
import { estimateFixAt, nextSpeed } from "../lib/route-info";
import { preparePolyline, type LatLng } from "../lib/shared/polyline";

const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];

/** deterministic PRNG */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const STOPS = [0, 600, 1300, 1900, 2700, 3400, 4000];
const LIGHT = { s: 2200, from: 300, to: 345 }; // red light at 2.2 km between t=300..345 s
const VMAX = 12;
const ACC = 1.2;
const DWELL = 20;

/** Truth: simple kinematic bus, dt = 0.1 s. Returns s(t) sampler. */
function simulateTruth(): { s: (t: number) => number; end: number } {
  const dt = 0.1;
  const xs: number[] = [];
  let s = 0;
  let v = 0;
  let dwellUntil = 0;
  let stopIdx = 1;
  let t = 0;
  for (; t < 900 && stopIdx < STOPS.length; t += dt) {
    xs.push(s);
    if (t < dwellUntil) continue;
    const stopAt = STOPS[stopIdx];
    const redAhead = t >= LIGHT.from && t < LIGHT.to && s < LIGHT.s;
    const target = redAhead ? Math.min(stopAt, LIGHT.s) : stopAt;
    const dist = target - s;
    const brake = (v * v) / (2 * ACC);
    if (dist <= 0.5 && v < 0.5) {
      v = 0;
      if (target === stopAt) {
        dwellUntil = t + DWELL;
        stopIdx += 1;
      }
      continue;
    }
    v = dist <= brake + 1 ? Math.max(0, v - ACC * dt) : Math.min(VMAX, v + ACC * dt);
    s = Math.min(target, s + v * dt);
  }
  return { s: (tt: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(tt / dt)))], end: t };
}

interface SimStats {
  msg: string;
  backwards: number;
  bigJumps: number;
  cruiseP50: number;
  cruiseP95: number;
  longestStall: number;
}

function runSim(seed: number, cfg: Partial<MotionConfig> = {}): SimStats {
  const rnd = lcg(seed);
  const truth = simulateTruth();
  const shape = makeMotionShape("kb:000000000000.aaaaaa", preparePolyline([P(0, 0), P(4000, 0)])!, STOPS);

  // upstream: a new position every 6–18 s
  const upstream: Array<{ t: number; s: number }> = [];
  for (let t = 0; t < truth.end; t += 6 + rnd() * 12) upstream.push({ t, s: truth.s(t) });
  const upstreamAt = (t: number) => {
    let u = upstream[0];
    for (const x of upstream) {
      if (x.t > t) break;
      u = x;
    }
    return u;
  };

  // server: poll every ~10 s, port of attachRouteInfo's fix_at / speed
  type Srv = { s: number; updatedAt: number; fixAt: number; speed: number | null; speedAt?: number; moveDs?: number; atStop: boolean };
  const serverSnaps: Array<{ t: number; rec: MotionInput }> = [];
  let prev: Srv | undefined;
  for (let t = 0; t < truth.end; t += 10 + rnd() * 1.5) {
    const u = upstreamAt(t);
    const atStop = STOPS.some((x) => Math.abs(x - u.s) < 40);
    const moved = !prev || Math.abs(u.s - prev.s) > 1e-6;
    const fixAt = estimateFixAt(prev, t, moved);
    let speed = prev?.speed ?? null;
    let speedAt = prev?.speedAt;
    let moveDs = prev?.moveDs;
    if (prev && moved) {
      const ds = u.s - prev.s;
      const v = nextSpeed(prev.speed, prev.moveDs, ds, fixAt - prev.fixAt, prev.updatedAt - prev.fixAt, prev.atStop || atStop);
      if (v !== null) {
        speed = v;
        speedAt = fixAt;
      }
      moveDs = ds;
    }
    prev = { s: u.s, updatedAt: t, fixAt, speed, speedAt, moveDs, atStop };
    const seq = STOPS.filter((x) => x <= u.s + 40).length - 1;
    const next = STOPS.find((x) => x > u.s + 15) ?? STOPS[STOPS.length - 1];
    const [lat, lon] = P(u.s, 0);
    serverSnaps.push({
      t,
      rec: {
        id: "bus",
        lat,
        lon,
        at_stop: atStop,
        current_stop_sequence: seq,
        bearing: 90,
        next_stop_lat: P(next, 0)[0],
        next_stop_lon: P(next, 0)[1],
        shape: shape.key,
        dist_m: Math.round(u.s),
        fix_at: Math.round(fixAt * 10) / 10,
        ...(speed !== null && speedAt !== undefined && t - speedAt <= 90 ? { speed: Math.round(speed * 10) / 10 } : {}),
      },
    });
  }
  const serverAt = (t: number) => {
    let r = serverSnaps[0];
    for (const x of serverSnaps) {
      if (x.t > t) break;
      r = x;
    }
    return r;
  };

  // client: poll every 4 s (+ latency), render at 60 Hz; local clock = server clock + 1234 s
  const SKEW = 1_234_000;
  const m = createMotionStore(cfg);
  m.setShape(shape);
  const o: MotionSample = { lat: 0, lon: 0, heading: null, moving: false };
  let nextPoll = 0;
  let lastDisp: number | null = null;
  // the client can only know the bus is moving once a fix shows it: a
  // departure after a dwell is invisible until the next upstream update
  let lastRecS: number | null = null;
  let knownMoving = false;
  const movingErrs: number[] = [];
  let backwards = 0;
  let bigJumps = 0;
  const errs: number[] = [];
  let stallStart: number | null = null;
  let longestStall = 0;
  for (let tMs = 0; tMs < truth.end * 1000; tMs += 16) {
    const t = tMs / 1000;
    if (t >= nextPoll) {
      const latency = 0.1 + rnd() * 0.5;
      const snap = serverAt(t - latency);
      const recS = snap.rec.dist_m ?? 0;
      if (lastRecS !== null && recS !== lastRecS) knownMoving = recS - lastRecS > 20 && !snap.rec.at_stop;
      lastRecS = recS;
      m.ingest([snap.rec], tMs + SKEW, (t - latency) * 1000);
      nextPoll += 4;
    }
    m.sample("bus", tMs + SKEW, o);
    const disp = (o.lon - LON0) * KX;
    // warm-up: until two moving fixes arrive nothing knows the speed yet
    if (t > 60) {
      if (lastDisp !== null) {
        if (disp < lastDisp - 0.5) backwards += 1;
        if (Math.abs(disp - lastDisp) > 3) bigJumps += 1;
      }
      errs.push(Math.abs(disp - truth.s(t)));
      const vTrue = (truth.s(t) - truth.s(t - 1)) / 1;
      if (knownMoving && vTrue > 6) movingErrs.push(Math.abs(disp - truth.s(t)));
      // visible stall while the real bus cruises and the feed already shows it moving
      if (knownMoving && vTrue > 6 && lastDisp !== null && Math.abs(disp - lastDisp) < 0.01) {
        stallStart ??= t;
        longestStall = Math.max(longestStall, t - stallStart);
      } else {
        stallStart = null;
      }
    }
    lastDisp = disp;
  }
  errs.sort((a, b) => a - b);
  movingErrs.sort((a, b) => a - b);
  const q = (xs: number[], f: number) => xs[Math.floor(xs.length * f)] ?? 0;
  const msg =
    `all p50=${q(errs, 0.5).toFixed(1)} p95=${q(errs, 0.95).toFixed(1)} | ` +
    `cruising p50=${q(movingErrs, 0.5).toFixed(1)} p95=${q(movingErrs, 0.95).toFixed(1)} | ` +
    `back=${backwards} jumps=${bigJumps} stall=${longestStall.toFixed(1)}s`;
  return { msg, backwards, bigJumps, cruiseP50: q(movingErrs, 0.5), cruiseP95: q(movingErrs, 0.95), longestStall };
}

describe("closed-loop simulation", () => {
  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}: smooth, monotone and close to the truth`, () => {
      const r = runSim(seed);
      if (process.env.SIM_VERBOSE) console.log(`seed ${seed}: ${r.msg}`);
      assert.equal(r.backwards, 0, r.msg);
      assert.equal(r.bigJumps, 0, r.msg);
      // the feed is 10–30 s stale and a departure is invisible until the next
      // fix, so "close" means tens of metres, not metres
      assert.ok(r.cruiseP50 < 80, r.msg);
      assert.ok(r.cruiseP95 < 200, r.msg);
      assert.ok(r.longestStall < 8, r.msg);
    });
  }
});
