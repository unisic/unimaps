import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hhmmFromSecs, secsFromHHMM } from "../lib/client/format";
import type { TimetableDeparture } from "../lib/client/types";
import { bearing, metersBetween } from "../lib/geo";
import { mzkAngleToCompassBearing } from "../lib/mzk-poller";

describe("mzk-timetable and schedule logic", () => {
  it("formats seconds to HH:MM correctly in 24h format with midnight wrap", () => {
    assert.equal(hhmmFromSecs(0), "00:00");
    assert.equal(hhmmFromSecs(3600), "01:00");
    assert.equal(hhmmFromSecs(12 * 3600 + 30 * 60), "12:30");
    assert.equal(hhmmFromSecs(23 * 3600 + 59 * 60), "23:59");
    assert.equal(hhmmFromSecs(24 * 3600 + 15 * 60), "00:15"); // midnight wrap
  });

  it("parses HH:MM strings to agency-local seconds", () => {
    assert.equal(secsFromHHMM("00:00"), 0);
    assert.equal(secsFromHHMM("06:30"), 6 * 3600 + 30 * 60);
    assert.equal(secsFromHHMM("14:45"), 14 * 3600 + 45 * 60);
    assert.equal(secsFromHHMM("23:59"), 23 * 3600 + 59 * 60);
  });

  it("sorts combined KB and MZK departures in chronological order", () => {
    const kbDepartures: TimetableDeparture[] = [
      {
        departure: 7 * 3600 + 15 * 60,
        trip_id: "kb:101",
        line: "101",
        direction: "Szczyrk",
        operator: "KB",
      },
      {
        departure: 7 * 3600 + 45 * 60,
        trip_id: "kb:102",
        line: "101",
        direction: "Szczyrk",
        operator: "KB",
      },
    ];

    const mzkDepartures: TimetableDeparture[] = [
      {
        departure: 7 * 3600 + 10 * 60,
        trip_id: "mzk:5001:100",
        line: "1",
        direction: "Cygański Las",
        operator: "MZK",
      },
      {
        departure: 7 * 3600 + 30 * 60,
        trip_id: "mzk:5002:100",
        line: "8",
        direction: "Kamienica",
        operator: "MZK",
      },
      {
        departure: 8 * 3600,
        trip_id: "mzk:5003:100",
        line: "1",
        direction: "Cygański Las",
        operator: "MZK",
      },
    ];

    const combined = [...kbDepartures, ...mzkDepartures].sort(
      (a, b) => a.departure - b.departure,
    );

    assert.equal(combined.length, 5);
    assert.deepEqual(
      combined.map((d) => ({ line: d.line, op: d.operator, time: hhmmFromSecs(d.departure) })),
      [
        { line: "1", op: "MZK", time: "07:10" },
        { line: "101", op: "KB", time: "07:15" },
        { line: "8", op: "MZK", time: "07:30" },
        { line: "101", op: "KB", time: "07:45" },
        { line: "1", op: "MZK", time: "08:00" },
      ],
    );
  });

  it("properly constructs MZK trip_id identifiers with course and variant", () => {
    const courseId = 5055448;
    const variantId = 14767;
    const tripId = `mzk:${courseId}:${variantId}`;

    assert(tripId.startsWith("mzk:"));
    const parts = tripId.split(":");
    assert.equal(parts[1], "5055448");
    assert.equal(parts[2], "14767");
  });

  it("converts OnTime Cartesian angles to standard navigation compass bearings", () => {
    // North: Cartesian 90° -> Compass 0°
    assert.equal(mzkAngleToCompassBearing(90), 0);

    // East: Cartesian 0° -> Compass 90°
    assert.equal(mzkAngleToCompassBearing(0), 90);

    // South: Cartesian -90° -> Compass 180°
    assert.equal(mzkAngleToCompassBearing(-90), 180);

    // West: Cartesian 180° or -180° -> Compass 270°
    assert.equal(mzkAngleToCompassBearing(180), 270);
    assert.equal(mzkAngleToCompassBearing(-180), 270);

    // North-West: Cartesian 127° -> Compass 323°
    assert.equal(mzkAngleToCompassBearing(127), 323);

    // North-East: Cartesian 45° -> Compass 45°
    assert.equal(mzkAngleToCompassBearing(45), 45);

    // South-East: Cartesian -45° -> Compass 135°
    assert.equal(mzkAngleToCompassBearing(-45), 135);

    // South-West: Cartesian -135° -> Compass 225°
    assert.equal(mzkAngleToCompassBearing(-135), 225);
  });

  it("computes movement bearing correctly for vehicle displacement", () => {
    // Bus moving north along Warszawska
    const lat1 = 49.82;
    const lon1 = 19.04;
    const lat2 = 49.83;
    const lon2 = 19.04;

    const dist = metersBetween(lat1, lon1, lat2, lon2);
    assert(dist > 500, "Distance should be > 500m");

    const brg = bearing(lat1, lon1, lat2, lon2);
    assert(brg !== null);
    assert(Math.abs(brg - 0) < 0.1 || Math.abs(brg - 360) < 0.1, `Expected North (0°), got ${brg}`);

    // Bus moving south towards Cygański Las
    const sBrg = bearing(lat2, lon2, lat1, lon1);
    assert(sBrg !== null);
    assert(Math.abs(sBrg - 180) < 0.1, `Expected South (180°), got ${sBrg}`);
  });
});
