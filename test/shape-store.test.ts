/**
 * Road-shape store: queue/worker behaviour with a fake OSRM + fake clock (no
 * network, no timers), and persistence in a throwaway temp dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ALGO_VERSION, ShapeStore, pickRefreshCandidate, type ShapeEntry, type ShapeStoreOptions } from "../lib/shape-store";
import type { KbPattern } from "../lib/shape-patterns";
import { decodePolyline, encodePolyline, segMeters, type LatLng } from "../lib/shared/polyline";

const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];

function pattern(key = "kb:0123456789ab", n = 4): KbPattern {
  const stopPts = Array.from({ length: n }, (_, i) => P(i * 300, 0));
  return { key, stopPts, waypoints: stopPts, wpSig: "sig1", line: "1", dir: "X" };
}

type Mode = "ok" | "down" | "noroute";

function harness(extra: Partial<ShapeStoreOptions> = {}) {
  let now = 1_800_000_000_000;
  const sleeps: number[] = [];
  const reqAt: number[] = [];
  const state: { mode: Mode } = { mode: "ok" };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    reqAt.push(now);
    if (state.mode === "down") return new Response("", { status: 503 });
    if (state.mode === "noroute") return new Response(JSON.stringify({ code: "NoRoute" }), { status: 400 });
    const p = new URL(String(input)).pathname;
    const coords = p
      .slice(p.lastIndexOf("/") + 1)
      .split(";")
      .map((c) => {
        const [lon, lat] = c.split(",").map(Number);
        return [lat, lon] as LatLng;
      });
    // a "road" that bulges 20 m north between stops
    const geom: LatLng[] = [];
    coords.forEach((c, i) => {
      geom.push(c);
      if (i + 1 < coords.length) geom.push([(c[0] + coords[i + 1][0]) / 2 + 20 / 111_320, (c[1] + coords[i + 1][1]) / 2]);
    });
    const legs = coords.slice(1).map((c, i) => ({ distance: segMeters(coords[i][0], coords[i][1], c[0], c[1]) + 2 }));
    return new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: encodePolyline(geom), legs }] }), { status: 200 });
  }) as typeof fetch;
  const store = new ShapeStore({
    fetchImpl,
    osrmBase: "https://osrm.test/route/v1/driving",
    userAgent: "test",
    minIntervalMs: 1000,
    maxAgeDays: 14,
    file: null,
    timers: false,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    ...extra,
  });
  store.start();
  return {
    store,
    state,
    sleeps,
    reqAt,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe("ShapeStore — KB routing", () => {
  it("new pattern → straight entry at once (not served), routed by the worker", async () => {
    const h = harness();
    const p = pattern();
    h.store.touchKb(p, "urgent");
    assert.equal(h.store.getEntry(p.key)?.src, "straight");
    assert.equal(h.store.wireId(p.key), null);
    assert.equal(h.store.status(p.key), "pending");
    assert.deepEqual(h.store.lookup([p.key]).missing, [p.key]);

    assert.equal(await h.store.runNext(), true);
    const e = h.store.getEntry(p.key)!;
    assert.equal(e.src, "osrm");
    assert.equal(h.store.status(p.key), "road");
    const id = h.store.wireId(p.key)!;
    assert.equal(id, `${p.key}.${e.rev}`);
    const look = h.store.lookup([id]);
    assert.equal(look.exact, true);
    assert.equal(look.shapes[id].id, id);
    assert.equal(look.shapes[id].stops.length, 4);
    // stops are monotone along the road
    const s = look.shapes[id].stops as number[];
    assert.ok(s[0] < s[1] && s[1] < s[2] && s[2] < s[3]);
    assert.ok(decodePolyline(look.shapes[id].poly).length > 4);
    assert.equal(await h.store.runNext(), false);
  });

  it("an outdated rev gets current content but is not immutable", async () => {
    const h = harness();
    const p = pattern();
    h.store.touchKb(p, "urgent");
    await h.store.runNext();
    const look = h.store.lookup([`${p.key}.ffffff`]);
    assert.equal(look.exact, false);
    assert.equal(look.shapes[`${p.key}.ffffff`].id, h.store.wireId(p.key));
  });

  it("OSRM down: nothing committed, breaker pauses, job kept", async () => {
    const h = harness();
    const p = pattern();
    h.state.mode = "down";
    h.store.touchKb(p, "urgent");
    await h.store.runNext();
    assert.equal(h.store.getEntry(p.key)!.src, "straight");
    assert.equal(h.store.health().osrm_state, "paused");
    assert.equal(h.store.health().queued, 1);
    // still paused → nothing runnable
    assert.equal(await h.store.runNext(), false);
    h.advance(61_000);
    h.state.mode = "ok";
    assert.equal(await h.store.runNext(), true);
    assert.equal(h.store.getEntry(p.key)!.src, "osrm");
  });

  it("never downgrades a stored road shape", async () => {
    const h = harness();
    const p = pattern();
    h.store.touchKb(p, "urgent");
    await h.store.runNext();
    const rev = h.store.getEntry(p.key)!.rev;
    // stops moved → rebuild queued; this time every leg is unroutable
    h.state.mode = "noroute";
    h.store.touchKb({ ...p, wpSig: "sig2" }, "urgent");
    await h.store.runNext();
    const e = h.store.getEntry(p.key)!;
    assert.equal(e.src, "osrm");
    assert.equal(e.rev, rev);
  });

  it("all legs unroutable → straight, marked unroutable, status none", async () => {
    const h = harness();
    const p = pattern();
    h.state.mode = "noroute";
    h.store.touchKb(p, "urgent");
    await h.store.runNext();
    const e = h.store.getEntry(p.key)!;
    assert.equal(e.src, "straight");
    assert.equal(e.unroutable, true);
    assert.equal(h.store.status(p.key), "none");
  });

  it("throttles every request ≥ minInterval apart", async () => {
    const h = harness();
    h.store.touchKb(pattern("kb:aaaaaaaaaaaa", 30), "urgent"); // 3 chunks
    h.store.touchKb(pattern("kb:bbbbbbbbbbbb", 4), "background");
    while (await h.store.runNext()) {
      /* drain */
    }
    assert.equal(h.reqAt.length, 8); // 4 chunks, each with and without the stop directions
    for (let i = 1; i < h.reqAt.length; i++) assert.ok(h.reqAt[i] - h.reqAt[i - 1] >= 1000);
  });

  it("403 from OSRM: blocked for a day — trips report none, then it retries", async () => {
    const h = harness();
    const p = pattern();
    h.state.mode = "ok";
    h.store.touchKb(p, "urgent");
    // swap in a refusing OSRM
    (h.store as unknown as { o: { fetchImpl: typeof fetch } }).o.fetchImpl = (async () =>
      new Response("", { status: 403 })) as typeof fetch;
    await h.store.runNext();
    assert.equal(h.store.health().osrm_state, "blocked");
    assert.equal(h.store.status(p.key), "none");
    h.advance(25 * 3_600_000);
    assert.equal(h.store.health().osrm_state, "ok");
    assert.equal(h.store.status(p.key), "pending");
  });

  it("routing disabled → straight only, status none, nothing queued", async () => {
    const h = harness({ osrmBase: null });
    const p = pattern();
    h.store.touchKb(p, "urgent");
    assert.equal(h.store.status(p.key), "none");
    assert.equal(await h.store.runNext(), false);
  });
});

describe("ShapeStore — MZK", () => {
  const course = {
    stopPoints: [P(0, 0), P(500, 0), P(1000, 0)].map(([latitude, longitude]) => ({ latitude, longitude })),
    segments: [
      { nodes: [P(0, 0), P(250, 30), P(500, 0)].map(([latitude, longitude]) => ({ latitude, longitude })) },
      { nodes: [P(500, 0), P(1000, 0)].map(([latitude, longitude]) => ({ latitude, longitude })) },
    ],
  };

  it("fetches a variant in the background and serves it as road", async () => {
    let calls = 0;
    const h = harness({
      mzkFetch: async () => {
        calls += 1;
        return course;
      },
    });
    h.store.touchMzk(13954);
    assert.equal(h.store.status("mzk:13954"), "pending");
    await h.store.runNext();
    const e = h.store.getEntry("mzk:13954")!;
    assert.equal(e.src, "mzk");
    assert.equal(e.stops.length, 3);
    assert.equal(e.stops[0], 0);
    assert.ok(Math.abs(e.stops[2]! - e.len) < 0.5);
    assert.ok(h.store.wireId("mzk:13954"));
    const pts = await h.store.getMzkShape(13954);
    assert.ok(pts && pts.length >= 4);
    assert.equal(calls, 1);
  });

  it("negative-caches failures and dedupes concurrent on-demand fetches", async () => {
    let calls = 0;
    const h = harness({
      mzkFetch: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const [a, b] = await Promise.all([h.store.getMzkShape(7), h.store.getMzkShape(7)]);
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(calls, 1);
    await h.store.getMzkShape(7);
    assert.equal(calls, 1);
  });
});

describe("pickRefreshCandidate", () => {
  const base = (over: Partial<ShapeEntry>): ShapeEntry => ({
    src: "osrm",
    poly: "",
    len: 0,
    stops: [],
    rev: "000000",
    builtAt: 0,
    seenAt: 0,
    fails: 0,
    retryAt: 0,
    algo: ALGO_VERSION,
    ...over,
  });
  const now = 100 * 86_400_000;

  it("oldest due entry first; unseen and fresh ones skipped", () => {
    const entries: Array<[string, ShapeEntry]> = [
      ["kb:fresh000000", base({ builtAt: now - 86_400_000, seenAt: now })],
      ["kb:old00000000", base({ builtAt: now - 20 * 86_400_000, seenAt: now })],
      ["kb:older000000", base({ builtAt: now - 30 * 86_400_000, seenAt: now })],
      ["kb:unseen00000", base({ builtAt: 0, seenAt: now - 30 * 86_400_000 })],
      ["mzk:1", base({ src: "mzk", builtAt: 0, seenAt: now })],
    ];
    assert.equal(pickRefreshCandidate(entries, now, 14), "kb:older000000");
    assert.equal(pickRefreshCandidate(entries.slice(0, 1), now, 14), null);
  });

  it("straight retries honour retryAt; old algo is always due", () => {
    assert.equal(
      pickRefreshCandidate([["kb:s", base({ src: "straight", retryAt: now + 1, seenAt: now })]], now, 14),
      null,
    );
    assert.equal(
      pickRefreshCandidate([["kb:s", base({ src: "straight", retryAt: now - 1, seenAt: now })]], now, 14),
      "kb:s",
    );
    assert.equal(pickRefreshCandidate([["kb:a", base({ algo: 0, builtAt: now, seenAt: now })]], now, 14), "kb:a");
  });
});

describe("ShapeStore — persistence", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kb-shapes-"));

  it("flush + reload round-trips; a corrupt main file falls back to .bak", async () => {
    const dir = tmp();
    const file = path.join(dir, "route-shapes.v1.json");
    const h = harness({ file });
    const p = pattern();
    h.store.touchKb(p, "urgent");
    await h.store.runNext();
    h.store.flush(true);
    const rev = h.store.getEntry(p.key)!.rev;
    // second save creates the .bak
    h.store.touchKb(pattern("kb:cccccccccccc"), "background");
    h.store.flush(true);
    h.store.stop();
    assert.ok(fs.existsSync(file) && fs.existsSync(`${file}.bak`));
    assert.ok(!fs.existsSync(`${file}.lock`));

    const again = harness({ file });
    assert.equal(again.store.getEntry(p.key)?.rev, rev);
    again.store.stop();

    fs.writeFileSync(file, "{not json");
    const fromBak = harness({ file });
    assert.equal(fromBak.store.getEntry(p.key)?.rev, rev);
    assert.ok(fs.readdirSync(dir).some((f) => f.includes(".corrupt-")));
    fromBak.store.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never overwrites a store written by a newer format", () => {
    const dir = tmp();
    const file = path.join(dir, "route-shapes.v1.json");
    const newer = JSON.stringify({ format: "kb-map/route-shapes", version: 99, shapes: {} });
    fs.writeFileSync(file, newer);
    const h = harness({ file });
    h.store.touchKb(pattern(), "urgent");
    h.store.flush(true);
    h.store.stop();
    assert.equal(fs.readFileSync(file, "utf-8"), newer);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an owner whose lock was taken over drops to read-only", () => {
    const dir = tmp();
    const file = path.join(dir, "route-shapes.v1.json");
    const h = harness({ file });
    assert.equal(h.store.health().read_only, false);
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid + 1, host: "elsewhere" }));
    (h.store as unknown as { heartbeat(): void }).heartbeat();
    assert.equal(h.store.health().read_only, true);
    h.store.stop();
    assert.ok(fs.existsSync(`${file}.lock`)); // the new owner's lock survives
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a live lock held by another process makes the store read-only", () => {
    const dir = tmp();
    const file = path.join(dir, "route-shapes.v1.json");
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid + 1, host: "elsewhere" }));
    const h = harness({ file });
    assert.equal(h.store.health().read_only, true);
    h.store.touchKb(pattern(), "urgent");
    assert.equal(h.store.health().queued, 0);
    h.store.flush(true);
    assert.ok(!fs.existsSync(file));
    h.store.stop();
    assert.ok(fs.existsSync(`${file}.lock`)); // not ours to remove
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
