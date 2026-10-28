import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { FleetTracker, type FleetRunningInput } from "../lib/fleet-tracker";
import {
  createGzmFleetTracker,
  feedGzmFleet,
  gzmCompany,
  gzmFleetInput,
  gzmFleetListBody,
  gzmIdleDetail,
  GZM_SIDE_RE,
  type GzmFleetSource,
} from "../lib/gzm-fleet";

/** 2026-10-04 12:00:00 Europe/Warsaw (CEST, UTC+2) = service-day second 43 200 */
const NOON_OCT4_MS = Date.UTC(2026, 9, 4, 10, 0, 0);
const NOON = 43_200;

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: NOON_OCT4_MS }));
afterEach(() => mock.timers.reset());

/** Brigade 69/1 at noon: 11:40 -> 12:05, served the second of three stops. */
function src(over: Partial<GzmFleetSource> = {}): GzmFleetSource {
  return {
    side: "283_4285",
    label: "4285",
    model: "Solaris Urbino 12",
    vehicleType: "3",
    line: "69",
    brigade: "1",
    tripId: "0123456789abcdef",
    headsign: "Sosnowiec Pętla",
    stops: [
      { id: "s1", name: "Katowice Dworzec", dep: NOON - 1200, distM: 0 },
      { id: "s2", name: "Katowice Rondo", dep: NOON - 600, distM: 1500 },
      { id: "s3", name: "Sosnowiec Pętla", dep: NOON + 300, distM: 6000 },
    ],
    servedIdx: 1,
    nextIdx: 2,
    reachedM: 2500,
    atStop: false,
    notStarted: false,
    delaySec: 60,
    lat: 50.26,
    lon: 19.03,
    bearing: 90,
    fixAt: NOON_OCT4_MS / 1000 - 4,
    nextTrip: null,
    ...over,
  };
}

/** The same brigade's next trip: 12:15 back from the terminus. */
const SECOND_TRIP: Partial<GzmFleetSource> = {
  tripId: "fedcba9876543210",
  headsign: "Katowice Dworzec",
  stops: [
    { id: "s3", name: "Sosnowiec Pętla", dep: NOON + 900, distM: 0 },
    { id: "s1", name: "Katowice Dworzec", dep: NOON + 2400, distM: 6000 },
  ],
  servedIdx: 0,
  nextIdx: 1,
  reachedM: 200,
};

describe("gzm-fleet input", () => {
  it("maps a GZM source to the tracker input", () => {
    const v = gzmFleetInput(src());
    assert.equal(v.vehicleId, "283_4285");
    assert.equal(v.courseLoid, 0x0123456789ab);
    assert.equal(v.lineName, "69");
    assert.equal(v.direction, "Sosnowiec Pętla");
    assert.equal(v.delaySec, 60);
    assert.equal(v.angle, 90);
    assert.equal(v.lastPingDate, NOON_OCT4_MS - 4000);
    assert.equal(v.reachedMeters, 2500);
    assert.deepEqual(
      v.stopPoints?.map((s) => [s.symbol, s.orderNo, s.distance]),
      [
        ["s1", 0, 0],
        ["s2", 1, 1500],
        ["s3", 2, 4500],
      ],
    );
    assert.deepEqual(v.stopSecs, [NOON - 1200, NOON - 600, NOON + 300]);
    assert.equal(v.servedIdx, 1);
    assert.equal(v.nextIdx, 2);
    assert.equal(v.brigade, "1");
    assert.equal(v.label, "4285");
    assert.equal(v.company, "PKM Tychy");
    assert.equal(v.notStarted, false);
  });

  it("drops distances unless every stop has one, and reads a null delay as on time", () => {
    const v = gzmFleetInput(
      src({
        delaySec: null,
        bearing: null,
        fixAt: null,
        stops: [
          { id: "s1", name: "A", dep: NOON, distM: 0 },
          { id: "s2", name: "B", dep: NOON + 60, distM: null },
        ],
      }),
    );
    assert.equal(v.delaySec, 0);
    assert.equal("angle" in v, false);
    assert.equal("lastPingDate" in v, false);
    assert.equal("reachedMeters" in v, false);
    assert.deepEqual(
      v.stopPoints?.map((s) => s.distance),
      [0, 0],
    );
  });

  it("names companies by their code and validates keys", () => {
    assert.equal(gzmCompany("125_712"), "Tramwaje Śląskie");
    assert.equal(gzmCompany("999_1"), "Przewoźnik 999");
    assert.equal(GZM_SIDE_RE.test("283_4285"), true);
    assert.equal(GZM_SIDE_RE.test("283"), false);
    assert.equal(GZM_SIDE_RE.test("283_4285/../x"), false);
  });
});

describe("gzm-fleet tracker", () => {
  it("splits a brigade's consecutive trips into two courses, the first archived completed", () => {
    const t = createGzmFleetTracker(null);
    t.updateFromRunningVehicles([gzmFleetInput(src())]);
    mock.timers.setTime(NOON_OCT4_MS + 6 * 60_000);
    t.updateFromRunningVehicles([gzmFleetInput(src(SECOND_TRIP))]);

    const d = t.getVehicleDetail("283_4285");
    assert(d);
    assert.equal(d.operator, "GZM");
    assert.equal(d.label, "4285");
    assert.equal(d.company, "PKM Tychy");
    assert.equal(d.currentCourse?.courseLoid, 0xfedcba987654);
    assert.equal(d.currentCourse?.brigade, "1");
    assert.equal(d.currentCourse?.startTime, "12:15");
    assert.equal(d.todayCourses.length, 1);
    const first = d.todayCourses[0];
    assert.equal(first.courseLoid, 0x0123456789ab);
    assert.equal(first.status, "completed");
    assert.equal(first.brigade, "1");
    assert.equal(first.startTime, "11:40");
    assert.equal(first.endTime, "12:05");
    assert.equal(first.drivenMeters, 6000);
    // GZM keeps no stop table for finished courses (day-file size)
    assert.equal(first.stops, undefined);
    assert.equal(d.stats.totalCoursesToday, 2);

    const row = t.getFleetSummary()[0];
    assert.equal(row.sideNumber, "283_4285");
    assert.equal(row.label, "4285");
    assert.equal(row.company, "PKM Tychy");
    assert.equal(row.brigade, "1");
  });

  it("does not archive a course that never began", () => {
    const t = createGzmFleetTracker(null);
    t.updateFromRunningVehicles([gzmFleetInput(src({ notStarted: true, servedIdx: null, nextIdx: 0 }))]);
    const waiting = t.getFleetSummary()[0];
    assert.equal(waiting.notStarted, true);
    assert.equal(waiting.delaySec, undefined);

    mock.timers.setTime(NOON_OCT4_MS + 60_000);
    t.updateFromRunningVehicles([gzmFleetInput(src(SECOND_TRIP))]);
    assert.equal(t.getVehicleDetail("283_4285")?.todayCourses.length, 0);

    mock.timers.setTime(NOON_OCT4_MS + 2 * 60_000);
    const t2 = createGzmFleetTracker(null);
    t2.updateFromRunningVehicles([gzmFleetInput(src({ notStarted: true }))]);
    t2.updateFromRunningVehicles([]);
    const gone = t2.getVehicleDetail("283_4285");
    assert.equal(gone?.status, "depot");
    assert.equal(gone?.todayCourses.length, 0);
  });

  it("predicts the next course from the brigade's next scheduled trip", () => {
    const t = createGzmFleetTracker(null);
    const nextTrip = { line: "69", headsign: "Katowice Dworzec", firstStopName: "Sosnowiec Pętla", firstStopId: "s3", dep: NOON + 900 };
    t.updateFromRunningVehicles([gzmFleetInput(src({ nextTrip }))]);
    assert.deepEqual(t.getVehicleDetail("283_4285")?.predictedNextCourse, {
      lineName: "69",
      direction: "Katowice Dworzec",
      departureTime: "12:15",
      departureSecs: NOON + 900,
      fromStopName: "Sosnowiec Pętla",
      fromStopSymbol: "s3",
      // ends 12:05 +1 min late, leaves 12:15
      pauseMinutes: 9,
      confidence: "high",
      reason: "Według rozkładu brygady 69/1.",
    });
  });

  it("wraps a next trip past midnight (service-day seconds over 86 400)", () => {
    const t = createGzmFleetTracker(null);
    const late = src({
      delaySec: 0,
      stops: [
        { id: "s1", name: "A", dep: 85_000, distM: 0 },
        { id: "s2", name: "B", dep: 86_100, distM: 900 },
      ],
      servedIdx: 0,
      nextIdx: 1,
      nextTrip: { line: "69", headsign: "A", firstStopName: "B", firstStopId: "s2", dep: 86_400 + 600 },
    });
    t.updateFromRunningVehicles([gzmFleetInput(late)]);
    const p = t.getVehicleDetail("283_4285")?.predictedNextCourse;
    assert.equal(p?.departureTime, "00:10");
    assert.equal(p?.departureSecs, 600);
    assert.equal(p?.pauseMinutes, 15);
  });

  it("sorts by company, then fleet number, numerically", () => {
    const t = createGzmFleetTracker(null);
    const sides = ["283_4285", "108_12", "2_900", "108_3"];
    t.updateFromRunningVehicles(sides.map((side, i) => gzmFleetInput(src({ side, label: side.split("_")[1], tripId: `${i}`.repeat(16) }))));
    assert.deepEqual(
      t.getFleetSummary().map((v) => v.sideNumber),
      ["2_900", "108_3", "108_12", "283_4285"],
    );
  });

  it("feeds only trips with a course key and caches the list body per update", () => {
    const key = Symbol.for("kb-gtfs.gzm-fleet");
    const g = globalThis as typeof globalThis & { [key]?: FleetTracker };
    const prev = g[key];
    g[key] = createGzmFleetTracker(null);
    try {
      feedGzmFleet([src(), src({ side: "108_3", tripId: "" })]);
      const a = gzmFleetListBody();
      const body = JSON.parse(a.body) as { count: number; vehicles: { sideNumber: string }[]; serverNow?: number };
      assert.equal(body.count, 1);
      assert.equal(body.vehicles[0].sideNumber, "283_4285");
      assert.equal("serverNow" in body, false);
      assert.match(a.etag, /^"[\w-]{22}"$/);
      assert.equal(gzmFleetListBody(), a);

      mock.timers.setTime(NOON_OCT4_MS + 10_000);
      feedGzmFleet([src({ delaySec: 240 })]);
      assert.notEqual(gzmFleetListBody().etag, a.etag);
    } finally {
      g[key] = prev;
    }
  });

  it("gives a vehicle on the map but never on a course an idle card, without storing it", () => {
    const key = Symbol.for("kb-gtfs.gzm-fleet");
    const g = globalThis as typeof globalThis & { [key]?: FleetTracker };
    const prev = g[key];
    g[key] = createGzmFleetTracker(null);
    try {
      const fixAt = NOON_OCT4_MS / 1000 - 15;
      const d = gzmIdleDetail("104_3008", { label: "3008", model: "Mercedes Citaro", line: "744", lat: 50.3, lon: 18.9, fixAt });
      assert.equal(d.sideNumber, "104_3008");
      assert.equal(d.label, "3008");
      assert.equal(d.company, "PKM Świerklaniec");
      assert.equal(d.model, "Mercedes Citaro");
      assert.equal(d.status, "depot");
      assert.equal(d.currentCourse, null);
      assert.equal(d.lastSeenAt, fixAt);
      assert.deepEqual(d.lastKnownLocation, { lat: 50.3, lon: 18.9, name: "Na mapie bez kursu, linia 744" });
      assert.equal(g[key].getVehicleDetail("104_3008"), null);
    } finally {
      g[key] = prev;
    }
  });

  it("restores a day of a vehicle without a static fleet from its own file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gzm-fleet-"));
    try {
      const t = createGzmFleetTracker(dir);
      t.updateFromRunningVehicles([gzmFleetInput(src())]);
      mock.timers.setTime(NOON_OCT4_MS + 6 * 60_000);
      t.updateFromRunningVehicles([gzmFleetInput(src(SECOND_TRIP))]);
      t.flushSync();
      assert.deepEqual(fs.readdirSync(dir), ["fleet-history-2026-10-04.json"]);

      const back = createGzmFleetTracker(dir).getVehicleDetail("283_4285");
      assert(back);
      assert.equal(back.label, "4285");
      assert.equal(back.company, "PKM Tychy");
      assert.equal(back.model, "Solaris Urbino 12");
      assert.equal(back.todayCourses.length, 1);
      assert.equal(back.todayCourses[0].brigade, "1");
      assert.equal(back.currentCourse?.courseLoid, 0xfedcba987654);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("default MZK tracker", () => {
  // the wire and file shape of the MZK fleet, key order included: GZM fields never leak in
  function stop(symbol: string, name: string, orderNo: number, distance: number, ms: number) {
    return { symbol, name, orderNo, distance, scheduledDeparture: ms, plannedDeparture: ms };
  }
  const base = NOON_OCT4_MS - 20 * 60_000;
  const out: FleetRunningInput = {
    vehicleId: "233",
    lineName: "50",
    courseLoid: 1,
    direction: "Os. Karpackie",
    delaySec: 120,
    latitude: 49.9,
    longitude: 19.0,
    orderInCourse: 2,
    lastStopOrderNo: 1,
    reachedMeters: 500,
    stopPoints: [
      stop("1", "Czechowice-Dziedzice Silesia", 0, 0, base),
      stop("2", "B", 1, 400, base + 60_000),
      stop("3", "Osiedle Karpackie", 2, 900, base + 600_000),
    ],
  };
  const back: FleetRunningInput = {
    ...out,
    courseLoid: 2,
    direction: "Czechowice-Dziedzice Silesia",
    orderInCourse: 1,
    lastStopOrderNo: 0,
    stopPoints: [
      stop("3", "Osiedle Karpackie", 0, 0, base + 900_000),
      stop("2", "B", 1, 400, base + 960_000),
      stop("1", "Czechowice-Dziedzice Silesia", 2, 900, base + 1_500_000),
    ],
  };

  it("keeps its output unchanged for an existing-style input", () => {
    const t = new FleetTracker({ historyDir: null });
    t.updateFromRunningVehicles([out]);
    mock.timers.setTime(NOON_OCT4_MS + 60_000);
    t.updateFromRunningVehicles([back]);

    const d = t.getVehicleDetail("233");
    assert(d?.currentCourse);
    assert.equal(d.operator, "MZK");
    assert.deepEqual(Object.keys(d), [
      "sideNumber", "operator", "model", "producer", "year", "lengthCategory", "fuelType", "features", "status",
      "lines", "mainLine", "currentCourse", "predictedNextCourse", "todayCourses", "lastSeenAt", "lastKnownLocation", "stats",
    ]);
    assert.deepEqual(Object.keys(d.currentCourse), [
      "id", "courseLoid", "lineName", "direction", "firstStopName", "lastStopName", "firstStopSymbol", "lastStopSymbol",
      "startTime", "endTime", "startSecs", "endSecs", "delaySec", "notStarted", "atStop", "stopsCount", "currentStopIndex",
      "currentStopName", "nextStopName", "lat", "lon", "bearing", "progressPct", "lengthMeters", "drivenMeters", "status", "stops",
    ]);
    assert.deepEqual(Object.keys(d.todayCourses[0]), [
      "id", "courseLoid", "lineName", "direction", "firstStopName", "lastStopName", "firstStopSymbol", "lastStopSymbol",
      "startTime", "endTime", "startSecs", "endSecs", "delaySec", "stopsCount", "status", "cancelledReason",
      "cancelledAtStopName", "completedAt", "lengthMeters", "drivenMeters", "stops",
    ]);
    assert.equal(d.todayCourses[0].stops?.length, 3);
    const row = t.getFleetSummary().find((x) => x.sideNumber === "233");
    assert(row);
    assert.deepEqual(Object.keys(row), [
      "sideNumber", "model", "producer", "year", "lengthCategory", "fuelType", "status", "lines", "lineName", "direction",
      "startTime", "firstStopName", "currentStopName", "nextStopName", "atStop", "delaySec", "notStarted", "progressPct",
      "coursesCountToday", "cancelledCoursesToday", "kmToday", "lastSeenAt", "lastLineName",
    ]);
    assert.deepEqual(d.predictedNextCourse, {
      lineName: "50",
      direction: "Osiedle Karpackie",
      departureTime: "12:10",
      departureSecs: 43_800,
      fromStopName: "Czechowice-Dziedzice Silesia",
      fromStopSymbol: "1",
      pauseMinutes: 3,
      confidence: "medium",
      reason: "Pojazd kursuje dziś wahadłowo na linii 50, postój na pętli ok. 5 min.",
    });
  });
});
