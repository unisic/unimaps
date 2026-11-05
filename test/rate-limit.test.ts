import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allowRequest, allowSearch, chargeSearch, clientIp } from "../lib/rate-limit";

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

describe("allowSearch / chargeSearch", () => {
  it("spends one process-wide loop-time budget: 200 ms burst, 250 ms/s, a long search overdraws it", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_900_000_000_000 });
    assert.equal(allowSearch(), true);
    chargeSearch("192.0.2.10", 200);
    assert.equal(allowSearch(), false, "the burst is spent");
    t.mock.timers.tick(4);
    assert.equal(allowSearch(), true);
    chargeSearch("192.0.2.10", 1001);
    t.mock.timers.tick(2000);
    assert.equal(allowSearch(), false, "an overdrawn budget waits its debt out");
    t.mock.timers.tick(2000);
    assert.equal(allowSearch(), false);
    t.mock.timers.tick(4);
    assert.equal(allowSearch(), true);
  });

  it("a wall clock stepped back drains nothing", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 2_000_000_000_000 });
    assert.equal(allowSearch(), true);
    t.mock.timers.setTime(2_000_000_000_000 - 3_600_000);
    assert.equal(allowSearch(), true);
    chargeSearch("192.0.2.10", 199);
    assert.equal(allowSearch(), true);
  });

  it("charges the client's own bucket 1 token per 2.5 ms, so one IP cannot hold the whole budget", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 2_100_000_000_000 });
    assert.equal(allowRequest("192.0.2.4", 20), true);
    chargeSearch("192.0.2.4", 1450);
    assert.equal(allowRequest("192.0.2.4"), false, "580 tokens of loop time spent");
    assert.equal(allowRequest("192.0.2.5"), true, "other IPs keep their own bucket");
    chargeSearch("192.0.2.4", 250);
    t.mock.timers.tick(2000);
    assert.equal(allowRequest("192.0.2.4", 1), false, "a long search overdraws the IP: 100 tokens of debt");
    t.mock.timers.tick(1000);
    assert.equal(allowRequest("192.0.2.4", 20), true, "repaid at 40 tokens/s");
  });
});

describe("clientIp", () => {
  it("keys on the LAST X-Forwarded-For hop (the one the proxy set)", () => {
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
    assert.equal(clientIp(req), "203.0.113.9");
    assert.equal(clientIp(new Request("http://x/")), "local");
  });
});
