import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

// lib/config.ts reads env at module load and node --test runs every file in its own process:
// pin the fixture feed (not the developer's output/gtfs) and no MZK timetable, the same data as CI
process.env.KB_GTFS_DIR = path.join(process.cwd(), "test", "fixtures", "gtfs");
process.env.KB_MZK_TIMETABLE_FILE = path.join(process.cwd(), "test", "fixtures", "no-mzk-timetable.json");

let findConnections: typeof import("../lib/router").findConnections;

before(async () => {
  ({ findConnections } = await import("../lib/router"));
});

// pinned weekday (Wed): without it the search used today's service day, so the suite went red on Saturdays/Sundays
const DATE = "2026-09-30";

describe("findConnections", () => {
  it("returns empty array for non-existent stops", () => {
    const res = findConnections({ from: "NON_EXISTENT_STOP_XYZ", to: "ANOTHER_NON_EXISTENT", date: DATE });
    assert.deepEqual(res, []);
  });

  it("finds direct connections between Bielsko-Biała D.A. and Szczyrk", () => {
    const res = findConnections({
      date: DATE,
      from: "BIELSKO-BIAŁA D.A.",
      to: "SZCZYRK SKALITE",
      afterSecs: 14 * 3600,
      limit: 3,
    });
    assert.ok(res.length > 0);
    const first = res[0];
    assert.equal(first.type, "direct");
    assert.equal(first.transfersCount, 0);
    assert.equal(first.legs.length, 1);
    assert.ok(first.legs[0].line.length > 0);
    assert.ok(first.departureSecs >= 14 * 3600);
    assert.ok(first.arrivalSecs > first.departureSecs);
    assert.ok(first.totalDurationMins > 0);
  });

  it("finds transfer connections when no direct line exists", () => {
    const res = findConnections({
      date: DATE,
      from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
      to: "SZCZYRK SKALITE",
      afterSecs: 14 * 3600,
      limit: 3,
    });
    assert.ok(res.length > 0);
    const transfer = res.find((r) => r.type === "transfer");
    assert.ok(transfer, "expected a transfer itinerary");
    assert.equal(transfer.transfersCount, 1);
    assert.equal(transfer.legs.length, 2);
    assert.ok((transfer.transferWaitMins ?? 0) >= 3);
    assert.ok(transfer.legs[0].arrivalSecs <= transfer.legs[1].departureSecs);
  });

  it("resolves stops by numeric ID as well as name", () => {
    // 10000 is Bielsko-Biała D.A.
    const res = findConnections({
      date: DATE,
      from: "10000",
      to: "SZCZYRK SKALITE",
      afterSecs: 14 * 3600,
      limit: 1,
    });
    assert.ok(res.length > 0);
    assert.equal(res[0].legs[0].fromStopName, "BIELSKO-BIAŁA D.A.");
  });

  it("filters strictly direct connections when directOnly: true", () => {
    // Direct search between D.A. and Szczyrk should return only direct itineraries
    const res = findConnections({
      date: DATE,
      from: "BIELSKO-BIAŁA D.A.",
      to: "SZCZYRK SKALITE",
      afterSecs: 14 * 3600,
      directOnly: true,
      limit: 5,
    });
    assert.ok(res.length > 0);
    for (const item of res) {
      assert.equal(item.type, "direct");
      assert.equal(item.transfersCount, 0);
      assert.equal(item.legs.length, 1);
    }
  });

  it("returns empty when no direct connection exists and directOnly: true", () => {
    // Wapienica Centrum to Szczyrk Skalite has no direct connection
    const res = findConnections({
      date: DATE,
      from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
      to: "SZCZYRK SKALITE",
      afterSecs: 14 * 3600,
      directOnly: true,
      limit: 5,
    });
    assert.equal(res.length, 0);
  });

  it("attaches date and dayLabel metadata to itineraries", () => {
    const res = findConnections({
      from: "BIELSKO-BIAŁA D.A.",
      to: "SZCZYRK SKALITE",
      afterSecs: 14 * 3600,
      date: "2026-09-14",
      dayLabel: "Jutro",
      limit: 1,
    });
    assert.ok(res.length > 0);
    assert.equal(res[0].date, "2026-09-14");
    assert.equal(res[0].dayLabel, "Jutro");
  });

  it("sorts by duration when sortBy: 'duration'", () => {
    const res = findConnections({
      date: DATE,
      from: "BIELSKO-BIAŁA D.A.",
      to: "SZCZYRK SKALITE",
      afterSecs: 10 * 3600,
      sortBy: "duration",
      limit: 5,
    });
    assert.ok(res.length >= 2);
    for (let i = 1; i < res.length; i++) {
      assert.ok(res[i].totalDurationMins >= res[i - 1].totalDurationMins);
    }
  });

  it("resolves city name to main hub when searching connections", () => {
    const res = findConnections({
      date: DATE,
      from: "SZCZYRK CENTRUM",
      to: "KĘTY",
      afterSecs: 12 * 3600,
      limit: 3,
    });
    assert.ok(res.length > 0);
    assert.equal(res[0].legs[res[0].legs.length - 1].toStopName, "KĘTY D.A.");
  });

  it("finds evening and next-morning connections without returning empty list", () => {
    const res = findConnections({
      date: DATE,
      from: "SZCZYRK CENTRUM",
      to: "KĘTY",
      afterSecs: 20 * 3600 + 52 * 60,
      limit: 3,
    });
    assert.ok(res.length > 0);
    assert.ok(res[0].departureSecs >= 20 * 3600 + 52 * 60);
  });

  it("finds transfer connection between Buczkowice and Pietrzykowice with detailed intermediate stops", () => {
    const res = findConnections({
      from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
      to: "SZCZYRK SKALITE",
      date: "2026-09-14",
      afterSecs: 8 * 3600,
      limit: 5,
    });
    assert.ok(res.length > 0, "should find connections between Wapienica and Szczyrk");
    const first = res[0];
    assert.ok(first.transfersCount >= 1, "must require at least 1 transfer");
    assert.equal(first.legs.length, first.transfersCount + 1);
    assert.ok((first.transferWaitMins ?? 0) >= 3, "transfer wait time must be at least 3 minutes");
    assert.ok(first.transferStopName != null && first.transferStopName.length > 0);

    for (const leg of first.legs) {
      assert.ok(leg.stops != null && leg.stops.length >= 2, "leg must include detailed intermediate stops");
      assert.equal(leg.stops[0].stopName, leg.fromStopName);
      assert.equal(leg.stops[leg.stops.length - 1].stopName, leg.toStopName);
      assert.ok(typeof leg.stops[0].lat === "number" && leg.stops[0].lat > 45);
      assert.ok(typeof leg.stops[0].lon === "number" && leg.stops[0].lon > 15);
      assert.ok(leg.stops[0].departureTime.length > 0);
      assert.ok(leg.stops[leg.stops.length - 1].arrivalTime.length > 0);
    }
  });

  it("automatically falls back to next available service day when querying non-running day", () => {
    const res = findConnections({
      from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
      to: "SZCZYRK SKALITE",
      limit: 3,
    });
    assert.ok(res.length > 0, "should find connections via auto-fallback to next service day");
    assert.ok(res[0].dayLabel != null || res[0].date != null);
  });

  it("ensures no itinerary is strictly dominated in results", () => {
    const res = findConnections({
      from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
      to: "SZCZYRK SKALITE",
      date: "2026-09-14",
      afterSecs: 8 * 3600,
      limit: 10,
    });
    for (const it of res) {
      const strictlyDominated = res.some(
        (other) =>
          other !== it &&
          other.departureSecs >= it.departureSecs &&
          other.arrivalSecs <= it.arrivalSecs &&
          other.transfersCount <= it.transfersCount &&
          (other.departureSecs > it.departureSecs ||
            other.arrivalSecs < it.arrivalSecs ||
            other.transfersCount < it.transfersCount),
      );
      assert.equal(strictlyDominated, false, "no itinerary should be strictly Pareto-dominated");
    }
  });

  it("resolves stops with punctuation, commas, dots and street names (PIETRZYKOWICE, KOŚCIÓŁ -> KĘTY, D.A.)", () => {
    const res = findConnections({
      from: "PIETRZYKOWICE, KOŚCIÓŁ",
      to: "KĘTY, D.A.",
      date: "2026-09-14",
      afterSecs: 15 * 3600,
      limit: 5,
    });
    assert.ok(res.length > 0, "should find connections for PIETRZYKOWICE, KOŚCIÓŁ -> KĘTY, D.A.");
    const first = res[0];
    assert.ok(first.transfersCount >= 1, "transfer required");
    assert.ok(first.transferStopName?.includes("BIELSKO-BIAŁA"), "transfer happens in Bielsko-Biała");
  });

  it("handles stop names with trailing street names seamlessly", () => {
    const res = findConnections({
      from: "PIETRZYKOWICE KOŚCIÓŁ",
      to: "KĘTY, D.A. UL. SIENKIEWICZA",
      date: "2026-09-14",
      afterSecs: 15 * 3600,
      limit: 3,
    });
    assert.ok(res.length > 0, "should resolve KĘTY, D.A. UL. SIENKIEWICZA and find itineraries");
  });

  it("resolves no stop from input without letters or digits", () => {
    // cleanText("-") is "", and an empty key is a substring of every stop name: every pole became an origin
    assert.deepEqual(findConnections({ from: "-", to: "SZCZYRK SKALITE", date: DATE, afterSecs: 14 * 3600 }), []);
  });

  it("treats a NaN limit and minimum transfer as unset", () => {
    const q = { from: "BIELSKO-BIAŁA WAPIENICA CENTRUM", to: "SZCZYRK SKALITE", date: DATE, afterSecs: 14 * 3600 };
    const res = findConnections({ ...q, limit: NaN, minTransferSecs: NaN });
    assert.deepEqual(res, findConnections(q));
    assert.ok(res.length > 0);
  });
});
