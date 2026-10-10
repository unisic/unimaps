import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  cleanStopName,
  directionDiff,
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

/* ---------- helpers ---------- */
const kb = (id: string, name: string, lat: number, lon: number, extra: Partial<FormattedStop> = {}): FormattedStop => ({
  id, designator: `d${id}`, name, lat, lon, operator: "KB", ...extra,
});
const mzk = (sym: string, name: string, lat: number, lon: number, extra: Partial<FormattedStop> = {}): FormattedStop => ({
  id: `mzk:${sym}`, designator: `mzk:${sym}`, name, lat, lon, operator: "MZK", symbol: sym, ...extra,
});
/** 1° lat ≈ 111 139 m — offsets in metres → degrees at ~49.8°N */
const dLat = (m: number) => m / 111139;
const dLon = (m: number) => m / (111139 * Math.cos((49.8 * Math.PI) / 180));
const L0 = 49.8;
const O0 = 19.0;

function pairing(merged: FormattedStop[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of merged) if (s.operator === "BOTH") out[s.kbId!] = (s.mzkSymbols ?? [s.mzkSymbol!]).slice().sort();
  return out;
}

describe("directionDiff", () => {
  it("is null without information, smallest angle otherwise", () => {
    assert.equal(directionDiff(undefined, [90]), null);
    assert.equal(directionDiff([], [90]), null);
    assert.equal(directionDiff([350], [10]), 20);
    assert.equal(directionDiff([0, 180], [170]), 10); // best pair wins (stop served both ways)
    assert.equal(directionDiff([2], [181]), 179);
  });
});

describe("mergeStops pairing is independent of list order", () => {
  // two direction twins on both sides; the MZK list order must not decide who gets whom
  const kbs = [
    kb("1", "BIELSKO-BIAŁA TESTOWA", L0, O0, { dirs: [90] }),
    kb("2", "BIELSKO-BIAŁA TESTOWA", L0 + dLat(20), O0 + dLon(80), { dirs: [270] }),
  ];
  const a = mzk("A", "Testowa", L0 + dLat(1), O0 + dLon(2)); // sits on KB 1
  const b = mzk("B", "Testowa", L0 + dLat(20), O0 + dLon(79)); // sits on KB 2

  it("same result for both MZK list orders (no direction data)", () => {
    const p1 = pairing(mergeStops(kbs, [a, b]));
    const p2 = pairing(mergeStops(kbs, [b, a]));
    assert.deepEqual(p1, { "1": ["A"], "2": ["B"] });
    assert.deepEqual(p2, p1);
  });

  it("same result for both KB list orders", () => {
    assert.deepEqual(pairing(mergeStops([...kbs].reverse(), [a, b])), { "1": ["A"], "2": ["B"] });
  });
});

describe("mergeStops: a farther same-name stop must not steal the nearer stop's partner", () => {
  // Bestwińska Strefa Przemysłowa (captured): KB2 has MZK A at 2 m and MZK B at 31 m; B is only 83 m
  // from KB1. The old greedy loop handed KB2 to whichever of A/B the upstream listed first.
  const kbs = [
    kb("1", "BIELSKO-BIAŁA STREFA", L0, O0),
    kb("2", "BIELSKO-BIAŁA STREFA", L0 + dLat(111), O0 - dLon(2)),
  ];
  const A = mzk("A", "Strefa", L0 + dLat(111), O0 - dLon(4));
  const B = mzk("B", "Strefa", L0 + dLat(82), O0 - dLon(14));
  it("pairs A with the stop it sits on, whatever the list order", () => {
    assert.deepEqual(pairing(mergeStops(kbs, [A, B])), { "1": ["B"], "2": ["A"] });
    assert.deepEqual(pairing(mergeStops(kbs, [B, A])), { "1": ["B"], "2": ["A"] });
  });
});

describe("mergeStops is direction aware", () => {
  // Wapienica Centrum-like layout: stops of the two directions are staggered along the road,
  // so the NEAREST stop is the one for the opposite direction.
  const kbs = [
    kb("E", "BIELSKO-BIAŁA STAGGER", L0, O0, { dirs: [77] }), // eastbound pole
    kb("W", "BIELSKO-BIAŁA STAGGER", L0 + dLat(23), O0 - dLon(81), { dirs: [257] }), // westbound pole
  ];
  const mE = mzk("mE", "Stagger", L0 + dLat(4), O0 - dLon(73), { dirs: [84] }); // eastbound, 73 m from KB E
  const mW = mzk("mW", "Stagger", L0 + dLat(25), O0 - dLon(26), { dirs: [263] }); // westbound, 36 m from KB E!

  it("pairs by direction even when the opposite stop is closer", () => {
    for (const order of [[mE, mW], [mW, mE]]) {
      assert.deepEqual(pairing(mergeStops(kbs, order)), { E: ["mE"], W: ["mW"] });
    }
  });

  it("without direction data it falls back to distance (and stays order independent)", () => {
    const strip = (s: FormattedStop): FormattedStop => ({ ...s, dirs: undefined });
    const p1 = pairing(mergeStops(kbs.map(strip), [mE, mW].map(strip)));
    const p2 = pairing(mergeStops(kbs.map(strip), [mW, mE].map(strip)));
    assert.deepEqual(p1, p2);
  });

  it("an opposite-direction stop on the other carriageway is NOT merged (36 m, no same-direction MZK stop)", () => {
    const k = kb("K", "BIELSKO-BIAŁA OPP", L0, O0, { dirs: [90] });
    const m = mzk("M", "Opp", L0 + dLat(10), O0 + dLon(34), { dirs: [270] });
    const out = mergeStops([k], [m]);
    assert.equal(out.length, 2);
    assert.ok(out.every((s) => s.operator !== "BOTH"));
  });

  it("…but the same pole with disagreeing direction labels (<= 12 m) still merges", () => {
    const k = kb("K", "BIELSKO-BIAŁA POLE", L0, O0, { dirs: [197] });
    const m = mzk("M", "Pole", L0 + dLat(2), O0 + dLon(2), { dirs: [18] });
    assert.deepEqual(pairing(mergeStops([k], [m])), { K: ["M"] });
  });

  it("the orphaned same-direction stop wins over a closer opposite one (Grunwaldzka-like: 1 KB, 2 MZK)", () => {
    const k = kb("K", "BIELSKO-BIAŁA GRUNWALDZKA SZPITAL", L0, O0, { dirs: [218] });
    const wrong = mzk("112", "Grunwaldzka Szpital", L0 + dLat(10), O0 + dLon(11), { dirs: [23] }); // 15 m, opposite, listed first
    const right = mzk("113", "Grunwaldzka Szpital", L0 + dLat(2), O0 + dLon(2), { dirs: [235] }); // 3 m, same direction
    const out = mergeStops([k], [wrong, right]);
    assert.deepEqual(pairing(out), { K: ["113"] });
    assert.equal(out.find((s) => s.id === "mzk:112")?.operator, "MZK"); // other carriageway stays its own stop
  });
});

describe("mergeStops keeps the established thresholds (no false merges)", () => {
  it("same name beyond 120 m is not merged", () => {
    const out = mergeStops([kb("1", "BIELSKO-BIAŁA FAR", L0, O0)], [mzk("A", "Far", L0, O0 + dLon(130))]);
    assert.ok(out.every((s) => s.operator !== "BOTH"));
  });
  it("different names beyond 35 m are not merged", () => {
    const out = mergeStops([kb("1", "BIELSKO-BIAŁA ALFA", L0, O0)], [mzk("A", "Beta", L0, O0 + dLon(60))]);
    assert.ok(out.every((s) => s.operator !== "BOTH"));
  });
  it("different names within 35 m are merged (shared pole, differently spelled)", () => {
    const out = mergeStops([kb("1", "BIELSKO-BIAŁA ALFA", L0, O0)], [mzk("A", "Beta", L0, O0 + dLon(20))]);
    assert.deepEqual(pairing(out), { "1": ["A"] });
  });
  it("cleaned names must be > 2 chars to count as a name match", () => {
    const out = mergeStops([kb("1", "BIELSKO-BIAŁA AB", L0, O0)], [mzk("A", "AB", L0, O0 + dLon(80))]);
    assert.ok(out.every((s) => s.operator !== "BOTH"));
  });
});

describe("mergeStops: arrows of a merged stop", () => {
  const at = (dirs: number[]) => ({ dirs });
  it("near-identical KB and MZK bearings collapse to ONE arrow (no doubled arrow)", () => {
    const out = mergeStops([kb("1", "BIELSKO-BIAŁA A", L0, O0, at([218]))], [mzk("A", "A", L0, O0, at([220]))]);
    assert.deepEqual(out[0].dirs, [218]);
  });
  it("opposite bearings keep two arrows, never more than two", () => {
    const out = mergeStops([kb("1", "BIELSKO-BIAŁA A", L0, O0, at([10, 190]))], [mzk("A", "A", L0, O0, at([100, 280]))]);
    assert.deepEqual(out[0].dirs, [10, 190]);
  });
  it("MZK supplies the arrow when KB has none", () => {
    const out = mergeStops([kb("1", "BIELSKO-BIAŁA A", L0, O0)], [mzk("A", "A", L0, O0, at([77]))]);
    assert.deepEqual(out[0].dirs, [77]);
  });
});

describe("mergeStops: bus station hub (fan-out, no absorption)", () => {
  const da = kb("DA", "BIELSKO-BIAŁA D.A.", L0, O0, { isStation: true, showPlatforms: true });
  // the MZK street stops around Bielsko-Biała D.A. (a KB-only station): the bare "DWORZEC" matches them all
  const hub = [
    mzk("343", "Warszawska Dworzec", L0 + dLat(60), O0 + dLon(60)), // 85 m
    mzk("341", "Warszawska Dworzec", L0 - dLat(100), O0 + dLon(110)), // 149 m
    mzk("264", "Piastowska Dworzec", L0 - dLat(140), O0 - dLon(40)), // 146 m
  ];
  const railway = mzk("2", "3 Maja Dworzec", L0 + dLat(300), O0 + dLon(250)); // 390 m — a different station
  const cz = kb("CZ", "CZECHOWICE-DZIEDZICE D.A.", L0, O0, { isStation: true });
  const poles = [
    mzk("2366", "Czechowice-Dz. Dworzec", L0 + dLat(10), O0), // 10 m, line 50 one way
    mzk("2367", "Czechowice-Dz. Dworzec", L0 - dLat(13), O0), // 13 m, line 50 the other way
  ];

  it("never takes in a same-name MZK stop beyond MERGE_HUB_M: Bielsko-Biała D.A. stays KB-only", () => {
    const out = mergeStops([da], [...hub, railway]);
    assert.deepEqual(pairing(out), {});
    assert.equal(out.find((s) => s.id === "DA")?.operator, "KB");
    for (const sym of ["343", "341", "264", "2"]) assert.equal(getMergedStop(`mzk:${sym}`)?.id, `mzk:${sym}`);
  });

  it("lists every same-name MZK stop on its premises (primary first); the extras stay MZK-only entries of their own", () => {
    const out = mergeStops([cz], poles);
    const s = out.find((x) => x.operator === "BOTH")!;
    assert.equal(s.kbId, "CZ");
    assert.equal(s.mzkSymbol, "2366"); // nearest = primary
    assert.deepEqual(s.mzkSymbols, ["2366", "2367"]);
    assert.equal(s.symbol, undefined); // no single "(2366)" label for a hub
    assert.equal("aka" in s, false);
    // the extra keeps its own stop (own position, own designator) — MZK trip timelines are drawn there
    const own = out.find((x) => x.id === "mzk:2367")!;
    assert.equal(own.operator, "MZK");
    assert.equal(own.lat, poles[1].lat);
    assert.equal(out.find((x) => x.id === "mzk:2366"), undefined); // the primary is merged into the station
    assert.equal(out.length, 2);
  });

  it("is order independent; the registry resolves the primary symbol to the hub and extras to their own stop", () => {
    const a = mergeStops([cz], poles);
    const b = mergeStops([cz], [...poles].reverse());
    assert.deepEqual(pairing(a), pairing(b));
    assert.equal(getMergedStop("2366")?.id, "CZ");
    assert.equal(getMergedStop("mzk:2366")?.id, "CZ");
    assert.equal(getMergedStop("2367")?.id, "mzk:2367", "2367 must NOT resolve to the hub");
    assert.equal(getMergedStop("mzk:2367")?.id, "mzk:2367");
  });

  it("a normal (non-station) stop never fans out to several MZK stops", () => {
    const plain = kb("P", "BIELSKO-BIAŁA WARSZAWSKA DWORZEC", L0, O0); // same name as 343/341, but not a station
    const out = mergeStops([plain], hub);
    const both = out.filter((s) => s.operator === "BOTH");
    assert.equal(both.length, 1);
    assert.equal(both[0].mzkSymbols, undefined);
    assert.equal(out.filter((s) => s.operator === "MZK").length, 2);
  });

  it("an opposite-direction MZK stop is never listed by the hub", () => {
    const station = kb("S", "BIELSKO-BIAŁA D.A.", L0, O0, { isStation: true, dirs: [90] });
    const near = mzk("A", "Dworzec", L0 + dLat(20), O0, { dirs: [92] });
    const opp = mzk("B", "Dworzec", L0 - dLat(20), O0, { dirs: [272] });
    const s = mergeStops([station], [near, opp]).find((x) => x.operator === "BOTH")!;
    assert.equal(s.mzkSymbol, "A");
    assert.equal(s.mzkSymbols, undefined);
  });
});

describe("mergeStops: stops without usable coordinates", () => {
  it("are never merged (not even a station with a same-name MZK stop) and never break the others", () => {
    const station = kb("S", "BIELSKO-BIAŁA D.A.", NaN, O0, { isStation: true });
    const ok = kb("K", "BIELSKO-BIAŁA OKOLICA", L0, O0);
    const out = mergeStops([station, ok], [mzk("1", "Dworzec", L0, O0), mzk("2", "Okolica", L0, O0 + dLon(3))]);
    assert.deepEqual(pairing(out), { K: ["2"] });
    assert.equal(out.length, 3);
  });
});

describe("mergeStops: learned MZK bearings steer the pairing but never reach the wire", () => {
  const kbs = [
    kb("E", "BIELSKO-BIAŁA STAGGER", L0, O0, { dirs: [77] }),
    kb("W", "BIELSKO-BIAŁA STAGGER", L0 + dLat(23), O0 - dLon(81), { dirs: [257] }),
  ];
  const mE = mzk("mE", "Stagger", L0 + dLat(4), O0 - dLon(73));
  const mW = mzk("mW", "Stagger", L0 + dLat(25), O0 - dLon(26));
  const learned = new Map<string, number[]>([["mE", [84]], ["mW", [263]]]);

  it("opts.mzkDirs pairs by direction (the nearest stop is the opposite one) for either list order", () => {
    for (const order of [[mE, mW], [mW, mE]]) {
      assert.deepEqual(pairing(mergeStops(kbs, order, { mzkDirs: learned })), { E: ["mE"], W: ["mW"] });
    }
  });

  it("without them the pairing is distance based and still order independent", () => {
    assert.deepEqual(pairing(mergeStops(kbs, [mE, mW])), pairing(mergeStops(kbs, [mW, mE])));
  });

  it("merged and MZK-only stops carry exactly the arrows they had before (KB's own, none for MZK-only)", () => {
    const out = mergeStops(kbs, [mE, mW, mzk("lone", "Alone", L0 + dLat(900), O0)], { mzkDirs: new Map([...learned, ["lone", [10]]]) });
    for (const s of out) {
      if (s.operator === "BOTH") assert.deepEqual(s.dirs, s.kbId === "E" ? [77] : [257]);
      if (s.operator === "MZK") assert.equal(s.dirs, undefined);
    }
  });
});

describe("mergeStops on captured 2026-10-02 data (regression)", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "stop-merge-live.json"), "utf8")) as {
    kb: FormattedStop[];
    mzk: FormattedStop[];
  };
  const kbAll = fx.kb.map((k) => ({ ...k, operator: "KB" as const }));
  const mzkAll = fx.mzk.map((m) => ({ ...m, operator: "MZK" as const }));
  const want: Record<string, string[]> = {
    // KB stop id -> MZK symbols that serve the SAME direction at the same place
    "10091": ["36"], "10092": ["35"], // Bestwińska Strefa Przemysłowa (greedy used to cross both pairs)
    "10431": ["57"], "10432": ["66"], // Wapienica Centrum (opposite stop was nearer)
    "21601": ["2045"], "21602": ["2044"], // Wilkowice Sklep
    "11072": ["113"], // Grunwaldzka Szpital Miejski (112 is the other carriageway)
    "10342": ["63"], // Cieszyńska Os. Wojska Polskiego (63 sits on the KB stop, 0 m)
    "10881": ["220"], // Mazańcowicka Katowicka
    "10302": ["265"], // Piastowska Lubertowicza (the reported stop)
    // 10000 Bielsko-Biała D.A. is KB-only: its MZK "Dworzec" street stops are 89-183 m away
    "10021": ["2"], // 3 Maja Dworzec (railway station)
    "29021": ["2374"], "29022": ["2376"], // Czechowice Górnicza Węglowa (direction-consistent)
    "10291": ["64"], // Cieszyńska Lotnisko
  };

  it("pairs the same direction at every captured place", () => {
    assert.deepEqual(pairing(mergeStops(kbAll, mzkAll)), want);
  });

  it("the production path (MZK bearings passed as opts.mzkDirs, none on the stops) pairs identically", () => {
    const mzkDirs = new Map(mzkAll.filter((m) => m.dirs?.length).map((m) => [m.symbol!, m.dirs!] as const));
    const bare = mzkAll.map((m) => ({ ...m, dirs: undefined }));
    assert.deepEqual(pairing(mergeStops(kbAll, bare, { mzkDirs })), want);
  });

  it("gives the identical result for reversed and shuffled input order", () => {
    const base = pairing(mergeStops(kbAll, mzkAll));
    assert.deepEqual(pairing(mergeStops([...kbAll].reverse(), [...mzkAll].reverse())), base);
    const rot = <T,>(a: T[], n: number) => [...a.slice(n), ...a.slice(0, n)];
    for (let n = 1; n < mzkAll.length; n += 5) assert.deepEqual(pairing(mergeStops(rot(kbAll, n % kbAll.length), rot(mzkAll, n))), base);
  });

  it("MZK 441 'Lotnisko' (137 m from the KB stop, different place) stays MZK-only", () => {
    const out = mergeStops(kbAll, mzkAll);
    assert.equal(out.find((s) => s.id === "mzk:441")?.operator, "MZK");
  });
});

describe("tripTimeMatchesStop with a station hub (several MZK symbols)", () => {
  const hub = {
    id: "10000",
    designator: "184900",
    kbId: "10000",
    mzkId: "mzk:343",
    kbDesignator: "184900",
    mzkDesignator: "mzk:343",
    mzkSymbol: "343",
    mzkSymbols: ["343", "341", "264"],
  };
  it("matches an MZK trip calling at ANY symbol of the hub", () => {
    for (const sym of ["343", "341", "264"]) {
      assert.equal(tripTimeMatchesStop({ place_id: `mzk:${sym}` }, hub), true, sym);
    }
  });
  it("does not match a symbol outside the hub", () => {
    assert.equal(tripTimeMatchesStop({ place_id: "mzk:2" }, hub), false);
  });
});
