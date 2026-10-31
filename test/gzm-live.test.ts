/**
 * GZM live layer on a synthetic feed: zbiorkom record parsing, the trip join (all pairs, brigade tie-break),
 * layover onto the brigade's next trip, not-started, prune, fix_at on the record clock, staleness, the board,
 * and the SDIP position overlay (session, dating, newest fix wins, watch gate).
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { GzmLive, matchTrip, nextPollDelay, parseSdip, parseZbiorkom, schedulePosition, zbKey } from "../lib/gzm";
import type { GzmFeed } from "../lib/gzm-feed";
import type { GzmFleetSource } from "../lib/gzm-fleet";
import type { VehicleJson, VehiclesResponse } from "../lib/types";
import { DATE, FILES, LAT, LON, at, loadGzmFeed, rec, type RecOpts } from "./support/gzm-fixture";

let feed: GzmFeed;
before(async () => {
  feed = await loadGzmFeed();
});

/** A GzmLive whose upstream answers `body()` and whose clock is `clock.ms`. */
function rig(feedOf: () => GzmFeed | null = () => feed, slug?: string) {
  const clock = { ms: at("08:03") * 1000 };
  let positions: unknown[] = [];
  const live = new GzmLive({
    slug,
    feed: feedOf,
    now: () => clock.ms,
    url: "https://x.invalid/positions",
    fetchImpl: async () => new Response(JSON.stringify({ positions })),
  });
  const poll = async (nowS: number, list: unknown[]): Promise<VehiclesResponse> => {
    clock.ms = nowS * 1000;
    positions = list;
    assert.equal(await live.pollOnce(), true);
    return JSON.parse(live.vehiclesBody()) as VehiclesResponse;
  };
  return { live, clock, poll };
}
const only = (r: VehiclesResponse): VehicleJson => {
  assert.equal(r.vehicles.length, 1);
  return r.vehicles[0];
};

describe("parseZbiorkom", () => {
  const now = at("08:03") * 1000;
  it("keeps valid records keyed by <op>_<fleet>, the newest per key", () => {
    const recs = parseZbiorkom(
      {
        positions: [
          rec({ ts: at("08:02"), calls: [[1, "08:05"]] }),
          rec({ ts: at("08:02", 40), calls: [[1, "08:05"]], delay: 30 }),
          { ...rec({ ts: at("08:02"), calls: [] }), url: "https://x.invalid/gzm/vehicle/bogus" },
          rec({ key: "1_1", ts: at("08:02"), calls: [], lat: 0, lon: 0 }),
          rec({ key: "1_2", ts: at("07:50"), calls: [] }),
          { ...rec({ key: "1_3", ts: at("08:02"), calls: [[2, "08:10"], [1, "08:05"]] }), bearing: -90 },
        ],
      },
      now,
    );
    assert.deepEqual(recs.map((r) => [r.key, r.delayMs]), [["283_4285", 30000], ["1_3", 0]]);
    assert.equal(recs[0].label, "4285");
    assert.deepEqual(recs[1].upcoming.map((u) => u.seq), [1, 2]);
    assert.equal(recs[1].bearing, 270);
  });

  it("keys another city's vehicles by type, agency and id: two operators' bus 101 stay two vehicles", () => {
    assert.equal(zbKey({ type: "3", id: "36146", agency: "default" }), "3_36146");
    assert.equal(zbKey({ type: "3", id: "101", agency: "MINSK" }), "3_MINSK_101");
    assert.equal(zbKey({ type: "3", id: "101", agency: "GPA" }), "3_GPA_101");
    assert.equal(zbKey({ type: "3", id: "04 ", agency: "OTWOCK" }), "3_OTWOCK_04_");
    assert.equal(zbKey({ type: "0", id: "2369" }), "0_2369");
    assert.equal(zbKey({ type: "3", id: "", agency: "MINSK" }), undefined);
  });

  it("marks another operator's vehicle with its agency in a zbiorkom city, never in GZM", () => {
    const own = rec({ ts: at("08:02"), calls: [] });
    const otwock = { ...own, vehicle: { ...own.vehicle, id: "03", type: "3", agency: "OTWOCK" } };
    const [a, b] = parseZbiorkom({ positions: [own, otwock] }, now, undefined, true);
    assert.deepEqual([a.key, a.agency, b.key, b.agency], ["0_4285", null, "3_OTWOCK_03", "OTWOCK"]);
    const gzm = { ...otwock, url: own.url.replace("283_4285", "1_1") };
    assert.equal(parseZbiorkom({ positions: [gzm] }, now)[0].agency, null);
  });

  it("throws on a body without a positions array", () => {
    assert.throws(() => parseZbiorkom({ vehicles: [] }, now));
  });
});

describe("matchTrip", () => {
  const days = [{ date: DATE, base: at("00:00") }];
  const one = (o: RecOpts) => parseZbiorkom({ positions: [rec(o)] }, (o.ts + 1) * 1000)[0];
  it("needs every (sequence, departure) pair; the brigade breaks a tie", () => {
    assert.equal(matchTrip(feed, one({ ts: at("08:02"), calls: [[1, "08:05"], [2, "08:10"]] }), days)?.trip.tripId, "gzm:tA");
    assert.equal(matchTrip(feed, one({ ts: at("08:02"), calls: [[1, "08:05"], [2, "08:11"]] }), days), null);
    assert.equal(matchTrip(feed, one({ ts: at("07:58"), calls: [[0, "08:00"]], brigade: "4" }), days)?.trip.tripId, "gzm:tX");
    assert.equal(matchTrip(feed, one({ ts: at("07:58"), calls: [[0, "08:00"]], brigade: "9" }), days), null);
    assert.equal(matchTrip(feed, one({ ts: at("08:02"), calls: [[1, "08:05"]], line: "8" }), days), null);
  });

  it("joins calls timed a few seconds off the feed only when no trip fits exactly", () => {
    const r = one({ ts: at("08:02"), calls: [[1, "08:05"], [2, "08:10"]] });
    const late = (s: number) => ({ ...r, upcoming: r.upcoming.map((c) => ({ ...c, dep: c.dep + s })) });
    assert.equal(matchTrip(feed, late(5), days)?.trip.tripId, "gzm:tA");
    assert.equal(matchTrip(feed, late(45), days), null);
  });
});

describe("GzmLive", () => {
  it("joins a running vehicle: trip, delay in seconds, stop indices, shape", async () => {
    const { poll } = rig();
    const v = only(await poll(at("08:03"), [rec({ ts: at("08:02", 40), calls: [[1, "08:05"], [2, "08:10"]], delay: 60, lon: 19.005 })]));
    assert.equal(v.id, "gzm:283_4285");
    assert.equal(v.trip_id, "gzm:tA");
    assert.equal(v.sched_trip_id, "gzm:tA");
    assert.equal(v.operator, "GZM");
    assert.equal(v.vehicle_type, 0);
    assert.equal(v.delay, 60);
    assert.equal(v.side_number, "4285");
    assert.equal(v.current_stop_sequence, 0);
    assert.equal(v.next_stop_seq, 1);
    assert.equal(v.next_stop_name, "Beta 01");
    assert.equal(v.at_stop, false);
    assert.match(v.shape ?? "", /^gzm:shA\.[0-9a-f]{6}$/);
    assert.ok(v.dist_m !== undefined && v.dist_m > 300 && v.dist_m < 420, `dist_m ${v.dist_m}`);
  });

  it("an unmatched vehicle keeps its position with no trip and no delay", async () => {
    const { poll } = rig();
    const v = only(await poll(at("08:03"), [rec({ ts: at("08:02", 40), calls: [[1, "08:07"]], delay: 60 })]));
    assert.equal(v.trip_id, "");
    assert.equal(v.delay, null);
    assert.equal(v.next_stop_name, null);
  });

  it("feeds the fleet only the vehicles on a trip, and nothing while the feed loads", async () => {
    const got: GzmFleetSource[][] = [];
    let loaded: GzmFeed | null = null;
    const positions = [
      rec({ ts: at("08:02", 40), calls: [[1, "08:05"], [2, "08:10"]], delay: 60, lon: 19.005 }),
      rec({ key: "108_3", ts: at("08:02", 40), calls: [[1, "08:07"]] }),
    ];
    const live = new GzmLive({
      feed: () => loaded,
      now: () => at("08:03") * 1000,
      url: "https://x.invalid/positions",
      fetchImpl: async () => new Response(JSON.stringify({ positions })),
      fleet: (s) => got.push(s),
    });
    assert.equal(await live.pollOnce(), true);
    assert.equal(got.length, 0, "no trips yet: an empty list would close every running course");
    loaded = feed;
    assert.equal(await live.pollOnce(), true);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].map((s) => s.side), ["283_4285"]);
    const s = got[0][0];
    assert.equal(s.label, "4285");
    assert.equal(s.tripId, "tA");
    assert.equal(s.brigade, "3");
    assert.equal(s.delaySec, 60);
    assert.equal(s.notStarted, false);
    assert.deepEqual([s.servedIdx, s.nextIdx], [0, 1]);
    assert.deepEqual(
      s.stops.map((x) => [x.id, x.name, x.dep]),
      [["gzm:a", "Alfa 01", at("08:00") - at("00:00")], ["gzm:b", "Beta 01", at("08:05") - at("00:00")], ["gzm:c", "Gamma 01", at("08:10") - at("00:00")]],
    );
    const d = s.stops.map((x) => x.distM);
    assert.ok(d.every((m) => m !== null) && d[0]! < d[1]! && d[1]! < d[2]!, `distM ${d}`);
    assert.deepEqual(s.nextTrip, { line: "7", headsign: "Alfa", firstStopName: "Gamma 01", firstStopId: "gzm:c", dep: at("08:20") - at("00:00") });
  });

  it("a vehicle at its first stop before departure is not_started with no delay", async () => {
    const { poll } = rig();
    const v = only(await poll(at("07:58"), [rec({ ts: at("07:57", 40), calls: [[0, "08:00"]], brigade: "4", lon: LON.a })]));
    assert.equal(v.trip_id, "gzm:tX");
    assert.equal(v.not_started, true);
    assert.equal(v.delay, null);
    assert.equal(v.at_stop, true);
  });

  it("a bus driving to its first stop off the route is not_started; one on the route past it has begun", async () => {
    const { poll } = rig();
    const call = { ts: at("07:59", 40), calls: [[0, "08:00"]] as Array<[number, string]>, brigade: "3" };
    const depot = only(await poll(at("08:00"), [rec({ ...call, lat: LAT + 0.01, lon: LON.a + 0.005 })]));
    assert.deepEqual([depot.trip_id, depot.not_started, depot.delay], ["gzm:tA", true, null]);
    const lagging = only(await poll(at("08:00", 20), [rec({ ...call, ts: at("08:00"), lon: LON.a + 0.007 })]));
    assert.equal(lagging.not_started, undefined);
  });

  it("lays over onto the brigade's next trip once the last stop is behind, then hands over", async () => {
    const { poll } = rig();
    // last stop c was due 08:10 + 0 s; at 08:13 the vehicle stands at c, listed on tA with a frozen delay
    let v = only(await poll(at("08:13"), [rec({ ts: at("08:12", 40), calls: [[2, "08:10"]], lon: LON.c })]));
    assert.equal(v.trip_id, "gzm:tB");
    assert.equal(v.not_started, true);
    assert.equal(v.delay, null);
    assert.equal(v.next_stop_name, "Gamma 01");
    // the same vehicle with no upcoming calls stays on the cached trip's successor
    v = only(await poll(at("08:14"), [rec({ ts: at("08:13", 40), calls: [], lon: LON.c })]));
    assert.equal(v.trip_id, "gzm:tB");
    // zbiorkom moves it to tB: a direct match, now running
    v = only(await poll(at("08:22"), [rec({ ts: at("08:21", 40), calls: [[1, "08:25"], [2, "08:30"]], delay: 90, lon: 19.015 })]));
    assert.equal(v.trip_id, "gzm:tB");
    assert.equal(v.not_started, undefined);
    assert.equal(v.delay, 90);
  });

  it("still en route to the last stop is no layover (eta = schedule + delay)", async () => {
    const { poll } = rig();
    const v = only(await poll(at("08:13"), [rec({ ts: at("08:12", 40), calls: [[2, "08:10"]], delay: 240, lon: 19.018 })]));
    assert.equal(v.trip_id, "gzm:tA");
    assert.equal(v.delay, 240);
  });

  it("standing at the last stop ends the trip even while zbiorkom's delay grows with the clock", async () => {
    const { poll } = rig();
    // eta = 08:10 + 160 s = the snapshot time: the eta rule alone would keep the vehicle on tA
    const v = only(await poll(at("08:13"), [rec({ ts: at("08:12", 40), calls: [[2, "08:10"]], delay: 160, lon: LON.c })]));
    assert.equal(v.trip_id, "gzm:tB");
    assert.equal(v.not_started, true);
  });

  it("a trip zbiorkom never closes (standing 10 min, delay growing) is dropped mid-route, laid over before the last stop", async () => {
    const { poll } = rig();
    const mid = { key: "283_1", lon: 19.005, calls: [[1, "08:05"], [2, "08:10"]] as Array<[number, string]> };
    const end = { key: "283_2", lon: 19.0158, calls: [[2, "08:10"]] as Array<[number, string]> };
    let r = await poll(at("08:13"), [rec({ ...mid, ts: at("08:12", 40), delay: 460 }), rec({ ...end, ts: at("08:12", 40), delay: 160 })]);
    const byId = (x: VehiclesResponse, k: string) => x.vehicles.find((v) => v.id === `gzm:${k}`)!;
    assert.equal(byId(r, "283_1").trip_id, "gzm:tA");
    assert.equal(byId(r, "283_1").delay, 460);
    assert.equal(byId(r, "283_2").trip_id, "gzm:tA");
    // 11 min later, not moved a metre, each delay grown by the 11 min
    r = await poll(at("08:24"), [rec({ ...mid, ts: at("08:23", 40), delay: 1120 }), rec({ ...end, ts: at("08:23", 40), delay: 820 })]);
    assert.equal(byId(r, "283_1").trip_id, "");
    assert.equal(byId(r, "283_1").delay, null);
    assert.equal(byId(r, "283_2").trip_id, "gzm:tB");
    assert.equal(byId(r, "283_2").not_started, true);
  });

  it("prunes vehicles missing from a poll; fix_at follows the record clock, never the poll time", async () => {
    const { poll } = rig();
    const ts = at("08:02", 40);
    const calls: Array<[number, string]> = [[1, "08:05"], [2, "08:10"]];
    const both = await poll(at("08:03"), [rec({ ts, calls, lon: 19.004 }), rec({ key: "283_1", ts, calls: [[1, "08:06"]], brigade: "4" })]);
    assert.deepEqual(both.vehicles.map((x) => [x.id, x.fix_at]), [["gzm:283_4285", ts - 10], ["gzm:283_1", ts - 10]]);
    let v = only(await poll(at("08:03", 20), [rec({ ts, calls, lon: 19.004 })]));
    assert.equal(v.fix_at, ts - 10, "same snapshot: same fix");
    v = only(await poll(at("08:03", 40), [rec({ ts: ts + 20, calls, lon: 19.006 })]));
    assert.equal(v.fix_at, ts + 10);
    assert.notEqual(v.fix_at, at("08:03", 40));
  });

  it("goes empty once the last good poll is stale", async () => {
    const { live, clock, poll } = rig();
    await poll(at("08:03"), [rec({ ts: at("08:02", 40), calls: [[1, "08:05"], [2, "08:10"]] })]);
    assert.ok(live.tripExecution("gzm:283_4285"));
    clock.ms = (at("08:03") + 181) * 1000;
    assert.equal((JSON.parse(live.vehiclesBody()) as VehiclesResponse).count, 0);
    assert.equal(live.tripExecution("gzm:283_4285"), null);
  });

  it("serves live trips with estimates from the next stop on; static trips carry none", async () => {
    const { live, poll } = rig();
    await poll(at("08:03"), [rec({ ts: at("08:02", 40), calls: [[1, "08:05"], [2, "08:10"]], delay: 60 })]);
    const t = live.tripExecution("gzm:283_4285") as { trip: { times: Array<{ estimate?: { time_diff: number }; departure_time: string; place_id: string }> }; vehicle_trip_index: number; shape_status: string };
    assert.equal(t.vehicle_trip_index, 1);
    assert.deepEqual(t.trip.times.map((x) => x.estimate?.time_diff ?? null), [null, 60, 60]);
    assert.deepEqual(t.trip.times.map((x) => x.departure_time), ["08:00", "08:05", "08:10"]);
    assert.equal(t.trip.times[0].place_id, "gzm:a");
    assert.equal(t.shape_status, "road");
    // flat like the client's Trip: times beside the shape ref, never the trip_execution envelope
    const s = live.trip("gzm:tA") as { times: Array<{ estimate?: unknown }>; shape_status: string; trip?: unknown };
    assert.ok(s.times.every((x) => x.estimate === undefined));
    assert.equal(s.shape_status, "road");
    assert.equal(s.trip, undefined);
    assert.equal(live.trip("gzm:nope"), "unknown");
  });

  it("logs when each stop was passed, per trip: the vehicle id outlives its trip", async () => {
    const { live, poll } = rig();
    const arrived = () => (live.tripExecution("gzm:283_4285") as { arrived?: (number | null)[] }).arrived;
    await poll(at("08:03"), [rec({ ts: at("08:02", 40), calls: [[1, "08:05"], [2, "08:10"]], lon: 19.004 })]);
    assert.deepEqual(arrived(), [], "the first sighting is a baseline: stops passed before it stay unknown");
    const v = only(await poll(at("08:03", 20), [rec({ ts: at("08:03"), calls: [[2, "08:10"]], delay: 60, lon: 19.012 })]));
    assert.deepEqual(arrived(), [null, v.fix_at]);
    await poll(at("08:13"), [rec({ ts: at("08:12", 40), calls: [[2, "08:10"]], lon: LON.c })]);
    assert.deepEqual(arrived(), [], "the brigade's next trip starts its own log");
  });

  it("builds the board from the feed with the live delay, hiding visits already passed", async () => {
    const { live, poll } = rig();
    await poll(at("08:03"), [rec({ ts: at("08:02", 40), calls: [[1, "08:05"], [2, "08:10"]], delay: 60, lon: 19.005 })]);
    const board = live.departures("gzm:b");
    assert.ok(board && board !== "unknown");
    const rows = board.rows as Array<{ trip_id: string; eta_ts: number | null; plan_ts: number; delay_sec: number | null; trip_execution_id: string; time: string }>;
    assert.deepEqual(rows.map((r) => r.trip_id), ["gzm:tA", "gzm:tX", "gzm:tB"]);
    assert.equal(rows[0].plan_ts, at("08:05"));
    assert.equal(rows[0].eta_ts, at("08:06"));
    assert.equal(rows[0].delay_sec, 60);
    assert.equal(rows[0].trip_execution_id, "gzm:283_4285");
    assert.equal(rows[0].time, "08:06");
    assert.equal(rows[1].eta_ts, null);
    assert.equal(rows[1].trip_execution_id, "");
    // the vehicle passed b: its tA visit there is gone
    await poll(at("08:07"), [rec({ ts: at("08:06", 40), calls: [[2, "08:10"]], delay: 60, lon: 19.012 })]);
    const later = live.departures("gzm:b");
    assert.ok(later && later !== "unknown");
    assert.deepEqual(later.rows.map((r) => r.trip_id), ["gzm:tX", "gzm:tB"]);
    assert.equal(live.departures("gzm:nope"), "unknown");
  });

  it("answers null while the feed loads, and still shows bare positions", async () => {
    const { live, poll } = rig(() => null);
    const v = only(await poll(at("08:03"), [rec({ ts: at("08:02", 40), calls: [[1, "08:05"]] })]));
    assert.equal(v.trip_id, "");
    assert.equal(live.departures("gzm:b"), null);
    assert.equal(live.timetable("gzm:b", DATE), null);
    assert.equal(live.trip("gzm:tA"), null);
    assert.equal(live.connections({ from: "gzm:a", to: "gzm:c" }), null);
    assert.deepEqual(live.shapes(["gzm:shA"]), { shapes: {}, missing: ["gzm:shA"], exact: false });
  });

  it("a zbiorkom city polls all of Poland while its feed parses, then again as soon as the feed lands", async () => {
    let f: GzmFeed | null = null;
    const urls: string[] = [];
    const live = new GzmLive({
      slug: "warsaw",
      feed: () => f,
      now: () => at("08:03", 4) * 1000, // the next grid step is 19 s away
      fetchImpl: async (u) => {
        urls.push(String(u));
        return new Response(JSON.stringify({ positions: [rec({ ts: at("08:02", 40), calls: [[1, "08:05"]], lat: 52.23, lon: 21.01 })] }));
      },
    });
    const until = async (ok: () => boolean) => {
      for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 20))) assert.ok(Date.now() - t0 < 3000, "timed out");
    };
    live.touch();
    live.start();
    try {
      await until(() => (JSON.parse(live.vehiclesBody()) as VehiclesResponse).count === 1);
      assert.match(urls[0], /\/warsaw\/positions\/14,49,24\.2,55$/);
      assert.equal(only(JSON.parse(live.vehiclesBody())).lat, 52.23);
      f = feed;
      await until(() => urls.length === 2);
      assert.doesNotMatch(urls[1], /14,49,24\.2,55$/);
    } finally {
      live.stop();
    }
  });

  it("lists a pole's day timetable and nothing outside the feed's dates", () => {
    const live = new GzmLive({ feed: () => feed, fetchImpl: async () => new Response("{}") });
    const tt = live.timetable("gzm:b", DATE);
    assert.ok(tt && tt !== "unknown");
    assert.deepEqual(tt.departures.map((d) => [d.trip_id, d.departure]), [
      ["gzm:tA", 8 * 3600 + 300],
      ["gzm:tX", 8 * 3600 + 360],
      ["gzm:tB", 8 * 3600 + 1500],
    ]);
    assert.deepEqual(live.timetable("gzm:b", "2027-01-01"), { departures: [] });
  });
});

describe("schedulePosition", () => {
  const stops = { arr: Int32Array.from([100, 200, 330]), dep: Int32Array.from([100, 230, 330]) };
  it("runs from the first departure up to the last arrival, standing through a dwell", () => {
    assert.equal(schedulePosition(stops, 99), null);
    assert.deepEqual(schedulePosition(stops, 100), { i: 0, f: 0, next: 1 });
    assert.deepEqual(schedulePosition(stops, 150), { i: 0, f: 0.5, next: 1 });
    assert.deepEqual(schedulePosition(stops, 215), { i: 1, f: 0, next: 1 });
    assert.deepEqual(schedulePosition(stops, 280), { i: 1, f: 0.5, next: 2 });
    assert.equal(schedulePosition(stops, 330), null);
    assert.equal(schedulePosition({ arr: stops.arr.subarray(0, 1), dep: stops.dep.subarray(0, 1) }, 100), null);
  });
});

describe("scheduled metro (a zbiorkom city)", () => {
  let metro: GzmFeed;
  before(async () => {
    metro = await loadGzmFeed({ ...FILES, "routes.txt": FILES["routes.txt"].replace("Tramwaj 7,0", "Metro 7,1") }, "warsaw");
  });

  it("places every running metro trip by the timetable, on the shape when it has one", async () => {
    const { live, poll } = rig(() => metro, "warsaw");
    const r = await poll(at("08:02", 30), []);
    const byTrip = new Map(r.vehicles.map((v) => [v.trip_id, v]));
    assert.deepEqual([...byTrip.keys()].sort(), ["warsaw:tA", "warsaw:tX"]);
    const a = byTrip.get("warsaw:tA")!;
    assert.equal(a.scheduled, true);
    assert.equal(a.delay, null);
    assert.equal(a.vehicle_type, 1);
    assert.equal(a.next_stop_name, "Beta 01");
    assert.ok(Math.abs(a.lon - (LON.a + LON.b) / 2) < 1e-4);
    assert.ok(a.shape?.startsWith("warsaw:shA.") && a.dist_m! > 0);
    const x = byTrip.get("warsaw:tX")!;
    assert.equal(x.shape, undefined);
    assert.ok(Math.abs(x.lon - (LON.a + (LON.b - LON.a) * (150 / 360))) < 1e-6);
    assert.match(a.id, /^warsaw:1_S[A-Za-z0-9_-]{10}$/);
    // the same trip keeps its id between polls, so the marker glides
    const again = await poll(at("08:03"), []);
    assert.ok(again.vehicles.some((v) => v.id === a.id));
    assert.equal(live.health().scheduled, 2);
    const ex = live.tripExecution(a.id) as { vehicle_trip_index?: number } | null;
    assert.equal(ex?.vehicle_trip_index, 1);
  });

  it("a line some live record serves is never doubled; GZM never schedules", async () => {
    const { poll } = rig(() => metro, "warsaw");
    const live7 = rec({ key: "1_9", ts: at("08:02", 20), calls: [[1, "08:05"]] });
    const r = await poll(at("08:02", 30), [{ ...live7, vehicle: { ...live7.vehicle, type: "1" } }]);
    assert.equal(r.vehicles.filter((v) => v.scheduled).length, 0);
    const gzm = rig(() => metro);
    assert.equal((await gzm.poll(at("08:02", 30), [])).vehicles.length, 0);
  });
});

describe("nextPollDelay", () => {
  it("wakes 3 s past the next 20 s grid point, never sooner than 1 s", () => {
    assert.equal(nextPollDelay(1_000_000), 3000);
    assert.equal(nextPollDelay(1_002_500), 500 + 20000);
    assert.equal(nextPollDelay(1_003_000), 20000);
    assert.equal(nextPollDelay(1_010_000), 13000);
  });
});

describe("parseSdip", () => {
  it("keys like zbiorkom, converts compass radians to degrees, drops foreign ids and (0,0)", () => {
    const m = parseSdip([
      { id: "104_3053", lat: LAT, lon: LON.a, bearing: Math.PI / 2 },
      { id: "104_3054", lat: LAT, lon: LON.a, bearing: -Math.PI / 2 },
      { id: "104_1", lat: 0, lon: 0, bearing: 0 },
      { id: "x", lat: LAT, lon: LON.a, bearing: 0 },
      { id: "104_2", lat: LAT, lon: LON.a },
    ]);
    assert.deepEqual([...m.keys()], ["104_3053", "104_3054", "104_2"]);
    assert.equal(m.get("104_3053")?.bearing, 90);
    assert.equal(m.get("104_3054")?.bearing, 270);
    assert.equal(m.get("104_2")?.bearing, null);
    assert.throws(() => parseSdip("<html>"));
  });
});

describe("SDIP overlay", () => {
  const SDIP = "https://sdip.invalid/vm/main";
  function sdipRig() {
    const clock = { ms: at("08:03") * 1000 };
    let positions: unknown[] = [];
    let sdipList: unknown = [];
    const calls: string[] = [];
    let expired = false;
    const live = new GzmLive({
      feed: () => feed,
      now: () => clock.ms,
      url: "https://x.invalid/positions",
      sdipUrl: SDIP,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const cookie = new Headers(init?.headers).get("cookie") ?? "";
        calls.push(url === SDIP ? "login" : url.startsWith(SDIP) ? `v:${cookie}` : "zb");
        if (url === SDIP) return new Response("<html/>", { headers: { "set-cookie": `JSESSIONID=s${calls.length}; Path=/vm; HttpOnly` } });
        if (url.startsWith(SDIP)) {
          if (expired) {
            expired = false;
            return new Response("<html>login</html>");
          }
          return new Response(JSON.stringify(sdipList));
        }
        return new Response(JSON.stringify({ positions }));
      },
    });
    const zb = async (nowS: number, list: unknown[]) => {
      clock.ms = nowS * 1000;
      positions = list;
      assert.equal(await live.pollOnce(), true);
    };
    const sdip = async (nowS: number, list: unknown) => {
      clock.ms = nowS * 1000;
      sdipList = list;
      assert.equal(await live.pollSdipOnce(), true);
    };
    const veh = () => only(JSON.parse(live.vehiclesBody()) as VehiclesResponse);
    return { live, clock, zb, sdip, veh, calls, expire: () => (expired = true) };
  }
  const calls: Array<[number, string]> = [[1, "08:05"], [2, "08:10"]];
  const sd = (lon: number, bearingRad = Math.PI / 2) => [{ id: "283_4285", lat: LAT, lon, bearing: bearingRad }];

  it("takes SDIP's position once it is seen changing, dated at the poll-window midpoint", async () => {
    const { zb, sdip, veh, calls: log } = sdipRig();
    const ts = at("08:02", 40);
    await zb(at("08:03"), [rec({ ts, calls, lon: 19.004 })]);
    await sdip(at("08:03", 1), sd(19.0045));
    assert.equal(veh().lon, 19.004, "first sight: age unknown, zbiorkom stays");
    await sdip(at("08:03", 6), sd(19.0052, 0));
    const v = veh();
    assert.equal(v.lon, 19.0052);
    assert.equal(v.fix_at, at("08:03", 3.5));
    assert.equal(v.bearing, 0);
    assert.equal(v.trip_id, "gzm:tA", "the join stays zbiorkom's");
    assert.equal(v.delay, 0);
    assert.ok(v.dist_m !== undefined && v.dist_m > 350, `dist_m ${v.dist_m}`);
    assert.deepEqual(log, ["zb", "login", "v:JSESSIONID=s2", "v:JSESSIONID=s2"]);
  });

  it("keeps the newer SDIP fix when zbiorkom's snapshot is older; zbiorkom wins once SDIP goes quiet", async () => {
    const { zb, sdip, veh } = sdipRig();
    const ts = at("08:02", 40);
    await zb(at("08:03"), [rec({ ts, calls, lon: 19.004 })]);
    await sdip(at("08:03", 1), sd(19.0045));
    await sdip(at("08:03", 6), sd(19.006));
    // zbiorkom's next snapshot (fix 08:02:50) is older than SDIP's (08:03:03.5)
    await zb(at("08:03", 20), [rec({ ts: ts + 20, calls, lon: 19.005 })]);
    assert.equal(veh().lon, 19.006);
    // SDIP silent for > 60 s: zbiorkom's fresh fix again
    await zb(at("08:05"), [rec({ ts: at("08:04", 40), calls, lon: 19.009 })]);
    assert.equal(veh().lon, 19.009);
  });

  it("a standing bus stays on SDIP's position: zbiorkom's lagging copy never pulls it back", async () => {
    const { zb, sdip, veh } = sdipRig();
    await zb(at("08:03"), [rec({ ts: at("08:02", 40), calls, lon: 19.004 })]);
    await sdip(at("08:03", 1), sd(19.0045));
    await sdip(at("08:03", 6), sd(19.006));
    // standing since 08:03:03.5; zbiorkom's next snapshots still show where the bus was before, with newer stamps
    for (let i = 1; i <= 14; i++) {
      await sdip(at("08:03", 6 + 5 * i), i === 7 ? [] : sd(19.006));
      if (i % 4 === 0) await zb(at("08:03", 6 + 5 * i), [rec({ ts: at("08:03", 5 * i), calls, lon: 19.005 })]);
    }
    const v = veh();
    assert.equal(v.lon, 19.006, "one SDIP list without the bus holds it too");
    assert.equal(v.fix_at, at("08:03", 3.5));
  });

  it("never dates a change across a long gap; re-logs in when the session expired", async () => {
    const { live, zb, sdip, veh, calls: log, expire } = sdipRig();
    await zb(at("08:03"), [rec({ ts: at("08:02", 40), calls, lon: 19.004 })]);
    await sdip(at("08:03", 1), sd(19.0045));
    await sdip(at("08:03", 30), sd(19.006));
    assert.equal(veh().lon, 19.004, "29 s between polls: the change can't be dated");
    expire();
    await sdip(at("08:03", 35), sd(19.007));
    assert.equal(veh().lon, 19.007);
    assert.deepEqual(log.slice(-3), ["v:JSESSIONID=s2", "login", "v:JSESSIONID=s6"]);
    assert.equal(live.sdipMoved, 1);
  });

  it("pauses 5 min after 3 failed polls", async () => {
    const live = new GzmLive({ feed: () => feed, now: () => 1e12, sdipUrl: SDIP, fetchImpl: async () => new Response("down", { status: 503 }) });
    for (let i = 0; i < 3; i++) assert.equal(await live.pollSdipOnce(), false);
    const h = live.health().sdip as { paused_until: number | null; last_error: string };
    assert.equal(h.paused_until, 1e9 + 300);
    assert.match(h.last_error, /HTTP 503/);
  });
});
