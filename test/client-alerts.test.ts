import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alertAction, alertUntil, tripAlertKey, type Alert } from "../lib/client/alerts";
import type { DepartureRow } from "../lib/client/types";

const NOW = 1_800_000_000;
const row = (over: Partial<DepartureRow> = {}): DepartureRow => ({
  operator: "KB",
  row_key: "kb:e1#4",
  line_name: "120",
  plan_ts: NOW + 600,
  eta_ts: NOW + 600,
  ...over,
});
const alert = (over: Partial<Alert> = {}): Alert => ({
  key: "kb:e1#4",
  designator: "123",
  stopName: "Szczyrk Biła",
  line: "120",
  dest: "Bielsko-Biała",
  leadMin: 5,
  until: NOW + 600 + 1800,
  ...over,
});

describe("alertAction", () => {
  it("waits while the departure is further away than the lead, fires inside it with the real minutes", () => {
    assert.deepEqual(alertAction(alert(), [row()], NOW), { act: "wait" });
    assert.deepEqual(alertAction(alert(), [row({ eta_ts: NOW + 300 })], NOW), { act: "fire", mins: 5 });
    // set with less time left than the lead: fires at once, not "za 10 min"
    assert.deepEqual(alertAction(alert({ leadMin: 10 }), [row({ eta_ts: NOW + 240 })], NOW), { act: "fire", mins: 4 });
  });

  it("a bus standing at the stop fires as 0 min", () => {
    assert.deepEqual(alertAction(alert(), [row({ at_stop: true, eta_ts: null })], NOW), { act: "fire", mins: 0 });
  });

  it("matches by row key only: another departure of the same line never fires it", () => {
    assert.deepEqual(alertAction(alert(), [row({ row_key: "kb:e2#4", eta_ts: NOW + 60 })], NOW), { act: "wait" });
  });

  it("a cancelled course reports as cancelled, a row gone past `until` as expired", () => {
    assert.deepEqual(alertAction(alert(), [row({ canceled: true })], NOW), { act: "cancelled" });
    assert.deepEqual(alertAction(alert(), [], NOW + 600 + 1801), { act: "expired" });
    assert.deepEqual(alertAction(alert(), [], NOW + 600), { act: "wait" });
  });

  it("an MZK course that has not begun counts from its earliest possible time, never a delay", () => {
    const r = row({ operator: "MZK", row_key: "mzk:c1#0", not_started: true, eta_ts: NOW + 900, delay_sec: 120 });
    assert.deepEqual(alertAction(alert({ key: "mzk:c1#0" }), [r], NOW), { act: "wait" });
    assert.deepEqual(alertAction(alert({ key: "mzk:c1#0" }), [r], NOW + 600), { act: "fire", mins: 5 });
  });

  it("gives up 30 min after the plan, across midnight too", () => {
    // NOW is 09:00 in Warsaw
    assert.equal(alertUntil(9 * 3600 + 600, NOW), NOW + 600 + 1800);
    const at2355 = NOW + (23 * 3600 + 55 * 60 - 9 * 3600);
    assert.equal(alertUntil(5 * 60, at2355), at2355 + 600 + 1800);
  });
});

describe("tripAlertKey", () => {
  // row keys of the same visits captured from live boards (2026-10-26)
  it("builds the board row key of a trip's stop from the trip view", () => {
    assert.equal(tripAlertKey("6408:739915:0", 2), "6408:739915:0#2");
    assert.equal(tripAlertKey("mzk:5088713:233", 14), "mzk:5088713#14");
    assert.equal(tripAlertKey("mzk:5088713:", 0), "mzk:5088713#0");
  });
});
