/** /status probes: what a zbiorkom or SDIP answer means for a city's dot. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeSdip, probeZb } from "../lib/city-status";
import { at, LAT, LON, rec } from "./support/gzm-fixture";

const answer = (res: () => Response): typeof fetch => async () => res();
const json = (body: unknown) => () => new Response(JSON.stringify(body));

describe("probeZb", () => {
  const now = at("08:03") * 1000;
  it("counts the parsed vehicles and dates them by the newest fix", async () => {
    const body = { positions: [rec({ ts: at("08:02"), calls: [] }), rec({ key: "1_1", ts: at("08:02", 40), calls: [] })] };
    assert.deepEqual(await probeZb("gzm", answer(json(body)), now), { name: "zbiorkom", state: "ok", vehicles: 2, age: 20 });
  });
  it("tells an empty answer (night, or the outage of 2026-10-31) from a dead one", async () => {
    assert.equal((await probeZb("gzm", answer(json({ positions: [] })), now)).state, "empty");
    const down = async (f: typeof fetch) => {
      const s = await probeZb("krakow", f, now);
      return [s.state, s.error];
    };
    assert.deepEqual(await down(answer(() => new Response("", { status: 503 }))), ["down", "HTTP 503"]);
    assert.deepEqual(await down(answer(() => new Response("<html>"))), ["down", "invalid response"]);
    assert.deepEqual(await down(answer(json({ vehicles: [] }))), ["down", "invalid response"]);
    assert.deepEqual(await down(() => Promise.reject(new TypeError("fetch failed"))), ["down", "network error"]);
    assert.deepEqual(await down(() => Promise.reject(new DOMException("t", "TimeoutError"))), ["down", "timeout"]);
  });
});

describe("probeSdip", () => {
  const URL = "https://sdip.invalid/vm/main";
  it("opens a session, then counts the list", async () => {
    const f: typeof fetch = async (input, init) => {
      if (String(input) === URL) return new Response("", { headers: { "Set-Cookie": "JSESSIONID=abc; Path=/" } });
      assert.equal(new Headers(init?.headers).get("Cookie"), "JSESSIONID=abc");
      return new Response(JSON.stringify([{ id: "104_1", lat: LAT, lon: LON.a, bearing: 0 }]));
    };
    assert.deepEqual(await probeSdip(f, URL), { name: "SDIP", state: "ok", vehicles: 1, age: null });
  });
  it("is down without a session", async () => {
    const s = await probeSdip(answer(() => new Response("", { status: 502 })), URL);
    assert.deepEqual([s.state, s.error], ["down", "HTTP 502"]);
  });
});
