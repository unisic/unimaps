import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import * as route from "../server/api/trips/route";

/* Fake singleton (already "started"): the route talks to a fake KbApi, never to upstream. */
const KEY = Symbol.for("kb-gtfs.poller-singleton");

let fake: { cached: Set<string>; fail: Set<string> };

beforeEach(() => {
  fake = { cached: new Set(), fail: new Set() };
  (globalThis as Record<symbol, unknown>)[KEY] = {
    api: {
      hasCachedTrip: (id: string) => fake.cached.has(id),
      fetchTripsBatch: async (ids: string[]) => {
        const trips: Record<string, unknown> = {};
        let failed = 0;
        for (const id of ids) {
          if (fake.fail.has(id)) failed += 1;
          else trips[id] = { times: [], line: { name: "120" }, direction: "x" };
        }
        return { trips, failed };
      },
    },
    poller: { kbPatternFor: () => null },
    shapes: {},
    startPromise: Promise.resolve(),
    signalsRegistered: true,
    lastStartFailAt: 0,
  };
});

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(from + i)).join(",");
const get = (q: string, ip: string) =>
  route.GET(new Request(`http://x/api/trips?ids=${q}`, { headers: { "x-forwarded-for": ip } }));

describe("GET /api/trips", () => {
  it("charges a rate-limit token per uncached id, not one per request", async () => {
    assert.equal((await get(ids(300), "10.0.0.1")).status, 200);
    assert.equal((await get(ids(300), "10.0.0.1")).status, 200);
    assert.equal((await get(ids(300), "10.0.0.1")).status, 429, "600 upstream fetches spend the per-IP burst");
    for (let i = 1; i <= 300; i++) fake.cached.add(String(i));
    assert.equal((await get(ids(300), "10.0.0.2")).status, 200);
    assert.equal((await get(ids(300), "10.0.0.2")).status, 200);
    assert.equal((await get(ids(300), "10.0.0.2")).status, 200, "cached ids cost no upstream fetch");
  });

  it("a failed upstream fetch is not cached as 'no such trip'; all failed is a 502", async () => {
    fake.fail.add("2");
    const partial = await get("1,2", "10.0.1.1");
    assert.equal(partial.status, 200);
    assert.equal(partial.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(((await partial.json()) as { trips: object }).trips), ["1"]);
    fake.fail.add("1");
    assert.equal((await get("1,2", "10.0.1.1")).status, 502);
    fake.fail.clear();
    assert.equal((await get("1,2", "10.0.1.1")).headers.get("cache-control"), "public, max-age=3600");
  });

  it("has no POST handler (it parsed an unbounded body before the rate-limit gate)", () => {
    assert.equal((route as Record<string, unknown>).POST, undefined);
  });
});
