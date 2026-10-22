import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

// lib/config.ts reads env at module load: pin the fixture feed, never the developer's output/gtfs
process.env.KB_GTFS_DIR = path.join(process.cwd(), "test", "fixtures", "gtfs");

let sd: typeof import("@/lib/stop-directions");

before(async () => {
  sd = await import("@/lib/stop-directions");
});

describe("stop-directions", () => {
  it("computes road directions and strips them from bus stations (D.A.)", () => {
    sd.invalidateStopDirections();
    const dirs = sd.getStopDirections();
    assert.ok(dirs.size > 0, "should compute directions from GTFS feed");

    // Bus stations (D.A.) must have NO direction arrows
    assert.equal(dirs.has("10000"), false, "Bielsko-Biała D.A. must have no arrows");
    assert.equal(dirs.has("23000"), false, "Czechowice-Dziedzice D.A. must have no arrows");
    assert.equal(dirs.has("50000"), false, "Andrychów D.A. must have no arrows");
    assert.equal(dirs.has("40000"), false, "Kęty D.A. must have no arrows");

    // Stops with 2 directions must be opposite traffic along the road (~180° apart, diff >= 100°)
    for (const [id, d] of dirs.entries()) {
      if (d.length === 2) {
        const rawDiff = Math.abs(d[0] - d[1]) % 360;
        const diff = rawDiff > 180 ? 360 - rawDiff : rawDiff;
        assert.ok(
          diff >= 100,
          `Stop ${id} directions [${d[0]}, ${d[1]}] should be opposite along road (diff ${diff} >= 100°)`,
        );
      } else {
        assert.equal(d.length, 1, `Stop ${id} should have 1 dominant direction`);
      }
    }
  });
});
