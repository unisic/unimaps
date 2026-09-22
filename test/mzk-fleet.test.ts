import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAllFleetVehicles, getFleetDetails, type FleetVehicleSummary } from "../lib/mzk-fleet";

describe("mzk-fleet", () => {
  it("resolves Solaris Urbino 18 electric for side number 250", () => {
    const info = getFleetDetails("250", { electric: true, longVehicle: true });
    assert.equal(info.model, "Solaris Urbino 18 electric");
    assert.equal(info.lengthCategory, "MEGA");
    assert.equal(info.fuelType, "electric");
    assert.equal(info.features.longVehicle, true);
    assert.equal(info.features.electric, true);
  });

  it("resolves Solaris Urbino 12 hydrogen for side number 256", () => {
    const info = getFleetDetails("256");
    assert.equal(info.model, "Solaris Urbino 12 hydrogen");
    assert.equal(info.fuelType, "hydrogen");
    assert.equal(info.features.hydrogen, true);
    assert.equal(info.lengthCategory, "MAXI");
  });

  it("resolves Irizar ie bus 12 for side number 238", () => {
    const info = getFleetDetails("238");
    assert.equal(info.model, "Irizar ie bus 12");
    assert.equal(info.fuelType, "electric");
    assert.equal(info.features.electric, true);
  });

  it("resolves Isuzu Novociti Life for side number 230", () => {
    const info = getFleetDetails("230", { airCondition: true, lowFloor: true });
    assert.equal(info.model, "Isuzu Novociti Life");
    assert.equal(info.lengthCategory, "MINI");
    assert.equal(info.features.airCondition, true);
    assert.equal(info.features.lowFloor, true);
  });

  it("resolves Solaris Urbino 12 IV for side number 178", () => {
    const info = getFleetDetails("178");
    assert.equal(info.model, "Solaris Urbino 12 IV");
    assert.equal(info.lengthCategory, "MAXI");
  });

  it("handles unknown side numbers gracefully", () => {
    const info = getFleetDetails("999");
    assert.equal(info.model, "MZK Bielsko-Biała #999");
    assert.equal(info.sideNumber, "999");
  });

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
