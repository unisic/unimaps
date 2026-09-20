import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanStopName,
  getMergedStop,
  mergeStops,
  stopDistanceMeters,
  type FormattedStop,
} from "../lib/stop-merge";
import { tripTimeMatchesStop } from "../lib/client/format";

describe("cleanStopName", () => {
  it("strips known city/municipality prefixes", () => {
    assert.equal(cleanStopName("BIELSKO-BIAŁA 3 MAJA DWORZEC"), "3MAJADWORZEC");
    assert.equal(cleanStopName("BIELSKO BIAŁA CIESZYŃSKA HULANKA"), "CIESZYŃSKAHULANKA");
    assert.equal(cleanStopName("BYSTRA SZKOŁA"), "SZKOŁA");
    assert.equal(cleanStopName("CZECHOWICE-DZIEDZICE DWORZEC"), "DWORZEC");
  });

  it("normalizes D.A. and DWORZEC AUTOBUSOWY to DWORZEC", () => {
    assert.equal(cleanStopName("BIELSKO-BIAŁA D.A."), "DWORZEC");
    assert.equal(cleanStopName("BIELSKO-BIAŁA DWORZEC AUTOBUSOWY"), "DWORZEC");
  });

  it("strips punctuation and non-alphanumeric characters", () => {
    assert.equal(cleanStopName("Cieszyńska (Lotnisko)"), "CIESZYŃSKALOTNISKO");
    assert.equal(cleanStopName("Plac Żwirki i Wigury"), "PLACŻWIRKIIWIGURY");
  });
});

describe("stopDistanceMeters", () => {
  it("calculates distance between close coordinates", () => {
    // ~111m per degree lat
    const d = stopDistanceMeters(49.827, 19.044, 49.8271, 19.044);
    assert.ok(d > 10 && d < 12, `Expected ~11m, got ${d}`);
  });

  it("returns 0 for identical coordinates", () => {
    assert.equal(stopDistanceMeters(49.82, 19.04, 49.82, 19.04), 0);
  });
});

describe("mergeStops", () => {
  const sampleKb: FormattedStop[] = [
    {
      id: "10021",
      designator: "10021",
      name: "BIELSKO-BIAŁA 3 MAJA DWORZEC",
      lat: 49.82777,
      lon: 19.04484,
      operator: "KB",
      dirs: [90],
      isStation: true,
      showPlatforms: true,
    },
    {
      id: "50011",
      designator: "50011",
      name: "ANDRYCHÓW 1 MAJA",
      lat: 49.853,
      lon: 19.338,
      operator: "KB",
      isStation: false,
      showPlatforms: false,
    },
  ];

  const sampleMzk: FormattedStop[] = [
    {
      id: "mzk:2",
      designator: "mzk:2",
      name: "3 Maja Dworzec",
      lat: 49.8278,
      lon: 19.0449, // ~10m from KB 10021
      operator: "MZK",
      symbol: "2",
      isStation: false,
      showPlatforms: false,
    },
    {
      id: "mzk:999",
      designator: "mzk:999",
      name: "Szyndzielnia Dolna Stacja",
      lat: 49.773,
      lon: 19.025,
      operator: "MZK",
      symbol: "999",
      isStation: false,
      showPlatforms: false,
    },
  ];

  it("merges stops that represent the same physical location", () => {
    const merged = mergeStops(sampleKb, sampleMzk);

    // Should have 3 stops total: 1 merged (3 Maja Dworzec) + 1 KB-only + 1 MZK-only
    assert.equal(merged.length, 3);

    const merged3Maja = merged.find((s) => s.id === "10021");
    assert.ok(merged3Maja, "Expected merged 3 Maja stop");
    assert.equal(merged3Maja.operator, "BOTH");
    assert.deepEqual(merged3Maja.operators, ["KB", "MZK"]);
    assert.equal(merged3Maja.kbId, "10021");
    assert.equal(merged3Maja.mzkId, "mzk:2");
    assert.equal(merged3Maja.kbDesignator, "10021");
    assert.equal(merged3Maja.mzkDesignator, "mzk:2");
    assert.equal(merged3Maja.mzkSymbol, "2");
    assert.equal(merged3Maja.symbol, "2");
    assert.equal(merged3Maja.isStation, true);
  });

  it("leaves unmatched stops with their original operators", () => {
    const merged = mergeStops(sampleKb, sampleMzk);

    const andrychow = merged.find((s) => s.id === "50011");
    assert.ok(andrychow);
    assert.equal(andrychow.operator, "KB");
    assert.deepEqual(andrychow.operators, ["KB"]);

    const szyndzielnia = merged.find((s) => s.id === "mzk:999");
    assert.ok(szyndzielnia);
    assert.equal(szyndzielnia.operator, "MZK");
    assert.deepEqual(szyndzielnia.operators, ["MZK"]);
  });

  it("allows lookup of merged stop by any of its IDs or designators", () => {
    mergeStops(sampleKb, sampleMzk);

    assert.equal(getMergedStop("10021")?.id, "10021");
    assert.equal(getMergedStop("mzk:2")?.id, "10021");
    assert.equal(getMergedStop("2")?.id, "10021");
  });
});

describe("tripTimeMatchesStop with merged stops", () => {
  const mergedStop = {
    id: "10021",
    designator: "10021",
    kbId: "10021",
    mzkId: "mzk:2",
    kbDesignator: "10021",
    mzkDesignator: "mzk:2",
    mzkSymbol: "2",
    symbol: "2",
  };

  it("matches KB trip by numeric designator", () => {
    assert.equal(tripTimeMatchesStop({ designator: 10021 }, mergedStop), true);
  });

  it("matches KB trip by place_id designator", () => {
    assert.equal(tripTimeMatchesStop({ place_id: "10021" }, mergedStop), true);
  });

  it("matches MZK trip by mzk place_id", () => {
    assert.equal(tripTimeMatchesStop({ place_id: "mzk:2" }, mergedStop), true);
    assert.equal(tripTimeMatchesStop({ place_id: "2" }, mergedStop), true);
  });

  it("matches MZK trip by mzkId designator", () => {
    assert.equal(tripTimeMatchesStop({ designator: "mzk:2" as unknown as number }, mergedStop), true);
  });

  it("does not match unrelated stops", () => {
    assert.equal(tripTimeMatchesStop({ designator: 99999, place_id: "other" }, mergedStop), false);
  });
});
