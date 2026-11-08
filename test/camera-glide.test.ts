import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { easeFly, easeSpring, flyAt, flyDip, glideSeconds } from "../lib/client/motion";

describe("camera glide timing", () => {
  it("easeSpring is cubic-bezier(0.32, 0.72, 0, 1), monotonic from 0 to 1", () => {
    assert.equal(easeSpring(0), 0);
    assert.equal(easeSpring(1), 1);
    // sample the curve parametrically and compare against the solver
    for (let i = 1; i < 100; i++) {
      const u = i / 100;
      const x = 0.96 * u * (1 - u) ** 2 + u ** 3;
      const y = 2.16 * u * (1 - u) ** 2 + 3 * u * u * (1 - u) + u ** 3;
      assert.ok(Math.abs(easeSpring(x) - y) < 1e-5, `u=${u}`);
    }
    let prev = 0;
    for (let t = 0.01; t <= 1; t += 0.01) {
      const e = easeSpring(t);
      assert.ok(e >= prev, `t=${t}`);
      prev = e;
    }
    // front-loaded like the sheet: past half way a third of the way in
    assert.ok(easeSpring(1 / 3) > 0.5);
  });

  it("easeFly is CSS ease: a gentle start, past half way at t = 0.5, settling slowly", () => {
    for (let i = 1; i < 100; i++) {
      const u = i / 100;
      const x = 0.75 * u * (1 - u) ** 2 + 0.75 * u * u * (1 - u) + u ** 3;
      const y = 0.3 * u * (1 - u) ** 2 + 3 * u * u * (1 - u) + u ** 3;
      assert.ok(Math.abs(easeFly(x) - y) < 1e-5, `u=${u}`);
    }
    assert.ok(easeFly(0.05) < 0.05 && easeFly(0.5) > 0.75 && easeFly(0.95) > 0.99);
  });

  it("the fly backs out at least a level, far enough to see both ends, and lands exactly", () => {
    assert.equal(flyDip(16, 16, 200, 900), 15);
    // 4000 px apart on a 900 px map: out until they are 450 px apart
    assert.ok(Math.abs(flyDip(16, 16, 4000, 900) - (16 - Math.log2(4000 / 450))) < 1e-9);
    assert.deepEqual(flyAt(0, 16, 17, 14), [0, 16]);
    assert.deepEqual(flyAt(1, 16, 17, 14), [1, 17]);
    assert.equal(flyAt(0.5, 16, 17, 14)[1], 14);
    // backing out leads the pan
    const [pan, z] = flyAt(0.2, 16, 16, 14);
    assert.ok(pan < 0.2 && z < 15, `pan ${pan}, zoom ${z}`);
  });

  it("glideSeconds grows with distance and zoom change, within 0.3-0.6 s", () => {
    assert.equal(glideSeconds(0, 0), 0.3);
    assert.ok(glideSeconds(1, 0) > glideSeconds(0.2, 0));
    assert.ok(glideSeconds(0.5, 3) > glideSeconds(0.5, 0));
    assert.equal(glideSeconds(0.5, -2), glideSeconds(0.5, 2));
    assert.equal(glideSeconds(10, 6), 0.6);
  });
});
