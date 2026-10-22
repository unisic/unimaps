/**
 * LivePoller end to end against a fake KbApi (no network): the departures-board truncation rule, the 404 cache,
 * ghost filtering, heading, parsePosition's midnight wrap, out-of-order responses, the arrival log bound and the
 * stop-list reload backoff. Private scan methods are driven through a typed cast; time is mock.timers.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { KbApi } from "../lib/kb-api";
import { LivePoller, type LivePollerOptions } from "../lib/poller";
import type { Stop } from "../lib/types";

const T0 = Date.UTC(2026, 9, 22, 8, 0, 0); // 10:00 Europe/Warsaw
const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): [number, number] => [LAT0 + north / 111_320, LON0 + east / KX];

const mkStops = (n: number): Stop[] =>
  Array.from({ length: n }, (_, i) => ({
    urlId: `S${i + 1}`,
    internalId: i + 1,
    name: `Stop ${i + 1}`,
    lat: LAT0,
    lon: LON0 + i * 0.01,
    onlyDisembarking: false,
    isStation: false,
    showPlatforms: false,
    stopId: `S${i + 1}`,
  }));

/** A trip execution reply; designators 901+ resolve to no stop, so GPS progress stays out of the way. */
function tripResp(at: [number, number], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trip: {
      times: ["10:00", "10:05", "10:10"].map((t, i) => ({ stop_name: `T${i}`, designator: 901 + i, departure_time: t })),
      line: { name: "1" },
      direction: "X",
    },
    vehicle: { lat: at[0], lon: at[1] },
    vehicle_trip_index: 0,
    next_departure_index: 1,
    at_stop: false,
    estimates: [{ arrival_abs: "10:06" }],
    ...extra,
  };
}

interface Internals {
  fullScan(): Promise<void>;
  refreshActive(): Promise<void>;
  notFound: Map<string, number>;
}
const internals = (p: LivePoller): Internals => p as unknown as Internals;

async function mkPoller(api: Partial<Record<keyof KbApi, unknown>>, stops: Stop[], opts: LivePollerOptions = {}): Promise<LivePoller> {
  const fake = { fetchRevision: async () => "1", fetchStops: async () => stops, ...api } as unknown as KbApi;
  const poller = new LivePoller(fake, opts);
  await poller.loadStops();
  return poller;
}

const setT = (sec: number): void => mock.timers.setTime(T0 + sec * 1000);

describe("LivePoller with a fake KbApi", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: T0 }));
  afterEach(() => mock.timers.reset());

  it("a board absent from the reply (truncation) is rescanned, an empty board is cached as empty", async () => {
    const asked: string[][] = [];
    const poller = await mkPoller(
      {
        fetchMultipleDepartures: async (ids: string[]) => {
          asked.push(ids);
          // upstream answers at most 6 boards, empty stops still get a board with empty rows
          return { departures: ids.slice(0, 6).map((designator) => ({ designator, rows: [] })) };
        },
        fetchTripExecution: async () => ({}),
      },
      mkStops(8),
      { batchSize: 8 },
    );
    await internals(poller).fullScan();
    assert.deepEqual(asked, [["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]]);
    await internals(poller).fullScan();
    assert.deepEqual(asked[1], ["S7", "S8"], "only the truncated stops are due again");
  });

  it("404 cache: a cached skip never re-stamps, the trip is re-fetched once the cache expires, a fetch error is not a 404", async () => {
    let calls = 0;
    let mode: "404" | "ok" | "throw" = "404";
    const poller = await mkPoller(
      {
        fetchMultipleDepartures: async () => ({ departures: [{ designator: "S1", rows: [{ trip_execution_id: "E1", time: "< 1 min" }] }] }),
        fetchTripExecution: async () => {
          calls += 1;
          if (mode === "throw") throw new Error("socket hang up");
          return mode === "404" ? {} : tripResp(P(0, 0));
        },
      },
      mkStops(1),
      { cache404: 240 },
    );
    const nf = internals(poller).notFound;
    const t0s = Math.floor(T0 / 1000);
    await internals(poller).fullScan();
    assert.equal(calls, 1);
    assert.equal(nf.get("E1"), t0s);

    mode = "ok";
    setT(180);
    await internals(poller).fullScan();
    assert.equal(calls, 1, "still inside the 404 cache: skipped");
    assert.equal(nf.get("E1"), t0s, "the skip must not slide the TTL");

    setT(241);
    await internals(poller).fullScan();
    assert.equal(calls, 2, "cache expired: fetched again");
    const pos = poller.positions.get("E1");
    assert.ok(pos, "the late-dispatched bus is tracked");
    assert.equal(nf.has("E1"), false);

    mode = "throw";
    setT(251);
    await internals(poller).refreshActive();
    assert.equal(calls, 3);
    assert.equal(poller.positions.get("E1"), pos, "a failed fetch keeps the previous position");
    assert.equal(nf.has("E1"), false, "a failed fetch is not a 404");
  });

  it("ghosts: a feed frozen within the movement epsilon (no delay) is hidden and pruned, a creeping bus is not", async () => {
    let north = 0;
    let east = 0;
    const poller = await mkPoller({ fetchTripExecution: async () => tripResp(P(east, north), { estimates: [] }) }, []);
    poller.ingestTripExecution("ghost", tripResp(P(0, 0), { estimates: [] }));
    assert.equal(poller.positions.get("ghost")?.delay, null);
    for (let k = 1; k <= 6; k++) {
      setT(60 * k);
      north = k % 2 ? 3 : -3; // GPS jitter around a parked bus
      await internals(poller).refreshActive();
      if (k === 4) assert.equal(poller.toJson().count, 1, "frozen 240 s: still shown");
    }
    assert.equal(poller.toJson().count, 0, "frozen > 300 s with no delay estimate: hidden");
    assert.equal(poller.positions.size, 0, "and pruned");

    setT(0);
    north = 0;
    poller.ingestTripExecution("creep", tripResp(P(0, 0), { estimates: [] }));
    for (let k = 1; k <= 8; k++) {
      setT(60 * k);
      east = 5 * k; // 5 m per poll: each step under the epsilon, the sum is not
      await internals(poller).refreshActive();
    }
    const v = poller.positions.get("creep");
    assert.ok(v, "a slowly moving bus stays tracked");
    assert.ok(v.lastMovedAt > T0 / 1000 + 300, `lastMovedAt advanced (${v.lastMovedAt - T0 / 1000})`);
    assert.equal(poller.toJson().count, 1);
  });

  it("heading follows movement of >= 8 m and is kept while (almost) standing", async () => {
    let at = P(0, 0);
    const poller = await mkPoller({ fetchTripExecution: async () => tripResp(at) }, []);
    poller.ingestTripExecution("E", tripResp(at));
    const step = async (sec: number, p: [number, number]): Promise<number | null> => {
      setT(sec);
      at = p;
      await internals(poller).refreshActive();
      return poller.positions.get("E")!.bearing;
    };
    assert.equal(await step(10, P(0, 3)), null, "3 m: no heading yet");
    const north = await step(20, P(0, 23));
    assert.ok(north !== null && (north < 1 || north > 359), `20 m north -> ${north}`);
    assert.equal(await step(30, P(3, 23)), north, "3 m east: heading kept");
    const east = await step(40, P(23, 23));
    assert.ok(east !== null && Math.abs(east - 90) < 1, `20 m east -> ${east}`);
  });

  it("parsePosition delay wraps midnight both ways; time_diff is the fallback", async () => {
    const poller = await mkPoller({}, []);
    const times = (t1: string, est?: Record<string, unknown>): Record<string, unknown> => ({
      times: [
        { designator: 901, departure_time: "23:50", ...(est ? { estimate: est } : {}) },
        { designator: 902, departure_time: t1 },
      ],
      line: { name: "1" },
      direction: "X",
    });
    const late = poller.ingestTripExecution("a", tripResp(P(0, 0), { trip: times("23:58"), estimates: [{ arrival_abs: "00:02" }] }));
    assert.equal(late?.delayUp, 240);
    const early = poller.ingestTripExecution("b", tripResp(P(0, 0), { trip: times("00:02"), estimates: [{ arrival_abs: "23:58" }] }));
    assert.equal(early?.delayUp, -240);
    const fb = poller.ingestTripExecution("c", tripResp(P(0, 0), { trip: times("00:02", { time_diff: 90 }), estimates: [] }));
    assert.equal(fb?.delayUp, 90);
  });

  it("out-of-order responses: a reply to an older request never overwrites a newer position", async () => {
    let release: (v: unknown) => void = () => {};
    const poller = await mkPoller({ fetchTripExecution: () => new Promise((r) => (release = r)) }, []);
    poller.ingestTripExecution("E", tripResp(P(0, 0)));
    setT(10);
    const refresh = internals(poller).refreshActive(); // poller asks upstream at t=10 ...
    setT(12);
    poller.ingestTripExecution("E", tripResp(P(0, 200))); // ... a viewer's newer reply lands first
    release(tripResp(P(0, 100))); // ... then the poller's older one
    await refresh;
    assert.equal(poller.positions.get("E")!.lat, P(0, 200)[0]);
    // a viewer's reply to a request issued before the stored one is dropped as well
    const kept = poller.ingestTripExecution("E", tripResp(P(0, 50)), T0 + 11_000);
    assert.equal(kept?.lat, P(0, 200)[0]);
  });

  it("the arrival log stays bounded by the trip's stop count on a garbage vehicle_trip_index", async () => {
    const poller = await mkPoller({}, []);
    poller.ingestTripExecution("E", tripResp(P(0, 0), { vehicle_trip_index: 0 }));
    setT(10);
    poller.ingestTripExecution("E", tripResp(P(0, 100), { vehicle_trip_index: 1 }));
    setT(20);
    const pos = poller.ingestTripExecution("E", tripResp(P(0, 200), { vehicle_trip_index: 100_000 }));
    assert.ok(pos?.arrivals);
    assert.ok(pos.arrivals.arrived.length <= 3, `arrived.length ${pos.arrivals.arrived.length}`);
  });
});

describe("LivePoller stop-list reload", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 }));
  afterEach(() => mock.timers.reset());

  it("an empty reload backs off like a failed one instead of retrying every full scan", async () => {
    let stopCalls = 0;
    const stops = mkStops(1);
    const poller = await mkPoller(
      {
        fetchStops: async () => (++stopCalls === 1 ? stops : []),
        fetchMultipleDepartures: async () => ({}),
      },
      [],
      { scanInterval: 1, refreshInterval: 1 },
    );
    await poller.start();
    const before = stopCalls;
    poller.stopsLoadedAt = 0; // the daily reload is due
    for (let i = 0; i < 6; i++) {
      mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
    }
    await poller.stop();
    assert.equal(stopCalls - before, 1, "one empty reload, then the 30 min backoff");
    assert.equal(poller.stops.length, 1, "the previous list is kept");
  });
});
