import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { FleetTracker, type FleetRunningInput } from "../lib/fleet-tracker";
import {
  classifyDelay,
  compareLineNames,
  foldText,
  matchesFleetQuery,
  median,
  TIMELINE_SLOT_SECS,
} from "../lib/shared/fleet";

// every tracker here is in-memory (or on a temp dir): never the real output/fleet-history-<day>.json
const memTracker = () => new FleetTracker({ historyDir: null });

/** 2026-10-04 12:00:00 Europe/Warsaw (CEST, UTC+2) */
const NOON_OCT4_MS = Date.UTC(2026, 9, 4, 10, 0, 0);

afterEach(() => mock.timers.reset());

function stop(symbol: string, name: string, orderNo: number, distance: number, schedMs: number, plannedMs = schedMs) {
  return { symbol, name, orderNo, distance, scheduledDeparture: schedMs, plannedDeparture: plannedMs };
}

describe("fleet-tracker", () => {
  it("initializes with full static fleet in depot state", () => {
    const tracker = memTracker();
    const stats = tracker.getStats();

    assert(stats.totalFleet >= 140, `Expected >= 140 vehicles, got ${stats.totalFleet}`);
    assert.equal(stats.activeCount, 0);
    assert.equal(stats.depotCount, stats.totalFleet);
    assert.equal(stats.seenTodayCount, 0);
    assert.equal(stats.medianDelaySec, null);

    const veh230 = tracker.getVehicleDetail("230");
    assert(veh230, "Vehicle 230 should exist");
    assert.equal(veh230.sideNumber, "230");
    assert.equal(veh230.model, "Isuzu Novociti Life");
    assert.equal(veh230.status, "depot");
    assert.deepEqual(veh230.lines, []);
    assert.equal(veh230.mainLine, null);
    assert.equal(tracker.getVehicleDetail("#230")?.sideNumber, "230");
  });

  it("updates vehicle status and current course on active running vehicles", () => {
    const tracker = memTracker();

    tracker.updateFromRunningVehicles([
      {
        vehicleId: "233",
        lineName: "50",
        courseLoid: 5057156,
        direction: "Os. Karpackie",
        delaySec: 120, // +2 min
        latitude: 49.928,
        longitude: 19.008,
        angle: 180,
        orderInCourse: 2,
        stopPoints: [
          stop("2375", "Czechowice-Dziedzice Silesia", 0, 0, 1790097000000, 1790097060000),
          stop("2376", "Czechowice-Dz. Górnicza", 1, 371, 1790097060000, 1790097120000),
          stop("2373", "Czechowice-Dz. Węglowa", 2, 850, 1790097120000, 1790097240000),
          stop("307", "Osiedle Karpackie", 3, 25000, 1790099820000, 1790099940000),
        ],
      },
    ]);

    const stats = tracker.getStats();
    assert.equal(stats.activeCount, 1);
    assert.equal(stats.depotCount, stats.totalFleet - 1);
    assert.deepEqual(stats.activeLines, ["50"]);
    assert.equal(stats.measuredCount, 1);
    assert.equal(stats.medianDelaySec, 120);

    const veh233 = tracker.getVehicleDetail("233");
    assert(veh233, "Vehicle 233 should be found");
    assert.equal(veh233.status, "active");
    // OnTime publishes no duty rosters: the served lines, never an invented "50/1" brigade
    assert.deepEqual(veh233.lines, ["50"]);
    assert.equal(veh233.mainLine, "50");

    assert(veh233.currentCourse, "Current course must exist");
    assert.equal(veh233.currentCourse.lineName, "50");
    assert.equal(veh233.currentCourse.firstStopName, "Czechowice-Dziedzice Silesia");
    assert.equal(veh233.currentCourse.lastStopName, "Osiedle Karpackie");
    assert.equal(veh233.currentCourse.currentStopName, "Czechowice-Dz. Węglowa");
    assert.equal(veh233.currentCourse.nextStopName, "Osiedle Karpackie");
    assert.equal(veh233.currentCourse.delaySec, 120);
    assert.equal(veh233.currentCourse.lengthMeters, 26221);
    assert.equal(veh233.currentCourse.drivenMeters, 1221);

    // next course: an estimate (8 min default layover, measured from the scheduled arrival)
    const next = veh233.predictedNextCourse;
    assert(next, "Predicted next course should be computed");
    assert.equal(next.lineName, "50");
    assert.equal(next.fromStopName, "Osiedle Karpackie");
    assert.equal(next.direction, "Czechowice-Dziedzice Silesia");
    assert.equal(next.pauseMinutes, 6); // 8 min after the scheduled arrival, the bus arrives 2 min late
    assert.equal(next.confidence, "low"); // no shuttle observed yet
  });

  it("never back-fills invented courses for a vehicle first seen mid-day", () => {
    const tracker = memTracker();
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "250",
        lineName: "1",
        courseLoid: 1001,
        direction: "Os. Beskidzkie",
        delaySec: 0,
        latitude: 49.8,
        longitude: 19.0,
        orderInCourse: 0,
        lastStopOrderNo: 0,
        reachedMeters: 200,
        stopPoints: [stop("1", "Cygański Las", 0, 0, 1790080000000), stop("2", "Os. Beskidzkie", 1, 8000, 1790082000000)],
      },
    ]);
    const veh = tracker.getVehicleDetail("250")!;
    assert.deepEqual(veh.todayCourses, []);
    assert.equal(veh.stats.totalCoursesToday, 1);
    assert.equal(veh.stats.completedCoursesToday, 0);
  });

  it("counts real kilometres from OnTime stop distances, clamped between the stops served", () => {
    const tracker = memTracker();
    const stops = [
      stop("10", "A", 0, 0, 1790080000000),
      stop("11", "B", 1, 500, 1790080120000),
      stop("12", "C", 2, 700, 1790080240000),
      stop("13", "D", 3, 800, 1790080360000),
    ];
    const run = (over: Partial<FleetRunningInput>): FleetRunningInput => ({
      vehicleId: "250",
      lineName: "1",
      courseLoid: 2001,
      direction: "D",
      delaySec: 30,
      latitude: 49.8,
      longitude: 19.0,
      orderInCourse: 1,
      lastStopOrderNo: 1,
      stopPoints: stops,
      ...over,
    });

    // at stop B (index 1): reachedMeters below the stop is lifted to it
    tracker.updateFromRunningVehicles([run({ onStopPoint: "11", reachedMeters: 300 })]);
    let veh = tracker.getVehicleDetail("250")!;
    assert.equal(veh.currentCourse?.lengthMeters, 2000);
    assert.equal(veh.currentCourse?.drivenMeters, 500);
    assert.equal(veh.currentCourse?.progressPct, 25);
    assert.equal(veh.stats.kmToday, 0.5);

    // between B and C: OnTime's reachedMeters is used as is
    tracker.updateFromRunningVehicles([run({ reachedMeters: 900 })]);
    veh = tracker.getVehicleDetail("250")!;
    assert.equal(veh.currentCourse?.drivenMeters, 900);

    // a reading past the next stop is capped at it
    tracker.updateFromRunningVehicles([run({ reachedMeters: 5000 })]);
    assert.equal(tracker.getVehicleDetail("250")!.currentCourse?.drivenMeters, 1200);

    // a course that ends on time counts its whole length
    tracker.updateFromRunningVehicles([]);
    veh = tracker.getVehicleDetail("250")!;
    assert.equal(veh.todayCourses[0].status, "completed");
    assert.equal(veh.todayCourses[0].drivenMeters, 2000);
    assert.equal(veh.stats.kmToday, 2);
    assert.equal(tracker.getStats().kmToday, 2);
  });

  it("archives previous course to todayCourses when course changes", () => {
    const tracker = memTracker();

    tracker.updateFromRunningVehicles([
      {
        vehicleId: "250",
        lineName: "1",
        courseLoid: 1001,
        direction: "Os. Beskidzkie",
        delaySec: 60,
        latitude: 49.8,
        longitude: 19.0,
        orderInCourse: 1,
        stopPoints: [stop("1", "Cygański Las", 0, 0, 1790080000000), stop("2", "Os. Beskidzkie", 1, 8000, 1790082000000, 1790082060000)],
      },
    ]);

    let veh = tracker.getVehicleDetail("250")!;
    assert.equal(veh.currentCourse?.courseLoid, 1001);

    tracker.updateFromRunningVehicles([
      {
        vehicleId: "250",
        lineName: "1",
        courseLoid: 1002,
        direction: "Cygański Las",
        delaySec: 0,
        latitude: 49.82,
        longitude: 19.03,
        orderInCourse: 0,
        stopPoints: [stop("2", "Os. Beskidzkie", 0, 0, 1790083000000), stop("1", "Cygański Las", 1, 8000, 1790085000000)],
      },
    ]);

    veh = tracker.getVehicleDetail("250")!;
    assert.equal(veh.currentCourse?.courseLoid, 1002);
    assert.equal(veh.todayCourses.length, 1);
    const archived = veh.todayCourses[0];
    assert.equal(archived.courseLoid, 1001);
    assert.equal(archived.status, "completed");
    assert.equal(archived.firstStopName, "Cygański Las");
    assert.equal(archived.lastStopName, "Os. Beskidzkie");

    // the bus shuttles on line 1: the estimate says so (observed 1000 s layover, ~17 min)
    assert.equal(veh.predictedNextCourse?.confidence, "medium");
    assert.equal(veh.predictedNextCourse?.direction, "Os. Beskidzkie");
    assert.equal(veh.predictedNextCourse?.departureSecs, veh.currentCourse!.endSecs + 17 * 60);
  });

  it("derives served lines in order of first service and the main line by course count", () => {
    const tracker = memTracker();
    const course = (courseLoid: number, lineName: string, startMs: number): FleetRunningInput => ({
      vehicleId: "238",
      lineName,
      courseLoid,
      direction: "B",
      delaySec: 0,
      latitude: 49.82,
      longitude: 19.04,
      orderInCourse: 1,
      stopPoints: [stop("1", "A", 0, 0, startMs), stop("2", "B", 1, 3000, startMs + 1_200_000)],
    });
    tracker.updateFromRunningVehicles([course(1, "7", 1790080000000)]);
    tracker.updateFromRunningVehicles([course(2, "50", 1790083600000)]);
    tracker.updateFromRunningVehicles([course(3, "50", 1790087200000)]);
    const veh = tracker.getVehicleDetail("238")!;
    assert.deepEqual(veh.lines, ["7", "50"]);
    assert.equal(veh.mainLine, "50");

    // the line filter finds a depot vehicle by the lines it served today
    tracker.updateFromRunningVehicles([]);
    assert(tracker.getFleetSummary({ line: "7" }).some((v) => v.sideNumber === "238"));
    assert.equal(tracker.getFleetSummary({ query: "#238" })[0].lastLineName, "50");
  });

  it("filters fleet summary by line, status, propulsion, and search query", () => {
    const tracker = memTracker();

    tracker.updateFromRunningVehicles([
      {
        vehicleId: "256", // Solaris hydrogen
        lineName: "8",
        courseLoid: 8001,
        direction: "Szyndzielnia",
        delaySec: 0,
        latitude: 49.8,
        longitude: 19.0,
      },
      {
        vehicleId: "250", // Solaris electric MEGA
        lineName: "1",
        courseLoid: 1001,
        direction: "Cygański Las",
        delaySec: 30,
        latitude: 49.8,
        longitude: 19.0,
      },
    ]);

    const hits256 = tracker.getFleetSummary({ query: "#256" });
    assert.equal(hits256.length, 1);
    assert.equal(hits256[0].sideNumber, "256");

    const h2List = tracker.getFleetSummary({ propulsion: "hydrogen" });
    assert(h2List.length >= 1);
    assert(h2List.every((v) => tracker.getVehicleDetail(v.sideNumber)!.features.hydrogen));

    const electricList = tracker.getFleetSummary({ propulsion: "electric" });
    assert(electricList.length >= 1);
    assert(electricList.every((v) => tracker.getVehicleDetail(v.sideNumber)!.features.electric));

    const active = tracker.getFleetSummary({ status: "active" });
    assert.equal(active.length, 2);
    assert.deepEqual(
      active.map((v) => v.sideNumber),
      ["250", "256"], // running vehicles by line number: 1 before 8
    );

    assert.deepEqual(
      tracker.getFleetSummary({ line: "8" }).map((v) => v.sideNumber),
      ["256"],
    );
  });

  it("marks all stops in completed course as 'passed' when vehicle goes to depot or changes course", () => {
    const tracker = memTracker();

    tracker.updateFromRunningVehicles([
      {
        vehicleId: "230",
        lineName: "7",
        courseLoid: 999991,
        direction: "Zajezdnia MZK",
        delaySec: 0,
        latitude: 49.79,
        longitude: 19.04,
        orderInCourse: 1,
        stopPoints: [
          stop("31", "Szyndzielnia", 0, 0, 1790080000000),
          stop("22", "Armii Krajowej Karbowa", 1, 739, 1790080100000),
          stop("44", "Boboli Szpital", 2, 1500, 1790080200000),
          stop("446", "Zajezdnia MZK", 3, 2300, 1790080300000),
        ],
      },
    ]);

    let veh = tracker.getVehicleDetail("230")!;
    assert(veh.currentCourse);
    assert.equal(veh.currentCourse.stops?.[1].status, "current");
    assert.equal(veh.currentCourse.stops?.[2].status, "upcoming");
    assert.equal(veh.predictedNextCourse, null, "a course into the depot has no next course");

    tracker.updateFromRunningVehicles([]);

    veh = tracker.getVehicleDetail("230")!;
    assert.equal(veh.status, "depot");
    assert.equal(veh.currentCourse, null);

    const completed = veh.todayCourses.find((c) => c.courseLoid === 999991);
    assert(completed, "Completed course must be recorded in todayCourses");
    assert.equal(completed.status, "completed");
    assert(completed.stops && completed.stops.length === 4);
    for (const s of completed.stops) {
      assert.equal(s.status, "passed", `Stop ${s.name} in completed course should be 'passed', was '${s.status}'`);
    }
  });

  it("formats course times strictly in Europe/Warsaw timezone", () => {
    const tracker = memTracker();

    // 1727092800000 ms = 2024-09-23 12:00:00 UTC = 14:00:00 CEST (Europe/Warsaw)
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "250",
        lineName: "1",
        courseLoid: 888801,
        direction: "Osiedle Beskidzkie",
        delaySec: 0,
        latitude: 49.82,
        longitude: 19.04,
        orderInCourse: 0,
        stopPoints: [stop("1", "Cygański Las", 0, 0, 1727092800000), stop("307", "Osiedle Beskidzkie", 1, 4000, 1727094000000)],
      },
    ]);

    const veh = tracker.getVehicleDetail("250");
    assert(veh && veh.currentCourse);
    assert.equal(veh.currentCourse.startTime, "14:00");
    assert.equal(veh.currentCourse.endTime, "14:20");
    assert.equal(veh.currentCourse.stops?.[0].scheduledTime, "14:00");
    assert.equal(veh.currentCourse.stops?.[1].scheduledTime, "14:20");
  });

  it("sorts todayCourses in road card from newest to oldest", () => {
    const tracker = memTracker();
    const course = (courseLoid: number, direction: string, startMs: number): FleetRunningInput => ({
      vehicleId: "238",
      lineName: "8",
      courseLoid,
      direction,
      delaySec: 0,
      latitude: 49.82,
      longitude: 19.04,
      orderInCourse: 0,
      stopPoints: [stop("1", "Start A", 0, 0, startMs), stop("2", "End A", 1, 2000, startMs + 1_800_000)],
    });

    tracker.updateFromRunningVehicles([course(777001, "Warszawska", 1727064000000)]); // 06:00
    tracker.updateFromRunningVehicles([course(777002, "Szyndzielnia", 1727085600000)]); // 12:00
    tracker.updateFromRunningVehicles([course(777003, "Warszawska", 1727096400000)]); // 15:00
    tracker.updateFromRunningVehicles([]);

    const veh = tracker.getVehicleDetail("238")!;
    assert.equal(veh.status, "depot");
    assert.deepEqual(
      veh.todayCourses.map((c) => c.courseLoid),
      [777003, 777002, 777001],
    );
  });

  it("detects broken down vehicle with 50 minutes delay disappearing from GPS and marks course as cancelled", () => {
    const tracker = memTracker();

    tracker.updateFromRunningVehicles([
      {
        vehicleId: "230",
        lineName: "7",
        courseLoid: 999992,
        direction: "Zajezdnia MZK",
        delaySec: 3000, // 50 min delay
        latitude: 49.79,
        longitude: 19.04,
        orderInCourse: 1,
        stopPoints: [
          stop("31", "Szyndzielnia", 0, 0, 1790080000000, 1790083000000),
          stop("22", "Armii Krajowej Karbowa", 1, 739, 1790080100000, 1790083100000),
          stop("44", "Boboli Szpital", 2, 1500, 1790080200000, 1790083200000),
          stop("446", "Zajezdnia MZK", 3, 2300, 1790080300000, 1790083300000),
        ],
      },
    ]);

    let veh = tracker.getVehicleDetail("230")!;
    assert(veh.currentCourse);
    assert.equal(veh.currentCourse.delaySec, 3000);
    assert.equal(veh.currentCourse.currentStopName, "Armii Krajowej Karbowa");

    // the bus disappears from GPS mid-route (broke down, towed, or turned off)
    tracker.updateFromRunningVehicles([]);

    veh = tracker.getVehicleDetail("230")!;
    assert.equal(veh.status, "depot");
    assert.equal(veh.currentCourse, null);

    const cancelled = veh.todayCourses.find((c) => c.courseLoid === 999992);
    assert(cancelled, "Cancelled course must be recorded in todayCourses");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelledAtStopName, "Armii Krajowej Karbowa");
    assert(
      cancelled.cancelledReason?.includes("50 min") && cancelled.cancelledReason?.includes("Armii Krajowej Karbowa"),
      `Expected cancellation reason to describe 50 min delay and stop, got: ${cancelled.cancelledReason}`,
    );
    // only the distance to the last stop reached counts as driven
    assert.equal(cancelled.drivenMeters, 739);

    assert(cancelled.stops && cancelled.stops.length === 4);
    assert.equal(cancelled.stops[0].status, "passed");
    assert.equal(cancelled.stops[1].status, "current");
    assert.equal(cancelled.stops[2].status, "upcoming");
    assert.equal(cancelled.stops[3].status, "upcoming");

    assert.equal(veh.stats.cancelledCoursesToday, 1);
    assert.equal(veh.stats.completedCoursesToday, 0);
    assert(
      veh.lastKnownLocation?.name.includes("Utrata sygnału GPS"),
      `Expected breakdown description in lastKnownLocation, got: ${veh.lastKnownLocation?.name}`,
    );

    const summary = tracker.getFleetSummary({ query: "#230" });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].cancelledCoursesToday, 1);
    assert.equal(tracker.getStats().coursesCancelledToday, 1);
  });

  it("marks course as completed if vehicle reaches terminus even with large delay", () => {
    const tracker = memTracker();

    tracker.updateFromRunningVehicles([
      {
        vehicleId: "230",
        lineName: "7",
        courseLoid: 999993,
        direction: "Zajezdnia MZK",
        delaySec: 3000,
        latitude: 49.79,
        longitude: 19.04,
        orderInCourse: 3,
        stopPoints: [
          stop("31", "Szyndzielnia", 0, 0, 1790080000000, 1790083000000),
          stop("22", "Armii Krajowej Karbowa", 1, 739, 1790080100000, 1790083100000),
          stop("44", "Boboli Szpital", 2, 1500, 1790080200000, 1790083200000),
          stop("446", "Zajezdnia MZK", 3, 2300, 1790080300000, 1790083300000),
        ],
      },
    ]);

    tracker.updateFromRunningVehicles([]);

    const veh = tracker.getVehicleDetail("230")!;
    const completed = veh.todayCourses.find((c) => c.courseLoid === 999993);
    assert(completed);
    assert.equal(completed.status, "completed");
    assert(completed.stops?.every((s) => s.status === "passed"));
  });

  it("recovers cleanly without duplicates when GPS reconnects after temporary dropout", () => {
    const tracker = memTracker();

    const courseData: FleetRunningInput = {
      vehicleId: "230",
      lineName: "7",
      courseLoid: 999994,
      direction: "Zajezdnia MZK",
      delaySec: 3000,
      latitude: 49.79,
      longitude: 19.04,
      orderInCourse: 1,
      stopPoints: [
        stop("31", "Szyndzielnia", 0, 0, 1790080000000, 1790083000000),
        stop("22", "Armii Krajowej Karbowa", 1, 739, 1790080100000, 1790083100000),
        stop("44", "Boboli Szpital", 2, 1500, 1790080200000, 1790083200000),
        stop("446", "Zajezdnia MZK", 3, 2300, 1790080300000, 1790083300000),
      ],
    };

    tracker.updateFromRunningVehicles([courseData]);
    tracker.updateFromRunningVehicles([]);
    let veh = tracker.getVehicleDetail("230")!;
    assert.equal(veh.status, "depot");
    assert(veh.todayCourses.some((c) => c.courseLoid === 999994));

    tracker.updateFromRunningVehicles([courseData]);
    veh = tracker.getVehicleDetail("230")!;
    assert.equal(veh.status, "active");
    assert.equal(veh.currentCourse?.courseLoid, 999994);
    assert(
      !veh.todayCourses.some((c) => c.courseLoid === 999994),
      "Live reconnected course must be removed from todayCourses to prevent duplicates",
    );
    assert.equal(veh.stats.cancelledCoursesToday, 0);
  });

  // OnTime drops a course on arrival (or hands the bus its next one) before the terminus registers
  it("a late course that leaves the feed on its last leg was run to the end", () => {
    const tracker = memTracker();
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "230",
        lineName: "7",
        courseLoid: 999995,
        direction: "Zajezdnia MZK",
        delaySec: 900,
        latitude: 49.79,
        longitude: 19.04,
        orderInCourse: 2,
        stopPoints: [
          stop("31", "Szyndzielnia", 0, 0, 1790080000000),
          stop("22", "Armii Krajowej Karbowa", 1, 739, 1790080100000),
          stop("44", "Boboli Szpital", 2, 1500, 1790080200000),
          stop("446", "Zajezdnia MZK", 3, 2300, 1790080300000),
        ],
      },
    ]);
    tracker.updateFromRunningVehicles([]);

    const veh = tracker.getVehicleDetail("230")!;
    const c = veh.todayCourses.find((x) => x.courseLoid === 999995)!;
    assert.equal(c.status, "completed");
    assert.equal(c.cancelledReason, undefined);
    assert.equal(c.drivenMeters, c.lengthMeters);
    assert.equal(veh.stats.cancelledCoursesToday, 0);
    assert(!veh.lastKnownLocation?.name.includes("Utrata sygnału GPS"));
  });

  it("a late course that leaves the feed within 300 m of its end was run, stops left or not", () => {
    const tracker = memTracker();
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "230",
        lineName: "7",
        courseLoid: 999996,
        direction: "Zajezdnia MZK",
        delaySec: 1200,
        latitude: 49.79,
        longitude: 19.04,
        orderInCourse: 1,
        reachedMeters: 1560,
        stopPoints: [
          stop("31", "Szyndzielnia", 0, 0, 1790080000000),
          stop("22", "Armii Krajowej Karbowa", 1, 1500, 1790080100000),
          stop("44", "Boboli Szpital", 2, 120, 1790080200000),
          stop("45", "Boboli", 3, 100, 1790080250000),
          stop("446", "Zajezdnia MZK", 4, 80, 1790080300000),
        ],
      },
    ]);
    tracker.updateFromRunningVehicles([]);

    const c = tracker.getVehicleDetail("230")!.todayCourses.find((x) => x.courseLoid === 999996)!;
    assert.equal(c.status, "completed");
    assert.equal(c.drivenMeters, 1800);
  });

  it("a late bus moved to its next course mid-route: the first one was cut short, not lost", () => {
    const tracker = memTracker();
    const course = (courseLoid: number, orderInCourse: number): FleetRunningInput => ({
      vehicleId: "230",
      lineName: "7",
      courseLoid,
      direction: "Zajezdnia MZK",
      delaySec: 900,
      latitude: 49.79,
      longitude: 19.04,
      orderInCourse,
      stopPoints: [
        stop("31", "Szyndzielnia", 0, 0, 1790080000000),
        stop("22", "Armii Krajowej Karbowa", 1, 739, 1790080100000),
        stop("44", "Boboli Szpital", 2, 1500, 1790080200000),
        stop("446", "Zajezdnia MZK", 3, 2300, 1790080300000),
      ],
    });
    tracker.updateFromRunningVehicles([course(999997, 1)]);
    tracker.updateFromRunningVehicles([course(999998, 0)]);

    const veh = tracker.getVehicleDetail("230")!;
    assert.equal(veh.currentCourse?.courseLoid, 999998);
    const cut = veh.todayCourses.find((x) => x.courseLoid === 999997)!;
    assert.equal(cut.status, "cancelled");
    assert.equal(cut.cancelledAtStopName, "Armii Krajowej Karbowa");
    assert(cut.cancelledReason?.startsWith("Kurs skrócony"), `got: ${cut.cancelledReason}`);
    assert.equal(cut.drivenMeters, 739);
  });

  it("samples the running fleet into 5-minute punctuality slots (last sample wins)", () => {
    mock.timers.enable({ apis: ["Date"], now: NOON_OCT4_MS + 70_000 }); // 12:01:10
    const tracker = memTracker();
    const base = (vehicleId: string, delaySec: number, extra: Partial<FleetRunningInput> = {}): FleetRunningInput => ({
      vehicleId,
      lineName: "1",
      courseLoid: Number(vehicleId),
      direction: "B",
      delaySec,
      latitude: 49.8,
      longitude: 19.0,
      orderInCourse: 1,
      ...extra,
    });
    const waiting = base("250", 840, { orderInCourse: 0, lastStopOrderNo: null });

    tracker.updateFromRunningVehicles([base("230", 0), base("233", 900), waiting]);
    let tl = tracker.getTimeline();
    assert.equal(tl.length, 1);
    assert.deepEqual(tl[0], { t: 12 * 3600, waiting: 1, early: 0, onTime: 1, late: 0, veryLate: 1 });

    // same slot: overwritten, not added up
    mock.timers.setTime(NOON_OCT4_MS + 200_000);
    tracker.updateFromRunningVehicles([base("230", -120)]);
    tl = tracker.getTimeline();
    assert.equal(tl.length, 1);
    assert.deepEqual(tl[0], { t: 12 * 3600, waiting: 0, early: 1, onTime: 0, late: 0, veryLate: 0 });

    // next slot
    mock.timers.setTime(NOON_OCT4_MS + TIMELINE_SLOT_SECS * 1000);
    tracker.updateFromRunningVehicles([base("230", 300)]);
    tl = tracker.getTimeline();
    assert.deepEqual(
      tl.map((p) => p.t),
      [12 * 3600, 12 * 3600 + TIMELINE_SLOT_SECS],
    );
    assert.equal(tl[1].late, 1);
  });
});

describe("fleet-tracker persistence", () => {
  const tmpDirs: string[] = [];
  const mkTmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fleet-"));
    tmpDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("restores the day's history, drops back-filled synth courses and sanitizes completed stops", () => {
    mock.timers.enable({ apis: ["Date"], now: NOON_OCT4_MS });
    const dir = mkTmp();
    const realCourse = {
      id: "c-555001",
      courseLoid: 555001,
      lineName: "16",
      direction: "Hałcnów",
      firstStopName: "Dworzec",
      lastStopName: "Hałcnów",
      startTime: "09:00",
      endTime: "09:30",
      startSecs: 9 * 3600,
      endSecs: 9.5 * 3600,
      delaySec: 60,
      stopsCount: 2,
      status: "completed",
      lengthMeters: 6400,
      stops: [
        { symbol: "1", name: "Dworzec", scheduledTime: "09:00", plannedTime: "09:00", status: "passed" },
        { symbol: "2", name: "Hałcnów", scheduledTime: "09:30", plannedTime: "09:31", status: "current" },
      ],
    };
    const synth = { ...realCourse, id: "synth-167-0", courseLoid: undefined, startSecs: 5.5 * 3600 };
    fs.writeFileSync(
      path.join(dir, "fleet-history-2026-10-04.json"),
      JSON.stringify({
        _v: 2,
        _timeline: [{ t: 9 * 3600, waiting: 0, early: 0, onTime: 3, late: 1, veryLate: 0 }],
        "167": { todayCourses: [realCourse, synth], lastSeenAt: Math.floor(NOON_OCT4_MS / 1000) - 3600 },
      }),
    );

    const tracker = new FleetTracker({ historyDir: dir });
    const veh = tracker.getVehicleDetail("167")!;
    assert.deepEqual(
      veh.todayCourses.map((c) => c.id),
      ["c-555001"],
    );
    assert(veh.todayCourses[0].stops?.every((s) => s.status === "passed"));
    assert.equal(veh.stats.kmToday, 6.4);
    assert.deepEqual(veh.lines, ["16"]);
    assert.equal(veh.status, "depot");
    assert.equal(tracker.getTimeline().length, 1);
    assert.equal(tracker.getStats().seenTodayCount, 1);
  });

  it("re-judges saved interrupted courses: one that left on its last leg was run", () => {
    mock.timers.enable({ apis: ["Date"], now: NOON_OCT4_MS });
    const dir = mkTmp();
    const base = {
      lineName: "7",
      direction: "Zajezdnia MZK",
      firstStopName: "Szyndzielnia",
      lastStopName: "Zajezdnia MZK",
      startTime: "09:00",
      endTime: "09:30",
      startSecs: 9 * 3600,
      endSecs: 9.5 * 3600,
      delaySec: 1500,
      stopsCount: 3,
      status: "cancelled",
      lengthMeters: 4000,
      drivenMeters: 2500,
      cancelledReason: "Kurs przerwany: …",
      cancelledAtStopName: "Boboli Szpital",
    };
    const stops = (current: number) =>
      ["Szyndzielnia", "Boboli Szpital", "Zajezdnia MZK"].map((name, i) => ({
        symbol: String(i),
        name,
        scheduledTime: "09:00",
        plannedTime: "09:25",
        status: i < current ? "passed" : i === current ? "current" : "upcoming",
      }));
    fs.writeFileSync(
      path.join(dir, "fleet-history-2026-10-04.json"),
      JSON.stringify({
        _v: 2,
        "167": {
          todayCourses: [
            { ...base, id: "c-1", courseLoid: 1, stops: stops(1) },
            { ...base, id: "c-2", courseLoid: 2, startSecs: 8 * 3600, drivenMeters: 0, stops: stops(0) },
          ],
          lastSeenAt: Math.floor(NOON_OCT4_MS / 1000) - 3600,
        },
      }),
    );

    const veh = new FleetTracker({ historyDir: dir }).getVehicleDetail("167")!;
    const run = veh.todayCourses.find((c) => c.id === "c-1")!;
    assert.equal(run.status, "completed");
    assert.equal(run.cancelledReason, undefined);
    assert.equal(run.drivenMeters, 4000);
    assert(run.stops?.every((s) => s.status === "passed"));
    const cut = veh.todayCourses.find((c) => c.id === "c-2")!;
    assert.equal(cut.status, "cancelled");
    assert.equal(veh.stats.cancelledCoursesToday, 1);
  });

  it("rolls over at Warsaw midnight: the old day is saved, the new day starts empty", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 4, 21, 50, 0) }); // 23:50 Warsaw
    const dir = mkTmp();
    const tracker = new FleetTracker({ historyDir: dir });
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "250",
        lineName: "1",
        courseLoid: 4242,
        direction: "B",
        delaySec: 0,
        latitude: 49.8,
        longitude: 19.0,
        orderInCourse: 1,
        stopPoints: [stop("1", "A", 0, 0, 1790080000000), stop("2", "B", 1, 3000, 1790081200000)],
      },
    ]);
    tracker.updateFromRunningVehicles([]);
    assert.equal(tracker.getVehicleDetail("250")!.todayCourses.length, 1);

    mock.timers.setTime(Date.UTC(2026, 9, 4, 22, 5, 0)); // 00:05 Warsaw, 2026-10-05
    tracker.updateFromRunningVehicles([]);
    const veh = tracker.getVehicleDetail("250")!;
    assert.deepEqual(veh.todayCourses, []);
    assert.equal(veh.lastSeenAt, 0);
    assert.equal(tracker.getStats().kmToday, 0);
    assert.equal(tracker.getTimeline().length, 1, "only the new day's first sample");

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "fleet-history-2026-10-04.json"), "utf-8")) as Record<
      string,
      { todayCourses?: { courseLoid?: number }[] }
    >;
    assert.equal(saved["250"]?.todayCourses?.[0]?.courseLoid, 4242);
  });
});

describe("shared fleet helpers", () => {
  it("classifies delays: -1..+3 min is on time, over 10 min very late", () => {
    assert.equal(classifyDelay(-61), "early");
    assert.equal(classifyDelay(-60), "onTime");
    assert.equal(classifyDelay(180), "onTime");
    assert.equal(classifyDelay(181), "late");
    assert.equal(classifyDelay(600), "late");
    assert.equal(classifyDelay(601), "veryLate");
  });

  it("median handles empty, odd and even inputs without mutating them", () => {
    const xs = [5, 1, 3, 2];
    assert.equal(median([]), null);
    assert.equal(median([4, 1, 9]), 4);
    assert.equal(median(xs), 2.5);
    assert.deepEqual(xs, [5, 1, 3, 2]);
  });

  it("folds Polish diacritics including ł", () => {
    assert.equal(foldText("Łódź Żywiec Ćwiklice"), "lodz zywiec cwiklice");
  });

  it("orders line names numerically, then alphabetically", () => {
    assert.deepEqual(["10", "A", "2", "1", "N1"].sort(compareLineNames), ["1", "2", "10", "A", "N1"]);
  });

  it("matches side numbers, lines and folded text without line/side confusion", () => {
    const v = {
      sideNumber: "123",
      model: "Solaris Urbino 12",
      producer: "Solaris",
      lines: ["7"],
      lineName: "50",
      direction: "Żywiec Dworzec",
      currentStopName: "Hałcnów",
    };
    assert.equal(matchesFleetQuery(v, ""), true);
    assert.equal(matchesFleetQuery(v, "#12"), true);
    assert.equal(matchesFleetQuery(v, "123"), true);
    assert.equal(matchesFleetQuery(v, "1"), false, "line 1 must match neither side 123 nor model Urbino 12");
    assert.equal(matchesFleetQuery(v, "urbino 12"), true);
    assert.equal(matchesFleetQuery(v, "50"), true);
    assert.equal(matchesFleetQuery(v, "7"), true);
    assert.equal(matchesFleetQuery(v, "zywiec"), true);
    assert.equal(matchesFleetQuery(v, "halcnow"), true);
    assert.equal(matchesFleetQuery(v, "#urbino"), false);
  });
});
