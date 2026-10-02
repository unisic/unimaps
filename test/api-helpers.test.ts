/**
 * Security pins for the passthrough-route input validators — these are the only
 * thing standing between user input and the upstream URL path/query.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidId, isValidDate, isValidShapeId } from "../lib/api-helpers";

describe("isValidId", () => {
  it("accepts real designator / trip-id shapes", () => {
    assert.equal(isValidId("19223"), true);
    assert.equal(isValidId("19132:39688"), true);
    assert.equal(isValidId("a.b_c-d"), true);
    assert.equal(isValidId("A"), true);
    assert.equal(isValidId("x".repeat(64)), true);
  });

  it("rejects empty and over-long values", () => {
    assert.equal(isValidId(""), false);
    assert.equal(isValidId("x".repeat(65)), false);
  });

  it("rejects every character that could rewrite the upstream URL", () => {
    assert.equal(isValidId("a/b"), false);
    assert.equal(isValidId("../x"), false);
    assert.equal(isValidId("a?b"), false);
    assert.equal(isValidId("a#b"), false);
    assert.equal(isValidId("a&b"), false);
    assert.equal(isValidId("a%2fb"), false);
    assert.equal(isValidId("a b"), false);
    assert.equal(isValidId("a\nb"), false);
  });
});

describe("isValidDate", () => {
  it("accepts strict YYYY-MM-DD", () => {
    assert.equal(isValidDate("2026-07-21"), true);
    assert.equal(isValidDate("1999-01-01"), true);
  });

  it("rejects everything else", () => {
    assert.equal(isValidDate("2026-7-21"), false);
    assert.equal(isValidDate("20260721"), false);
    assert.equal(isValidDate("2026-07-21T00"), false);
    assert.equal(isValidDate("2026-07-21 "), false);
    assert.equal(isValidDate(""), false);
  });
});

describe("isValidShapeId", () => {
  it("accepts kb/mzk keys with an optional rev", () => {
    assert.equal(isValidShapeId("kb:0123456789ab"), true);
    assert.equal(isValidShapeId("kb:0123456789ab.7b21c0"), true);
    assert.equal(isValidShapeId("mzk:13954"), true);
    assert.equal(isValidShapeId("mzk:13954.0c9e1f"), true);
  });

  it("rejects anything else", () => {
    assert.equal(isValidShapeId("kb:0123456789AB"), false);
    assert.equal(isValidShapeId("kb:0123"), false);
    assert.equal(isValidShapeId("mzk:abc"), false);
    assert.equal(isValidShapeId("kb:0123456789ab.7b21c"), false);
    assert.equal(isValidShapeId("kb:0123456789ab~7b21c0"), false);
    assert.equal(isValidShapeId("../etc"), false);
    assert.equal(isValidShapeId(""), false);
  });
});
