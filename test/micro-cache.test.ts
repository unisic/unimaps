import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMicroCache } from "../lib/micro-cache";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createMicroCache", () => {
  it("coalesces concurrent loads into one upstream call", async () => {
    const c = createMicroCache<string>({ ttlMs: 4000, now: () => 0 });
    const d = deferred<string>();
    let calls = 0;
    const load = () => {
      calls++;
      return d.promise;
    };
    const ps = [c.get("a", load), c.get("a", load), c.get("a", load)];
    d.resolve("rows");
    const out = await Promise.all(ps);
    assert.equal(calls, 1);
    assert.deepEqual(out.map((o) => o.value), ["rows", "rows", "rows"]);
  });

  it("serves from cache inside the TTL (reporting the age) and reloads after it", async () => {
    let t = 1000;
    const c = createMicroCache<number>({ ttlMs: 4000, now: () => t });
    let n = 0;
    const load = async () => ++n;
    assert.deepEqual(await c.get("k", load), { value: 1, ageMs: 0 });
    t += 3999;
    assert.deepEqual(await c.get("k", load), { value: 1, ageMs: 3999 });
    t += 1;
    assert.deepEqual(await c.get("k", load), { value: 2, ageMs: 0 });
    assert.equal(n, 2);
  });

  it("never caches a rejection: joiners all see it, the next caller retries", async () => {
    const c = createMicroCache<string>({ ttlMs: 4000, now: () => 0 });
    const d = deferred<string>();
    const p1 = c.get("k", () => d.promise);
    const p2 = c.get("k", () => d.promise);
    d.reject(new Error("upstream down"));
    await assert.rejects(p1, /upstream down/);
    await assert.rejects(p2, /upstream down/);
    assert.equal(c.size(), 0);
    assert.equal((await c.get("k", async () => "ok")).value, "ok");
  });

  it("cacheable() can refuse a partial result", async () => {
    const c = createMicroCache<{ partial: boolean }>({ ttlMs: 4000, now: () => 0, cacheable: (v) => !v.partial });
    let n = 0;
    await c.get("k", async () => ({ partial: ++n === 1 }));
    await c.get("k", async () => ({ partial: ++n === 1 }));
    assert.equal(n, 2); // first (partial) was not cached
    await c.get("k", async () => ({ partial: ++n === 1 }));
    assert.equal(n, 2); // second (complete) was cached
  });

  it("is bounded: oldest-inserted keys are evicted first", async () => {
    const c = createMicroCache<number>({ ttlMs: 1e9, max: 2, now: () => 0 });
    for (const k of ["a", "b", "c"]) await c.get(k, async () => 1);
    assert.equal(c.size(), 2);
    let reloaded = false;
    await c.get("a", async () => {
      reloaded = true;
      return 1;
    });
    assert.equal(reloaded, true);
  });
});
