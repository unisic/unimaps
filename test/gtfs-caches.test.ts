import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { tsImport } from "tsx/esm/api";

// lib/config.ts reads env at module load and node --test runs every file in its own process
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kb-gtfs-caches-"));
process.env.KB_GTFS_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const write = (name: string, text: string): void => fs.writeFileSync(path.join(DIR, name), text);

/* Next bundles instrumentation (which runs the nightly rebuild and its invalidations) and every route
   separately, each with its own copy of lib/*. Every tsImport() call loads such an isolated module instance. */
const copy = <T>(rel: string): Promise<T> => tsImport(rel, import.meta.url) as Promise<T>;

describe("GTFS caches survive a second module copy", () => {
  it("an invalidation in one copy reaches the reader in another (lines, trips, stop directions)", async () => {
    type Lines = typeof import("../lib/lines");
    type Trips = typeof import("../lib/gtfs-trips");
    type Dirs = typeof import("../lib/stop-directions");
    const [routeLines, refreshLines] = [await copy<Lines>("../lib/lines.ts"), await copy<Lines>("../lib/lines.ts")];
    const [routeTrips, refreshTrips] = [await copy<Trips>("../lib/gtfs-trips.ts"), await copy<Trips>("../lib/gtfs-trips.ts")];
    const [routeDirs, refreshDirs] = [await copy<Dirs>("../lib/stop-directions.ts"), await copy<Dirs>("../lib/stop-directions.ts")];
    assert.notEqual(routeLines, refreshLines);

    // a route reads before the first build finished: empty everywhere
    assert.equal(routeLines.getLines().length, 0);
    assert.equal(routeTrips.gtfsTripMeta("t1"), null);
    assert.equal(routeDirs.getStopDirections().size, 0);

    write("routes.txt", "route_id,route_short_name,route_long_name\nL_1,1,A\n");
    write("trips.txt", "route_id,service_id,trip_id,trip_headsign,trip_short_name\nL_1,S,t1,A,1\n");
    write("stops.txt", "stop_id,stop_name,stop_lat,stop_lon\n1,X,49.80,19.00\n2,Y,49.81,19.00\n");
    write("stop_times.txt", "trip_id,stop_id,stop_sequence\nt1,1,0\nt1,2,1\n");
    refreshLines.invalidateLines();
    refreshTrips.invalidateGtfsTrips();
    refreshDirs.invalidateStopDirections();

    assert.equal(routeLines.getLines().length, 1);
    assert.equal(routeTrips.gtfsTripMeta("t1")?.line, "1");
    assert.deepEqual(routeDirs.getStopDirections().get("1"), [0]);
  });
});
