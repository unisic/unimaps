/**
 * zbiorkom city residency (KB_ZB_RESIDENT = 2): a quiet city is evicted for a newcomer, one still viewed only once a
 * minute (meanwhile the newcomer is a parked, never-started stand-in); prebuiltJson serializes and gzips once per owner;
 * the connections memo never keeps a swapped-out feed alive.
 */
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { gunzipSync } from "node:zlib";
import { describe, it, mock } from "node:test";

import { prebuiltJson } from "../lib/api-helpers";
import { GzmLive, getZb, safeZbHealth, startZb } from "../lib/gzm";
import type { GzmFeed } from "../lib/gzm-feed";
import { at, loadGzmFeed } from "./support/gzm-fixture";

describe("zbiorkom residency", () => {
  it("drops a viewed city once a minute, a quiet one at once, parks the rest", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const resident = () => {
      const h = safeZbHealth();
      return Object.keys(h).filter((k) => typeof h[k] === "object").sort();
    };
    try {
      getZb("krakow");
      getZb("lodz");
      getZb("szczecin");
      assert.deepEqual(resident(), ["lodz", "szczecin"]);

      const p = getZb("krakow");
      assert.equal(p.currentFeed(), null);
      await startZb("krakow");
      assert.equal(p.running, false);
      assert.equal(getZb("krakow"), p);
      assert.deepEqual(resident(), ["lodz", "szczecin"]);
      assert.equal(safeZbHealth().parked_requests, 3);

      for (let i = 0; i < 3; i++) {
        mock.timers.tick(20_000);
        getZb("lodz");
        getZb("szczecin");
      }
      assert.notEqual(getZb("krakow"), p);
      assert.deepEqual(resident(), ["krakow", "szczecin"]);

      mock.timers.tick(31_000);
      getZb("krakow");
      getZb("tricity");
      assert.deepEqual(resident(), ["krakow", "tricity"]);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("prebuiltJson", () => {
  it("builds and gzips once per owner", async () => {
    const owner = {};
    let builds = 0;
    const build = () => (builds++, JSON.stringify({ n: 1 }));
    const gz = new Request("http://x/", { headers: { "accept-encoding": "gzip, br" } });
    const r1 = prebuiltJson(gz, owner, build, { ETag: '"e"' });
    const r2 = prebuiltJson(new Request("http://x/"), owner, build, {});
    assert.equal(builds, 1);
    assert.equal(r1.headers.get("content-encoding"), "gzip");
    assert.equal(r1.headers.get("etag"), '"e"');
    assert.equal(gunzipSync(Buffer.from(await r1.arrayBuffer())).toString(), '{"n":1}');
    assert.equal(r2.headers.get("content-encoding"), null);
    assert.equal(await r2.text(), '{"n":1}');
  });
});

describe("connections memo", () => {
  it("lets a swapped-out feed be collected", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    let cur: GzmFeed | null = await loadGzmFeed();
    const old = new WeakRef(cur);
    const live = new GzmLive({ feed: () => cur, now: () => at("08:00") * 1000, sdipUrl: null });
    assert.equal(live.connections({ from: "gzm:a", to: "gzm:c" })?.length, 1);
    cur = await loadGzmFeed();
    assert.equal(live.connections({ from: "gzm:a", to: "gzm:b" })?.length, 1);
    await new Promise((r) => setImmediate(r));
    gc();
    assert.equal(old.deref(), undefined);
  });
});
