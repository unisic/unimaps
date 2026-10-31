import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { todayLocalISO } from "../lib/config";
import { NO_DROP_OFF, NO_PICKUP } from "../lib/gtfs-csv";
import { gzmStopKey } from "../lib/shared/gzm-stop-key";
import { buildRouterIndex, callColumns, findConnections, lineTimetable, stopEvents, type RouterStopInput, type TripEntry } from "../lib/router";

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
    ...callColumns(calls.map(([stopId, t], i) => ({ stopId, seq: i + 1, arr: secs(t), dep: secs(t) })), new Map()),
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

  it("starts from a point at every pole within 800 m, departing when the rider leaves", () => {
    // the point is ~498 m (8 min) east of Alfa 01, ~213 m (4 min) west of Beta, ~925 m from Gamma
    const idx = index([
      trip("gzm:from-a", [["gzm:a1", "08:00"], ["gzm:d", "08:20"]], [DATE]),
      trip("gzm:from-b", [["gzm:b", "08:10"], ["gzm:d", "08:25"]], [DATE]),
      trip("gzm:from-c", [["gzm:c", "08:05"], ["gzm:d", "08:15"]], [DATE]),
    ]);
    const fromPoint = { lat: 50.25, lon: 19.007 };
    const res = findConnections({ from: "geo:50.25,19.007", fromPoint, to: "gzm:d", toIds: ["gzm:d"], date: DATE, afterSecs: secs("07:00") }, idx);
    assert.deepEqual(
      res.map((c) => [c.legs[0].tripId, c.departureTime, c.accessWalkMins, c.walkMinutes, c.totalDurationMins]),
      [
        ["gzm:from-a", "07:52", 8, 8, 28],
        ["gzm:from-b", "08:06", 4, 4, 19],
      ],
    );
    assert.equal(res[0].legs[0].departureTime, "08:00");
    // leaving at 07:55 is too late for the 08:00 at Alfa
    const later = findConnections({ from: "geo:50.25,19.007", fromPoint, to: "gzm:d", toIds: ["gzm:d"], date: DATE, afterSecs: secs("07:55") }, idx);
    assert.deepEqual(later.map((c) => c.legs[0].tripId), ["gzm:from-b"]);
    // a rider who walks at most 300 m reaches only Beta
    const short = findConnections({ from: "geo:50.25,19.007", fromPoint: { ...fromPoint, walkM: 300 }, to: "gzm:d", toIds: ["gzm:d"], date: DATE, afterSecs: secs("07:00") }, idx);
    assert.deepEqual(short.map((c) => c.legs[0].tripId), ["gzm:from-b"]);
    // a search from a stop carries no access walk
    assert.equal(findConnections(q("gzm:a1", "gzm:d", secs("07:00")), idx)[0]?.accessWalkMins, undefined);
  });

  it("ends at a point: every pole within 800 m, the walk from it counted into the arrival", () => {
    // the point is ~213 m (4 min) west of Delta, ~498 m (8 min) east of Gamma, ~925 m from Epsilon
    const idx = index([
      trip("gzm:to-c", [["gzm:a1", "08:00"], ["gzm:c", "08:10"]], [DATE]),
      trip("gzm:to-d", [["gzm:a1", "08:05"], ["gzm:d", "08:20"]], [DATE]),
      trip("gzm:to-e", [["gzm:a1", "08:06"], ["gzm:e", "08:12"]], [DATE]),
    ]);
    const toPoint = { lat: 50.25, lon: 19.027 };
    const res = findConnections({ ...q("gzm:a1", "geo:50.25,19.027", secs("07:00")), toPoint }, idx);
    assert.deepEqual(
      res.map((c) => [c.legs[0].tripId, c.arrivalTime, c.legs[0].arrivalTime, c.egressWalkMins, c.walkMinutes, c.totalDurationMins]),
      [
        ["gzm:to-c", "08:18", "08:10", 8, 8, 18],
        ["gzm:to-d", "08:24", "08:20", 4, 4, 19],
      ],
    );
    // a search to a stop carries no egress walk
    assert.equal(findConnections(q("gzm:a1", "gzm:d", secs("07:00")), idx)[0]?.egressWalkMins, undefined);
  });

  it("arrive-by: the latest-leaving journeys arriving by the time, the window growing back", () => {
    const idx = index(
      ["07:00", "07:30", "08:00", "08:30"].map((t, i) =>
        trip(`gzm:t${i}`, [["gzm:a1", t], ["gzm:d", t.replace(/:(\d)0$/, ":$12")]], [DATE]),
      ),
    );
    const by = (hhmm: string, limit: number) =>
      findConnections({ ...q("gzm:a1", "gzm:d", secs(hhmm)), arriveBy: true, limit }, idx).map((c) => `${c.departureTime}-${c.arrivalTime}`);
    assert.deepEqual(by("08:25", 2), ["07:30-07:32", "08:00-08:02"]);
    assert.deepEqual(by("08:02", 2), ["07:30-07:32", "08:00-08:02"]);
    assert.deepEqual(by("08:01", 5), ["07:00-07:02", "07:30-07:32"]);
    // nothing in the first 2 h before 12:00: the window grows back to the morning
    assert.deepEqual(by("12:00", 2), ["08:00-08:02", "08:30-08:32"]);
    assert.deepEqual(by("06:00", 5), []);
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

describe("lineTimetable", () => {
  it("groups the day's trips of one line by stop pattern, busiest first, each trip's times in minutes", () => {
    const other = { ...trip("gzm:x", [["gzm:a1", "07:00"], ["gzm:b", "07:05"]], [DATE]), line: "8" };
    const idx = index([
      trip("gzm:late", [["gzm:a1", "09:00"], ["gzm:b", "09:05"]], [DATE]),
      trip("gzm:early", [["gzm:a1", "08:00"], ["gzm:b", "08:04"]], [DATE]),
      trip("gzm:short", [["gzm:b", "08:30"], ["gzm:c", "08:35"]], [DATE]),
      trip("gzm:night", [["gzm:b", "23:58"], ["gzm:c", "24:03"]], [DATE]),
      trip("gzm:tomorrow", [["gzm:c", "08:00"], ["gzm:d", "08:05"]], [plusDays(DATE, 1)]),
      other,
    ]);
    const v = lineTimetable("7", "GZM", DATE, idx)!;
    assert.deepEqual(v.map((x) => x.stops.map((st) => st.name)), [["Alfa 01", "Beta 01"], ["Beta 01", "Gamma 1t"]]);
    assert.deepEqual(v[0].times, [[480, 484], [540, 545]]);
    assert.deepEqual(v[1].times, [[510, 515], [1438, 1443]]);
    assert.equal(v[0].headsign, "Koniec");
    assert.deepEqual(lineTimetable("7", "MZK", DATE, idx), []);
    assert.deepEqual(lineTimetable("7", "GZM", plusDays(DATE, 2), idx), []);
  });
});


describe("router options", () => {
  const TODAY = todayLocalISO();
  const at = (id: string, calls: Array<[string, string]>, o: Partial<TripEntry> = {}): TripEntry => ({
    ...trip(id, calls, [TODAY]),
    ...o,
  });

  it("boards a late bus that left on paper, keeps its timetable time on the wire", () => {
    const idx = index([at("gzm:t1", [["gzm:a1", "10:00"], ["gzm:b", "10:10"]]), at("gzm:t2", [["gzm:a1", "10:30"], ["gzm:b", "10:40"]])]);
    const query = q("gzm:a1", "gzm:b", secs("10:03"), TODAY);
    assert.equal(findConnections(query, idx)[0].legs[0].tripId, "gzm:t2");
    const live = findConnections({ ...query, live: (id, d) => (id === "gzm:t1" && d === TODAY ? 300 : undefined) }, idx)[0].legs[0];
    assert.equal(live.tripId, "gzm:t1");
    assert.equal(live.departureTime, "10:00");
    assert.equal(live.delaySec, 300);
  });

  it("drops a transfer the feeder's delay breaks, ignores live data on another day", () => {
    const idx = index([
      at("gzm:f", [["gzm:a1", "10:00"], ["gzm:b", "10:10"]]),
      at("gzm:n1", [["gzm:b", "10:15"], ["gzm:c", "10:25"]]),
      at("gzm:n2", [["gzm:b", "10:45"], ["gzm:c", "10:55"]]),
    ]);
    const late = (day: string) => (id: string, d: string) => (id === "gzm:f" && d === day ? 600 : undefined);
    const query = { ...q("gzm:a1", "gzm:c", secs("09:50"), TODAY), live: late(TODAY), limit: 1 };
    assert.equal(findConnections(query, idx)[0].legs[1].tripId, "gzm:n2");
    assert.equal(findConnections({ ...query, live: late(plusDays(TODAY, -1)) }, idx)[0].legs[1].tripId, "gzm:n1");
  });

  it("never rides an avoided line or route", () => {
    const idx = index([
      at("gzm:l7", [["gzm:a1", "10:00"], ["gzm:b", "10:10"]]),
      at("gzm:l8", [["gzm:a1", "10:05"], ["gzm:b", "10:15"]], { line: "8", routeId: "tram" }),
      at("gzm:l9", [["gzm:a1", "10:20"], ["gzm:b", "10:30"]], { line: "9" }),
    ]);
    const query = { ...q("gzm:a1", "gzm:b", secs("09:50"), TODAY), limit: 3 };
    assert.deepEqual(findConnections({ ...query, avoidLines: ["7"], avoidRoutes: ["tram"] }, idx).map((c) => c.legs[0].line), ["9"]);
  });

  it("puts the fewest transfers first on the transfers profile", () => {
    const idx = index([
      at("gzm:x1", [["gzm:a1", "10:00"], ["gzm:b", "10:10"]]),
      at("gzm:x2", [["gzm:b", "10:15"], ["gzm:c", "10:30"]], { line: "8" }),
      at("gzm:d1", [["gzm:a1", "10:30"], ["gzm:b", "10:40"], ["gzm:c", "11:00"]], { line: "9" }),
    ]);
    const query = { ...q("gzm:a1", "gzm:c", secs("09:50"), TODAY), limit: 2 };
    assert.deepEqual(findConnections(query, idx).map((c) => c.transfersCount), [1, 0]);
    assert.deepEqual(findConnections({ ...query, sortBy: "transfers" as const }, idx).map((c) => c.transfersCount), [0, 1]);
  });
});
