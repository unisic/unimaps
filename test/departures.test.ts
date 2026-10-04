import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GONE_AFTER_AT_STOP_SEC,
  GONE_AFTER_SEC,
  KB_REL_BIAS_SEC,
  compareBoardItems,
  enrichKbRow,
  delayMinutes,
  etaClock,
  etaLabel,
  hhmm,
  isGone,
  kbAnchorTs,
  kbRowKey,
  kbTiming,
  minutesUntil,
  mzkRowKey,
  mzkTiming,
  mzkWireFields,
  nextEarlierHorizon,
  nextLaterHorizon,
  boardExtension,
  autoLaterHorizon,
  schedTiming,
  schedTripKey,
  schedVehicle,
  vehicleTripKey,
  parseClockNear,
  parseRelMinutes,
  pickDirection,
  preSortRows,
  resolveTiming,
  rowKey,
  sortBoard,
  uniqueKeys,
  warsawDateISO,
  warsawDayTs,
  type BoardItem,
  type TimingRow,
} from "../lib/shared/departures";

/** epoch seconds of a Warsaw wall-clock instant (CEST +02:00 in October, CET +01:00 in winter) */
const at = (iso: string): number => Date.parse(iso) / 1000;
const D = "2026-10-02";
const cest = (hms: string, day = D) => at(`${day}T${hms}+02:00`);

/* ---- real upstream rows captured 2026-10-02 22:49-23:05 (trimmed) ---- */

/** KB board row, BYSTRA CENTRUM 22:49:18.273 — a bus whose delay keeps growing */
const KB_116 = { time: "8 min", static_time: "2 min", time_diff: 5, at_stop: false, canceled: false, is_estimated: true, direction_id: 39764000, line_name: "116", trip_id: 51750655, trip_execution_id: "3229:739891:0", trip_index: 12 };
/** KB board row, SZCZYRK CENTRUM 22:59:24 — the bus STANDS at the stop: time null, no static_time, no time_diff */
const KB_AT_STOP = { time: null, at_stop: true, canceled: false, is_estimated: true, direction_id: 40118000, line_name: "120", trip_id: 50763986, trip_execution_id: "4263:739891:0", trip_index: 19 };
/** KB board row, BIELSKO-BIAŁA 3 MAJA DWORZEC 23:00 — timetable only */
const KB_SCHEDULED = { time: "6 min", static_time: "6 min", time_diff: 0, at_stop: false, canceled: false, is_estimated: false, direction_id: 39660000, line_name: "140", trip_id: 38671957, trip_execution_id: "1046:739891:0", trip_index: 36 };
/** KB board row, 3 MAJA DWORZEC 23:00 — 4 min late (time_diff is MINUTES) */
const KB_LATE = { time: "20 min", static_time: "16 min", time_diff: 3, at_stop: false, canceled: false, is_estimated: true, direction_id: 39660000, line_name: "142", trip_id: 38672085, trip_execution_id: "1454:739891:0", trip_index: 57 };

describe("parseRelMinutes", () => {
  it("reads KB's whole-minute strings", () => {
    assert.equal(parseRelMinutes("5 min"), 5);
    assert.equal(parseRelMinutes("32 min"), 32);
    assert.equal(parseRelMinutes(" 7 min "), 7);
    assert.equal(parseRelMinutes("< 1 min"), 0);
    assert.equal(parseRelMinutes("<1 min"), 0);
    assert.equal(parseRelMinutes("5 Min."), 5);
  });
  it("returns null for anything that is not a relative minute count", () => {
    for (const v of ["23:12", "", "   ", null, undefined, 5, "teraz", "1 h 5 min", "abc"]) assert.equal(parseRelMinutes(v), null, String(v));
  });
});

describe("kbTiming", () => {
  const anchor = cest("22:49:18") + 0.273;
  it("estimated row: eta = anchor + N min (+29 s), delay minutes → seconds", () => {
    const t = kbTiming(KB_116, anchor);
    assert.equal(t.eta_ts, anchor + 8 * 60 + KB_REL_BIAS_SEC);
    assert.equal(t.plan_ts, cest("22:52:00")); // static "2 min" at 22:49:18 → the trip's planned departure_time (22:52)
    assert.equal(t.delay_sec, 300); // time_diff 5 MINUTES — the old UI fed 5 into a seconds formatter ("o czasie")
    assert.equal(t.at_stop, false);
    assert.equal(t.canceled, false);
    // the countdown prints exactly what KB printed, at fetch time
    assert.equal(minutesUntil({ etaTs: t.eta_ts, atStop: false }, anchor), 8);
  });
  it("at_stop row (time null, no static_time, no time_diff): eta = anchor, no plan, no delay", () => {
    const t = kbTiming(KB_AT_STOP, anchor);
    assert.deepEqual({ ...t }, { plan_ts: null, eta_ts: anchor, delay_sec: null, at_stop: true, canceled: false });
  });
  it("timetable-only row has no delay even though time_diff is present", () => {
    const t = kbTiming(KB_SCHEDULED, anchor);
    assert.equal(t.delay_sec, null);
    assert.equal(t.eta_ts, anchor + 6 * 60 + KB_REL_BIAS_SEC);
  });
  it("'< 1 min' is within the next minute, an unparseable time has no eta", () => {
    assert.equal(kbTiming({ time: "< 1 min", is_estimated: true }, 1000).eta_ts, 1000 + KB_REL_BIAS_SEC);
    assert.equal(kbTiming({ time: "soon", is_estimated: true }, 1000).eta_ts, null);
    assert.equal(kbTiming({ time: null, is_estimated: true }, 1000).eta_ts, null); // null WITHOUT at_stop: unknown, not 'now'
  });
  it("carries the canceled flag", () => {
    assert.equal(kbTiming({ time: "9 min", static_time: "9 min", canceled: true }, 0).canceled, true);
  });
});

describe("mzkTiming", () => {
  // stop 255, line 3 veh 170, 22:56: sched 23:08:00, real 23:09:27
  const d = { scheduledDeparture: cest("23:08:00") * 1000, realDeparture: cest("23:09:27") * 1000, lack: false, onStopPoint: false };
  it("keeps real instants (no HH:MM round trip) and a seconds delay", () => {
    assert.deepEqual({ ...mzkTiming(d) }, { plan_ts: cest("23:08:00"), eta_ts: cest("23:09:27"), delay_sec: 87, at_stop: false, canceled: false });
  });
  it("lack (no vehicle) or no realDeparture = scheduled only", () => {
    assert.equal(mzkTiming({ ...d, lack: true, realDeparture: 0 }).eta_ts, null);
    assert.equal(mzkTiming({ ...d, lack: true }).delay_sec, null);
    assert.equal(mzkTiming({ ...d, realDeparture: 0 }).eta_ts, null);
  });
  it("ignores OnTime's `passed` flag (it flips ±25 s around realDeparture; isGone's clock rule decides)", () => {
    const flagged = { ...d, passed: true };
    assert.deepEqual({ ...mzkTiming(flagged) }, { ...mzkTiming(d) });
    assert.equal(mzkTiming(flagged).eta_ts, cest("23:09:27"));
  });
  it("a zero/missing scheduledDeparture is 'unknown', never 1970", () => {
    assert.equal(mzkTiming({ ...d, scheduledDeparture: 0 }).plan_ts, null);
    assert.equal(mzkTiming({ ...d, scheduledDeparture: Number.NaN }).plan_ts, null);
    assert.equal(mzkTiming({ ...d, scheduledDeparture: 0 }).delay_sec, null);
  });
  it("onStopPoint is NOT 'leaving now' (a bus waiting at its first stop has it set minutes before departure)", () => {
    assert.equal(mzkTiming({ ...d, onStopPoint: true }).at_stop, false);
    // REAL record, getRealtime(132 Osiedle Kopernika) 22:58:14 — bus 240 waits at its origin, real departure 23:05:00
    const waiting = { courseId: 5088601, orderInCourse: 0, scheduledDeparture: 1790975160000, realDeparture: 1790975100000, lack: false, onStopPoint: true };
    const now = 1790974694.231;
    const t = resolveTiming({ operator: "MZK", ...mzkWireFields(waiting) }, null);
    assert.equal(t.atStop, false);
    assert.equal(etaLabel(t, now), "7 min");
    assert.equal(minutesUntil(t, now), 7);
  });
  it("a post-midnight departure is an unambiguous instant", () => {
    const next = cest("00:01:00", "2026-10-03");
    assert.equal(mzkTiming({ ...d, scheduledDeparture: next * 1000, realDeparture: next * 1000 }).plan_ts, next);
  });
});

describe("pickDirection", () => {
  const directions = { "39660000": "BIELSKO-BIAŁA D.A." };
  it("resolves KB's direction_id through the board's top-level map ('Linia 119' fix)", () => {
    assert.equal(pickDirection({ direction_id: 39660000 }, directions), "BIELSKO-BIAŁA D.A.");
  });
  it("keeps an existing direction, tolerates missing maps and ids, ignores inherited keys", () => {
    assert.equal(pickDirection({ direction: "X", direction_id: 39660000 }, directions), "X");
    assert.equal(pickDirection({ direction_id: 1 }, directions), undefined);
    assert.equal(pickDirection({ direction_id: 1 }, undefined), undefined);
    assert.equal(pickDirection({}, directions), undefined);
    assert.equal(pickDirection({ direction_id: "constructor" }, {}), undefined);
  });
});

describe("resolveTiming", () => {
  const plan = cest("15:12:00");
  const mzk: TimingRow = { operator: "MZK", plan_ts: plan, eta_ts: cest("15:19:00"), delay_sec: 420, is_estimated: true };
  it("MZK + matched vehicle: plan + the live vehicle delay", () => {
    const t = resolveTiming(mzk, { delay: 960 });
    assert.equal(t.etaTs, plan + 960);
    assert.equal(t.delaySec, 960);
    assert.equal(t.source, "vehicle");
    assert.equal(t.estimated, true);
  });
  it("MZK without a vehicle: the operator's stop-level estimate", () => {
    const t = resolveTiming(mzk, null);
    assert.equal(t.etaTs, cest("15:19:00"));
    assert.equal(t.delaySec, 420);
    assert.equal(t.source, "stop");
    assert.equal(resolveTiming(mzk, { delay: null }).source, "stop");
  });
  it("MZK scheduled-only (lack): timetable, not 'estimated'", () => {
    const t = resolveTiming({ operator: "MZK", plan_ts: plan, eta_ts: null, delay_sec: null }, null);
    assert.deepEqual({ ...t }, { etaTs: plan, planTs: plan, delaySec: null, estimated: false, atStop: false, canceled: false, source: "schedule" });
  });
  it("KB: the board's own time wins over the vehicle delay (same snapshot as the printed number)", () => {
    const t = resolveTiming({ operator: "KB", ...kbTiming(KB_LATE, 1000), is_estimated: true }, { delay: 900 });
    assert.equal(t.source, "board");
    assert.equal(t.etaTs, 1000 + 20 * 60 + KB_REL_BIAS_SEC);
    assert.equal(t.delaySec, 180);
  });
  it("KB at_stop: no time_diff upstream, so the vehicle delay labels it", () => {
    const row = { operator: "KB" as const, ...kbTiming(KB_AT_STOP, 5000), is_estimated: true };
    assert.equal(resolveTiming(row, { delay: 120 }).delaySec, 120);
    assert.equal(resolveTiming(row, null).delaySec, null);
    assert.equal(resolveTiming(row, null).atStop, true);
  });
  it("KB timetable-only row is not estimated and has no delay", () => {
    const t = resolveTiming({ operator: "KB", ...kbTiming(KB_SCHEDULED, 1000), is_estimated: false }, { delay: 600 });
    assert.equal(t.estimated, false);
    assert.equal(t.delaySec, null);
  });
  it("a canceled MZK row never takes a vehicle delay", () => {
    assert.equal(resolveTiming({ ...mzk, canceled: true }, { delay: 600 }).source, "stop");
  });
  it("nothing known → null eta", () => {
    assert.equal(resolveTiming({ operator: "KB" }, null).etaTs, null);
    assert.equal(resolveTiming({ operator: "KB" }, null).source, "none");
  });
});

describe("hhmm / etaLabel", () => {
  it("formats on the Warsaw wall clock, summer and winter, midnight as 00:xx", () => {
    assert.equal(hhmm(at("2026-10-02T23:05:00+02:00")), "23:05");
    assert.equal(hhmm(at("2026-10-03T00:05:00+02:00")), "00:05");
    assert.equal(hhmm(at("2026-12-01T00:05:00+01:00")), "00:05");
    assert.equal(hhmm(at("2026-12-01T23:59:59+01:00")), "23:59");
  });
  const base = { planTs: null, delaySec: null, estimated: true, atStop: false, canceled: false, source: "stop" as const };
  const now = cest("23:55:00");
  it("counts down in minutes across midnight (no wrap logic needed: epoch seconds)", () => {
    assert.equal(etaLabel({ ...base, etaTs: cest("00:05:00", "2026-10-03") }, now), "10 min");
    assert.equal(etaLabel({ ...base, etaTs: now + 89 }, now), "1 min");
    assert.equal(etaLabel({ ...base, etaTs: now + 91 }, now), "2 min");
    assert.equal(etaLabel({ ...base, etaTs: now + 29 }, now), "teraz");
    assert.equal(etaLabel({ ...base, etaTs: now - 40 }, now), "teraz");
  });
  it("switches to the clock time from one hour on", () => {
    assert.equal(etaLabel({ ...base, etaTs: now + 59 * 60 }, now), "59 min");
    assert.equal(etaLabel({ ...base, etaTs: cest("01:10:00", "2026-10-03") }, now), "01:10");
  });
  it("timetable-only → clock time; canceled → odwołany; standing → odjeżdża; unknown → fallback", () => {
    assert.equal(etaLabel({ ...base, source: "schedule", etaTs: cest("23:59:00") }, now), "23:59");
    assert.equal(etaLabel({ ...base, canceled: true, etaTs: now + 60 }, now), "odwołany");
    assert.equal(etaLabel({ ...base, atStop: true, etaTs: now }, now), "odjeżdża");
    assert.equal(etaLabel({ ...base, etaTs: null }, now, "5 min"), "5 min");
    assert.equal(etaLabel({ ...base, etaTs: null }, now), "");
  });
  it("the printed minute IS the sort bucket (property over every second of a 70 min window)", () => {
    for (let dt = -90; dt <= 70 * 60; dt++) {
      const tm = { ...base, etaTs: now + dt };
      const mins = minutesUntil(tm, now);
      const label = etaLabel(tm, now);
      if (mins === 0) assert.equal(label, "teraz", `dt=${dt}`);
      else if (mins < 60) assert.equal(label, `${mins} min`, `dt=${dt}`);
      else assert.equal(label, hhmm(now + mins * 60), `dt=${dt}`); // the 59 min → clock switch never skips or repeats a minute
    }
  });
  it("etaClock rounds like the delay label: printed plan + printed delay = printed time", () => {
    const plan = cest("18:40:00");
    assert.equal(etaClock({ planTs: plan, etaTs: plan + 150 }), "18:43"); // hhmm alone: 18:42 next to "+3 min"
    assert.equal(etaClock({ planTs: plan, etaTs: plan - 150 }), "18:37");
    assert.equal(etaClock({ planTs: plan, etaTs: plan + 29 }), "18:40");
    assert.equal(etaClock({ planTs: null, etaTs: cest("18:42:30") }), "18:43");
    assert.equal(etaClock({ planTs: null, etaTs: cest("18:42:29") }), "18:42");
    assert.equal(etaClock({ planTs: plan, etaTs: null }), "");
    for (let d = -900; d <= 900; d++) {
      assert.equal(etaClock({ planTs: plan, etaTs: plan + d }), hhmm(plan + delayMinutes(d) * 60), `d=${d}`);
    }
  });
  it("the printed KB number equals KB's own at fetch time and ticks down per minute", () => {
    const anchor = cest("22:49:18");
    const t = { ...base, etaTs: anchor + 8 * 60 + KB_REL_BIAS_SEC };
    assert.equal(etaLabel(t, anchor), "8 min");
    assert.equal(etaLabel(t, anchor + 58), "8 min");
    assert.equal(etaLabel(t, anchor + 61), "7 min");
    assert.equal(etaLabel(t, anchor + 8 * 60), "teraz");
  });
});

describe("isGone", () => {
  it("hides a departure once its estimate is more than a minute in the past", () => {
    const now = 10_000;
    assert.equal(isGone({ etaTs: now - GONE_AFTER_SEC + 1, atStop: false }, now), false);
    assert.equal(isGone({ etaTs: now - GONE_AFTER_SEC - 1, atStop: false }, now), true);
    assert.equal(isGone({ etaTs: null, atStop: false }, now), false);
  });
  it("a bus still standing at the stop is kept longer", () => {
    const now = 10_000;
    assert.equal(isGone({ etaTs: now - GONE_AFTER_SEC - 1, atStop: true }, now), false);
    assert.equal(isGone({ etaTs: now - GONE_AFTER_AT_STOP_SEC - 1, atStop: true }, now), true);
  });
});


/* ---- the route glue, on a REAL board (BIELSKO-BIAŁA 3 MAJA DWORZEC, captured 23:00:00 — response `timestamp` 1790974799) ---- */
const REAL_BOARD = {
  timestamp: 1790974799,
  rows: [
    { time: "6 min", static_time: "6 min", time_diff: 0, at_stop: false, canceled: false, is_estimated: false, direction_id: 39660000, platform: "1", deviation_id: null, line_name: "140", show_line_name: true, vehicle_type: 0, vehicle_attributes: [], trip_id: 38671957, trip_execution_id: "1046:739891:0", trip_index: 36, passenger_load: null },
    { time: "14 min", static_time: "14 min", time_diff: 0, at_stop: false, canceled: false, is_estimated: true, direction_id: 39660000, platform: "1", deviation_id: null, line_name: "136", show_line_name: true, vehicle_type: 0, vehicle_attributes: [], trip_id: 51272520, trip_execution_id: "1650:739891:0", trip_index: 32, passenger_load: null },
    { time: "20 min", static_time: "16 min", time_diff: 3, at_stop: false, canceled: false, is_estimated: true, direction_id: 39660000, platform: "1", deviation_id: null, line_name: "142", show_line_name: true, vehicle_type: 0, vehicle_attributes: [], trip_id: 38672085, trip_execution_id: "1454:739891:0", trip_index: 57, passenger_load: null },
  ],
  directions: { "39660000": "BIELSKO-BIAŁA D.A." },
};

describe("kbAnchorTs", () => {
  it("uses upstream's own timestamp when it is sane, else our receive time", () => {
    assert.equal(kbAnchorTs(1000, 1010), 1000);
    assert.equal(kbAnchorTs(1000, 1119.9), 1000);
    assert.equal(kbAnchorTs(1000, 1500), 1500); // 8 min off: a stale/foreign timestamp must not skew every ETA
    assert.equal(kbAnchorTs(undefined, 1500), 1500);
    assert.equal(kbAnchorTs("1000", 1500), 1500);
    assert.equal(kbAnchorTs(Number.NaN, 1500), 1500);
  });
});

describe("enrichKbRow on a real board", () => {
  const anchor = kbAnchorTs(REAL_BOARD.timestamp, REAL_BOARD.timestamp + 0.3);
  const rows = REAL_BOARD.rows.map((r) => enrichKbRow(r, REAL_BOARD.directions, anchor));
  it("resolves the destination through the board's directions map ('Linia 140' → 'BIELSKO-BIAŁA D.A.')", () => {
    assert.deepEqual(rows.map((r) => r.direction), ["BIELSKO-BIAŁA D.A.", "BIELSKO-BIAŁA D.A.", "BIELSKO-BIAŁA D.A."]);
  });
  it("adds absolute timing and keeps every upstream field", () => {
    assert.equal(rows[2].operator, "KB");
    assert.equal(rows[2].eta_ts, anchor + 20 * 60 + KB_REL_BIAS_SEC);
    assert.equal(rows[2].delay_sec, 180); // time_diff 3 MINUTES
    assert.equal(rows[0].delay_sec, null); // timetable-only
    assert.equal(rows[2].time, "20 min");
    assert.equal(rows[2].time_diff, 3);
    assert.equal(rows[2].platform, "1");
    assert.equal(rows[2].trip_id, 38672085);
    assert.equal(rows[2].row_key, "1454:739891:0#57");
  });
  it("does not mutate the upstream row", () => {
    assert.equal((REAL_BOARD.rows[0] as Record<string, unknown>).operator, undefined);
    assert.equal((REAL_BOARD.rows[0] as Record<string, unknown>).eta_ts, undefined);
  });
  it("an at_stop row (time null) keeps its place first once merged with MZK rows", () => {
    const standing = enrichKbRow(KB_AT_STOP, { "40118000": "SZCZYRK SALMOPOL (SOLISKO)" }, anchor);
    assert.equal(standing.direction, "SZCZYRK SALMOPOL (SOLISKO)");
    const mzk = { operator: "MZK" as const, line_name: "4", ...mzkWireFields({ courseId: 9, orderInCourse: 2, scheduledDeparture: (anchor + 180) * 1000, realDeparture: (anchor + 180) * 1000, lack: false, onStopPoint: false }) };
    const merged = preSortRows([mzk, ...rows, standing], anchor);
    assert.deepEqual(merged.map((r) => r.line_name), ["120", "4", "140", "136", "142"]);
  });
});

describe("mzkWireFields", () => {
  it("adds instants, delay, at_stop, index and a vehicle-free key", () => {
    const d = { courseId: 5088502, orderInCourse: 4, scheduledDeparture: cest("23:23:00") * 1000, realDeparture: cest("23:22:00") * 1000, lack: false, onStopPoint: false };
    assert.deepEqual({ ...mzkWireFields(d) }, { plan_ts: cest("23:23:00"), eta_ts: cest("23:22:00"), delay_sec: -60, at_stop: false, canceled: false, trip_index: 4, row_key: "mzk:5088502#4" });
  });
});

/* ------------------------------------------------------------------ ordering */

interface Spec {
  op: "KB" | "MZK";
  line: string;
  /** minutes from now to the displayed ETA, or null = unknown */
  min?: number | null;
  planMin?: number;
  atStop?: boolean;
  canceled?: boolean;
  sched?: boolean;
  key?: string;
}
const NOW = cest("15:22:00");
function item(s: Spec, now = NOW): BoardItem {
  const eta = s.min == null ? null : now + s.min * 60;
  const row: TimingRow = {
    operator: s.op,
    line_name: s.line,
    plan_ts: s.planMin != null ? now + s.planMin * 60 : eta,
    eta_ts: s.sched ? null : eta,
    delay_sec: 0,
    is_estimated: !s.sched,
    at_stop: s.atStop,
    canceled: s.canceled,
    row_key: s.key ?? `${s.op}-${s.line}-${s.min}`,
  };
  return { row, timing: resolveTiming(row, null) };
}

describe("sortBoard — screenshot C (15:22, Bielsko-Biała Partyzantów Andersa, KB + MZK)", () => {
  /* The old route sorted on the STOP-level estimate (#170 ≈ 15:19) while the list showed plan + the
     VEHICLE-level delay (#170: 15:12 + 16 min = 15:28 → "6 min"): the 6-minute bus sat above 1/2/4-minute ones. */
  const mk = (line: string, side: string, planHHMM: string, stopEta: string, vehDelay: number): { row: TimingRow; veh: { delay: number } } => ({
    row: { operator: "MZK", line_name: line, symbol: side, plan_ts: cest(`${planHHMM}:00`), eta_ts: cest(`${stopEta}:00`), row_key: `mzk:${side}`, is_estimated: true },
    veh: { delay: vehDelay },
  });
  const kb119: TimingRow = { operator: "KB", line_name: "119", ...kbTiming({ time: "4 min", static_time: "< 1 min", time_diff: 5, is_estimated: true, at_stop: false }, NOW), is_estimated: true, row_key: "kb119#7" };
  const specs = [
    mk("10", "170", "15:12", "15:19", 960), // not-started bus: vehicle delay +16 min, stop-level only +7
    mk("57", "151", "15:17", "15:23", 360),
    mk("24", "191", "15:24", "15:24", 0),
    mk("10", "226", "15:27", "15:29", 120),
  ];
  const items = [...specs.map((s) => ({ row: s.row, timing: resolveTiming(s.row, s.veh) })), { row: kb119, timing: resolveTiming(kb119, { delay: 300 }) }];
  it("lists them by the countdown the rider reads", () => {
    const sorted = sortBoard(items, NOW);
    assert.deepEqual(
      sorted.map((i) => [i.row.line_name, etaLabel(i.timing, NOW)]),
      [["57", "1 min"], ["24", "2 min"], ["119", "4 min"], ["10", "6 min"], ["10", "7 min"]],
    );
    assert.equal(sorted[3].row.symbol, "170");
    assert.equal(sorted[4].row.symbol, "226");
  });
  it("the printed minutes never decrease down the list", () => {
    const mins = sortBoard(items, NOW).map((i) => minutesUntil(i.timing, NOW));
    assert.deepEqual(mins, [...mins].sort((a, b) => a - b));
  });
});

describe("sortBoard — midnight", () => {
  const now = cest("23:55:00");
  const row = (op: "KB" | "MZK", line: string, etaTs: number, key: string): BoardItem => {
    const r: TimingRow = { operator: op, line_name: line, plan_ts: etaTs, eta_ts: etaTs, is_estimated: true, row_key: key };
    return { row: r, timing: resolveTiming(r, null) };
  };
  it("a 00:05 MZK departure is 10 min away at 23:55, after a 23:58 one and before a KB '12 min'", () => {
    const a = row("MZK", "5", cest("23:58:00"), "a");
    const b = row("MZK", "7", cest("00:05:00", "2026-10-03"), "b"); // the OLD key read "00:05" as 300 s and listed it FIRST
    const kb = { operator: "KB" as const, line_name: "120", ...kbTiming({ time: "12 min", static_time: "12 min", is_estimated: true }, now), is_estimated: true, row_key: "kb" };
    const items = [{ row: kb, timing: resolveTiming(kb, null) }, b, a];
    assert.deepEqual(sortBoard(items, now).map((i) => i.row.row_key), ["a", "b", "kb"]);
    assert.deepEqual(sortBoard(items, now).map((i) => etaLabel(i.timing, now)), ["3 min", "10 min", "12 min"]);
  });
  it("a night bus scheduled for 01:17 is the LAST row at 23:04 (it used to be the first one)", () => {
    const n = cest("23:04:00");
    const night = { operator: "MZK" as const, line_name: "502", plan_ts: cest("01:17:00", "2026-10-03"), eta_ts: null, delay_sec: null, row_key: "night" };
    const kb = { operator: "KB" as const, line_name: "140", ...kbTiming({ time: "4 min", static_time: "4 min", is_estimated: false }, n), row_key: "kb" };
    const m4 = { operator: "MZK" as const, line_name: "4", plan_ts: cest("23:12:00"), eta_ts: cest("23:11:00"), delay_sec: -60, row_key: "m4" };
    const items = [night, kb, m4].map((row) => ({ row, timing: resolveTiming(row, null) }));
    const sorted = sortBoard(items, n);
    assert.deepEqual(sorted.map((i) => i.row.row_key), ["kb", "m4", "night"]);
    assert.equal(etaLabel(sorted[2].timing, n), "01:17");
  });
});

describe("compareBoardItems — special rows", () => {
  it("a bus standing at the stop (time null) is first — the old key sorted it LAST", () => {
    const standing = item({ op: "KB", line: "120", min: null, atStop: true, key: "standing" });
    const items = [item({ op: "KB", line: "142", min: 0, key: "now" }), item({ op: "MZK", line: "3", min: 5, key: "five" }), standing];
    assert.equal(sortBoard(items, NOW)[0].row.row_key, "standing");
    assert.equal(etaLabel(standing.timing, NOW), "odjeżdża");
  });
  it("canceled departures go last (even when nominally the nearest)", () => {
    const items = [item({ op: "KB", line: "1", min: 1, canceled: true, key: "x" }), item({ op: "MZK", line: "2", min: 30, key: "y" }), item({ op: "KB", line: "3", min: 5, key: "z" })];
    assert.deepEqual(sortBoard(items, NOW).map((i) => i.row.row_key), ["z", "y", "x"]);
  });
  it("unknown ETA goes after known ones (but before nothing it should not)", () => {
    const items = [item({ op: "KB", line: "9", min: null, key: "unk" }), item({ op: "MZK", line: "8", min: 90, key: "far" }), item({ op: "KB", line: "7", min: 2, key: "near" })];
    assert.deepEqual(sortBoard(items, NOW).map((i) => i.row.row_key), ["near", "far", "unk"]);
  });
  it("same printed minute: line number in natural order, then plan, then key — seconds never matter", () => {
    const mk = (line: string, secs: number, key: string, planMin = 5): BoardItem => {
      const r: TimingRow = { operator: "MZK", line_name: line, plan_ts: NOW + planMin * 60, eta_ts: NOW + secs, row_key: key };
      return { row: r, timing: resolveTiming(r, null) };
    };
    // 301 s and 329 s both print "5 min"; 17 < 119 numerically although "119" < "17" as text
    const a = mk("119", 301, "a");
    const b = mk("17", 329, "b");
    assert.deepEqual(sortBoard([a, b], NOW).map((i) => i.row.line_name), ["17", "119"]);
    // jitter: swap the seconds, the order must not change
    const a2 = mk("119", 329, "a");
    const b2 = mk("17", 301, "b");
    assert.deepEqual(sortBoard([a2, b2], NOW).map((i) => i.row.line_name), ["17", "119"]);
    // same line: earlier plan first; then key
    const c = mk("17", 310, "c", 6);
    const d = mk("17", 310, "d", 4);
    assert.deepEqual(sortBoard([c, d], NOW).map((i) => i.row.row_key), ["d", "c"]);
    const e = mk("17", 310, "e");
    const f = mk("17", 310, "f");
    assert.deepEqual(sortBoard([f, e], NOW).map((i) => i.row.row_key), ["e", "f"]);
  });
  it("is a total, input-order independent order (shuffles agree)", () => {
    const base = [
      item({ op: "KB", line: "119", min: 4, key: "1" }),
      item({ op: "MZK", line: "10", min: 6, key: "2" }),
      item({ op: "MZK", line: "10", min: 6, key: "3" }),
      item({ op: "MZK", line: "57", min: 1, key: "4" }),
      item({ op: "KB", line: "140", min: null, key: "5" }),
      item({ op: "KB", line: "142", min: 2, canceled: true, key: "6" }),
      item({ op: "MZK", line: "24", min: 0, atStop: true, key: "7" }),
    ];
    const ref = sortBoard(base, NOW).map((i) => i.row.row_key);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 50; n++) {
      const shuffled = [...base].sort(() => rnd() - 0.5);
      assert.deepEqual(sortBoard(shuffled, NOW).map((i) => i.row.row_key), ref);
    }
  });
  it("property: printed minutes are non-decreasing, canceled and unknown only at the tail", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 200; round++) {
      const items: BoardItem[] = [];
      const n = 3 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        items.push(
          item({
            op: rnd() < 0.5 ? "KB" : "MZK",
            line: String(1 + Math.floor(rnd() * 140)),
            min: r < 0.1 ? null : Math.round(rnd() * 140 - 1) / 2,
            atStop: rnd() < 0.05,
            canceled: rnd() < 0.08,
            sched: rnd() < 0.2,
            key: `r${round}-${i}`,
          }),
        );
      }
      const sorted = sortBoard(items, NOW);
      let phase = 0; // 0 live, 1 canceled
      let prev = -1;
      for (const it of sorted) {
        const m = minutesUntil(it.timing, NOW);
        if (it.timing.canceled) { phase = 1; prev = -1; }
        else assert.equal(phase, 0, "a live row after a canceled one");
        assert.ok(m >= prev, `minutes went down: ${prev} → ${m}`);
        prev = m;
      }
    }
  });
  it("compareBoardItems is antisymmetric and reflexive-zero", () => {
    const a = item({ op: "KB", line: "119", min: 4, key: "a" });
    const b = item({ op: "MZK", line: "10", min: 4, key: "b" });
    assert.equal(compareBoardItems(a, a, NOW), 0);
    assert.equal(Math.sign(compareBoardItems(a, b, NOW)), -Math.sign(compareBoardItems(b, a, NOW)));
  });
});

describe("sortBoard — departed rows", () => {
  it("drops rows whose estimate is over a minute past, keeps 'teraz' ones", () => {
    const items = [item({ op: "MZK", line: "1", min: -2, key: "gone" }), item({ op: "MZK", line: "2", min: -0.5, key: "teraz" }), item({ op: "MZK", line: "3", min: 3, key: "ok" })];
    assert.deepEqual(sortBoard(items, NOW).map((i) => i.row.row_key), ["teraz", "ok"]);
  });
});

describe("keys", () => {
  it("are stable across refetches (KB plan_ts jitter and an MZK vehicle being assigned must not change them)", () => {
    const k1 = kbRowKey("3229:739891:0", 12);
    assert.equal(k1, "3229:739891:0#12");
    assert.equal(mzkRowKey(5088502, 4), "mzk:5088502#4");
    const before = { operator: "MZK" as const, row_key: mzkRowKey(5090373, 17), trip_execution_id: "mzk:5090373:" };
    const after = { operator: "MZK" as const, row_key: mzkRowKey(5090373, 17), trip_execution_id: "mzk:5090373:248" };
    assert.equal(rowKey(before), rowKey(after));
  });
  it("fall back to exec/trip id + index + plan when the server sent no row_key", () => {
    assert.equal(rowKey({ trip_execution_id: "a:b:0", trip_index: 3, static_time: "5 min" }), "a:b:0#3#5 min");
    assert.equal(rowKey({ trip_id: 77 }), "77##");
  });
  it("uniqueKeys suffixes a repeated key (a loop visiting a stop twice)", () => {
    const rows = [{ row_key: "x" }, { row_key: "y" }, { row_key: "x" }, { row_key: "x" }];
    assert.deepEqual(uniqueKeys(rows), ["x", "y", "x~1", "x~2"]);
  });
});

describe("preSortRows (server)", () => {
  it("orders like a vehicle-less client", () => {
    const rows: TimingRow[] = [
      { operator: "MZK", line_name: "1", plan_ts: NOW + 3600, eta_ts: null, row_key: "late" },
      { operator: "KB", line_name: "120", ...kbTiming({ time: "4 min", static_time: "4 min", is_estimated: false }, NOW), row_key: "kb" },
      { operator: "MZK", line_name: "4", plan_ts: NOW + 600, eta_ts: NOW + 480, row_key: "mzk" },
    ];
    assert.deepEqual(preSortRows(rows, NOW).map((r) => r.row_key), ["kb", "mzk", "late"]);
  });
});

/* ------------------------------------------------- verifier additions (v2) */

describe("parseClockNear — KB prints far-off departures as a wall-clock HH:MM", () => {
  it("resolves to the nearest occurrence in [anchor-2h, anchor+22h) on the Warsaw clock", () => {
    const anchor = cest("14:20:30");
    assert.equal(parseClockNear("15:05", anchor), cest("15:05:00"));
    assert.equal(parseClockNear("14:20", anchor), cest("14:20:00"));
    assert.equal(parseClockNear("13:30", anchor), cest("13:30:00")); // 50 min in the past: a late bus, same day
    assert.equal(parseClockNear("5:10", anchor), cest("05:10:00", "2026-10-03")); // next morning
    assert.equal(parseClockNear("12:19", anchor), cest("12:19:00", "2026-10-03")); // > 2 h in the past = tomorrow
  });
  it("wraps midnight: at 23:50, 00:10 is tomorrow and 23:58 is today", () => {
    const anchor = cest("23:50:00");
    assert.equal(parseClockNear("00:10", anchor), cest("00:10:00", "2026-10-03"));
    assert.equal(parseClockNear("23:58", anchor), cest("23:58:00"));
  });
  it("is exact across the DST transitions (wall-clock minutes are not elapsed minutes)", () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET (clocks go back)
    const before = at("2026-10-25T01:30:00+02:00");
    assert.equal(parseClockNear("02:30", before), at("2026-10-25T02:30:00+02:00")); // first 02:30
    assert.equal(parseClockNear("03:10", before), at("2026-10-25T03:10:00+01:00")); // 100 wall minutes = 160 real ones
    // 2027-03-28 02:00 CET -> 03:00 CEST (clocks go forward)
    const spring = at("2027-03-28T01:30:00+01:00");
    assert.equal(parseClockNear("03:10", spring), at("2027-03-28T03:10:00+02:00")); // only 40 real minutes ahead
  });
  it("rejects anything that is not a clock time", () => {
    for (const v of ["5 min", "< 1 min", "", "24:00", "12:60", "ab:cd", null, undefined, 1230]) assert.equal(parseClockNear(v, cest("12:00:00")), null, String(v));
  });
});

describe("kbTiming — HH:MM dialect", () => {
  const anchor = cest("13:10:20");
  it("a far-off estimated departure: eta from the clock string, exact plan from static_time, delay from time_diff (minutes)", () => {
    const t = kbTiming({ time: "14:35", static_time: "14:30", time_diff: 5, is_estimated: true, at_stop: false }, anchor);
    assert.equal(t.eta_ts, cest("14:35:00"));
    assert.equal(t.plan_ts, cest("14:30:00"));
    assert.equal(t.delay_sec, 300);
  });
  it("a relative time with a clock static_time (mixed) keeps both readings", () => {
    const t = kbTiming({ time: "20 min", static_time: "13:28", time_diff: 2, is_estimated: true, at_stop: false }, anchor);
    assert.equal(t.eta_ts, anchor + 20 * 60 + KB_REL_BIAS_SEC);
    assert.equal(t.plan_ts, cest("13:28:00"));
  });
  it("a relative static_time N >= 1 yields the exact planned DEPARTURE: the next minute boundary at/after anchor + N min", () => {
    // REAL pairs (board static_time @ scan time → trip.times[trip_index].departure_time of the same trip), capture 22:49-23:07
    const real: Array<[number, string, string]> = [
      [1790974689.697, "9 min", "23:08"],
      [1790974360.857, "5 min", "22:58"],
      [1790974563.7, "10 min", "23:07"],
      [1790974487.668, "4 min", "22:59"],
      [1790974412.124, "8 min", "23:02"],
      [1790975217.078, "1 min", "23:08"],
    ];
    for (const [ts, st, dep] of real) assert.equal(kbTiming({ static_time: st, time: st }, ts).plan_ts, cest(`${dep}:00`), `${st} @ ${ts}`);
  });
  it("'< 1 min' saturates (a late bus's plan is in the past), so it yields no plan; an exact minute boundary stays", () => {
    assert.equal(kbTiming({ static_time: "< 1 min", time: "4 min" }, anchor).plan_ts, null);
    assert.equal(kbTiming({ static_time: "3 min", time: "3 min" }, cest("13:10:00") ).plan_ts, cest("13:13:00"));
  });
});

describe("sortBoard — KB clock rows are ordered by time, not by line", () => {
  const now = cest("13:10:20");
  const kb = (line: string, time: string, key: string): BoardItem => {
    const row: TimingRow = { operator: "KB", line_name: line, ...kbTiming({ time, static_time: time, time_diff: 0, is_estimated: false, at_stop: false }, now), is_estimated: false, row_key: key };
    return { row, timing: resolveTiming(row, null) };
  };
  it("14:20 (line 120) before 14:35 (line 116) although 116 < 120; a '45 min' row slots between", () => {
    const sorted = sortBoard([kb("116", "14:35", "a"), kb("119", "45 min", "c"), kb("120", "14:20", "b")], now);
    // "45 min" at 13:10:20 = 13:55:49, then 14:20, then 14:35
    assert.deepEqual(sorted.map((i) => i.row.line_name), ["119", "120", "116"]);
  });
  it("an MZK row at 14:00 sorts between two KB clock rows (no 'unknown ETA = last' bucket)", () => {
    const mzk: TimingRow = { operator: "MZK", line_name: "10", plan_ts: cest("14:00:00"), eta_ts: cest("14:00:00"), delay_sec: 0, is_estimated: true, row_key: "m" };
    const sorted = sortBoard([kb("116", "14:35", "a"), { row: mzk, timing: resolveTiming(mzk, null) }, kb("120", "13:50", "b")], now);
    assert.deepEqual(sorted.map((i) => i.row.line_name), ["120", "10", "116"]);
  });
});

describe("REAL far-off KB rows (live capture 2026-10-03 00:09:08, next departures 04:05-04:09)", () => {
  /* KB printed `time` AND `static_time` as an absolute "HH:MM" for departures ~4 h away (is_estimated false);
     the first corrected-module draft treated every non-"N min" string as "unknown ETA", ordering such rows by line number. */
  const anchor = Date.parse("2026-10-03T00:09:08+02:00") / 1000;
  const row = (line: string, hhmm: string, idx: number) => ({
    time: hhmm, static_time: hhmm, time_diff: 0, at_stop: false, canceled: false, is_estimated: false, direction_id: 227401000,
    line_name: line, trip_id: 38672054, trip_execution_id: `${line}:739892:0`, trip_index: idx,
  });
  const dirs = { "227401000": "BIELSKO-BIAŁA D.A." };
  it("normalises to absolute instants on the Warsaw clock (tomorrow's 04:05, not today's)", () => {
    const r = enrichKbRow(row("142", "04:05", 0), dirs, anchor);
    assert.equal(r.eta_ts, at("2026-10-03T04:05:00+02:00"));
    assert.equal(r.plan_ts, at("2026-10-03T04:05:00+02:00"));
    assert.equal(r.delay_sec, null); // not estimated
    assert.equal(r.direction, "BIELSKO-BIAŁA D.A.");
  });
  it("orders them chronologically (116 < 119 < 120 < 142 by LINE would reverse them), after a '30 min' row, before an unknown one", () => {
    const rows = [
      enrichKbRow(row("116", "04:30", 3), dirs, anchor),
      enrichKbRow(row("142", "04:05", 0), dirs, anchor),
      enrichKbRow({ ...row("120", "x", 5), time: "30 min", static_time: "30 min" }, dirs, anchor),
      enrichKbRow(row("119", "04:20", 2), dirs, anchor),
    ];
    const sorted = preSortRows(rows, anchor + 3);
    assert.deepEqual(sorted.map((r) => `${r.line_name}`), ["120", "142", "119", "116"]);
    assert.deepEqual(sorted.map((r) => etaLabel(resolveTiming(r, null), anchor + 3)), ["30 min", "04:05", "04:20", "04:30"]);
  });
});

describe("warsawDayTs / warsawDateISO", () => {
  it("places timetable seconds-of-day on the Warsaw clock (CEST and CET)", () => {
    assert.equal(warsawDayTs("2026-10-04", 12 * 3600), at("2026-10-04T12:00:00+02:00"));
    assert.equal(warsawDayTs("2026-12-01", 8 * 3600 + 1800), at("2026-12-01T08:30:00+01:00"));
  });
  it("is DST-exact on the switch day (2026-10-25) and rolls >= 86400 into the next day", () => {
    assert.equal(warsawDayTs("2026-10-25", 3600 + 1800), at("2026-10-25T01:30:00+02:00"));
    assert.equal(warsawDayTs("2026-10-25", 10 * 3600), at("2026-10-25T10:00:00+01:00"));
    assert.equal(warsawDayTs("2026-10-04", 86400 + 600), at("2026-10-05T00:10:00+02:00"));
  });
  it("rejects a malformed date", () => {
    assert.equal(warsawDayTs("4.10.2026", 600), null);
    assert.equal(warsawDayTs("2026-10-04", Number.NaN), null);
  });
  it("reads the Warsaw calendar date, not the UTC one", () => {
    assert.equal(warsawDateISO(at("2026-10-04T23:30:00+02:00")), "2026-10-04");
    assert.equal(warsawDateISO(at("2026-10-04T22:30:00Z")), "2026-10-05");
  });
});

describe("boardExtension", () => {
  const now = cest("12:00:00");
  const live: TimingRow[] = [
    { operator: "MZK", trip_id: "mzk:1:1", plan_ts: cest("12:05:00") },
    { operator: "MZK", trip_id: "mzk:2:1", plan_ts: cest("13:10:00") },
    { operator: "KB", trip_id: 100, plan_ts: cest("15:00:00") },
  ];
  const s = (trip_id: number | string, operator: "KB" | "MZK", planTs: number) => ({ trip_id, operator, planTs });

  it("splits per operator window, hides what the board lists, keeps tomorrow's run of a live KB trip", () => {
    const sched = [
      s("mzk:1:1", "MZK", cest("12:05:00")), // on the board
      s("mzk:9:1", "MZK", cest("11:30:00")), // departed
      s("mzk:3:1", "MZK", cest("12:30:00")), // inside the MZK window, not listed: OnTime skips untracked courses
      s("mzk:4:1", "MZK", cest("13:30:00")),
      s(101, "KB", cest("14:00:00")), // inside the KB window
      s(102, "KB", cest("15:30:00")),
      s(100, "KB", cest("15:00:00")), // on the board
      s(100, "KB", cest("15:00:00", "2026-10-03")), // the same static trip tomorrow
    ];
    const { earlier, gaps, later, liveEnd } = boardExtension(sched, live, now);
    assert.deepEqual(earlier.map((x) => x.trip_id), ["mzk:9:1"]);
    assert.deepEqual(gaps.map((x) => x.trip_id), ["mzk:3:1", 101]);
    assert.deepEqual(later.map((x) => x.trip_id), ["mzk:4:1", 102, 100]);
    assert.equal(later[2].planTs, cest("15:00:00", "2026-10-03"));
    assert.equal(liveEnd, cest("15:00:00"));
  });

  it("matches an MZK course across variants (realtime and timetable may disagree on it)", () => {
    const { gaps, later } = boardExtension([s("mzk:1:7", "MZK", cest("12:05:00"))], live, now);
    assert.equal(gaps.length + later.length, 0);
  });

  it("an operator without live rows extends from now; a late live row never pulls the window into the past", () => {
    const sched = [s(7, "KB", cest("11:50:00")), s(8, "KB", cest("12:20:00")), s("mzk:5:1", "MZK", cest("11:58:00"))];
    const { earlier, gaps, later } = boardExtension(sched, [{ operator: "MZK", trip_id: "mzk:6:1", plan_ts: cest("11:40:00") }], now);
    assert.deepEqual(earlier.map((x) => x.trip_id), [7, "mzk:5:1"]);
    assert.deepEqual(gaps, []);
    assert.deepEqual(later.map((x) => x.trip_id), [8]);
  });
});

describe("schedTripKey / vehicleTripKey / schedVehicle", () => {
  it("drops the MZK variant, keeps a KB id", () => {
    assert.equal(schedTripKey("mzk:5087321:247"), "mzk:5087321");
    assert.equal(schedTripKey("mzk:5087321"), "mzk:5087321");
    assert.equal(schedTripKey(35678394), "35678394");
  });
  it("keys a vehicle by the timetable trip it serves", () => {
    assert.equal(vehicleTripKey({ operator: "MZK", trip_id: "5087321" }), "mzk:5087321");
    assert.equal(vehicleTripKey({ operator: "KB", trip_id: "739893", sched_trip_id: "38672079" }), "38672079");
    // a KB vehicle's trip_id is a per-day id, never a timetable trip
    assert.equal(vehicleTripKey({ operator: "KB", trip_id: "739893" }), null);
  });
  it("matches today's visit only (the same KB trip tomorrow is not on the road)", () => {
    const now = cest("12:00:00");
    const byTrip = new Map([["38672079", "bus"]]);
    assert.equal(schedVehicle({ trip_id: 38672079, planTs: cest("11:40:00") }, byTrip, now), "bus");
    assert.equal(schedVehicle({ trip_id: 38672079, planTs: cest("11:40:00", "2026-10-03") }, byTrip, now), null);
    assert.equal(schedVehicle({ trip_id: 1, planTs: now }, byTrip, now), null);
  });
});

describe("schedTiming", () => {
  const plan = cest("12:10:00");
  it("plan + the vehicle's current delay", () => {
    const t = schedTiming(plan, { delay: 180 });
    assert.equal(t.etaTs, plan + 180);
    assert.equal(t.delaySec, 180);
    assert.equal(t.estimated, true);
    assert.equal(t.source, "vehicle");
  });
  it("no vehicle or no delay is the timetable", () => {
    assert.equal(schedTiming(plan, null).source, "schedule");
    assert.equal(schedTiming(plan, { delay: null }).estimated, false);
  });
  it("a course that has not begun never yields a delay", () => {
    const t = schedTiming(plan, { delay: 600, not_started: true });
    assert.equal(t.delaySec, null);
    assert.equal(t.etaTs, plan);
    assert.equal(t.source, "waiting");
  });
});

describe("autoLaterHorizon", () => {
  const rows = [100, 200, 300, 400, 500].map((planTs, i) => ({ trip_id: i, planTs }));
  it("everything up to the floor", () => {
    assert.equal(autoLaterHorizon(rows, 10, 300, 6), 300);
  });
  it("then more until the board holds the minimum", () => {
    // empty board (MZK courses without a tracked bus): the next 3 departures, whatever the floor
    assert.equal(autoLaterHorizon(rows, 0, 50, 3), 300);
    assert.equal(autoLaterHorizon(rows, 4, 250, 6), 200);
  });
  it("null when nothing is added", () => {
    assert.equal(autoLaterHorizon(rows, 6, 50, 6), null);
    assert.equal(autoLaterHorizon([], 0, 1e12, 6), null);
  });
});

describe("nextLaterHorizon / nextEarlierHorizon", () => {
  const rows = [10, 20, 30, 30, 40].map((planTs, i) => ({ trip_id: i, planTs }));
  it("reveals `step` more departures per call, a shared minute as a whole", () => {
    assert.equal(nextLaterHorizon(rows, null, 2), 20);
    assert.equal(nextLaterHorizon(rows, 20, 1), 30);
    assert.equal(nextLaterHorizon(rows, 30, 5), 40);
    assert.equal(nextLaterHorizon(rows, 40, 5), null);
  });
  it("walks back from the newest earlier departure", () => {
    assert.equal(nextEarlierHorizon(rows, null, 2), 30);
    assert.equal(nextEarlierHorizon(rows, 30, 2), 10);
    assert.equal(nextEarlierHorizon(rows, 10, 2), null);
  });
});
