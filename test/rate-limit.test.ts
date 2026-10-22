import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allowRequest, clientIp } from "../lib/rate-limit";

describe("allowRequest", () => {
  it("allows the per-IP burst, refuses past it and refills at the sustained rate", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    let allowed = 0;
    while (allowRequest("192.0.2.1") && allowed < 10_000) allowed += 1;
    assert.equal(allowed, 600);
    assert.equal(allowRequest("192.0.2.1"), false);
    assert.equal(allowRequest("192.0.2.2"), true, "buckets are per IP");
    t.mock.timers.tick(1000);
    for (let i = 0; i < 40; i++) assert.equal(allowRequest("192.0.2.1"), true);
    assert.equal(allowRequest("192.0.2.1"), false);
  });

  it("charges `cost` tokens at once and refuses a cost it cannot cover", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    assert.equal(allowRequest("192.0.2.3", 300), true);
    assert.equal(allowRequest("192.0.2.3", 300), true);
    assert.equal(allowRequest("192.0.2.3", 1), false);
  });
});

describe("clientIp", () => {
  it("keys on the LAST X-Forwarded-For hop (the one the proxy set)", () => {
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
    assert.equal(clientIp(req), "203.0.113.9");
    assert.equal(clientIp(new Request("http://x/")), "local");
  });
});
