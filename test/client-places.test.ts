import assert from "node:assert/strict";
import { describe, it } from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  },
});
store.set("kb:places", JSON.stringify({ home: { lat: "x" }, work: { designator: "123" }, routes: [{ to: 1 }, { from: { designator: "1" }, to: "2" }] }));
store.set("kb:places:gzm", "{not json");

// imported after the window stub: the store reads localStorage on first use
const places = () => import("../lib/client/places");
const read = (city: "bb" | "gzm") => JSON.parse(store.get(city === "gzm" ? "kb:places:gzm" : "kb:places") ?? "{}");

describe("places store", () => {
  it("drops what does not parse as a place, keeps the rest (an old string destination as a stop); a broken city key reads empty", async () => {
    const { setPlace } = await places();
    setPlace("bb", "home", { lat: 50, lon: 19, label: "Dom" });
    assert.deepEqual(read("bb"), {
      work: { designator: "123" },
      routes: [{ from: { designator: "1" }, to: { designator: "2" } }],
      home: { lat: 50, lon: 19, label: "Dom" },
    });
    setPlace("gzm", "work", { designator: "gzm:1" });
    assert.deepEqual(read("gzm"), { routes: [], work: { designator: "gzm:1" } });
  });

  it("toggles a route, newest first, at most 10", async () => {
    const { hasRoute, toggleRoute } = await places();
    for (let i = 0; i < 12; i++) toggleRoute("gzm", { from: { designator: `f${i}` }, to: { designator: "t" } });
    const routes = read("gzm").routes as { from: { designator: string } }[];
    assert.equal(routes.length, 10);
    assert.equal(routes[0].from.designator, "f11");
    toggleRoute("gzm", { from: { designator: "f11" }, to: { designator: "t" } });
    assert.equal(hasRoute(read("gzm"), { from: { designator: "f11" }, to: { designator: "t" } }), false);
    assert.equal(read("gzm").routes.length, 9);
  });
});
