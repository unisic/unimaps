import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { walkRoute, walkRouteNow } from "../lib/client/api";
import type { LatLng } from "../lib/client/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

it("walks the footpath between the poles, one router request a second, each path once", async () => {
  const sent: number[] = [];
  globalThis.fetch = (async () => {
    sent.push(Date.now());
    const coordinates = [
      [19.0182, 50.2578],
      [19.019, 50.2572],
    ];
    return new Response(JSON.stringify({ routes: [{ geometry: { coordinates } }] }));
  }) as typeof fetch;
  const a: LatLng = [50.2577, 19.0185];
  const b: LatLng = [50.2585, 19.0205];
  const c: LatLng = [50.26, 19.03];
  assert.equal(walkRouteNow(a, b), undefined);
  const [ab, again, bc] = await Promise.all([walkRoute(a, b), walkRoute(a, b), walkRoute(b, c)]);
  assert.deepEqual(ab, [a, [50.2578, 19.0182], [50.2572, 19.019], b]);
  assert.equal(again, ab);
  assert.deepEqual(bc?.at(-1), c);
  assert.equal(walkRouteNow(a, b), ab);
  assert.equal(sent.length, 2);
  assert.ok(sent[1] - sent[0] >= 990, `${sent[1] - sent[0]} ms apart`);
});

it("a failed request keeps no path and asks again next time", async () => {
  globalThis.fetch = (async () => new Response("", { status: 502 })) as typeof fetch;
  const a: LatLng = [50.1, 19.1];
  const b: LatLng = [50.2, 19.2];
  assert.equal(await walkRoute(a, b), null);
  assert.equal(walkRouteNow(a, b), undefined);
  globalThis.fetch = (async () => new Response(JSON.stringify({ routes: [{ geometry: { coordinates: [[19.1, 50.1], [19.2, 50.2]] } }] }))) as typeof fetch;
  assert.equal((await walkRoute(a, b))?.length, 4);
});
