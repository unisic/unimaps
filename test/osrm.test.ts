/**
 * Server-side OSRM routing helpers. Never touches the network: routeWaypoints
 * gets a fake fetch that answers like OSRM (polyline6 geometry + legs).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chunkWaypoints,
  classifyOsrmResponse,
  absurdLegs,
  implausibleLegs,
  matchChunk,
  mergeChunkGeometries,
  osrmMatchBase,
  osrmMatchUrl,
  osrmRouteUrl,
  paceRequest,
  plausibleMatch,
  routeChunk,
  routeWaypoints,
  waypointBearings,
  type OsrmClientOpts,
} from "../lib/osrm";
import { encodePolyline, segMeters, type LatLng } from "../lib/shared/polyline";

const LAT0 = 49.8;
const LON0 = 19.0;
const KX = 111_320 * Math.cos(LAT0 * (Math.PI / 180));
const P = (east: number, north: number): LatLng => [LAT0 + north / 111_320, LON0 + east / KX];

/** Fake OSRM: routes straight through the requested coordinates. */
function fakeOsrm(
  behave: (coords: LatLng[], url: string) => { status: number; body: unknown; headers?: Record<string, string> } | null = () => null,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    const coords = path
      .slice(path.lastIndexOf("/") + 1)
      .split(";")
      .map((c) => {
        const [lon, lat] = c.split(",").map(Number);
        return [lat, lon] as LatLng;
      });
    const custom = behave(coords, url);
    const res = custom ?? {
      status: 200,
      body: {
        code: "Ok",
        routes: [
          {
            geometry: encodePolyline(coords),
            legs: coords.slice(1).map((c, i) => ({ distance: segMeters(coords[i][0], coords[i][1], c[0], c[1]) })),
          },
        ],
      },
    };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const opts = (fetchImpl: typeof fetch, throttled: { n: number }): OsrmClientOpts => ({
  base: "https://osrm.test/route/v1/driving",
  fetchImpl,
  throttle: async () => {
    throttled.n += 1;
  },
  userAgent: "kb-map-test",
});

describe("chunkWaypoints / mergeChunkGeometries", () => {
  it("splits into overlapping chunks of ≤12 points", () => {
    const pts = Array.from({ length: 27 }, (_, i) => P(i * 100, 0));
    const chunks = chunkWaypoints(pts);
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((c) => c.length <= 12 && c.length >= 2));
    assert.deepEqual(chunks[0][11], chunks[1][0]);
    assert.deepEqual(chunks[2][chunks[2].length - 1], pts[26]);
    assert.equal(chunkWaypoints([P(0, 0)]).length, 0);
  });

  it("merge drops the duplicated joint", () => {
    const merged = mergeChunkGeometries([
      [P(0, 0), P(1, 0)],
      [P(1, 0), P(2, 0)],
    ]);
    assert.equal(merged.length, 3);
  });

  it("url carries polyline6 and lon,lat order", () => {
    const url = osrmRouteUrl("https://x/route/v1/driving/", [P(0, 0), P(10, 0)], true);
    assert.match(url, /^https:\/\/x\/route\/v1\/driving\/19\.000000,49\.800000;/);
    assert.match(url, /geometries=polyline6/);
    assert.match(url, /continue_straight=true/);
    assert.doesNotMatch(url, /bearings=/);
    const withB = osrmRouteUrl("https://x/route/v1/driving", [P(0, 0), P(10, 0), P(20, 0)], true, [90, null, 270]);
    assert.match(withB, /&bearings=90,45;;270,45$/);
  });
});

describe("waypointBearings", () => {
  it("takes the direction from the previous to the next waypoint, none when they are too close", () => {
    assert.deepEqual(waypointBearings([P(0, 0), P(100, 0), P(100, 100)]), [90, 45, 0]);
    assert.deepEqual(waypointBearings([P(0, 0), P(10, 0)]), [null, null]);
    assert.deepEqual(waypointBearings([P(0, 0)]), [null]);
  });
});

describe("classifyOsrmResponse", () => {
  it("classifies every failure family", () => {
    assert.equal(classifyOsrmResponse(400, { code: "NoRoute" }).ok, false);
    const kind = (s: number, b: unknown, ra?: string) => {
      const r = classifyOsrmResponse(s, b, ra);
      return r.ok ? "ok" : r.kind;
    };
    assert.equal(kind(400, { code: "NoRoute" }), "unroutable");
    assert.equal(kind(400, { code: "NoSegment" }), "unroutable");
    assert.equal(kind(400, { code: "InvalidQuery" }), "config");
    assert.equal(kind(404, null), "config");
    assert.equal(kind(414, null), "config");
    assert.equal(kind(403, null), "blocked");
    assert.equal(kind(503, null), "unavailable");
    assert.equal(kind(200, null), "unavailable");
    assert.equal(kind(429, null), "ratelimited");
    const rl = classifyOsrmResponse(429, null, "120");
    assert.ok(!rl.ok && rl.retryAfterSec === 120);
  });

  it("decodes a good response", () => {
    const r = classifyOsrmResponse(200, {
      code: "Ok",
      routes: [{ geometry: encodePolyline([P(0, 0), P(100, 0)]), legs: [{ distance: 100 }] }],
    });
    assert.ok(r.ok);
    assert.equal(r.pts.length, 2);
    assert.deepEqual(r.legs, [100]);
  });
});

describe("implausibleLegs", () => {
  it("flags around-the-block legs only", () => {
    const wps = [P(0, 0), P(200, 0), P(400, 0)];
    assert.deepEqual(implausibleLegs([210, 205], wps), []);
    assert.deepEqual(implausibleLegs([900, 205], wps), [0]);
    // 2.5x but only 300 m extra — tolerated (short legs on winding roads)
    assert.deepEqual(implausibleLegs([500, 200], wps), []);
  });

  it("absurd only past 3x and +3 km: a mountain serpentine is not", () => {
    const wps = [P(0, 0), P(934, 0)];
    assert.deepEqual(absurdLegs([2422], wps), []);
    assert.deepEqual(absurdLegs([4500], wps), [0]);
    assert.deepEqual(absurdLegs([3100], [P(0, 0), P(1500, 0)]), []); // +1.6 km, 2x
  });
});

describe("routeWaypoints", () => {
  it("routes every chunk, throttling every request", async () => {
    const { fetchImpl, calls } = fakeOsrm();
    const t = { n: 0 };
    const wps = Array.from({ length: 27 }, (_, i) => P(i * 100, 0));
    const r = await routeWaypoints(wps, opts(fetchImpl, t));
    assert.ok(r.ok);
    assert.equal(r.straightLegs, 0);
    assert.equal(r.totalLegs, 26);
    assert.equal(calls.length, 6); // each chunk with and without the stop directions
    assert.equal(t.n, 6);
    assert.equal(r.pts.length, 27);
  });

  it("aborts on a hard failure (nothing to commit)", async () => {
    const { fetchImpl } = fakeOsrm(() => ({ status: 503, body: null }));
    const r = await routeWaypoints([P(0, 0), P(100, 0)], opts(fetchImpl, { n: 0 }));
    assert.ok(!r.ok && r.kind === "unavailable");
  });

  it("unroutable chunks degrade to straight lines", async () => {
    const { fetchImpl, calls } = fakeOsrm(() => ({ status: 400, body: { code: "NoRoute" } }));
    const r = await routeWaypoints([P(0, 0), P(100, 0), P(200, 0)], opts(fetchImpl, { n: 0 }));
    assert.ok(r.ok);
    assert.equal(r.straightLegs, 2);
    // continue_straight, bearings, plain: for the chunk, then for each of its two pairs
    assert.equal(calls.length, 9);
  });

  it("one unroutable stop costs its own two legs, not the whole chunk", async () => {
    const bad = P(200, 0);
    const { fetchImpl } = fakeOsrm((coords) =>
      coords.some((c) => Math.abs(c[1] - bad[1]) < 2e-6) ? { status: 400, body: { code: "NoSegment" } } : null,
    );
    const r = await routeWaypoints(
      Array.from({ length: 6 }, (_, i) => P(i * 100, 0)),
      opts(fetchImpl, { n: 0 }),
    );
    assert.ok(r.ok);
    assert.equal(r.straightLegs, 2);
    assert.equal(r.totalLegs, 5);
  });

  /** Fake OSRM where the 2nd->3rd leg is `detour(straight)` long unless `fixed(url)` says otherwise. */
  const detourOsrm = (detour: (d: number) => number, fixed: (url: string) => boolean = () => false) =>
    fakeOsrm((coords, url) => {
      const legs = coords.slice(1).map((c, i) => {
        const d = segMeters(coords[i][0], coords[i][1], c[0], c[1]);
        const hit = Math.abs(coords[i][1] - LON0 - 100 / KX) < 2e-6 && !fixed(url);
        return { distance: hit ? detour(d) : d };
      });
      return { status: 200, body: { code: "Ok", routes: [{ geometry: encodePolyline(coords), legs }] } };
    });

  it("an absurd leg is re-routed pair by pair and goes straight if still bad", async () => {
    const { fetchImpl } = detourOsrm((d) => d * 5 + 5000);
    const r = await routeWaypoints([P(0, 0), P(100, 0), P(200, 0), P(300, 0)], opts(fetchImpl, { n: 0 }));
    assert.ok(r.ok);
    assert.equal(r.straightLegs, 1);
    assert.equal(r.totalLegs, 3);
  });

  it("a long but bounded detour stays on the road (a serpentine, a one-way loop)", async () => {
    const { fetchImpl, calls } = detourOsrm((d) => d * 5 + 1000);
    const r = await routeWaypoints([P(0, 0), P(100, 0), P(200, 0), P(300, 0)], opts(fetchImpl, { n: 0 }));
    assert.ok(r.ok);
    assert.equal(r.straightLegs, 0);
    assert.equal(calls.length, 3); // every way of asking tried once, the shortest kept
  });

  it("the stop directions settle a wrong-carriageway detour", async () => {
    const { fetchImpl, calls } = detourOsrm(
      (d) => d * 5 + 1000,
      (url) => url.includes("bearings="),
    );
    const r = await routeWaypoints([P(0, 0), P(100, 0), P(200, 0), P(300, 0)], opts(fetchImpl, { n: 0 }));
    assert.ok(r.ok);
    assert.equal(r.straightLegs, 0);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /&bearings=90,45;90,45;90,45;90,45/);
  });

  it("a plausible answer still loses to a shorter one with the stop directions (a side-street snap)", async () => {
    const { fetchImpl, calls } = detourOsrm((d) => d + 150, (url) => url.includes("bearings="));
    const wps = [P(0, 0), P(100, 0), P(200, 0), P(300, 0)];
    const r = await routeChunk(wps, opts(fetchImpl, { n: 0 }), waypointBearings(wps));
    assert.ok(r.ok);
    assert.deepEqual(r.legs.map(Math.round), [100, 100, 100]);
    assert.equal(calls.length, 2);
  });

  it("a shorter answer that snaps a stop far off its pole loses (a stop on a bend)", async () => {
    const { fetchImpl } = fakeOsrm((coords, url) => {
      const br = url.includes("bearings=");
      const legs = coords.slice(1).map((c, i) => ({
        distance: segMeters(coords[i][0], coords[i][1], c[0], c[1]) - (br && i === 1 ? 40 : 0),
      }));
      const waypoints = coords.map((_, i) => ({ distance: br && i === 2 ? 59 : 3 }));
      return { status: 200, body: { code: "Ok", routes: [{ geometry: encodePolyline(coords), legs }], waypoints } };
    });
    const wps = [P(0, 0), P(100, 0), P(200, 0), P(300, 0)];
    const r = await routeChunk(wps, opts(fetchImpl, { n: 0 }), waypointBearings(wps));
    assert.ok(r.ok);
    assert.deepEqual(r.legs.map(Math.round), [100, 100, 100]);
  });
});

describe("OSRM map matching", () => {
  const trace = Array.from({ length: 25 }, (_, i) => P(i * 100, (i % 2) * 8));
  const matchOpts = (fetchImpl: typeof fetch): OsrmClientOpts => ({ ...opts(fetchImpl, { n: 0 }), base: "https://osrm.test/match/v1/driving" });
  /** answers like /match: the chunk snapped onto the y = 0 road */
  const snapped = (coords: LatLng[]) => {
    const road = coords.map(([, lon]): LatLng => [LAT0, lon]);
    return {
      status: 200,
      body: {
        code: "Ok",
        matchings: [{ geometry: encodePolyline(road), legs: road.slice(1).map(() => ({ distance: 100 })) }],
      },
    };
  };

  it("match base and url: /route/ becomes /match/, one radius per point", () => {
    assert.equal(osrmMatchBase("https://router.project-osrm.org/route/v1/driving"), "https://router.project-osrm.org/match/v1/driving");
    assert.equal(osrmMatchBase("https://osrm.example/v1/driving"), null);
    const url = new URL(osrmMatchUrl("https://osrm.test/match/v1/driving/", [P(0, 0), P(100, 0)]));
    assert.equal(url.pathname.split("/").at(-1)!.split(";").length, 2);
    assert.equal(url.searchParams.get("radiuses"), "25;25");
    assert.equal(url.searchParams.get("gaps"), "ignore");
  });

  it("plausibleMatch rejects a detour around the block and a far-off match", () => {
    const line = [P(0, 0), P(500, 0)];
    assert.equal(plausibleMatch([P(0, 5), P(500, 5)], line), true);
    assert.equal(plausibleMatch([P(0, 0), P(0, 55), P(250, 55), P(250, -55), P(500, -55), P(500, 0)], line), false);
    assert.equal(plausibleMatch([P(0, 80), P(500, 80)], line), false);
  });

  it("snaps a chunk onto the road; chunks of `size` share a point", async () => {
    const chunks = chunkWaypoints(trace, 10);
    assert.ok(chunks.every((c) => c.length <= 10));
    assert.deepEqual(chunks[1][0], chunks[0].at(-1));
    const { fetchImpl, calls } = fakeOsrm(snapped);
    const r = await matchChunk(chunks[0], matchOpts(fetchImpl));
    assert.ok(r.ok);
    assert.equal(r.kept, false);
    assert.equal(calls.length, 1);
    assert.ok(r.pts.every((p) => Math.abs(p[0] - LAT0) < 1e-9));
    assert.deepEqual(r.pts[0], [LAT0, trace[0][1]]);
  });

  it("a chunk matched implausibly or in pieces keeps its own points", async () => {
    const chunk = chunkWaypoints(trace, 10)[0];
    const far = fakeOsrm((coords) => ({ status: 200, body: { code: "Ok", matchings: [{ geometry: encodePolyline(coords.map(([, lon]): LatLng => [LAT0 + 0.01, lon])), legs: coords.slice(1).map(() => ({ distance: 100 })) }] } }));
    const none = fakeOsrm(() => ({ status: 200, body: { code: "NoMatch", message: "no match" } }));
    for (const { fetchImpl } of [far, none]) {
      const r = await matchChunk(chunk, matchOpts(fetchImpl));
      assert.ok(r.ok);
      assert.equal(r.kept, true);
      assert.deepEqual(r.pts, chunk, "a kept chunk keeps the trace's own zigzag");
    }
  });

  it("a hard failure is reported, not kept", async () => {
    const { fetchImpl, calls } = fakeOsrm(() => ({ status: 429, body: { message: "slow down" }, headers: { "retry-after": "30" } }));
    const r = await matchChunk(chunkWaypoints(trace, 10)[0], matchOpts(fetchImpl));
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1);
    if (!r.ok) assert.equal(r.kind, "ratelimited");
  });

  it("paceRequest spaces callers that share one pace", async () => {
    const pace = { nextSlot: 0 };
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    await paceRequest(pace, 1000, 5000, sleep);
    await paceRequest(pace, 1000, 5200, sleep);
    await paceRequest(pace, 1000, 9000, sleep);
    assert.deepEqual(slept, [800]);
    assert.equal(pace.nextSlot, 10_000);
  });
});
