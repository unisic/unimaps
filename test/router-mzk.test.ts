import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

// lib/config.ts reads env at module load and node --test runs every file in its own process,
// so the router below loads the KB fixture feed plus one captured MZK course (line 22, 5088899)
process.env.KB_GTFS_DIR = path.join(process.cwd(), "test", "fixtures", "gtfs");
process.env.KB_MZK_TIMETABLE_FILE = path.join(process.cwd(), "test", "fixtures", "mzk-timetable.v1.json");

let findConnections: typeof import("../lib/router").findConnections;

before(async () => {
  ({ findConnections } = await import("../lib/router"));
});

describe("findConnections with the MZK timetable", () => {
  it("finds a direct MZK course between two MZK stops on a day of its day type", () => {
    const res = findConnections({ from: "mzk:2", to: "mzk:456", date: "2026-09-30" });
    assert.ok(res.length > 0);
    const first = res[0];
    assert.equal(first.type, "direct");
    assert.equal(first.legs[0].tripId, "mzk:5088899:13002");
    assert.equal(first.legs[0].line, "22");
    assert.equal(first.departureTime, "22:46");
    assert.equal(first.arrivalTime, "22:53");
  });

  it("runs a course only on the dates of its day type", () => {
    const sunday = findConnections({ from: "mzk:2", to: "mzk:456", date: "2026-10-04" });
    assert.equal(sunday[0]?.legs[0].tripId, "mzk:5087953:13002");
    assert.equal(sunday[0]?.departureTime, "21:46");
    // 2026-10-01 has no day type in the timetable: no MZK course may run
    const uncovered = findConnections({ from: "mzk:2", to: "mzk:456", date: "2026-10-01" });
    assert.ok(uncovered.every((c) => c.legs.every((l) => !l.tripId.startsWith("mzk:"))));
  });

  it("transfers from a KB trip to an MZK course on a nearby pole", () => {
    // KB 112 (35678320) leaves Porąbka Kozubnik 21:20 and calls at 3 Maja Dworzec 22:11, 12 m from MZK stop 2
    const res = findConnections({ from: "22191", to: "mzk:456", date: "2026-09-30", afterSecs: 21 * 3600 });
    const conn = res.find((c) => c.legs.length >= 2);
    assert.ok(conn, "expected a KB -> MZK itinerary");
    assert.ok(!conn.legs[0].tripId.startsWith("mzk:"));
    assert.equal(conn.legs[conn.legs.length - 1].tripId, "mzk:5088899:13002");
    assert.ok(conn.transfersCount >= 1);
  });

  it("resolves the origin from explicit stop ids before the name", () => {
    const res = findConnections({ from: "no such stop", fromIds: ["10021", "mzk:2"], to: "mzk:456", date: "2026-09-30" });
    assert.equal(res[0]?.legs[0].tripId, "mzk:5088899:13002");
    // ids the index does not know fall back to the name
    const byName = findConnections({ from: "3 Maja Dworzec", fromIds: ["mzk:999999"], to: "mzk:456", date: "2026-09-30" });
    assert.equal(byName[0]?.legs[0].tripId, "mzk:5088899:13002");
  });
});
