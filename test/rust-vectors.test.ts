/**
 * The golden vectors backend/tests/*.rs check the Rust port against, read back through the TS: a change to the
 * shared departure, alert or detour logic fails here until `node --import tsx scripts/dump-vectors.ts` is rerun, and the
 * regenerated vectors then fail the Rust tests until backend/src/shared is changed the same way.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { alertAction, alertMessage, type Alert } from "@/lib/shared/alerts";
import {
  enrichKbRow,
  hhmm,
  kbAnchorTs,
  mzkWireFields,
  parseClockNear,
  parseRelMinutes,
  preSortRows,
  rowKey,
  type TimingRow,
} from "@/lib/shared/departures";
import { injectDetourPoints } from "@/lib/shared/detours";
import type { LatLng } from "@/lib/shared/polyline";

const read = (name: string) => JSON.parse(fs.readFileSync(`backend/tests/vectors/${name}.json`, "utf8"));
const json = (x: unknown) => JSON.stringify(x);

test("departures vectors: preSortRows and hhmm", () => {
  const v = read("departures");
  for (const b of v.boards) {
    const sorted = preSortRows(b.rows as TimingRow[], v.now);
    assert.deepEqual(
      sorted.map((r) => b.rows.indexOf(r)),
      b.order,
    );
  }
  for (const [t, want] of v.hhmm) assert.equal(hhmm(t), want);
});

test("board_rows vectors: KB/MZK normalisers and rowKey", () => {
  const v = read("board_rows");
  for (const [s, want] of v.rel) assert.equal(parseRelMinutes(s), want);
  for (const [s, a, want] of v.clock) assert.equal(parseClockNear(s, a), want);
  for (const c of v.kb) assert.equal(json(enrichKbRow(c.row, c.directions, c.anchor)), json(c.out));
  for (const [b, local, want] of v.anchor) assert.equal(kbAnchorTs(b, local), want);
  for (const c of v.mzk) assert.equal(json(mzkWireFields(c.d)), json(c.out));
  for (const [row, want] of v.keys) assert.equal(rowKey(row), want);
});

test("alerts vectors: alertAction and alertMessage", () => {
  for (const c of read("alerts")) {
    const action = alertAction(c.alert as Alert, c.rows as TimingRow[], c.now);
    assert.deepEqual(action, c.action);
    assert.equal(json(alertMessage(c.alert as Alert, action)), json(c.message));
  }
});

test("shape_patterns vectors: injectDetourPoints", () => {
  for (const c of read("shape_patterns").detours) {
    const points = c.points as LatLng[];
    const res = injectDetourPoints(points, c.line ?? undefined, c.dir ?? undefined);
    assert.deepEqual(res.points === points ? null : res.points, c.out, json(c));
    assert.equal(res.detour?.id ?? null, c.id, json(c));
  }
});
