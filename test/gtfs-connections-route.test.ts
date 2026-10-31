import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GET } from "../server/api/connections/route";

// every request below should be rejected before the search; a fake, already "started" poller singleton
// makes sure a regression still cannot start real pollers or touch the network
(globalThis as Record<symbol, unknown>)[Symbol.for("kb-gtfs.poller-singleton")] = { startPromise: Promise.resolve(), shapes: {} };

const get = (qs: string, ip = "198.51.100.7"): Promise<Response> =>
  GET(new Request(`http://localhost/api/connections?${qs}`, { headers: { "x-forwarded-for": ip } }));

describe("GET /api/connections", () => {
  it("rejects a non-numeric limit or minTransfer instead of searching with NaN", async () => {
    assert.equal((await get("from=A&to=B&limit=abc")).status, 400);
    assert.equal((await get("from=A&to=B&minTransfer=abc")).status, 400);
  });

  it("is rate limited per client like the passthrough routes", async () => {
    let last = 0;
    // the per-IP burst is 600 requests; the CPU-bound search must not be callable without bound
    for (let i = 0; i < 650 && last !== 429; i++) last = (await get("to=B", "198.51.100.8")).status;
    assert.equal(last, 429);
  });
});
