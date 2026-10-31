/**
 * Whole-stop board ("Cały przystanek"): the same-name poles nearby, nearest first and capped, and the GZM board
 * of all of them with each row's post number.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nearestWithin } from "../lib/geo";
import { GzmLive } from "../lib/gzm";
import { FILES, LAT, LON, at, loadGzmFeed } from "./support/gzm-fixture";

describe("nearestWithin", () => {
  const p = (id: string, lon: number) => ({ id, lat: LAT, lon });
  it("keeps the points within the radius, nearest first, at most max", () => {
    const all = [p("far", 19.01), p("b", 19.002), p("self", 19.0), p("a", 19.001)];
    assert.deepEqual(nearestWithin(all[2], all, 600, 10).map((x) => x.id), ["self", "a", "b"]);
    assert.deepEqual(nearestWithin(all[2], all, 600, 2).map((x) => x.id), ["self", "a"]);
  });
});

describe("GzmLive whole-stop board", () => {
  // b2 "Beta 03" is ~70 m from b "Beta 01"; c renamed "Beta 02" shares the name but is ~700 m away
  const files = {
    ...FILES,
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type",
      `a,Alfa 01,${LAT},${LON.a},0`,
      `b,Beta 01,${LAT},${LON.b},0`,
      `b2,Beta 03,${LAT},${LON.b + 0.001},0`,
      `c,Beta 02,${LAT},${LON.c},0`,
    ].join("\n"),
    "trips.txt": `${FILES["trips.txt"]}\nr7,s1,tY,Beta,0,,5`,
    "stop_times.txt": `${FILES["stop_times.txt"]}\ntY,08:00:00,08:00:00,a,0\ntY,08:07:00,08:07:00,b2,1\ntY,08:09:00,08:09:00,c,2`,
  };

  it("lists one pole by default, every nearby pole with its post number with all", async () => {
    const feed = await loadGzmFeed(files);
    const live = new GzmLive({ feed: () => feed, now: () => at("08:03") * 1000, fetchImpl: async () => new Response("{}") });
    const one = live.departures("gzm:b");
    assert.ok(one && one !== "unknown");
    assert.equal(one.poles, 2, "the far same-name pole is not part of the stop");
    assert.deepEqual(one.rows.map((r) => r.trip_id), ["gzm:tA", "gzm:tX", "gzm:tB"]);
    assert.ok(one.rows.every((r) => !("pole" in r)));
    const all = live.departures("gzm:b", true);
    assert.ok(all && all !== "unknown");
    assert.equal(all.poles, 2);
    assert.deepEqual(all.rows.map((r) => [r.trip_id, r.pole]), [
      ["gzm:tA", "01"],
      ["gzm:tX", "01"],
      ["gzm:tY", "03"],
      ["gzm:tB", "01"],
    ]);
    const single = live.departures("gzm:a", true);
    assert.ok(single && single !== "unknown");
    assert.equal(single.poles, undefined, "a one-pole stop offers no whole-stop board");
  });
});
