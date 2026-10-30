import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isZbSlug, ZB_CITIES, ZB_SLUGS, zbCityOf } from "../lib/shared/cities";

describe("zbiorkom city registry", () => {
  it("every slug is a safe path segment with a name, agency, a Polish centre and a sane zoom", () => {
    assert.ok(ZB_SLUGS.length >= 50);
    assert.ok(ZB_SLUGS.includes("gzm"));
    for (const s of ZB_SLUGS) {
      const c = ZB_CITIES[s];
      assert.match(s, /^[a-zA-Z]+$/, s);
      assert.ok(c.name && c.agency, s);
      assert.ok(c.center[0] > 49 && c.center[0] < 55 && c.center[1] > 14 && c.center[1] < 24.2, s);
      assert.ok(c.zoom >= 9 && c.zoom <= 14, s);
    }
    assert.equal(new Set(ZB_SLUGS).size, ZB_SLUGS.length);
  });

  it("isZbSlug: own slugs only, never inherited properties", () => {
    assert.equal(isZbSlug("warsaw"), true);
    assert.equal(isZbSlug("bb"), false);
    assert.equal(isZbSlug("constructor"), false);
    assert.equal(isZbSlug("__proto__"), false);
    assert.equal(isZbSlug(null), false);
  });

  it("zbCityOf: the prefix before the first ':' when it is a slug", () => {
    assert.equal(zbCityOf("gzm:283_4285"), "gzm");
    assert.equal(zbCityOf("warsaw:3_1234"), "warsaw");
    assert.equal(zbCityOf("lodz:trip:with:colons"), "lodz");
    assert.equal(zbCityOf("mzk:13954"), null);
    assert.equal(zbCityOf("kb:0123"), null);
    assert.equal(zbCityOf("warsaw"), null);
    assert.equal(zbCityOf(42), null);
    assert.equal(zbCityOf(null), null);
  });
});
