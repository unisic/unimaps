import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isZbSlug, ZB_CITIES, ZB_SLUGS, zbCityOf, type ZbCity } from "../lib/shared/cities";

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

  it("a city or line colour carries the pill's white line number at WCAG AA (4.5:1)", () => {
    const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    for (const s of ZB_SLUGS) {
      const { color, lineColors }: ZbCity = ZB_CITIES[s];
      for (const hex of [color, ...Object.values(lineColors ?? {})]) {
        if (!hex) continue;
        assert.match(hex, /^#[0-9a-f]{6}$/, s);
        const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
        assert.ok(1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05) >= 4.5, s);
      }
    }
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
