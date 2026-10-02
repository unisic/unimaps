/**
 * Server-side OSRM routing helpers. Never touches the network: routeWaypoints
 * gets a fake fetch that answers like OSRM (polyline6 geometry + legs).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chunkWaypoints,
  classifyOsrmResponse,
  implausibleLegs,
  mergeChunkGeometries,
  osrmRouteUrl,
  routeWaypoints,
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
    assert.equal(calls.length, 3);
    assert.equal(t.n, 3);
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
    assert.equal(calls.length, 2); // continue_straight + plain retry
  });

  it("an implausible leg is re-routed pair by pair and goes straight if still bad", async () => {
    // any request containing the 2nd->3rd pair reports a huge detour on that leg
    const { fetchImpl } = fakeOsrm((coords) => {
      if (coords.length < 2) return null;
      const legs = coords.slice(1).map((c, i) => {
        const d = segMeters(coords[i][0], coords[i][1], c[0], c[1]);
        return { distance: Math.abs(coords[i][1] - LON0 - 100 / KX) < 2e-6 ? d * 5 + 1000 : d };
      });
      return { status: 200, body: { code: "Ok", routes: [{ geometry: encodePolyline(coords), legs }] } };
    });
    const r = await routeWaypoints([P(0, 0), P(100, 0), P(200, 0), P(300, 0)], opts(fetchImpl, { n: 0 }));
    assert.ok(r.ok);
    assert.equal(r.straightLegs, 1);
    assert.equal(r.totalLegs, 3);
  });
});
