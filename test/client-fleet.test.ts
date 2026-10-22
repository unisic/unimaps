import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { localUpdatedAt, type FleetApiResponse } from "../lib/client/fleet";

const res = (updatedAt: number, extra: Partial<FleetApiResponse> = {}): FleetApiResponse =>
  ({ stats: { updatedAt } as FleetApiResponse["stats"], count: 0, vehicles: [], ...extra });

describe("localUpdatedAt", () => {
  it("maps the server's update time onto a device clock 5 min ahead", () => {
    // updated 10 s before the body was built; the device clock runs 300 s ahead of the server
    assert.equal(localUpdatedAt(res(1000, { serverNow: 1010, receivedAt: 1310 })), 1300);
  });

  it("keeps 0 (no update yet) and falls back to the raw value without a server clock", () => {
    assert.equal(localUpdatedAt(res(0, { serverNow: 1010, receivedAt: 1310 })), 0);
    assert.equal(localUpdatedAt(res(1000)), 1000);
  });
});
