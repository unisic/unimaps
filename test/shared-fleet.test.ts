import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyDelay, compareLineNames, foldText, matchesFleetQuery, median } from "../lib/shared/fleet";

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
    assert.equal(matchesFleetQuery(v, "#"), true); // a bare "#" while typing matches everything
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
