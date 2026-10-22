import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { buildGtfs, getServiceDates } from "../lib/gtfs-builder";
import { KbApi } from "../lib/kb-api";
import type { Stop, Trip } from "../lib/types";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "kb-gtfs-builder-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const stop = (internalId: number, urlId: string, lat: number): Stop => ({
  urlId, internalId, name: `STOP ${internalId}`, lat, lon: 19, onlyDisembarking: false, isStation: false,
  showPlatforms: false, stopId: String(internalId),
});
const STOPS = [stop(1, "u1", 49.8), stop(2, "u2", 49.81)];
const TRIP: Trip = {
  tripId: "t1", direction: "STOP 2", lineName: "120", lineType: null, showName: true, vehicleType: null,
  currentStationId: null,
  times: [
    { stopName: "STOP 1", designator: 1, placeId: "u1", departureTime: "08:00", index: 0, platform: null },
    { stopName: "STOP 2", designator: 2, placeId: "u2", departureTime: "08:10", index: 1, platform: null },
  ],
};

/** The real KbApi (its fetchMany turns a failed fetch into null), with the upstream calls faked: never the network. */
class FakeKbApi extends KbApi {
  constructor(private readonly failing: ReadonlySet<string> = new Set()) {
    super();
  }
  override async fetchRevision(): Promise<string> {
    return "1";
  }
  override async fetchStops(): Promise<Stop[]> {
    return STOPS;
  }
  override async fetchTimetable(stopUrlId: string): Promise<unknown> {
    if (this.failing.has(stopUrlId)) throw new Error("HTTP 503");
    return { departures: [{ trip_id: "t1" }] };
  }
  override async fetchTrip(): Promise<Trip | null> {
    return TRIP;
  }
}

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf-8");

describe("getServiceDates", () => {
  it("samples the weekday service from today on Mon-Fri, never a past Monday", () => {
    assert.deepEqual(getServiceDates("2026-10-22"), { weekdayDate: "2026-10-22", saturdayDate: "2026-10-24", sundayDate: "2026-10-25" });
    assert.equal(getServiceDates("2026-10-19").weekdayDate, "2026-10-19");
    assert.deepEqual(getServiceDates("2026-10-24"), { weekdayDate: "2026-10-26", saturdayDate: "2026-10-24", sundayDate: "2026-10-25" });
    assert.deepEqual(getServiceDates("2026-10-25"), { weekdayDate: "2026-10-26", saturdayDate: "2026-10-31", sundayDate: "2026-10-25" });
  });
});

describe("buildGtfs", () => {
  it("publishes a feed whose calendar is valid from the build date on, with no temp dir left behind", async () => {
    const out = path.join(ROOT, "ok", "gtfs");
    await buildGtfs({ date: "2026-12-30", outDir: out, api: new FakeKbApi(), zip: false });
    assert.match(read(out, "trips.txt"), /,t1_KB_WEEKDAY,/);
    const [, cal] = read(out, "calendar.txt").trim().split("\n");
    const [start, end] = cal.split(",").slice(-2);
    assert.equal(start, "20261230");
    assert.ok(end > "20270101", `calendar end ${end} must lie past the year boundary`);
    const info = read(out, "feed_info.txt").trim().split("\n")[1].split(",");
    assert.equal(info[3], "20261230");
    assert.equal(info[4], end);
    assert.deepEqual(fs.readdirSync(path.dirname(out)), ["gtfs"]);
  });

  it("keeps the published feed when upstream failed for many timetables", async () => {
    const out = path.join(ROOT, "fail", "gtfs");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "trips.txt"), "the old feed\n");
    await assert.rejects(buildGtfs({ date: "2026-10-22", outDir: out, api: new FakeKbApi(new Set(["u1"])), zip: false }));
    assert.equal(read(out, "trips.txt"), "the old feed\n");
    assert.deepEqual(fs.readdirSync(path.dirname(out)), ["gtfs"]);
  });
});
