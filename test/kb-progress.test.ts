/**
 * GPS progress tracker (lib/kb-progress.ts): detects an upstream stop index that stalled behind the bus and
 * replaces the delay by the schedule deviation at the real position. Pure functions only (no LivePoller/KbApi).
 *
 * Fixtures in test/fixtures/kb-delay/ are real upstream captures (2026-10-02 night run) — compact: stops
 * (coords + plan) and one sample per poll (fix, vti, ndi, at_stop, estimates[0].arrival_abs).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { findActiveStop } from "../lib/client/geo";
import {
  HOLD_CARRY_S,
  plannedAt,
  progressAt,
  scheduleDelay,
  stepArrivals,
  stepKbProgress,
  straightGeom,
  trackAlong,
  type KbProgOut,
  type KbProgState,
  type ProgressGeom,
} from "../lib/kb-progress";
import { isFeedStale, kbNextStopIndex } from "../lib/poller";
import { preparePolyline, type LatLng } from "../lib/shared/polyline";

/* ------------------------------------------------------------------ fixtures */

interface FxStop {
  name: string;
  lat: number | null;
  lon: number | null;
  plan: string;
}
interface FxSample {
  t: number;
  local: number;
  lat: number;
  lon: number;
  vti: number | null;
  ndi: number | null;
  at: boolean;
  est0: string | null;
}
interface Fx {
  stops: FxStop[];
  samples: FxSample[];
}

function loadFx(name: string): Fx {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "kb-delay", `${name}.json`), "utf8")) as Fx;
}

const hhmm = (s: string | null): number | null => {
  if (!s) return null;
  const [h, m] = s.split(":").map(Number);
  return h * 3600 + m * 60;
};
const wrap = (x: number): number => (x > 43200 ? x - 86400 : x < -43200 ? x + 86400 : x);

/** parsePosition parity: trunc(estimates[0].arrival_abs − plan[ndi ?? vti]) */
function parityDelay(s: FxSample, plan: Array<number | null>): number | null {
  const tgt = s.ndi !== null && s.ndi >= 0 && s.ndi < plan.length ? s.ndi : s.vti;
  const arr = hhmm(s.est0);
  const sched = tgt !== null && tgt !== undefined ? plan[tgt] : null;
  return arr !== null && sched !== null ? Math.trunc(wrap(arr - sched)) : null;
}

interface Replayed {
  s: FxSample;
  delayUp: number | null;
  o: KbProgOut;
}

function replay(fx: Fx, samples: FxSample[] = fx.samples): Replayed[] {
  const stopPts = fx.stops.map((s): LatLng | null => (s.lat !== null && s.lon !== null ? [s.lat, s.lon] : null));
  const geom = straightGeom(stopPts);
  assert.ok(geom, "fixture has a usable geometry");
  const plan = fx.stops.map((s) => hhmm(s.plan));
  let st: KbProgState | null = null;
  return samples.map((s) => {
    const delayUp = parityDelay(s, plan);
    const nextUp = kbNextStopIndex(s.vti, s.ndi, s.at, plan.length);
    const o = stepKbProgress(
      { geom, plan, lat: s.lat, lon: s.lon, tEpoch: s.t / 1000, localSecs: s.local, vti: s.vti, nextUp, delayUp },
      st,
    );
    st = o.state;
    return { s, delayUp, o };
  });
}

/** what upstream does while its index is stuck: vti/ndi frozen, estimates[0] clamped to "now" (the current minute) */
function stuckAt(samples: FxSample[], vti: number, ndi: number, fromLocal: number): FxSample[] {
  return samples.map((s) =>
    s.local < fromLocal
      ? s
      : { ...s, vti, ndi, at: false, est0: `${String(Math.floor(s.local / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s.local / 60) % 60).padStart(2, "0")}` },
  );
}

/** Independent ground truth: time (epoch s) of the closest approach of the sampled track to each stop, taken in
 *  stop order (the first run of segments within 80 m after the previous stop's pass). */
function crossings(fx: Fx): Array<number | null> {
  const pts = fx.samples.map((s) => ({ t: s.t / 1000, lat: s.lat, lon: s.lon }));
  const out: Array<number | null> = [];
  let after = -Infinity;
  for (const st of fx.stops) {
    if (st.lat === null || st.lon === null) {
      out.push(null);
      continue;
    }
    const kx = 111_320 * Math.cos((st.lat * Math.PI) / 180);
    let best: { d: number; t: number } | null = null;
    let inRun = false;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (b.t < after) continue;
      const ax = (a.lon - st.lon) * kx;
      const ay = (a.lat - st.lat) * 110_540;
      const bx = (b.lon - st.lon) * kx;
      const by = (b.lat - st.lat) * 110_540;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const d = Math.hypot(ax + u * dx, ay + u * dy);
      if (d < 80) {
        inRun = true;
        if (!best || d < best.d) best = { d, t: a.t + u * (b.t - a.t) };
      } else if (inRun) break;
    }
    out.push(best ? best.t : null);
    if (best) after = best.t;
  }
  return out;
}

/** last stop passed at epoch-second t according to the independent crossings */
function trueLast(cr: Array<number | null>, t: number): number {
  let last = -1;
  cr.forEach((c, i) => {
    if (c !== null && c <= t) last = i;
  });
  return last;
}

const at = (h: number, m: number, s = 0): number => h * 3600 + m * 60 + s;

/* ------------------------------------------------------------------ pure helpers */

describe("kb-progress pure helpers", () => {
  const stops = [0, 1000, 2000, 3000];
  const plan = [at(10, 0), at(10, 2), at(10, 4), at(10, 6)];

  it("plannedAt interpolates linearly, clamps at both ends, is flat when two stops share a minute", () => {
    assert.equal(plannedAt(stops, plan, 500), at(10, 1));
    assert.equal(plannedAt(stops, plan, -50), plan[0]);
    assert.equal(plannedAt(stops, plan, 9999), plan[3]);
    assert.equal(plannedAt([0, 500, 1000], [100, 160, 160], 750), 160);
    assert.equal(plannedAt([null, 500], [null, 160], 100), 160);
    assert.equal(plannedAt([], [], 0), null);
  });

  it("plannedAt unwraps midnight (23:58 -> 00:01)", () => {
    const p = plannedAt([0, 1000], [at(23, 58), 60], 500);
    assert.ok(p !== null);
    assert.equal(wrap(p - at(23, 59, 30)), 0);
  });

  it("scheduleDelay: on time / late / early / waiting at the origin / midnight", () => {
    assert.equal(scheduleDelay(stops, plan, 1500, at(10, 3)), 0);
    assert.equal(scheduleDelay(stops, plan, 1500, at(10, 3) + 150), 150);
    assert.equal(scheduleDelay(stops, plan, 1500, at(10, 3) - 120), -120);
    assert.equal(scheduleDelay(stops, plan, 10, at(10, 0) - 300), 0, "early at the origin is not 'early running'");
    const late = scheduleDelay(stops, plan, 10, at(10, 0) + 90);
    assert.ok(late !== null && Math.abs(late - 90) < 2, "a late departure is counted");
    // 00:02 local time, timetable 23:58 -> 00:04 and the bus half way: planned 00:01 -> 60 s late
    const d = scheduleDelay([0, 1000], [at(23, 58), at(0, 4)], 500, at(0, 2));
    assert.equal(d, 60);
    assert.equal(scheduleDelay([null], [null], 0, 0), null);
  });

  it("progressAt: passed / next stop and the stale threshold (> 120 m beyond upstream's next stop)", () => {
    assert.deepEqual(progressAt(stops, 1010, 1), { lastIdx: 1, nextIdx: 2, stale: false, pastM: 10 });
    assert.equal(progressAt(stops, 1119, 1).stale, false);
    assert.equal(progressAt(stops, 1121, 1).stale, true);
    assert.equal(progressAt(stops, 2500, 1).lastIdx, 2);
    assert.equal(progressAt(stops, 3050, 1).nextIdx, null, "past the last stop");
    assert.equal(progressAt(stops, 1500, null).stale, false, "no upstream index, nothing to compare");
    assert.equal(progressAt([0, null, 2000], 2010, 1).lastIdx, 2, "unplaced stops are skipped");
    assert.equal(progressAt([0, null, 2000], 10, 0).nextIdx, 2, "the next stop is the next placed one");
    assert.equal(progressAt([0, 1000, 2000, null], 2000, 0).nextIdx, null, "past the last placed stop (terminus unresolved)");
  });

  it("straightGeom aligns stops with trip.times and tolerates unresolved stops", () => {
    const g = straightGeom([[49.8, 19.0], null, [49.81, 19.0], [49.82, 19.0]]);
    assert.ok(g);
    assert.equal(g.stops.length, 4);
    assert.equal(g.stops[1], null);
    assert.ok((g.stops[3] as number) > (g.stops[2] as number));
    assert.equal(straightGeom([[49.8, 19.0], null]), null, "fewer than two stops");
  });
});

/* ------------------------------------------------------------------ trackAlong */

describe("trackAlong", () => {
  const LAT0 = 49.8;
  const LON0 = 19.0;
  const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
  const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];

  it("never moves backwards on GPS jitter and refuses a teleport", () => {
    const pl = preparePolyline([P(0, 0), P(1500, 0)])!;
    const geom: ProgressGeom = { pl, stops: [0, 1500], maxOffM: 150 };
    const a = trackAlong(geom, ...P(500, 3), 1000, 36000, [36000, 36600], 0, 1, null)!;
    assert.equal(a.mode, "init");
    const b = trackAlong(geom, ...P(495, 3), 1010, 36010, [36000, 36600], 0, 1, { D: a.D, t: 1000 })!;
    assert.ok(b.D >= a.D);
    const c = trackAlong(geom, ...P(1400, 3), 1012, 36012, [36000, 36600], 0, 1, { D: b.D, t: 1010 })!;
    assert.equal(c.mode, "hold", "900 m in 2 s is not a plausible move");
    assert.equal(c.D, b.D);
    assert.equal(trackAlong(geom, ...P(500, 900), 1020, 36020, [36000, 36600], 0, 1, null), null, "off the route");
  });

  // out-and-back: 1 km east, back 10 m north of it; stops 0 / 500 / apex 1000 / 1510 (= 500 on the way back) / 2010
  const pl = preparePolyline([P(0, 0), P(1000, 0), P(1000, 10), P(0, 10)])!;
  const geom: ProgressGeom = { pl, stops: [0, 500, 1000, 1510, 2010], maxOffM: 150 };
  const plan = [at(10, 0), at(10, 5), at(10, 10), at(10, 15), at(10, 20)];

  it("upstream's last registered stop is a hard lower bound: the return leg is not mistaken for the outbound leg", () => {
    const back = trackAlong(geom, ...P(300, 10), 1000, at(10, 17), plan, 3, 4, null)!;
    assert.ok(Math.abs(back.D - 1710) < 2, `got ${back.D}`);
    const out = trackAlong(geom, ...P(300, 0), 1000, at(10, 3), plan, 0, 1, null)!;
    assert.ok(Math.abs(out.D - 300) < 2, `got ${out.D}`);
  });

  it("cold start: in sync wins unless the stale-index candidate fits the timetable clearly better", () => {
    // upstream stuck at stop 0 (next 1); the bus is at x=300 — outbound 300 m or return 1710 m?
    const nearSchedule = trackAlong(geom, ...P(300, 5), 1000, at(10, 3), plan, 0, 1, null)!;
    assert.ok(Math.abs(nearSchedule.D - 300) < 2, "10:03 fits the outbound pass (10:03) — in-sync candidate");
    const lateEvening = trackAlong(geom, ...P(300, 5), 1000, at(10, 17), plan, 0, 1, null)!;
    assert.ok(Math.abs(lateEvening.D - 1710) < 2, "10:17 fits the return pass (10:17) by far better than the outbound one");
  });

  it("cold start: a candidate clamped to the stale-index window keeps its real distance from the fix", () => {
    // bus 100 m before upstream's next stop; nothing beyond next+120 m is within 150 m of it, however well it fits
    const line = preparePolyline([P(0, 0), P(1000, 0), P(2000, 0), P(3000, 0)])!;
    const g: ProgressGeom = { pl: line, stops: [0, 1000, 2000, 3000], maxOffM: 150 };
    const r = trackAlong(g, ...P(900, 0), 1000, at(10, 8, 5), [at(10, 0), at(10, 1), at(11, 0), at(11, 30)], 0, 1, null)!;
    assert.ok(Math.abs(r.D - 900) < 2, `got ${r.D}`);
  });

  it("warm: monotone window keeps the leg even when upstream's index is stale", () => {
    let prev = { D: 0, t: 1000 };
    // drive east along the outbound leg and back; upstream stays at vti 0 / next 1 the whole time
    const path: Array<[number, number]> = [[200, 0], [400, 0], [600, 0], [800, 0], [1000, 5], [800, 10], [600, 10], [400, 10], [200, 10]];
    let last = 0;
    path.forEach(([x, y], i) => {
      const r = trackAlong(geom, ...P(x, y), 1010 + i * 10, at(10, 1) + i * 10, plan, 0, 1, prev)!;
      assert.ok(r.D >= last, `D never decreases (${last} -> ${r.D})`);
      assert.notEqual(r.mode, "hold");
      last = r.D;
      prev = { D: r.D, t: 1010 + i * 10 };
    });
    assert.ok(last > 1500, `ended on the return leg, got ${last}`);
  });
});

/* ------------------------------------------------------------------ stepKbProgress */

describe("stepKbProgress state machine", () => {
  const LAT0 = 49.8;
  const LON0 = 19.0;
  const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
  const P = (east: number): LatLng => [LAT0 + 3 / 111_320, LON0 + east / KX];
  const stopPts: Array<LatLng | null> = [[LAT0, LON0], [LAT0, LON0 + 1000 / KX], [LAT0, LON0 + 2000 / KX], [LAT0, LON0 + 3000 / KX]];
  const geom = straightGeom(stopPts)!;
  const plan: Array<number | null> = [at(10, 0), at(10, 2), at(10, 4), at(10, 6)];
  const base = { geom, plan, vti: 0, nextUp: 1 as number | null };

  it("in sync: keeps upstream's value untouched and reports no GPS indices", () => {
    const o = stepKbProgress({ ...base, lat: P(300)[0], lon: P(300)[1], tEpoch: 100, localSecs: at(10, 1), delayUp: 60 }, null);
    assert.equal(o.stale, false);
    assert.equal(o.src, "est");
    assert.equal(o.delay, 60);
    // diagnostics: the GPS schedule deviation is reported even when it isn't used (300 m into 10:00 -> 10:02 = 10:00:36)
    assert.ok(o.dev !== null && Math.abs(o.dev - 24) < 1, `dev ${o.dev}`);
  });

  it("stale index: the bus is past upstream's next stop -> schedule deviation, and it grows only with real lateness", () => {
    // bus at 1500 m (planned 10:03), upstream still says "next stop = 1" with delay now-10:02
    const o1 = stepKbProgress({ ...base, lat: P(1500)[0], lon: P(1500)[1], tEpoch: 100, localSecs: at(10, 3), delayUp: 60 }, null);
    assert.equal(o1.stale, true);
    assert.equal(o1.src, "gps");
    assert.ok(Math.abs(o1.delay!) < 1, `got ${o1.delay}`);
    assert.equal(o1.lastIdx, 1);
    assert.equal(o1.nextIdx, 2);
    // 20 s later, 200 m further on, upstream's estimate says +120 s: GPS says +10 s
    const o2 = stepKbProgress({ ...base, lat: P(1700)[0], lon: P(1700)[1], tEpoch: 120, localSecs: at(10, 3, 20) + 0, delayUp: 80 }, o1.state);
    assert.equal(o2.src, "gps");
    // 700 m into the 1000 m leg planned 10:02 -> 10:04 = 10:03:24; it is 10:03:20, i.e. 4 s EARLY (upstream: +80 s)
    assert.ok(o2.delay !== null && Math.abs(o2.delay + 4) < 2, `got ${o2.delay}`);
  });

  it("an unplaceable stale bus keeps its last GPS delay for HOLD_CARRY_S, then has no delay at all", () => {
    const o1 = stepKbProgress({ ...base, lat: P(1500)[0], lon: P(1500)[1], tEpoch: 100, localSecs: at(10, 3), delayUp: 60 }, null);
    const off = { ...base, lat: LAT0 + 0.05, lon: LON0 + 0.05, localSecs: at(10, 4), delayUp: 120 as number | null };
    const held = stepKbProgress({ ...off, tEpoch: 100 + HOLD_CARRY_S - 1 }, o1.state);
    assert.equal(held.src, "gps-held");
    assert.ok(Math.abs(held.delay!) < 1, `got ${held.delay}`);
    const gone = stepKbProgress({ ...off, tEpoch: 100 + HOLD_CARRY_S + 1 }, o1.state);
    assert.equal(gone.src, "unknown");
    assert.equal(gone.delay, null);
    // never stale before: an unplaceable bus keeps upstream's value (today's behaviour)
    const fresh = stepKbProgress({ ...off, tEpoch: 100 }, null);
    assert.equal(fresh.src, "est");
    assert.equal(fresh.delay, 120);
  });

  it("a bus parked at its last stop keeps the arrival delay instead of getting 'later' every minute", () => {
    const arrive = stepKbProgress({ ...base, lat: P(3000)[0], lon: P(3000)[1], tEpoch: 100, localSecs: at(10, 7), delayUp: 300 }, null);
    assert.equal(arrive.src, "gps");
    assert.equal(arrive.nextIdx, null);
    assert.ok(Math.abs(arrive.delay! - 60) < 1, `got ${arrive.delay}`);
    const parked = stepKbProgress({ ...base, lat: P(3000)[0], lon: P(3000)[1], tEpoch: 160, localSecs: at(10, 12), delayUp: 600 }, arrive.state);
    assert.equal(parked.delay, arrive.delay, "frozen at the arrival delay");
  });

  it("course over: a stale-indexed bus that reaches its last stop (warm) is finished and stays so wherever it drives next", () => {
    const warm = stepKbProgress({ ...base, lat: P(2900)[0], lon: P(2900)[1], tEpoch: 100, localSecs: at(10, 6), delayUp: 300 }, null);
    assert.equal(warm.finished, false);
    const arrive = stepKbProgress({ ...base, lat: P(3000)[0], lon: P(3000)[1], tEpoch: 110, localSecs: at(10, 6, 10), delayUp: 300 }, warm.state);
    assert.equal(arrive.finished, true);
    const away = stepKbProgress({ ...base, lat: LAT0 + 0.05, lon: LON0 + 0.05, tEpoch: 400, localSecs: at(10, 12), delayUp: null }, arrive.state);
    assert.equal(away.finished, true, "latched even after the 3-min cold-start gap");
    assert.equal(away.src, "gps-held");
    assert.equal(away.delay, arrive.delay);
    // chords overshoot D: D at the end of the polyline but the fix is 300 m from the last stop's own coordinates
    const farPts: Array<LatLng | null> = [...stopPts.slice(0, 3), [LAT0 + 300 / 110_540, LON0 + 3000 / KX]];
    const overshoot = stepKbProgress({ ...base, geom: { ...geom, pts: farPts }, lat: P(3000)[0], lon: P(3000)[1], tEpoch: 110, localSecs: at(10, 6, 10), delayUp: 300 }, warm.state);
    assert.equal(overshoot.stale, true);
    assert.equal(overshoot.nextIdx, null);
    assert.equal(overshoot.finished, false, "not physically at the last stop yet");
    // a cold start AT the last stop is not trusted (could be the wrong end of a start==end loop)
    const cold = stepKbProgress({ ...base, lat: P(3000)[0], lon: P(3000)[1], tEpoch: 110, localSecs: at(10, 6, 10), delayUp: 300 }, null);
    assert.equal(cold.finished, false);
    // in sync (upstream registered the last stop itself): left to parsePosition's own rule
    const sync = stepKbProgress({ ...base, vti: 3, nextUp: 4, lat: P(3000)[0], lon: P(3000)[1], tEpoch: 110, localSecs: at(10, 6), delayUp: 0 }, warm.state);
    assert.equal(sync.finished, false);
  });

  it("a stale-indexed bus last seen right at the terminus that is off the route now has left after its terminus", () => {
    const near = stepKbProgress({ ...base, lat: P(2950)[0], lon: P(2950)[1], tEpoch: 100, localSecs: at(10, 6), delayUp: 300 }, null);
    assert.equal(near.stale, true);
    const gone = stepKbProgress({ ...base, lat: LAT0 + 0.05, lon: LON0 + 0.05, tEpoch: 130, localSecs: at(10, 7), delayUp: 360 }, near.state);
    assert.equal(gone.finished, true);
    assert.equal(gone.src, "gps-held");
    // mid-route off-route: not finished, just held
    const mid = stepKbProgress({ ...base, lat: P(1500)[0], lon: P(1500)[1], tEpoch: 100, localSecs: at(10, 3), delayUp: 60 }, null);
    const lost = stepKbProgress({ ...base, lat: LAT0 + 0.05, lon: LON0 + 0.05, tEpoch: 130, localSecs: at(10, 4), delayUp: 120 }, mid.state);
    assert.equal(lost.finished, false);
    assert.equal(lost.src, "gps-held");
  });

  it("an implausible GPS delay (|dev| > 45 min: wrong plan/leg) is not trusted: upstream's value, no GPS indices", () => {
    const o = stepKbProgress({ ...base, lat: P(1500)[0], lon: P(1500)[1], tEpoch: 100, localSecs: at(12, 0), delayUp: 60 }, null);
    assert.equal(o.stale, false);
    assert.equal(o.src, "est");
    assert.equal(o.delay, 60);
  });
});

/* ------------------------------------------------------------------ real captures */

describe("stalled upstream stop index on a plain route (real capture, line 116, 22:49-22:57)", () => {
  const fx = loadFx("stall-116");
  const rows = replay(fx);
  it("upstream's delay inflates +1 min/min (5 -> 11 min) while the bus runs on time", () => {
    const stalled = rows.filter((r) => r.s.vti === 5 && r.s.ndi === 6);
    assert.ok(stalled.length >= 25);
    assert.ok(stalled[0].delayUp! >= 300 && stalled[stalled.length - 1].delayUp! >= 600);
  });
  it("the GPS delay stays within ±90 s, flagged stale, from the second poll on", () => {
    const stalled = rows.filter((r) => r.s.vti === 5 && r.s.ndi === 6 && r.s.local >= at(22, 49, 25));
    assert.ok(stalled.length >= 25);
    for (const r of stalled) {
      assert.equal(r.o.stale, true, `stale at ${r.s.local}`);
      assert.ok(r.o.src === "gps" || r.o.src === "gps-held", r.o.src);
      assert.ok(Math.abs(r.o.delay!) <= 90, `GPS delay ${r.o.delay} at ${r.s.local}`);
    }
  });
  it("matches the independent closest-approach delay at the last passed stop (±90 s)", () => {
    const cr = crossings(fx);
    const plan = fx.stops.map((s) => hhmm(s.plan));
    let n = 0;
    for (const r of rows) {
      if (!r.o.stale || r.o.src !== "gps") continue;
      const j = trueLast(cr, r.s.t / 1000);
      if (j < 0 || cr[j] === null) continue;
      const crossLocal = r.s.local - (r.s.t / 1000 - (cr[j] as number));
      const obs = wrap(crossLocal - (plan[j] as number));
      assert.ok(Math.abs(r.o.delay! - obs) <= 90, `GPS ${r.o.delay} vs observed ${obs} at ${r.s.local}`);
      n++;
    }
    assert.ok(n >= 20);
  });
  it("after upstream resyncs (vti 15) it is in sync again and upstream's value is used", () => {
    const after = rows.filter((r) => r.s.vti === 15 && r.s.local >= at(22, 56, 10));
    assert.ok(after.length >= 3);
    for (const r of after) {
      assert.equal(r.o.stale, false);
      assert.equal(r.o.delay, r.delayUp);
    }
  });
  it("second stall (vti 18 for 15 min): GPS delay <= +3 min where upstream reaches +11", () => {
    const rb = replay(loadFx("stall-116-b"));
    const stalled = rb.filter((r) => r.s.vti === 18 && r.s.ndi === 19 && r.s.local >= at(23, 2));
    assert.ok(stalled.length > 20);
    assert.ok(Math.max(...stalled.map((r) => r.delayUp ?? 0)) >= 600);
    for (const r of stalled) assert.ok(r.o.delay === null || (r.o.delay <= 180 && r.o.delay >= -120), `GPS ${r.o.delay} at ${r.s.local}`);
    assert.ok(stalled.filter((r) => r.o.src === "gps").length > 15);
  });
});

describe("midnight", () => {
  it("a trip running across midnight gives exactly the same result as the same trip shifted into the afternoon", () => {
    const fx = loadFx("stall-116");
    const shift = (secs: number): Fx => {
      const hm = (v: string | null): string | null => {
        const x = hhmm(v);
        if (x === null) return null;
        const y = (x + secs + 86400) % 86400;
        return `${String(Math.floor(y / 3600)).padStart(2, "0")}:${String(Math.floor(y / 60) % 60).padStart(2, "0")}`;
      };
      return {
        stops: fx.stops.map((st) => ({ ...st, plan: hm(st.plan) as string })),
        samples: fx.samples.map((sm) => ({ ...sm, local: (sm.local + secs + 86400) % 86400, est0: hm(sm.est0) })),
      };
    };
    const base = replay(fx);
    // 22:49 -> 00:09: the first stops are planned before and the rest after midnight
    const night = replay(shift(80 * 60));
    // 22:49 -> 14:49 (no midnight in the trip at all)
    const noon = replay(shift(-8 * 3600));
    assert.ok(night.every((r) => r.s.local < 3600), "polls are after midnight while the first stops are planned before it");
    base.forEach((r, i) => {
      for (const other of [night[i], noon[i]]) {
        assert.equal(other.o.stale, r.o.stale);
        assert.equal(other.o.lastIdx, r.o.lastIdx);
        assert.equal(other.delayUp, r.delayUp);
        assert.ok(
          (other.o.delay === null && r.o.delay === null) || Math.abs(other.o.delay! - r.o.delay!) < 1e-6,
          `delay ${other.o.delay} vs ${r.o.delay} at sample ${i}`,
        );
      }
    });
  });
});

describe("out-and-back spur: index stuck at the apex while the bus drives the return leg (real capture, line 136)", () => {
  const rows = replay(loadFx("spur-136"));
  it("locks onto the RETURN leg from the first poll (vti is a lower bound) and flags the index stale", () => {
    assert.equal(rows[0].s.vti, 23);
    assert.ok(rows[0].o.lastIdx! >= 25, `bus is past the return Centrum (25), got ${rows[0].o.lastIdx}`);
    assert.equal(rows[0].o.stale, true);
  });
  it("shows an EARLY bus where upstream's stale estimate says it is late", () => {
    const last = rows[rows.length - 1];
    assert.ok(last.delayUp! > 60, `upstream ${last.delayUp}`);
    assert.ok(last.o.delay! < -90, `GPS ${last.o.delay}`);
  });
});

describe("loop trip, upstream in sync (real capture, line 120, Szczyrk Biła loop)", () => {
  const fx = loadFx("healthy-120-loop");
  const rows = replay(fx);
  it("never flags stale and returns exactly upstream's value (zero behaviour change)", () => {
    assert.ok(rows.length > 30);
    for (const r of rows) {
      assert.equal(r.o.stale, false, `stale at ${r.s.local} last=${r.o.lastIdx} vti=${r.s.vti}`);
      assert.equal(r.o.delay, r.delayUp);
    }
  });
  it("tracks the bus monotonically through the loop apex and passes the loop stops in order", () => {
    let prev = -1;
    let maxLast = -1;
    for (const r of rows) {
      assert.ok(r.o.D! >= prev - 1e-6);
      prev = r.o.D!;
      maxLast = Math.max(maxLast, r.o.lastIdx!);
    }
    assert.ok(maxLast >= 28, `reached the end of the loop, last=${maxLast}`);
  });
});

describe("line 120 loop with a stalled index (the healthy capture, upstream frozen as observed on 116 / 136)", () => {
  const fx = loadFx("healthy-120-loop");
  const cr = crossings(fx);
  const plan = fx.stops.map((s) => hhmm(s.plan));
  const check = (label: string, vti: number, fromLocal: number, firstSample = 0): void => {
    const stuck = stuckAt(fx.samples, vti, vti + 1, fromLocal).slice(firstSample);
    const rows = replay(fx, stuck);
    it(`${label}: GPS progress follows the bus through the return leg, delay stays within ±2 min`, () => {
      let flagged = 0;
      let prevLast = -1;
      for (const r of rows) {
        if (r.s.local < fromLocal || !r.o.stale) continue;
        flagged++;
        const j = trueLast(cr, r.s.t / 1000);
        // the stops around the apex (22..25) are only ~190 m apart and the straight chords cut the real road,
        // so the index may run up to two stops ahead there for a poll or two
        const tol = j >= 21 && j <= 25 ? 2 : 1;
        assert.ok(Math.abs(r.o.lastIdx! - j) <= tol, `last ${r.o.lastIdx} vs true ${j} at ${r.s.local}`);
        assert.ok(r.o.lastIdx! >= prevLast, "progress never goes backwards");
        prevLast = r.o.lastIdx!;
        const crossLocal = r.s.local - (r.s.t / 1000 - (cr[j] as number));
        const obs = wrap(crossLocal - (plan[j] as number));
        if (r.o.src === "gps") assert.ok(Math.abs(r.o.delay! - obs) <= 120, `GPS ${r.o.delay} vs observed ${obs} at ${r.s.local}`);
      }
      assert.ok(flagged >= 15, `stale detected for ${flagged} polls`);
      const lastRow = rows[rows.length - 1];
      assert.ok(lastRow.delayUp! >= 240, `upstream would show ${lastRow.delayUp}`);
      assert.ok(Math.abs(lastRow.o.delay!) <= 120, `GPS ${lastRow.o.delay}`);
      assert.ok(lastRow.o.lastIdx! >= 28);
    });
  };
  // stuck right after the apex (Biła -> Beskid Arena): the state of the screenshot (bus past Nowy Kościół, header +5 min)
  check("index stuck at the apex (vti 23 / ndi 24)", 23, at(23, 3, 40));
  // stuck BEFORE the loop: neither the outbound loop stops nor the return leg are ever registered
  check("index stuck at Szczyrk Centrum (vti 19 / ndi 20)", 19, at(22, 58, 0));
  // cold start (server restart) in the middle of the return leg
  check("cold start on the return leg, index stuck at the apex", 23, at(23, 3, 40), 30);
  it("feeding the GPS index to the client's findActiveStop keeps the bus on the return leg", () => {
    const stuck = stuckAt(fx.samples, 19, 20, at(22, 58, 0));
    const rows = replay(fx, stuck);
    const pts = fx.stops.map((s) => (s.lat !== null && s.lon !== null ? { lat: s.lat, lon: s.lon } : null));
    let checked = 0;
    for (const r of rows) {
      if (!r.o.stale || r.o.lastIdx === null || r.o.lastIdx < 25 || r.o.lastIdx > 28) continue;
      const res = findActiveStop(pts, { lat: r.s.lat, lon: r.s.lon, at_stop: false, current_stop_sequence: r.o.lastIdx }, r.o.lastIdx);
      assert.ok(res.index >= r.o.lastIdx && res.index <= r.o.lastIdx + 1, `client index ${res.index} vs GPS last ${r.o.lastIdx} at ${r.s.local}`);
      checked++;
    }
    assert.ok(checked >= 8, `checked ${checked}`);
  });
});

/* ------------------------------------------------------------------ poller glue */

describe("isFeedStale tests upstream's raw delay", () => {
  it("a GPS-replaced delay must not hide a frozen feed from the ghost filter", () => {
    const frozen = { delay: 30, delayUp: null, lastMovedAt: 0 };
    assert.equal(isFeedStale(frozen, 1000, 300), true);
    assert.equal(isFeedStale({ delay: 30, delayUp: 30, lastMovedAt: 0 }, 1000, 300), false);
    assert.equal(isFeedStale({ delay: null, lastMovedAt: 0 }, 1000, 300), true, "MZK-style vehicle without delayUp");
    assert.equal(isFeedStale({ delay: null, delayUp: null, lastMovedAt: 900 }, 1000, 300), false, "moved recently");
  });
});

describe("stepArrivals", () => {
  it("baselines the first sighting, stamps reached stops, nulls skipped ones and stale gaps", () => {
    let a = stepArrivals(undefined, 3, 1000, 1000);
    assert.deepEqual(a.arrived, [], "stops passed before the first sighting stay unknown");
    a = stepArrivals(a, 3, 1010, 1008);
    assert.deepEqual(a.arrived, []);
    a = stepArrivals(a, 4, 1020, 1015);
    assert.deepEqual(a.arrived, [null, null, null, null, 1015]);
    a = stepArrivals(a, 6, 1030, 1025);
    assert.deepEqual(a.arrived, [null, null, null, null, 1015, null, 1025], "a jump stamps only the reached stop");
    a = stepArrivals(a, 5, 1040, 1040);
    assert.equal(a.reached, 6, "never goes back");
    a = stepArrivals(a, 7, 1200, 1190);
    assert.equal(a.arrived[7], null, "reached at an unknown moment inside a long poll gap");
    a = stepArrivals(a, 12, 1210, 1205);
    assert.equal(a.arrived[12], null, "a 5-stop jump in one poll is a resync, not an arrival");
    a = stepArrivals(a, 13, 1220, 1215);
    assert.equal(a.arrived[13], 1215);
  });
});
