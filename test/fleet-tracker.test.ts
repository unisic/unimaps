import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FleetTracker } from "../lib/fleet-tracker";

describe("fleet-tracker & brigades", () => {
  it("initializes with full static fleet in depot state", () => {
    const tracker = new FleetTracker();
    const stats = tracker.getStats();

    assert(stats.totalFleet >= 140, `Expected >= 140 vehicles, got ${stats.totalFleet}`);
    assert.equal(stats.activeCount, 0);
    assert.equal(stats.depotCount, stats.totalFleet);

    const veh230 = tracker.getVehicleDetail("230");
    assert(veh230, "Vehicle 230 should exist");
    assert.equal(veh230.sideNumber, "230");
    assert.equal(veh230.model, "Isuzu Novociti Life");
    assert.equal(veh230.status, "depot");
  });

  it("updates vehicle status and current course on active running vehicles", () => {
    const tracker = new FleetTracker();

    const sampleRunning = [
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
          {
            symbol: "2375",
            name: "Czechowice-Dziedzice Silesia",
            orderNo: 0,
            distance: 0,
            scheduledDeparture: 1790097000000,
            plannedDeparture: 1790097060000,
          },
          {
            symbol: "2376",
            name: "Czechowice-Dz. Górnicza",
            orderNo: 1,
            distance: 371,
            scheduledDeparture: 1790097060000,
            plannedDeparture: 1790097120000,
          },
          {
            symbol: "2373",
            name: "Czechowice-Dz. Węglowa",
            orderNo: 2,
            distance: 850,
            scheduledDeparture: 1790097120000,
            plannedDeparture: 1790097240000,
          },
          {
            symbol: "307",
            name: "Osiedle Karpackie",
            orderNo: 3,
            distance: 25000,
            scheduledDeparture: 1790099820000,
            plannedDeparture: 1790099940000,
          },
        ],
      },
    ];

    tracker.updateFromRunningVehicles(sampleRunning);

    const stats = tracker.getStats();
    assert.equal(stats.activeCount, 1);
    assert.equal(stats.depotCount, stats.totalFleet - 1);
    assert.deepEqual(stats.activeLines, ["50"]);

    const veh233 = tracker.getVehicleDetail("233");
    assert(veh233, "Vehicle 233 should be found");
    assert.equal(veh233.status, "active");
    assert.equal(veh233.brigade.id, "50/1");
    assert.equal(veh233.brigade.label, "Brygada 50/1");

    assert(veh233.currentCourse, "Current course must exist");
    assert.equal(veh233.currentCourse.lineName, "50");
    assert.equal(veh233.currentCourse.firstStopName, "Czechowice-Dziedzice Silesia");
    assert.equal(veh233.currentCourse.lastStopName, "Osiedle Karpackie");
    assert.equal(veh233.currentCourse.currentStopName, "Czechowice-Dz. Węglowa");
    assert.equal(veh233.currentCourse.nextStopName, "Osiedle Karpackie");
    assert.equal(veh233.currentCourse.delaySec, 120);

    // Predicts next course correctly
    assert(veh233.predictedNextCourse, "Predicted next course should be computed");
    assert.equal(veh233.predictedNextCourse.lineName, "50");
    assert.equal(veh233.predictedNextCourse.fromStopName, "Osiedle Karpackie");
    assert.equal(veh233.predictedNextCourse.direction, "Czechowice-Dziedzice Silesia");
    assert(veh233.predictedNextCourse.pauseMinutes >= 5);
  });

  it("archives previous course to todayCourses when course changes", () => {
    const tracker = new FleetTracker();

    // First course
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
        stopPoints: [
          { symbol: "1", name: "Cygański Las", orderNo: 0, distance: 0, scheduledDeparture: 1790080000000, plannedDeparture: 1790080000000 },
          { symbol: "2", name: "Os. Beskidzkie", orderNo: 1, distance: 8000, scheduledDeparture: 1790082000000, plannedDeparture: 1790082060000 },
        ],
      },
    ]);

    let veh = tracker.getVehicleDetail("250")!;
    assert.equal(veh.currentCourse?.courseLoid, 1001);

    // Transition to second course
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
        stopPoints: [
          { symbol: "2", name: "Os. Beskidzkie", orderNo: 0, distance: 0, scheduledDeparture: 1790083000000, plannedDeparture: 1790083000000 },
          { symbol: "1", name: "Cygański Las", orderNo: 1, distance: 8000, scheduledDeparture: 1790085000000, plannedDeparture: 1790085000000 },
        ],
      },
    ]);

    veh = tracker.getVehicleDetail("250")!;
    assert.equal(veh.currentCourse?.courseLoid, 1002);
    assert(veh.todayCourses.length >= 1, "Must contain previous course in todayCourses");
    const archived = veh.todayCourses.find((c) => c.courseLoid === 1001);
    assert(archived, "Course 1001 must be archived in history");
    assert.equal(archived.status, "completed");
    assert.equal(archived.firstStopName, "Cygański Las");
    assert.equal(archived.lastStopName, "Os. Beskidzkie");
  });

  it("filters fleet summary by line, status, propulsion, and search query", () => {
    const tracker = new FleetTracker();

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

    // Query for side number #256
    const hits256 = tracker.getFleetSummary({ query: "#256" });
    assert.equal(hits256.length, 1);
    assert.equal(hits256[0].sideNumber, "256");

    // Filter hydrogen propulsion
    const h2List = tracker.getFleetSummary({ propulsion: "hydrogen" });
    assert(h2List.length >= 1);
    assert(h2List.every((v) => v.features.hydrogen));

    // Filter electric MEGA
    const electricList = tracker.getFleetSummary({ propulsion: "electric" });
    assert(electricList.length >= 1);
    assert(electricList.every((v) => v.features.electric));

    // Filter status active
    const active = tracker.getFleetSummary({ status: "active" });
    assert.equal(active.length, 2);
    assert(active.some((v) => v.sideNumber === "256"));
    assert(active.some((v) => v.sideNumber === "250"));
  });

  it("marks all stops in completed course as 'passed' when vehicle goes to depot or changes course", () => {
    const tracker = new FleetTracker();

    // Vehicle 230 runs course with 4 stops, currently at stop index 1
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
          { symbol: "31", name: "Szyndzielnia", orderNo: 0, distance: 0, scheduledDeparture: 1790080000000, plannedDeparture: 1790080000000 },
          { symbol: "22", name: "Armii Krajowej Karbowa", orderNo: 1, distance: 739, scheduledDeparture: 1790080100000, plannedDeparture: 1790080100000 },
          { symbol: "44", name: "Boboli Szpital", orderNo: 2, distance: 1500, scheduledDeparture: 1790080200000, plannedDeparture: 1790080200000 },
          { symbol: "446", name: "Zajezdnia MZK", orderNo: 3, distance: 2300, scheduledDeparture: 1790080300000, plannedDeparture: 1790080300000 },
        ],
      },
    ]);

    let veh = tracker.getVehicleDetail("230")!;
    assert(veh.currentCourse);
    assert.equal(veh.currentCourse.stops?.[1].status, "current");
    assert.equal(veh.currentCourse.stops?.[2].status, "upcoming");

    // Vehicle goes to depot (no longer in running vehicles)
    tracker.updateFromRunningVehicles([]);

    veh = tracker.getVehicleDetail("230")!;
    assert.equal(veh.status, "depot");
    assert.equal(veh.currentCourse, null);

    const completed = veh.todayCourses.find((c) => c.courseLoid === 999991);
    assert(completed, "Completed course must be recorded in todayCourses");
    assert.equal(completed.status, "completed");
    assert(completed.stops && completed.stops.length === 4);

    // CRITICAL: All stops in the completed course must be 'passed', none 'current' or 'upcoming'
    for (const stop of completed.stops) {
      assert.equal(
        stop.status,
        "passed",
        `Stop ${stop.name} in completed course should have status 'passed', but was '${stop.status}'`,
      );
    }
  });

  it("ensures historical completed courses have all stops sanitized to 'passed'", () => {
    const tracker = new FleetTracker();
    const veh = tracker.getVehicleDetail("167");
    assert(veh);

    // Any completed course in todayCourses (from disk or memory) must not have any 'current' stop
    for (const course of veh.todayCourses) {
      if (course.status === "completed" && course.stops) {
        for (const stop of course.stops) {
          assert.equal(
            stop.status,
            "passed",
            `Historical stop ${stop.name} in course ${course.id} must be 'passed'`,
          );
        }
      }
    }
  });

  it("formats course times strictly in Europe/Warsaw timezone", () => {
    const tracker = new FleetTracker();

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
        stopPoints: [
          {
            symbol: "1",
            name: "Cygański Las",
            orderNo: 0,
            distance: 0,
            scheduledDeparture: 1727092800000,
            plannedDeparture: 1727092800000,
          },
          {
            symbol: "307",
            name: "Osiedle Beskidzkie",
            orderNo: 1,
            distance: 4000,
            scheduledDeparture: 1727094000000, // 14:20 Warsaw
            plannedDeparture: 1727094000000,
          },
        ],
      },
    ]);

    const veh = tracker.getVehicleDetail("250");
    assert(veh && veh.currentCourse);
    assert.equal(
      veh.currentCourse.startTime,
      "14:00",
      `Expected startTime in Europe/Warsaw (14:00), got ${veh.currentCourse.startTime}`,
    );
    assert.equal(
      veh.currentCourse.endTime,
      "14:20",
      `Expected endTime in Europe/Warsaw (14:20), got ${veh.currentCourse.endTime}`,
    );
    assert.equal(veh.currentCourse.stops?.[0].scheduledTime, "14:00");
    assert.equal(veh.currentCourse.stops?.[1].scheduledTime, "14:20");
  });

  it("sorts todayCourses in road card from newest to oldest", () => {
    const tracker = new FleetTracker();

    // Vehicle 238 runs first morning course (06:00 Warsaw = 1727064000000)
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "238",
        lineName: "8",
        courseLoid: 777001,
        direction: "Warszawska",
        delaySec: 0,
        latitude: 49.82,
        longitude: 19.04,
        orderInCourse: 0,
        stopPoints: [
          { symbol: "1", name: "Start A", orderNo: 0, distance: 0, scheduledDeparture: 1727064000000, plannedDeparture: 1727064000000 },
          { symbol: "2", name: "End A", orderNo: 1, distance: 2000, scheduledDeparture: 1727065800000, plannedDeparture: 1727065800000 },
        ],
      },
    ]);

    // Vehicle 238 switches to midday course (12:00 Warsaw = 1727085600000)
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "238",
        lineName: "8",
        courseLoid: 777002,
        direction: "Szyndzielnia",
        delaySec: 0,
        latitude: 49.82,
        longitude: 19.04,
        orderInCourse: 0,
        stopPoints: [
          { symbol: "2", name: "End A", orderNo: 0, distance: 0, scheduledDeparture: 1727085600000, plannedDeparture: 1727085600000 },
          { symbol: "1", name: "Start A", orderNo: 1, distance: 2000, scheduledDeparture: 1727087400000, plannedDeparture: 1727087400000 },
        ],
      },
    ]);

    // Vehicle 238 switches to afternoon course (15:00 Warsaw = 1727096400000)
    tracker.updateFromRunningVehicles([
      {
        vehicleId: "238",
        lineName: "8",
        courseLoid: 777003,
        direction: "Warszawska",
        delaySec: 0,
        latitude: 49.82,
        longitude: 19.04,
        orderInCourse: 0,
        stopPoints: [
          { symbol: "1", name: "Start A", orderNo: 0, distance: 0, scheduledDeparture: 1727096400000, plannedDeparture: 1727096400000 },
          { symbol: "2", name: "End A", orderNo: 1, distance: 2000, scheduledDeparture: 1727098200000, plannedDeparture: 1727098200000 },
        ],
      },
    ]);

    // Go to depot so all 3 courses are in todayCourses
    tracker.updateFromRunningVehicles([]);

    const veh = tracker.getVehicleDetail("238")!;
    assert.equal(veh.status, "depot");
    assert(veh.todayCourses.length >= 3);

    // Filter to the 3 real courses
    const testCourses = veh.todayCourses.filter(
      (c) => c.courseLoid && [777001, 777002, 777003].includes(c.courseLoid),
    );
    assert.equal(testCourses.length, 3);

    // Verify strictly descending order: 777003 (15:00) -> 777002 (12:00) -> 777001 (06:00)
    assert.equal(testCourses[0].courseLoid, 777003);
    assert.equal(testCourses[1].courseLoid, 777002);
    assert.equal(testCourses[2].courseLoid, 777001);

    // Verify all todayCourses are in descending order
    for (let i = 0; i < veh.todayCourses.length - 1; i++) {
      const cur = veh.todayCourses[i].startSecs;
      const next = veh.todayCourses[i + 1].startSecs;
      assert(
        cur >= next,
        `Expected descending course order: course at index ${i} (${cur}) should be >= course at index ${i + 1} (${next})`,
      );
    }
  });
});

