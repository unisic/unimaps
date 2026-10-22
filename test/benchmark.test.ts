import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import type { ConnectionItinerary } from "../lib/router";

// lib/config.ts reads env at module load: pin the fixture feed (not the developer's output/gtfs)
// and no MZK timetable, the same data as CI
process.env.KB_GTFS_DIR = path.join(process.cwd(), "test", "fixtures", "gtfs");
process.env.KB_MZK_TIMETABLE_FILE = path.join(process.cwd(), "test", "fixtures", "no-mzk-timetable.json");

let findConnections: typeof import("../lib/router").findConnections;

before(async () => {
  ({ findConnections } = await import("../lib/router"));
});

function validateItinerary(it: ConnectionItinerary): void {
  assert.ok(it.departureSecs < it.arrivalSecs, `departure (${it.departureTime}) must be before arrival (${it.arrivalTime})`);
  assert.equal(it.legs.length, it.transfersCount + 1, "legs count must equal transfersCount + 1");

  for (let i = 0; i < it.legs.length; i++) {
    const leg = it.legs[i];
    assert.ok(leg.departureSecs < leg.arrivalSecs, `leg ${i + 1} departure < arrival`);
    assert.ok(leg.stops && leg.stops.length >= 2, `leg ${i + 1} must have >= 2 stops`);
    assert.equal(leg.fromStopName, leg.stops[0].stopName, `leg ${i + 1} fromStopName matches stops[0]`);
    assert.equal(leg.toStopName, leg.stops[leg.stops.length - 1].stopName, `leg ${i + 1} toStopName matches stops[last]`);

    if (i < it.legs.length - 1) {
      const nextLeg = it.legs[i + 1];
      assert.ok(nextLeg.departureSecs >= leg.arrivalSecs, `transfer leg ${i + 2} departure >= leg ${i + 1} arrival`);
      // per transfer, the router needs max(change, walk + 90 s); walkMins is rounded, so the walk is >= walkMins - 0.5 min
      const walk = nextLeg.walkMins ?? 0;
      const minRequired = Math.max(180, walk > 0 ? walk * 60 + 60 : 0);
      assert.ok(nextLeg.departureSecs - leg.arrivalSecs >= minRequired, "transfer wait time satisfies buffer");
    }
  }
}

describe("Connection Search Quality & Invariants Benchmark", () => {
  // pinned weekday (Wed): without it the search used today's service day, so the suite went red on Saturdays/Sundays
  const DATE = "2026-09-30";
  const corridors: Array<{ from: string; to: string; afterSecs?: number; expectedType?: "direct" | "transfer" }> = [
    { from: "BIELSKO-BIAŁA D.A.", to: "SZCZYRK SKALITE", afterSecs: 12 * 3600, expectedType: "direct" },
    { from: "SZCZYRK SKALITE", to: "BIELSKO-BIAŁA D.A.", afterSecs: 14 * 3600, expectedType: "direct" },
    { from: "BIELSKO-BIAŁA D.A.", to: "KĘTY D.A.", afterSecs: 10 * 3600, expectedType: "direct" },
    { from: "BIELSKO-BIAŁA D.A.", to: "CZECHOWICE-DZIEDZICE D.A.", afterSecs: 12 * 3600, expectedType: "direct" },
    { from: "BIELSKO-BIAŁA D.A.", to: "JAWORZE NAŁĘŻE", afterSecs: 13 * 3600, expectedType: "direct" },
    { from: "BIELSKO-BIAŁA D.A.", to: "WILKOWICE URZĄD GMINY", afterSecs: 12 * 3600, expectedType: "direct" },
    { from: "BIELSKO-BIAŁA WAPIENICA CENTRUM", to: "SZCZYRK SKALITE", afterSecs: 9 * 3600, expectedType: "transfer" },
    { from: "SZCZYRK SKALITE", to: "KĘTY D.A.", afterSecs: 11 * 3600, expectedType: "transfer" },
    { from: "CZECHOWICE-DZIEDZICE D.A.", to: "SZCZYRK SKALITE", afterSecs: 10 * 3600, expectedType: "transfer" },
    { from: "JASIENICA", to: "BUCZKOWICE CENTRUM", afterSecs: 10 * 3600, expectedType: "transfer" },
    { from: "PIETRZYKOWICE, KOŚCIÓŁ", to: "KĘTY, D.A.", afterSecs: 15 * 3600, expectedType: "transfer" },
  ];

  for (const c of corridors) {
    it(`validates corridor: ${c.from} -> ${c.to}`, () => {
      const res = findConnections({ from: c.from, to: c.to, afterSecs: c.afterSecs, limit: 3, date: DATE });
      assert.ok(res.length > 0, `must find connections for ${c.from} -> ${c.to}`);
      if (c.expectedType) {
        assert.ok(res.some((r) => r.type === c.expectedType), `must contain ${c.expectedType} option`);
      }
      for (const it of res) {
        validateItinerary(it);
      }
    });
  }

  it("enforces sub-50ms latency on hot connection queries", () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      findConnections({
        from: "BIELSKO-BIAŁA D.A.",
        to: "SZCZYRK SKALITE",
        afterSecs: (10 + (i % 6)) * 3600,
        limit: 3,
        date: DATE,
      });
    }
    const avgMs = (performance.now() - t0) / 20;
    assert.ok(avgMs < 50, `Average hot query latency must be < 50ms, was ${avgMs.toFixed(2)}ms`);
  });
});
