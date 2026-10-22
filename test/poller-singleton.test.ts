import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { getApi, getCombinedVehicles, startPoller } from "../lib/poller-singleton";

/* A fake singleton on the same globalThis key: nothing here constructs a real poller against upstream. */
const KEY = Symbol.for("kb-gtfs.poller-singleton");
const g = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete g[KEY];
});

describe("startPoller", () => {
  it("retries a failed KB start in the background even though MZK started", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
    let kbStarts = 0;
    g[KEY] = {
      poller: { start: async () => { kbStarts += 1; throw new Error("upstream down"); }, stops: [] },
      mzkPoller: { start: async () => undefined, stops: [] },
      shapes: { start() {} },
      startPromise: null,
      signalsRegistered: true,
      lastStartFailAt: 0,
    };
    await startPoller();
    assert.equal(kbStarts, 1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(kbStarts, 2, "a failed KB start must be retried, not left dead for the life of the process");
  });
});

describe("getApi", () => {
  it("routes get their own bounded KbApi: a flood sheds instead of queueing behind the poller", async (t) => {
    t.mock.method(globalThis, "fetch", () => new Promise(() => {}));
    const routeApi = getApi();
    const pollerApi = (g[KEY] as { poller: { api: unknown } }).poller.api;
    assert.notEqual(routeApi, pollerApi, "passthrough traffic must not share the poller's limiter");
    const calls = Array.from({ length: 2000 }, (_, i) => routeApi.fetchDepartures(String(i)).then(() => "ok", (e: Error) => e.message));
    const first = await Promise.race([...calls, new Promise((r) => setTimeout(r, 200, "timeout"))]);
    assert.match(String(first), /queue full/);
  });
});

describe("getCombinedVehicles", () => {
  it("drops MZK positions once the MZK feed has stopped refreshing", () => {
    const now = Date.now() / 1000;
    const pos = (id: string, updatedAt: number) => ({ execId: id, tripId: id, routeId: "6", line: "6", lat: 49.8, lon: 19.0, updatedAt, timestamp: updatedAt, bearing: null, nextStopLat: null, nextStopLon: null, operator: "MZK" });
    g[KEY] = {
      poller: { liveVehicles: () => [], snapshotKey: () => "k", lastGoodRefresh: now, scanCount: 0, lastScan: now },
      mzkPoller: { positions: new Map([["fresh", pos("fresh", now - 3)], ["old", pos("old", now - 600)]]), lastGoodRefresh: now - 3, scanCount: 1, lastScan: now },
      shapes: { wireId: () => null },
    };
    const res = getCombinedVehicles("mzk");
    assert.deepEqual(res.vehicles.map((v) => v.id), ["fresh"]);
  });
});

describe("getCombinedVehicles memo", () => {
  it("serves the same payload until the KB snapshot or the MZK map changes", () => {
    const g = globalThis as Record<symbol, unknown>;
    const KEY2 = Symbol.for("kb-gtfs.poller-singleton");
    const prev = g[KEY2];
    let kbKey = "a";
    let builds = 0;
    const st = {
      poller: { liveVehicles: () => { builds += 1; return []; }, snapshotKey: () => kbKey, lastGoodRefresh: 0, scanCount: 0, lastScan: 0 },
      mzkPoller: { positions: new Map(), lastGoodRefresh: 0, scanCount: 0, lastScan: 0 },
    };
    g[KEY2] = st;
    try {
      const first = getCombinedVehicles(null);
      assert.equal(getCombinedVehicles(null), first);
      assert.equal(getCombinedVehicles("anything"), first, "an unknown filter shares the unfiltered entry");
      assert.equal(builds, 1);
      kbKey = "b";
      assert.notEqual(getCombinedVehicles(null), first);
      st.mzkPoller.positions = new Map();
      getCombinedVehicles(null);
      assert.equal(builds, 3);
    } finally {
      g[KEY2] = prev;
    }
  });
});
