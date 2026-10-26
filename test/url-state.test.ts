import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSearch, loadSavedLines, parseUrlState, saveLines } from "../lib/client/urlState";

describe("parseUrlState", () => {
  it("reads stop/exec/trip/lines/map", () => {
    const s = parseUrlState("?stop=19132%3A39688&exec=1:2&lines=104,120&map=49.82196,19.04575,13");
    assert.equal(s.stop, "19132:39688");
    assert.equal(s.exec, "1:2");
    assert.equal(s.trip, null);
    assert.deepEqual(s.lines, ["104", "120"]);
    assert.deepEqual(s.map, { lat: 49.82196, lon: 19.04575, zoom: 13 });
  });

  it("drops invalid parts without failing the rest", () => {
    const s = parseUrlState(`?stop=${"x".repeat(65)}&lines=104,zł+a,${"y".repeat(9)}&map=999,19,13&trip=42`);
    assert.equal(s.stop, null);
    assert.deepEqual(s.lines, ["104"]);
    assert.equal(s.map, null);
    assert.equal(s.trip, "42");
  });

  it("rejects out-of-range zoom and caps lines at 10", () => {
    assert.equal(parseUrlState("?map=49.8,19.0,25").map, null);
    assert.equal(parseUrlState("?map=49.8,19.0,2").map, null);
    const many = Array.from({ length: 15 }, (_, i) => `L${i}`).join(",");
    assert.equal(parseUrlState(`?lines=${many}`).lines?.length, 10);
  });

  it("empty search -> all nulls", () => {
    assert.deepEqual(parseUrlState(""), { stop: null, exec: null, trip: null, lines: null, map: null });
  });
});

describe("buildSearch", () => {
  it("round-trips through parseUrlState", () => {
    const s = {
      stop: "19132:39688",
      exec: "19132:39688",
      trip: null,
      lines: ["104"],
      map: { lat: 49.82196, lon: 19.04575, zoom: 13 },
    };
    assert.deepEqual(parseUrlState(buildSearch(s)), s);
  });

  it("exec wins over trip; empty state -> empty string", () => {
    assert.match(buildSearch({ stop: null, exec: "e", trip: "t", lines: null, map: null }), /exec=e/);
    assert.doesNotMatch(buildSearch({ stop: null, exec: "e", trip: "t", lines: null, map: null }), /trip=/);
    assert.equal(buildSearch({ stop: null, exec: null, trip: null, lines: null, map: null }), "");
  });
});

describe("saved line filter", () => {
  it("round-trips through localStorage, sanitized and capped; empty clears", () => {
    const store = new Map<string, string>();
    const g = globalThis as { window?: unknown };
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    try {
      assert.equal(loadSavedLines(), null);
      saveLines(["104", "120"]);
      assert.deepEqual(loadSavedLines(), ["104", "120"]);
      store.set("kb:lineFilter", `104,zł a,${Array.from({ length: 12 }, (_, i) => i).join(",")}`);
      assert.equal(loadSavedLines()?.length, 10);
      assert.equal(loadSavedLines()?.[0], "104");
      saveLines(null);
      assert.equal(store.has("kb:lineFilter"), false);
    } finally {
      delete g.window;
    }
  });

  it("forgets quietly when storage throws", () => {
    const g = globalThis as { window?: unknown };
    g.window = {};
    try {
      assert.equal(loadSavedLines(), null);
      saveLines(["104"]);
    } finally {
      delete g.window;
    }
  });
});
