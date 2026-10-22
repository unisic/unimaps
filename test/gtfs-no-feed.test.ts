import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// lib/config.ts reads env at module load and node --test runs every file in its own process:
// an empty feed dir, with the repo (and its test/fixtures/gtfs) as the working directory
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "kb-no-feed-"));
process.env.KB_GTFS_DIR = EMPTY;
process.env.KB_MZK_TIMETABLE_FILE = path.join(EMPTY, "mzk-timetable.v1.json");

let router: typeof import("../lib/router");
let dirs: typeof import("../lib/stop-directions");

before(async () => {
  router = await import("../lib/router");
  dirs = await import("../lib/stop-directions");
});
after(() => fs.rmSync(EMPTY, { recursive: true, force: true }));

describe("missing GTFS feed", () => {
  it("never serves the test fixture feed in its place", () => {
    assert.ok(fs.existsSync(path.join(process.cwd(), "test", "fixtures", "gtfs", "stops.txt")));
    assert.deepEqual(router.findConnections({ from: "BIELSKO-BIAŁA D.A.", to: "SZCZYRK SKALITE", date: "2026-09-30" }), []);
    assert.equal(dirs.getStopDirections().size, 0);
  });
});
