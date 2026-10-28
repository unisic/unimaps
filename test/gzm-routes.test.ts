/**
 * GZM routing contract: `?city=` parsing, the `gzm:` id spaces, and every route's GZM branch answered
 * from a fake GZM singleton on the synthetic feed (never the network).
 */
import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import * as connectionsRoute from "../app/api/connections/route";
import * as departuresRoute from "../app/api/stop/[designator]/departures/route";
import * as linesRoute from "../app/api/lines/route";
import * as shapesRoute from "../app/api/shapes/route";
import * as stopsRoute from "../app/api/stops/route";
import * as timetableRoute from "../app/api/stop/[designator]/timetable/route";
import * as tripExecRoute from "../app/api/trip_execution/route";
import * as tripRoute from "../app/api/trip/[tripId]/route";
import * as tripsRoute from "../app/api/trips/route";
import * as vehiclesRoute from "../app/api/vehicles/route";
import { isGzmId, isValidId, isValidShapeId, parseCity } from "../lib/api-helpers";
import { GzmLive, safeGzmHealth } from "../lib/gzm";
import type { GzmFeed } from "../lib/gzm-feed";
import { DATE, at, loadGzmFeed, rec } from "./support/gzm-fixture";

const req = (qs: string) => new Request(`http://localhost/api/vehicles${qs}`);

describe("parseCity", () => {
  it("defaults to bb so the BB paths stay unchanged", () => {
    assert.equal(parseCity(req("")), "bb");
    assert.equal(parseCity(req("?city=bb")), "bb");
  });

  it("accepts gzm while GZM is enabled", () => {
    assert.equal(parseCity(req("?city=gzm")), "gzm");
  });

  it("rejects an unknown city with a 400", () => {
    const r = parseCity(req("?city=krk"));
    assert.ok(r instanceof Response);
    assert.equal(r.status, 400);
  });
});

describe("gzm id spaces", () => {
  it("accepts real GZM stop / trip / vehicle ids", () => {
    assert.equal(isValidId("gzm:pszczelnik-park02-1irj5"), true);
    assert.equal(isValidId(`gzm:${"a".repeat(52)}`), true);
    assert.equal(isValidId("gzm:49c1791d4acf03df"), true);
    assert.equal(isValidId("gzm:283_4285"), true);
    assert.equal(isGzmId("gzm:283_4285"), true);
    assert.equal(isGzmId("mzk:13954"), false);
  });

  it("accepts gzm shape ids with an optional rev and nothing else", () => {
    assert.equal(isValidShapeId("gzm:0_428"), true);
    assert.equal(isValidShapeId("gzm:0_428.7b21c0"), true);
    assert.equal(isValidShapeId("gzm:0-428"), false);
    assert.equal(isValidShapeId("gzm:"), false);
    assert.equal(isValidShapeId("gzm:0_428.7b21c"), false);
  });
});

describe("GZM route branches", () => {
  const GZM = Symbol.for("kb-gtfs.gzm");
  const g = globalThis as Record<symbol, unknown>;
  let feed: GzmFeed | null = null;
  let live: GzmLive;
  let ip = 0;
  // a fresh client per request: the rate limiter is not under test here
  const get = (url: string, headers: Record<string, string> = {}) =>
    new Request(`http://x${url}`, { headers: { "x-forwarded-for": `10.9.0.${++ip}`, ...headers } });
  const params = <T>(v: T) => ({ params: Promise.resolve(v) });

  before(async () => {
    feed = await loadGzmFeed();
    live = new GzmLive({
      feed: () => feed,
      now: () => at("08:03") * 1000,
      url: "https://x.invalid/positions",
      sdipUrl: null,
      fetchImpl: async () => new Response(JSON.stringify({ positions: [rec({ ts: at("08:02", 40), calls: [[1, "08:05"], [2, "08:10"]], delay: 60 })] })),
    });
    // started = startGzm() is a no-op (no feed download, no upstream loop); the first poll seeds one tram
    live.start();
    await live.pollOnce();
    g[GZM] = live;
  });
  after(() => live.stop());

  it("vehicles: the prebuilt body, uncached, with the server clock; an unknown city is a 400", async () => {
    const r = await vehiclesRoute.GET(get("/api/vehicles?city=gzm"));
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(Number(r.headers.get("x-server-time")) > 0);
    const body = (await r.json()) as { vehicles: Array<{ id: string; trip_id: string; delay: number }> };
    assert.deepEqual(body.vehicles.map((v) => [v.id, v.trip_id, v.delay]), [["gzm:283_4285", "gzm:tA", 60]]);
    assert.equal((await vehiclesRoute.GET(get("/api/vehicles?city=krk"))).status, 400);
  });

  it("vehicles: gzip when the client accepts it (Next leaves route bodies uncompressed)", async () => {
    const plain = await (await vehiclesRoute.GET(get("/api/vehicles?city=gzm"))).text();
    const r = await vehiclesRoute.GET(get("/api/vehicles?city=gzm", { "accept-encoding": "gzip, deflate, br" }));
    assert.equal(r.headers.get("content-encoding"), "gzip");
    assert.equal(r.headers.get("vary"), "Accept-Encoding");
    assert.equal(gunzipSync(Buffer.from(await r.arrayBuffer())).toString(), plain);
  });

  it("stops: the feed's body with an ETag that revalidates to 304", async () => {
    const r = await stopsRoute.GET(get("/api/stops?city=gzm"));
    const body = (await r.json()) as { stops: Array<{ id: string; operator: string }> };
    assert.deepEqual(body.stops.map((x) => [x.id, x.operator]), [["gzm:a", "GZM"], ["gzm:b", "GZM"], ["gzm:c", "GZM"]]);
    const etag = r.headers.get("etag") ?? "";
    assert.ok(etag);
    assert.equal((await stopsRoute.GET(get("/api/stops?city=gzm", { "if-none-match": etag }))).status, 304);
  });

  it("lines: name, GTFS type and operator", async () => {
    const body = (await (await linesRoute.GET(get("/api/lines?city=gzm"))).json()) as { lines: Array<Record<string, string>> };
    assert.deepEqual(body.lines.map((l) => [l.name, l.type, l.operator]), [["7", "0", "GZM"]]);
  });

  it("trip and trips: static trips from the feed, an unknown id is empty, no KB fetch", async () => {
    const t = (await (await tripRoute.GET(get("/api/trip/gzm:tA"), params({ tripId: "gzm:tA" }))).json()) as {
      trip: { times: unknown[] };
      shape_id: string;
    };
    assert.equal(t.trip.times.length, 3);
    assert.match(t.shape_id, /^gzm:shA\.[0-9a-f]{6}$/);
    assert.deepEqual(await (await tripRoute.GET(get("/api/trip/gzm:nope"), params({ tripId: "gzm:nope" }))).json(), {});
    const b = (await (await tripsRoute.GET(get("/api/trips?ids=gzm:tA,gzm:nope"))).json()) as { count: number; trips: Record<string, unknown> };
    assert.deepEqual(Object.keys(b.trips), ["gzm:tA"]);
  });

  it("trip_execution: the vehicle's live trip; a malformed gzm id is a 400", async () => {
    const t = (await (await tripExecRoute.GET(get("/api/trip_execution?exec_id=gzm:283_4285"))).json()) as {
      vehicle_trip_index: number;
      trip: { times: Array<{ estimate?: { time_diff: number } }> };
    };
    assert.equal(t.vehicle_trip_index, 1);
    assert.deepEqual(t.trip.times.map((x) => x.estimate?.time_diff ?? null), [null, 60, 60]);
    assert.equal((await tripExecRoute.GET(get("/api/trip_execution?exec_id=gzm:../x"))).status, 400);
    assert.deepEqual(await (await tripExecRoute.GET(get("/api/trip_execution?exec_id=gzm:1_1"))).json(), {});
  });

  it("departures and timetable: from the feed; an unknown pole is a 404", async () => {
    const d = (await (await departuresRoute.GET(get("/api/stop/gzm:b/departures"), params({ designator: "gzm:b" }))).json()) as {
      rows: Array<{ trip_id: string; delay_sec: number | null }>;
    };
    assert.deepEqual(d.rows.map((r) => [r.trip_id, r.delay_sec]), [["gzm:tA", 60], ["gzm:tX", null], ["gzm:tB", null]]);
    assert.equal((await departuresRoute.GET(get("/api/stop/gzm:zz/departures"), params({ designator: "gzm:zz" }))).status, 404);
    const tt = (await (await timetableRoute.GET(get(`/api/stop/gzm:a/timetable?date=${DATE}`), params({ designator: "gzm:a" }))).json()) as {
      departures: Array<{ trip_id: string }>;
    };
    assert.deepEqual(tt.departures.map((x) => x.trip_id).sort(), ["gzm:tA", "gzm:tX"]);
  });

  it("shapes: feed shapes by wire id beside the store's, missing ids listed", async () => {
    const id = (feed!.shapes.wireId("gzm:shA") ?? "") as string;
    const r = await shapesRoute.GET(get(`/api/shapes?ids=${id},gzm:nope`));
    const body = (await r.json()) as { shapes: Record<string, { src: string }>; missing: string[] };
    assert.deepEqual(Object.keys(body.shapes), [id]);
    assert.equal(body.shapes[id].src, "gtfs");
    assert.deepEqual(body.missing, ["gzm:nope"]);
    assert.doesNotMatch(r.headers.get("cache-control") ?? "", /immutable/);
  });

  it("connections: searched in the GZM feed only, legs tagged GZM with their shape", async () => {
    const r = await connectionsRoute.GET(get(`/api/connections?city=gzm&from=gzm:a&to=gzm:c&date=${DATE}&time=07:50`));
    const body = (await r.json()) as { connections: Array<{ legs: Array<{ tripId: string; operator: string; shape_id?: string }> }> };
    const legs = body.connections.flatMap((c) => c.legs);
    assert.ok(legs.length > 0);
    assert.ok(legs.every((l) => l.operator === "GZM"));
    const tA = legs.find((l) => l.tripId === "gzm:tA");
    assert.match(tA?.shape_id ?? "", /^gzm:shA\./);
  });

  it("every branch answers 503 + Retry-After while the feed loads", async () => {
    const was = feed;
    feed = null;
    try {
      for (const res of [
        await stopsRoute.GET(get("/api/stops?city=gzm")),
        await linesRoute.GET(get("/api/lines?city=gzm")),
        await tripRoute.GET(get("/api/trip/gzm:tA"), params({ tripId: "gzm:tA" })),
        await departuresRoute.GET(get("/api/stop/gzm:b/departures"), params({ designator: "gzm:b" })),
        await connectionsRoute.GET(get("/api/connections?city=gzm&from=gzm:a&to=gzm:c")),
      ]) {
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("retry-after"), "10");
      }
      const trips = await tripsRoute.GET(get("/api/trips?ids=gzm:tA"));
      assert.equal(trips.headers.get("cache-control"), "no-store");
    } finally {
      feed = was;
    }
  });

  it("health block: informational counters", () => {
    const h = safeGzmHealth();
    assert.equal(h.enabled, true);
    assert.equal(h.vehicles, 1);
    assert.equal(h.matched, 1);
  });
});
