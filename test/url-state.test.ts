import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSearch, parseUrlState } from "../lib/client/urlState";

describe("parseUrlState", () => {
  it("reads stop/exec/trip/map", () => {
    const s = parseUrlState("?stop=19132%3A39688&exec=1:2&map=49.82196,19.04575,13");
    assert.equal(s.stop, "19132:39688");
    assert.equal(s.exec, "1:2");
    assert.equal(s.trip, null);
    assert.deepEqual(s.map, { lat: 49.82196, lon: 19.04575, zoom: 13 });
  });

  it("drops invalid parts without failing the rest", () => {
    const s = parseUrlState(`?stop=${"x".repeat(65)}&map=999,19,13&trip=42`);
    assert.equal(s.stop, null);
    assert.equal(s.map, null);
    assert.equal(s.trip, "42");
  });

  it("rejects out-of-range zoom", () => {
    assert.equal(parseUrlState("?map=49.8,19.0,25").map, null);
    assert.equal(parseUrlState("?map=49.8,19.0,2").map, null);
  });

  it("empty search -> all nulls", () => {
    assert.deepEqual(parseUrlState(""), { stop: null, exec: null, trip: null, map: null });
  });
});

describe("buildSearch", () => {
  it("round-trips through parseUrlState", () => {
    const s = {
      stop: "19132:39688",
      exec: "19132:39688",
      trip: null,
      map: { lat: 49.82196, lon: 19.04575, zoom: 13 },
    };
    assert.deepEqual(parseUrlState(buildSearch(s)), s);
  });

  it("exec wins over trip; empty state -> empty string", () => {
    assert.match(buildSearch({ stop: null, exec: "e", trip: "t", map: null }), /exec=e/);
    assert.doesNotMatch(buildSearch({ stop: null, exec: "e", trip: "t", map: null }), /trip=/);
    assert.equal(buildSearch({ stop: null, exec: null, trip: null, map: null }), "");
  });
});
