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
});
