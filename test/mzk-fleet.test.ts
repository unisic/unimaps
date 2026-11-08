import assert from "node:assert/strict";
import { describe, it } from "node:test";
// the getFleetDetails cases moved with the matcher to backend/tests/mzk_fleet.rs
import { getAllFleetVehicles, type FleetVehicleSummary } from "../lib/mzk-fleet";

describe("mzk-fleet", () => {
  it("exports all fleet vehicles correctly via getAllFleetVehicles", () => {
    const fleet = getAllFleetVehicles();
    assert(fleet.length >= 140, `Expected >= 140 vehicles, got ${fleet.length}`);

    // Sorted by side number
    for (let i = 1; i < fleet.length; i++) {
      assert(
        parseInt(fleet[i].sideNumber, 10) >= parseInt(fleet[i - 1].sideNumber, 10),
        `Order violation between ${fleet[i - 1].sideNumber} and ${fleet[i].sideNumber}`,
      );
    }

    // Hydrogen vehicles 256-259
    const h2Bus = fleet.find((f: FleetVehicleSummary) => f.sideNumber === "258");
    assert(h2Bus, "Vehicle 258 should exist");
    assert.equal(h2Bus.model, "Solaris Urbino 12 hydrogen");
    assert.equal(h2Bus.fuelType, "hydrogen");

    // Isuzu Novociti Life 230
    const isuzu = fleet.find((f: FleetVehicleSummary) => f.sideNumber === "230");
    assert(isuzu, "Vehicle 230 should exist");
    assert.equal(isuzu.model, "Isuzu Novociti Life");
    assert.equal(isuzu.lengthCategory, "MINI");

    // Mercedes Citaro G 146
    const citaro = fleet.find((f: FleetVehicleSummary) => f.sideNumber === "146");
    assert(citaro, "Vehicle 146 should exist");
    assert.equal(citaro.model, "Mercedes-Benz Citaro G");
    assert.equal(citaro.lengthCategory, "MEGA");
  });
});
