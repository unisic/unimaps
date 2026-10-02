import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { MZK_REALTIME_TTL_MS, MZK_SCHEDULE_TTL_MS, MzkApi } from "../lib/mzk-api";

/* getRealtime / getAtomicSchedule are cached per symbol (5 s / 15 min) with in-flight de-duplication, so a
   station hub that fans out to several symbols and several viewers refreshing the same stop cost one request. */
const realFetch = globalThis.fetch;
let calls: string[];
let failNext: boolean;

beforeEach(() => {
  calls = [];
  failNext = false;
  mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    await Promise.resolve();
    if (failNext) {
      failNext = false;
      return new Response("boom", { status: 500 });
    }
    return new Response(JSON.stringify({ departures: [], n: calls.length }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

describe("MzkApi.fetchRealtime cache", () => {
  it("concurrent callers share ONE request; the answer is reused inside the TTL and refetched after it", async () => {
    const api = new MzkApi("http://mzk.test");
    const [a, b] = await Promise.all([api.fetchRealtime("265"), api.fetchRealtime("265")]);
    assert.equal(calls.length, 1);
    assert.equal(a, b);
    mock.timers.tick(MZK_REALTIME_TTL_MS - 1);
    assert.equal(await api.fetchRealtime("265"), a);
    assert.equal(calls.length, 1);
    mock.timers.tick(2);
    const c = await api.fetchRealtime("265");
    assert.equal(calls.length, 2);
    assert.notEqual(c, a);
  });

  it("different symbols are independent", async () => {
    const api = new MzkApi("http://mzk.test");
    await Promise.all([api.fetchRealtime("1"), api.fetchRealtime("2"), api.fetchRealtime("1")]);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /stopPointSymbol=1$/);
  });

  it("a failed request is never cached: the next caller retries", async () => {
    const api = new MzkApi("http://mzk.test");
    failNext = true;
    await assert.rejects(api.fetchRealtime("265"));
    const ok = await api.fetchRealtime("265");
    assert.equal(calls.length, 2);
    assert.deepEqual((ok as unknown as { departures: unknown[] }).departures, []);
  });
});

describe("MzkApi.fetchAtomicSchedule cache", () => {
  it("is keyed by symbol AND date, lives 15 minutes", async () => {
    const api = new MzkApi("http://mzk.test");
    await api.fetchAtomicSchedule("265", "2026-10-02");
    await api.fetchAtomicSchedule("265", "2026-10-02");
    assert.equal(calls.length, 1);
    await api.fetchAtomicSchedule("265", "2026-10-03"); // another day
    await api.fetchAtomicSchedule("341", "2026-10-02"); // another stop
    assert.equal(calls.length, 3);
    mock.timers.tick(MZK_SCHEDULE_TTL_MS + 1);
    await api.fetchAtomicSchedule("265", "2026-10-02");
    assert.equal(calls.length, 4);
  });

  it("stays bounded: the oldest entries are evicted", async () => {
    const api = new MzkApi("http://mzk.test");
    for (let i = 0; i < 60; i++) await api.fetchAtomicSchedule(String(i), "2026-10-02");
    assert.equal(calls.length, 60);
    await api.fetchAtomicSchedule("59", "2026-10-02"); // newest: still cached
    assert.equal(calls.length, 60);
    await api.fetchAtomicSchedule("0", "2026-10-02"); // oldest: evicted → refetched
    assert.equal(calls.length, 61);
  });
});
