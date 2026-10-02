import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Stop } from "../lib/types";
import { MzkStopDirs, clusterBearings } from "../lib/mzk-stop-dirs";
import { createMergedStopsCache, formatKbStops, formatMzkStops, type MergedInput } from "../lib/merged-stops";

const kbStop = (internalId: number, urlId: string, name: string, lat: number, lon: number, extra: Partial<Stop> = {}): Stop => ({
  urlId, internalId, name, lat, lon, onlyDisembarking: false, isStation: false, showPlatforms: false, stopId: String(internalId), ...extra,
});
const mzkStop = (symbol: string, name: string, lat: number, lon: number, extra: Partial<Stop> = {}): Stop => ({
  urlId: `mzk:${symbol}`, internalId: Number(symbol) + 1000, name, lat, lon, onlyDisembarking: false, isStation: false, showPlatforms: false,
  stopId: `mzk:${symbol}`, operator: "MZK", symbol, ...extra,
});
const NO_DIRS: ReadonlyMap<string, number[]> = new Map();
const NO_MZK_DIRS: ReadonlyMap<string, readonly number[]> = new Map();

describe("formatKbStops / formatMzkStops (shared by every route)", () => {
  it("stations (name or showPlatforms) never get direction arrows; the upstream isStation flag is NOT used", () => {
    const out = formatKbStops(
      [
        kbStop(10000, "1", "BIELSKO-BIAŁA D.A.", 49.83, 19.04, { isStation: true, showPlatforms: true }),
        kbStop(28301, "2", "BUKOWIEC NA POTOKU", 49.7, 19.0, { isStation: true }), // loop/terminus flag, not a station
        kbStop(10302, "3", "BIELSKO-BIAŁA PIASTOWSKA LUBERTOWICZA", 49.827, 19.036),
      ],
      new Map([["10000", [1]], ["28301", [2]], ["10302", [218]]]),
    );
    assert.equal(out[0].isStation, true);
    assert.equal(out[0].dirs, undefined);
    assert.equal(out[1].isStation, undefined);
    assert.deepEqual(out[1].dirs, [2]);
    assert.deepEqual(out[2].dirs, [218]);
  });
  it("MZK stops carry symbol and flags — and NO dirs (learned bearings steer the pairing only)", () => {
    const [m] = formatMzkStops([mzkStop("265", "Piastowska Lubertowicza", 49.827, 19.036, { onRequest: true })]);
    assert.equal(m.symbol, "265");
    assert.equal(m.onRequest, true);
    assert.equal(m.dirs, undefined);
  });
});

describe("createMergedStopsCache", () => {
  const kb = [kbStop(10302, "19146:39714", "BIELSKO-BIAŁA PIASTOWSKA LUBERTOWICZA", 49.827047, 19.036152)];
  const mzk = [mzkStop("265", "Piastowska Lubertowicza", 49.827047, 19.036152)];
  const base = (over: Partial<MergedInput> = {}): MergedInput => ({ kb, mzk, kbDirs: NO_DIRS, mzkDirs: NO_MZK_DIRS, ...over });

  it("is memoized on input identity and re-merges when the MZK list arrives late (the stale-registry bug)", () => {
    const get = createMergedStopsCache();
    const none: Stop[] = []; // MZK upstream was down at start: the poller's `stops` is an empty array
    const early = get(base({ mzk: none }));
    assert.equal(early.partial, true);
    assert.equal(JSON.parse(early.body).partial, true); // the client re-fetches a partial list soon
    assert.equal(early.lookup("19146:39714")?.operator, "KB");
    assert.equal(get(base({ mzk: none })), early); // unchanged inputs → same view object
    const late = get(base()); // MZK stops loaded (new array identity)
    assert.equal(late.partial, false);
    assert.equal("partial" in JSON.parse(late.body), false);
    assert.equal(late.lookup("19146:39714")?.operator, "BOTH");
    assert.equal(late.lookup("mzk:265")?.id, "10302");
    assert.equal(late.lookup("265")?.id, "10302");
    assert.notEqual(late.etag, early.etag);
  });

  it("returns the identical view while nothing changed, a new one when a learned direction changed", () => {
    const get = createMergedStopsCache();
    const a = get(base());
    assert.equal(get(base()), a);
    assert.notEqual(get(base({ mzkDirs: new Map([["265", [218]]]) })), a);
  });

  it("summary counts the merge and its inputs (for /api/health)", () => {
    const v = createMergedStopsCache(() => 1_790_000_000_000)(base({ mzkDirs: new Map([["265", [218]]]) }));
    assert.deepEqual(v.summary, { both: 1, kb: 0, mzk: 0, kbStops: 1, mzkStops: 1, mzkDirStops: 1, builtAt: 1_790_000_000 });
    assert.equal(v.partial, false);
  });

  it("etag is a stable content hash", () => {
    const e1 = createMergedStopsCache()(base()).etag;
    const e2 = createMergedStopsCache()(base()).etag;
    assert.equal(e1, e2);
    assert.match(e1, /^"[A-Za-z0-9_-]{22}"$/);
  });
});

describe("MzkStopDirs (direction learned from the stop order of running courses)", () => {
  const P = (lat: number, lon: number, symbol: string) => ({ symbol, at: { lat, lon } });
  it("credits the prev→next tangent to each stop, once per variant", () => {
    const d = new MzkStopDirs();
    // three stops heading due north
    const stops = [P(49.80, 19.0, "A"), P(49.81, 19.0, "B"), P(49.82, 19.0, "C")];
    assert.equal(d.learn(11, stops), true);
    assert.equal(d.learn(11, stops), false); // same variant again: ignored
    const m = d.dirs();
    assert.deepEqual(m.get("B"), [0]);
    assert.deepEqual(m.get("A"), [0]); // first stop: outgoing
    assert.deepEqual(m.get("C"), [0]); // last stop: incoming
    assert.equal(d.variants, 1);
  });
  it("dirs() keeps its identity until a bearing actually changes (consumers memoize on it)", () => {
    const d = new MzkStopDirs();
    const north = [P(49.80, 19.0, "A"), P(49.81, 19.0, "B")];
    d.learn(1, north);
    const first = d.dirs();
    assert.equal(d.dirs(), first);
    d.learn(2, north); // a second variant with the same bearings: nothing changes
    assert.equal(d.dirs(), first);
    d.learn(3, [P(49.80, 19.0, "A"), P(49.80, 19.01, "Z")]); // a new stop appears
    assert.notEqual(d.dirs(), first);
    assert.deepEqual(d.dirs().get("Z"), [90]);
  });
  it("reconcile drops everything learned when a stop moved or vanished, keeps it otherwise", () => {
    const d = new MzkStopDirs();
    d.learn(1, [P(49.80, 19.0, "A"), P(49.81, 19.0, "B"), P(49.82, 19.0, "C")]);
    const cur = (lat: number, lon: number) => ({ lat, lon });
    const same = new Map([["A", cur(49.80, 19.0)], ["B", cur(49.81, 19.0)], ["C", cur(49.82, 19.0)]]);
    assert.equal(d.reconcile(same), false);
    assert.equal(d.reconcile(new Map([...same, ["B", cur(49.81, 19.00003)]])), false); // 2 m: noise
    assert.equal(d.reconcile(new Map([...same, ["B", cur(49.8105, 19.0)]])), true); // 55 m: re-surveyed
    assert.equal(d.size, 0);
    assert.equal(d.learn(1, [P(49.80, 19.0, "A"), P(49.81, 19.0, "B")]), true); // variant ids are relearned too
    d.reconcile(same);
    assert.equal(d.reconcile(new Map([["A", cur(49.80, 19.0)]])), true); // B vanished
  });
  it("keeps two opposite bearings for a stop served both ways, unknown stops are skipped", () => {
    const d = new MzkStopDirs();
    const north = [P(49.80, 19.0, "A"), P(49.81, 19.0, "X"), P(49.82, 19.0, "C")];
    const south = [P(49.82, 19.0, "C"), P(49.81, 19.0, "X"), P(49.80, 19.0, "A")];
    for (let i = 0; i < 3; i++) {
      d.learn(100 + i, north);
      d.learn(200 + i, south);
    }
    d.learn(300, [{ symbol: "00", at: null }, P(49.80, 19.0, "A"), P(49.81, 19.0, "X")]);
    assert.deepEqual(d.dirs().get("X")!.slice().sort((a, b) => a - b), [0, 180]);
    assert.equal(d.dirs().has("00"), false);
  });
  it("snapshot → restore round-trips and ignores garbage", () => {
    const d = new MzkStopDirs();
    d.learn(5, [P(49.80, 19.0, "A"), P(49.81, 19.0, "B")]);
    const snap = JSON.parse(JSON.stringify(d.snapshot()));
    assert.equal(snap.v, 2);
    assert.deepEqual(snap.at.A, [49.80, 19.0]); // positions the bearings were derived from
    const r = MzkStopDirs.restore(snap);
    assert.deepEqual(r.dirs().get("A"), d.dirs().get("A"));
    assert.equal(r.reconcile(new Map([["A", { lat: 49.80, lon: 19.0 }], ["B", { lat: 49.81, lon: 19.0 }]])), false);
    assert.equal(r.learn(5, [P(49.80, 19.0, "A"), P(49.81, 19.0, "B")]), false); // variant remembered
    assert.equal(MzkStopDirs.restore({ nonsense: true }).size, 0);
    assert.equal(MzkStopDirs.restore(null).size, 0);
  });
  it("clusterBearings merges nearby bearings and keeps an opposite cluster only with support", () => {
    assert.deepEqual(clusterBearings([10, 20, 350]), [7]);
    assert.deepEqual(clusterBearings([90, 92, 88, 270, 268]).sort((a, b) => a - b), [90, 269]);
    assert.deepEqual(clusterBearings([90, 92, 88, 91, 89, 90, 270]), [90]); // single stray sample is noise
  });
});
