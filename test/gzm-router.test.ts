import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { todayLocalISO } from "../lib/config";
import { NO_DROP_OFF, NO_PICKUP } from "../lib/gtfs-csv";
import { gzmStopKey } from "../lib/gzm-feed";
import { buildRouterIndex, findConnections, stopEvents, type RouterStopInput, type TripEntry } from "../lib/router";

// GZM-only router paths (dates, pickup flags, keyed pole groups, stopEvents) on a hand-built index;
// the KB/MZK paths are pinned by router*.test.ts against the fixture feed.
const DATE = "2026-10-28";
const secs = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 3600 + m * 60;
};
const plusDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function trip(id: string, calls: Array<[string, string]>, dates: string[], flags?: number[]): TripEntry {
  return {
    tripId: id,
    serviceId: "s",
    routeId: "r",
    line: "7",
    headsign: "Koniec",
    stops: calls.map(([stopId, t], i) => ({ stopId, seq: i + 1, arr: secs(t), dep: secs(t) })),
    nums: new Int32Array(0),
    pattern: "",
    dates: new Set(dates),
    ...(flags ? { flags: Uint8Array.from(flags) } : {}),
  };
}

// a line along lat 50.25: poles ~700 m apart, so no walking between A, B, C, D
const STOPS: RouterStopInput[] = [
  { id: "gzm:a1", name: "Alfa 01", lat: 50.25, lon: 19.0 },
  { id: "gzm:a2", name: "Alfa 02", lat: 50.2503, lon: 19.0 },
  { id: "gzm:b", name: "Beta 01", lat: 50.25, lon: 19.01 },
  { id: "gzm:c", name: "Gamma 1t", lat: 50.25, lon: 19.02 },
  { id: "gzm:d", name: "Delta 01", lat: 50.25, lon: 19.03 },
  { id: "gzm:e", name: "Epsilon 01", lat: 50.25, lon: 19.04 },
].map((s) => ({ ...s, key: gzmStopKey(s.name) }));

function index(trips: TripEntry[]) {
  return buildRouterIndex({ stops: STOPS.map((s) => ({ ...s })), trips: new Map(trips.map((t) => [t.tripId, t])) });
}

const q = (from: string, to: string, afterSecs: number, date = DATE) => ({ from, to, fromIds: [from], toIds: [to], date, afterSecs });

describe("gzmStopKey", () => {
  it("drops the post number in every form the feed uses", () => {
    assert.equal(gzmStopKey("Pszczelnik Park 02"), "Pszczelnik Park");
    assert.equal(gzmStopKey("Chorzów Stadion Śląski Pętla Zach. 1t"), "Chorzów Stadion Śląski Pętla Zach.");
    assert.equal(gzmStopKey("Katowice Sądowa 1A"), "Katowice Sądowa");
    assert.equal(gzmStopKey("Urbanowice II 01"), "Urbanowice II");
  });
});

describe("router on a GZM index", () => {
  it("groups the posts of one stop, so a query from post 01 boards at post 02", () => {
    const idx = index([trip("gzm:t1", [["gzm:a2", "08:00"], ["gzm:b", "08:05"]], [DATE])]);
    assert.equal(idx.stops.get("gzm:a1")?.name, "Alfa 01");
    const res = findConnections(q("gzm:a1", "gzm:b", secs("07:00")), idx);
    assert.equal(res[0]?.legs[0].fromStopId, "gzm:a2");
    assert.equal(res[0]?.departureTime, "08:00");
  });

  it("runs a trip only on its dates; an empty date set never runs", () => {
    const idx = index([
      trip("gzm:on", [["gzm:a1", "08:00"], ["gzm:b", "08:05"]], [DATE]),
      trip("gzm:never", [["gzm:a1", "09:00"], ["gzm:b", "09:05"]], []),
    ]);
    assert.deepEqual(findConnections(q("gzm:a1", "gzm:b", 0), idx).map((c) => c.legs[0].tripId), ["gzm:on"]);
    assert.deepEqual(findConnections(q("gzm:a1", "gzm:b", 0, plusDays(DATE, 1)), idx), []);
  });

  it("never boards at a NO_PICKUP call nor alights at a NO_DROP_OFF call", () => {
    // B: drop-off only, C: pick-up only
    const idx = index([
      trip("gzm:t", [["gzm:a1", "08:00"], ["gzm:b", "08:05"], ["gzm:c", "08:10"], ["gzm:d", "08:15"]], [DATE], [0, NO_PICKUP, NO_DROP_OFF, 0]),
      trip("gzm:to-b", [["gzm:e", "07:45"], ["gzm:b", "07:55"]], [DATE]),
      trip("gzm:from-c", [["gzm:c", "08:30"], ["gzm:e", "08:40"]], [DATE]),
    ]);
    assert.equal(findConnections(q("gzm:a1", "gzm:b", 0), idx)[0]?.arrivalTime, "08:05");
    assert.deepEqual(findConnections(q("gzm:b", "gzm:d", 0), idx), []);
    assert.deepEqual(findConnections(q("gzm:a1", "gzm:c", 0), idx), []);
    assert.equal(findConnections(q("gzm:c", "gzm:d", 0), idx)[0]?.departureTime, "08:10");
    // nor as a transfer: E -> B, then t at B; t to C, then C -> E
    assert.deepEqual(findConnections(q("gzm:e", "gzm:d", 0), idx), []);
    assert.deepEqual(findConnections(q("gzm:a1", "gzm:e", 0), idx), []);
  });

  it("keeps flagged and open trips of one stop sequence in separate patterns", () => {
    const calls: Array<[string, string]> = [["gzm:a1", "08:00"], ["gzm:b", "08:05"], ["gzm:c", "08:10"]];
    const idx = index([
      trip("gzm:open", calls, [DATE]),
      trip("gzm:flagged", calls.map(([s, t]) => [s, t.replace("08", "09")]), [DATE], [0, NO_PICKUP, 0]),
    ]);
    assert.notEqual(idx.trips.get("gzm:open")?.pattern, idx.trips.get("gzm:flagged")?.pattern);
    // a first call's NO_DROP_OFF / last call's NO_PICKUP block nothing, so they don't split the pattern
    const idx2 = index([trip("gzm:o", calls, [DATE]), trip("gzm:f", calls.map(([s, t]) => [s, t.replace("08", "09")]), [DATE], [NO_DROP_OFF, 0, NO_PICKUP])]);
    assert.equal(idx2.trips.get("gzm:o")?.pattern, idx2.trips.get("gzm:f")?.pattern);
    assert.deepEqual(findConnections(q("gzm:b", "gzm:c", secs("08:30")), idx), []);
  });

  it("answers an unreachable target with nothing", () => {
    const idx = index([trip("gzm:t", [["gzm:b", "08:00"], ["gzm:a1", "08:05"]], [DATE])]);
    assert.deepEqual(findConnections(q("gzm:a1", "gzm:b", 0), idx), []);
  });

  it("searches only fallbackDays following days of a today query", () => {
    const today = todayLocalISO();
    const idx = index([trip("gzm:t", [["gzm:a1", "08:00"], ["gzm:b", "08:05"]], [plusDays(today, 2)])]);
    const query = { ...q("gzm:a1", "gzm:b", secs("23:00"), today) };
    assert.deepEqual(findConnections({ ...query, fallbackDays: 1 }, idx), []);
    const res = findConnections({ ...query, fallbackDays: 2 }, idx);
    assert.equal(res[0]?.date, plusDays(today, 2));
  });

  it("walks between poles across a grid cell boundary, not beyond 350 m", () => {
    const cell = 350 / 111320;
    const lat = Math.ceil(50.25 / cell) * cell; // a cell edge
    const idx = buildRouterIndex({
      stops: [
        { id: "gzm:p", name: "P 01", lat: lat - 0.0003, lon: 19.1 },
        { id: "gzm:q", name: "Q 01", lat: lat + 0.002, lon: 19.1 }, // ~256 m north, next cell
        { id: "gzm:r", name: "R 01", lat: lat + 0.0045, lon: 19.1 }, // ~534 m north of p
      ],
      trips: new Map(),
    });
    const p = idx.stopNum.get("gzm:p")!;
    const q2 = idx.stopNum.get("gzm:q")!;
    assert.deepEqual(idx.foot[p].map((f) => idx.stopIds[f.to]), ["gzm:q"]);
    assert.deepEqual(idx.foot[q2].map((f) => idx.stopIds[f.to]), ["gzm:p", "gzm:r"]);
  });
});

describe("stopEvents", () => {
  const idx = index([
    trip("gzm:late", [["gzm:a1", "08:20"], ["gzm:b", "08:25"]], [DATE]),
    trip("gzm:early", [["gzm:a2", "08:10"], ["gzm:b", "08:15"], ["gzm:c", "08:20"]], [DATE], [0, NO_PICKUP, 0]),
    trip("gzm:night", [["gzm:b", "25:10"], ["gzm:c", "25:20"]], [plusDays(DATE, -1)]),
    trip("gzm:out", [["gzm:a1", "12:00"], ["gzm:b", "12:05"]], [DATE]),
  ]);

  it("lists boardable calls in the window, earliest first, with the trip's service day", () => {
    const ev = stopEvents(idx, ["gzm:a1", "gzm:a2", "gzm:b"], DATE, 0, secs("10:00"));
    assert.deepEqual(
      ev.map((e) => [e.trip.tripId, e.pos, e.dep, e.serviceDate]),
      [
        ["gzm:night", 0, secs("01:10"), plusDays(DATE, -1)],
        ["gzm:early", 0, secs("08:10"), DATE],
        ["gzm:late", 0, secs("08:20"), DATE],
      ],
    );
  });

  it("skips last calls and NO_PICKUP calls, honours the limit", () => {
    assert.deepEqual(stopEvents(idx, ["gzm:b"], DATE, secs("02:00"), secs("23:00")), []);
    assert.equal(stopEvents(idx, ["gzm:a1", "gzm:a2"], DATE, 0, 86400, 2).length, 2);
    assert.deepEqual(stopEvents(idx, ["gzm:unknown"], DATE, 0, 86400), []);
  });
});
