import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import * as route from "../server/api/geocode/route";

// Photon's answer to "Czeladź Sportowa" (captured 2026-10-29, trimmed): the street twice (two OSM
// ways), a place on it, plus a hit outside the GZM box
const feature = (lon: number, lat: number, properties: Record<string, string>) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties,
});
const PHOTON = {
  type: "FeatureCollection",
  features: [
    feature(19.0682041, 50.3175527, { name: "Sportowa", city: "Czeladź", type: "street" }),
    feature(19.0676975, 50.317499, { name: "Sportowa", city: "Czeladź", type: "street" }),
    feature(19.0677318, 50.3165803, { name: "Hala widowiskowo-sportowa MOSIR", street: "Sportowa", housenumber: "2", city: "Czeladź" }),
    feature(21.0, 52.2, { name: "Sportowa", city: "Warszawa" }),
    feature(19.07, 50.31, { type: "house" }),
  ],
};

const realFetch = globalThis.fetch;
let calls: string[] = [];
function stub(res: () => Response): void {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return res();
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

let ip = 0;
const get = (q: string) =>
  route.GET(new Request(`http://x/api/geocode?city=gzm&q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": `10.9.0.${++ip}` } }));

describe("GET /api/geocode", () => {
  it("lists each street once, names a place with its street, drops hits outside the city", async () => {
    stub(() => Response.json(PHOTON));
    const res = await get("Czeladź  Sportowa ");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).results, [
      { name: "Sportowa", detail: "Czeladź", lat: 50.3175527, lon: 19.0682041 },
      { name: "Hala widowiskowo-sportowa MOSIR", detail: "Sportowa 2, Czeladź", lat: 50.3165803, lon: 19.0677318 },
    ]);
    const u = new URL(calls[0]);
    assert.equal(u.searchParams.get("q"), "Czeladź Sportowa");
    assert.equal(u.searchParams.get("bbox"), "18.39,49.96,19.49,50.59");
    assert.equal(u.searchParams.get("lang"), "default");
  });

  it("answers a repeated query from memory", async () => {
    stub(() => Response.json(PHOTON));
    assert.equal((await get("czeladź sportowa")).status, 200);
    assert.equal(calls.length, 0);
  });

  it("rejects a too short query and hides upstream failures behind a 502", async () => {
    stub(() => Response.json(PHOTON));
    assert.equal((await get("ab")).status, 400);
    assert.equal(calls.length, 0);
    stub(() => new Response("boom", { status: 500 }));
    const res = await get("Katowice Mariacka");
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "Upstream request failed");
  });
});
