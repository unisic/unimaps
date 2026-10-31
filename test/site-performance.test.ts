import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { head, PAGES } from "../app/head";
import manifestFn from "../app/manifest";
import { KbApi } from "../lib/kb-api";

describe("Site Performance & Optimization Invariants", () => {
  describe("PWA Fullscreen & Safe-Area Configuration", () => {
    it("includes apple-touch-fullscreen and fullscreen manifest display override", () => {
      const headHtml = head(PAGES["index.html"]);
      assert.ok(
        headHtml.includes('<meta name="apple-touch-fullscreen" content="yes">'),
        "head must include apple-touch-fullscreen for iOS PWA fullscreen",
      );

      const manifest = manifestFn();
      assert.ok(
        manifest.display_override?.includes("fullscreen"),
        "manifest display_override must include fullscreen",
      );
      assert.equal(manifest.display, "standalone", "manifest display must remain standalone for fallback");
    });

    it("ensures TopBar uses safe-area offset with 0.75rem clearance to clear iOS status blur", () => {
      const topBarSrc = fs.readFileSync(path.resolve(process.cwd(), "components/TopBar.svelte"), "utf-8");
      assert.ok(
        topBarSrc.includes("calc(env(safe-area-inset-top,0px)+0.75rem)"),
        "TopBar must include clearance below safe-area to prevent entering topbar blur",
      );

      const filterSrc = fs.readFileSync(path.resolve(process.cwd(), "components/LineFilterChip.svelte"), "utf-8");
      assert.ok(
        filterSrc.includes("calc(env(safe-area-inset-top,0px)+0.75rem+56px)"),
        "LineFilterChip must stay aligned with TopBar",
      );

      const toastSrc = fs.readFileSync(path.resolve(process.cwd(), "components/Toast.svelte"), "utf-8");
      assert.ok(
        toastSrc.includes("calc(env(safe-area-inset-top,0px)+0.75rem+60px)"),
        "Toast must stay aligned with TopBar",
      );
    });

    it("verifies preconnect links to tile CDNs in the shared head", () => {
      const headHtml = head(PAGES["index.html"]);
      assert.ok(headHtml.includes('rel="preconnect" href="https://tiles.openfreemap.org"'));
      assert.ok(headHtml.includes('rel="dns-prefetch" href="https://tiles.openfreemap.org"'));
      assert.ok(headHtml.includes('rel="preconnect" href="https://tile.openstreetmap.org"'));
    });
  });

  describe("API Client & In-Memory Caching", () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    it("KbApi.fetchTripsBatch dedupes ids, serves repeats from cache and never caches a miss", async (t) => {
      const urls: string[] = [];
      t.mock.method(globalThis, "fetch", async (url: string | URL) => {
        urls.push(String(url));
        if (String(url).includes("/api/trip/404/")) return new Response("", { status: 404 });
        return json({ id: String(url) });
      });
      const api = new KbApi();

      const first = await api.fetchTripsBatch(["1", "1", "2", "404"]);
      assert.deepEqual(Object.keys(first.trips).sort(), ["1", "2"]);
      assert.equal(first.failed, 0, "a 404 is a missing trip, not a failed fetch");
      assert.equal(urls.length, 3, "duplicate ids must share one upstream request");

      const second = await api.fetchTripsBatch(["1", "2", "404"]);
      assert.deepEqual(second.trips, first.trips);
      assert.equal(urls.length, 4, "cached trips are not refetched; the 404 is retried");
      assert.ok(urls[3].includes("/api/trip/404/"));
    });

    it("KbApi.fetchTimetable answers a repeat for the same stop and date from cache", async (t) => {
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return json({ departures: [{ trip_id: 1 }] });
      });
      const api = new KbApi();
      const a = await api.fetchTimetable("19117:39660", "2026-10-22");
      const b = await api.fetchTimetable("19117:39660", "2026-10-22");
      assert.deepEqual(b, a);
      assert.equal(calls, 1);
      await api.fetchTimetable("19117:39660", "2026-10-23");
      assert.equal(calls, 2, "another date is another cache entry");
    });

    it("client getTripsBatch resolves missing trips in one request and then from cache", async (t) => {
      const { getTripsBatch } = await import("../lib/client/api");
      const urls: string[] = [];
      t.mock.method(globalThis, "fetch", async (url: string | URL) => {
        urls.push(String(url));
        return json({
          count: 2,
          trips: { "perf-a": { times: [{}], shape_status: "road" }, "perf-b": { times: [{}], shape_status: "road" } },
        });
      });

      const first = await getTripsBatch(["perf-a", "perf-b"]);
      assert.equal(urls.length, 1);
      assert.ok(urls[0].startsWith("/api/trips?ids="));
      assert.deepEqual([...first.keys()], ["perf-a", "perf-b"]);

      const second = await getTripsBatch(["perf-a", "perf-b"]);
      assert.equal(urls.length, 1, "cached trips must not hit the network again");
      assert.deepEqual(second, first);
    });
  });

  describe("Map Readiness Tuning", () => {
    it("VectorBaseLayer uses reduced tile padding and faster timeout fallback", () => {
      const baseLayerSrc = fs.readFileSync(path.resolve(process.cwd(), "components/VectorBaseLayer.svelte"), "utf-8");
      assert.ok(baseLayerSrc.includes("padding: 0.08"), "tile padding must be optimized for cold load");
      assert.ok(baseLayerSrc.includes("STYLE_TIMEOUT_MS = 5_000"), "style timeout must be 5s for fast fallback");
      assert.ok(!baseLayerSrc.includes("gl.areTilesLoaded()"), "should not block screen veil waiting for 100% tiles");
    });
  });
});
