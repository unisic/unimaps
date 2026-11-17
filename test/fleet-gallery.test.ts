import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_FILTERS, filtersFromParams, filtersToParams, hasActiveFilters, yearBin, type FleetFilters } from "@/components/brygady/fleetFilters";
import { byShelf, groupModels, knownModels, passFacets, passStatus, rankHits, rareModels } from "@/components/brygady/gallery";
import type { FleetSummaryItem } from "@/lib/shared/fleet";

function veh(sideNumber: string, patch: Partial<FleetSummaryItem> = {}): FleetSummaryItem {
  return {
    sideNumber,
    model: "Solaris Urbino 12",
    producer: "Solaris",
    lengthCategory: "MAXI",
    fuelType: "diesel",
    status: "depot",
    lines: [],
    coursesCountToday: 0,
    cancelledCoursesToday: 0,
    kmToday: 0,
    lastSeenAt: 0,
    ...patch,
  };
}

const running = (side: string, patch: Partial<FleetSummaryItem> = {}) => veh(side, { status: "active", lineName: "12", delaySec: 0, ...patch });

describe("fleet gallery", () => {
  it("keeps a view in the page URL", () => {
    const view: FleetFilters = { status: "late", company: "PKM Katowice", fuel: "electric", length: "MEGA", year: 3, line: "T24", model: "" };
    const p = new URLSearchParams("city=gzm");
    filtersToParams(view, p);
    assert.equal(
      p.toString(),
      "city=gzm&status=spoznione&przewoznik=PKM+Katowice&naped=elektryczny&dlugosc=przegubowy&rocznik=2015-2019&linia=T24&model=nieustalony",
    );
    assert.deepEqual(filtersFromParams(p), view);

    filtersToParams(DEFAULT_FILTERS, p);
    assert.equal(p.toString(), "city=gzm", "an unset filter leaves no param behind");
    assert.deepEqual(filtersFromParams(new URLSearchParams("status=x&naped=atom&rocznik=1700&linia=t24")), { ...DEFAULT_FILTERS, line: "T24" });
    assert.equal(hasActiveFilters(DEFAULT_FILTERS), false);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, model: "" }), true, "the model-less group is a filter");
  });

  it("bins the year of production", () => {
    assert.deepEqual([1975, 1989, 1990, 2014, 2025, 2031, undefined].map(yearBin), [0, 0, 1, 2, 5, 5, 6]);
  });

  it("filters by facets, and counts a facet's options without that facet", () => {
    const electric = running("1", { fuelType: "electric", built: 2022, company: "A" });
    const diesel = veh("2", { built: 2008, company: "B", lines: ["7"] });
    const unknown = veh("3", { fuelType: null, lengthCategory: null });
    const f: FleetFilters = { ...DEFAULT_FILTERS, fuel: "electric" };
    assert.deepEqual([electric, diesel, unknown].map((v) => passFacets(v, f)), [true, false, false]);
    assert.deepEqual([electric, diesel, unknown].map((v) => passFacets(v, f, "fuel")), [true, true, true]);
    assert.equal(passFacets(unknown, { ...DEFAULT_FILTERS, fuel: "none", length: "none", year: 6 }), true);
    assert.equal(passFacets(diesel, { ...DEFAULT_FILTERS, company: "B", year: 1, line: "7" }), true, "off duty: a line it served today");
    assert.equal(passFacets(electric, { ...DEFAULT_FILTERS, line: "7" }), false, "running: only its current line");
  });

  it("reads late and rare as kinds of running", () => {
    const fleet = [
      running("1", { delaySec: 200 }),
      running("2", { delaySec: 180 }),
      running("3", { model: "Jelcz M11", delaySec: 900 }),
      veh("4", { model: "Jelcz M11" }),
      running("5", { notStarted: true, delaySec: 700 }),
      running("6"),
      running("7", { model: "" }),
    ];
    const rare = rareModels(fleet);
    assert.deepEqual([...rare], ["Jelcz M11"], "at most 3 units; the model-less vehicles are no model");
    const sides = (status: FleetFilters["status"]) => fleet.filter((v) => passStatus(v, status, rare)).map((v) => v.sideNumber);
    assert.deepEqual(sides("late"), ["1", "3"], "over +3 min, never a waiting vehicle");
    assert.deepEqual(sides("rare"), ["3"]);
    assert.deepEqual(sides("waiting"), ["5"]);
    assert.deepEqual([...fleet].sort(byShelf).map((v) => v.sideNumber), ["3", "1", "2", "6", "7", "5", "4"]);
  });

  it("groups models, the most numerous first and the model-less last", () => {
    const groups = groupModels([
      veh("9", { model: "" }),
      veh("8", { model: "" }),
      veh("7", { model: "" }),
      running("1", { built: 2016, delaySec: 400, thumb: "a" }),
      veh("2", { built: 2021, fuelType: "hybrid", thumb: "b" }),
      veh("3", { model: "Jelcz M11", year: "1988" }),
    ]);
    assert.deepEqual(groups.map((g) => [g.model, g.vehicles.length]), [["Solaris Urbino 12", 2], ["Jelcz M11", 1], ["", 3]]);
    const [solaris, jelcz] = groups;
    assert.deepEqual(
      [solaris.active, solaris.depot, solaris.late, solaris.years, solaris.fuel, solaris.length, solaris.thumb],
      [1, 1, 1, "2016-2021", "mixed", "MAXI", "a"],
    );
    assert.equal(jelcz.years, "1988");
    assert.deepEqual(
      knownModels([veh("262", { model: "MZK Bielsko-Biała #262" }), veh("26", { model: "Jelcz #262" })]).map((v) => v.model),
      ["", "Jelcz #262"],
      "the placeholder of a vehicle outside the fleet table is no model",
    );
  });

  it("ranks a side-number search: exact, ends with, starts with, contains", () => {
    const fleet = ["1950", "95", "295", "9512", "4293", "2_95x"].map((s) => veh(s));
    fleet.push(veh("7_95", { label: "95" }));
    const { hits, total } = rankHits(fleet, " #95 ", 4);
    assert.equal(total, 6);
    assert.deepEqual(hits.map((v) => v.sideNumber), ["7_95", "95", "295", "9512"]);
    assert.deepEqual(rankHits(fleet, "  ", 4), { hits: [], total: 0 });
  });
});
