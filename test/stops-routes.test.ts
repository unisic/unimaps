import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GET as getStops } from "../app/api/stops/route";
import { GET as getDepartures } from "../app/api/stop/[designator]/departures/route";
import { GET as getTimetable } from "../app/api/stop/[designator]/timetable/route";
import { GET as getHealth } from "../app/api/health/route";
import { MzkStopDirs } from "../lib/mzk-stop-dirs";
import type { Stop } from "../lib/types";
import { departuresBoardCache } from "../lib/departures-board-cache";

/* The routes talk to the process-wide poller singleton; install a fake one (already "started", so no
   network and no pollers) and drive the REAL route handlers. */
const KEY = Symbol.for("kb-gtfs.poller-singleton");

const kb = (internalId: number, urlId: string, name: string, lat: number, lon: number, extra: Partial<Stop> = {}): Stop => ({
  urlId, internalId, name, lat, lon, onlyDisembarking: false, isStation: false, showPlatforms: false, stopId: String(internalId), ...extra,
});
const mz = (symbol: string, name: string, lat: number, lon: number): Stop => ({
  urlId: `mzk:${symbol}`, internalId: Number(symbol) + 1000, name, lat, lon, onlyDisembarking: false, isStation: false,
  showPlatforms: false, stopId: `mzk:${symbol}`, operator: "MZK", symbol,
});

const KB_STOPS = [
  kb(10302, "19146:39714", "BIELSKO-BIAŁA PIASTOWSKA LUBERTOWICZA", 49.827047, 19.036152),
  kb(10000, "184900", "BIELSKO-BIAŁA D.A.", 49.830227, 19.042746, { isStation: true, showPlatforms: true }),
];
const MZK_STOPS = [
  mz("265", "Piastowska Lubertowicza", 49.827047, 19.036152),
  mz("343", "Warszawska Dworzec", 49.8309, 19.0435),
  mz("341", "Warszawska Dworzec", 49.8315, 19.0432),
  mz("264", "Piastowska Dworzec", 49.8289, 19.0428),
];

interface Fake {
  kbRows: Record<string, unknown[]>;
  mzkRows: Record<string, Array<Record<string, unknown>>>;
  mzkFail?: boolean;
  kbFail?: boolean;
  schedFail?: boolean;
  mzkCalls: string[];
  kbCalls: string[];
}
let fake: Fake;
let state: { poller: { stops: Stop[]; addCandidates: () => void }; mzkPoller: { stops: Stop[] } & Record<string, unknown> };

const mzkDep = (course: number, line: string, sec: number) => ({
  courseId: course, scheduledDepartureSec: sec, scheduledDeparture: sec * 1000, realDeparture: 0, vehicleId: "", variantId: 1,
  orderInCourse: 1, passed: false, lack: true, onStopPoint: false, lineName: line, directionName: `dir ${line}`,
});

beforeEach(() => {
  departuresBoardCache.clear();
  fake = { kbRows: {}, mzkRows: {}, mzkCalls: [], kbCalls: [] };
  state = {
    poller: { stops: KB_STOPS, addCandidates: () => undefined },
    mzkPoller: { stops: MZK_STOPS, staticVehicles: new Map(), courseMetaMap: new Map(), runningVehiclesMap: new Map(), stopsBySymbol: new Map(), stopDirs: new MzkStopDirs() },
  };
  (globalThis as Record<symbol, unknown>)[KEY] = {
    api: {
      fetchDepartures: async (d: string) => {
        fake.kbCalls.push(d);
        if (fake.kbFail) throw new Error("KB unavailable");
        return { rows: fake.kbRows[d] ?? [] };
      },
      fetchTimetable: async () => ({ departures: [{ trip_id: "kbt1", departure: 54000, line: "120", direction: "x" }] }),
    },
    mzkApi: {
      fetchRealtime: async (s: string) => {
        fake.mzkCalls.push(s);
        if (fake.mzkFail) throw new Error("OnTime unavailable");
        return { departures: fake.mzkRows[s] ?? [] };
      },
      fetchAtomicSchedule: async (s: string) => {
        fake.mzkCalls.push(`sched:${s}`);
        if (fake.schedFail) throw new Error("OnTime unavailable");
        return { lineSchedules: { "6": { lineName: "6", destination: "x", departures: [{ courseId: 1, variantId: 1, scheduledDepartureSec: 54060 }] } } };
      },
    },
    poller: Object.assign(state.poller, {
      scanInterval: 90,
      healthSnapshot: () => {
        const now = Date.now() / 1000;
        return { stops: 2, scanCount: 1, lastScan: now, live: 0, tracked: 0, lastRefresh: now, lastGoodRefresh: now, loopRestarts: 0, lastLoopError: null, stopsLoadedAt: now };
      },
    }),
    mzkPoller: state.mzkPoller,
    shapes: { health: () => ({}) },
    startPromise: Promise.resolve(),
    signalsRegistered: true,
    lastStartFailAt: 0,
  };
});

const departures = async (designator: string) => {
  const res = await getDepartures(new Request(`http://x/api/stop/${designator}/departures`), { params: Promise.resolve({ designator }) });
  return (await res.json()) as {
    rows: Array<{ operator: string; line_name?: string; trip_execution_id?: string; static_time?: string }>;
    warnings?: string[];
  };
};

describe("GET /api/stops", () => {
  it("serves the merged list with an ETag, answers If-None-Match with 304", async () => {
    const res = await getStops(new Request("http://x/api/stops"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    const etag = res.headers.get("etag");
    assert.ok(etag);
    const body = (await res.json()) as { count: number; stops: Array<{ id: string; operator: string }> };
    assert.equal(body.stops.find((s) => s.id === "10302")?.operator, "BOTH");
    const again = await getStops(new Request("http://x/api/stops", { headers: { "if-none-match": etag } }));
    assert.equal(again.status, 304);
  });

  it("a list still missing the MZK stops is flagged `partial`, revalidated every time, and heals when they arrive", async () => {
    const mzkEarly: Stop[] = [];
    state.mzkPoller.stops = mzkEarly;
    const early = await getStops(new Request("http://x/api/stops"));
    assert.equal(early.headers.get("cache-control"), "no-cache"); // stored, but never reused without asking the server
    const e = (await early.json()) as { partial?: boolean; stops: Array<{ id: string; operator: string }> };
    assert.equal(e.partial, true);
    assert.equal(e.stops.find((s) => s.id === "10302")?.operator, "KB");
    const again = await getStops(new Request("http://x/api/stops", { headers: { "if-none-match": early.headers.get("etag")! } }));
    assert.equal(again.status, 304); // polling a partial list every 20 s costs a 304, not 300 KB
    state.mzkPoller.stops = MZK_STOPS; // MZK getStops finally loaded (the poller swaps in a new array)
    const late = await getStops(new Request("http://x/api/stops", { headers: { "if-none-match": early.headers.get("etag")! } }));
    assert.equal(late.status, 200);
    assert.equal(late.headers.get("cache-control"), "public, max-age=60");
    const l = (await late.json()) as { partial?: boolean; stops: Array<{ id: string; operator: string }> };
    assert.equal(l.partial, undefined);
    assert.equal(l.stops.find((s) => s.id === "10302")?.operator, "BOTH");
    assert.notEqual(early.headers.get("etag"), late.headers.get("etag"));
  });
});

describe("GET /api/stop/[designator]/departures", () => {
  it("BOTH stop: MZK + KB rows (Piastowska Lubertowicza)", async () => {
    fake.mzkRows["265"] = [mzkDep(1, "6", 54000), mzkDep(2, "15", 54300)];
    fake.kbRows["19146:39714"] = [{ trip_execution_id: "kb1", line_name: "120", static_time: "15:03", time: "15:03" }];
    const { rows } = await departures("19146:39714");
    assert.deepEqual(rows.map((r) => r.operator).sort(), ["KB", "MZK", "MZK"]);
    assert.deepEqual(fake.mzkCalls, ["265"]);
  });

  it("regression: MZK stops that load AFTER the first departures request are used without any /api/stops call", async () => {
    state.mzkPoller.stops = []; // MZK upstream was down when the first request arrived
    fake.mzkRows["265"] = [mzkDep(1, "6", 54000)];
    fake.kbRows["19146:39714"] = [{ trip_execution_id: "kb1", line_name: "120", static_time: "15:03", time: "15:03" }];
    const first = await departures("19146:39714");
    assert.deepEqual(first.rows.map((r) => r.operator), ["KB"]);
    state.mzkPoller.stops = MZK_STOPS; // loaded in the background; nobody calls /api/stops
    const second = await departures("19146:39714");
    assert.deepEqual(second.rows.map((r) => r.operator).sort(), ["KB", "MZK"]);
  });

  it("station hub: fans out to every MZK symbol and keeps a course that calls at two of them only once", async () => {
    fake.mzkRows["343"] = [mzkDep(10, "31", 54000)];
    fake.mzkRows["341"] = [mzkDep(11, "8", 54060), mzkDep(12, "11", 54120)];
    fake.mzkRows["264"] = [mzkDep(12, "11", 54180), mzkDep(13, "1", 54240)]; // course 12 calls at 341 AND 264
    const { rows } = await departures("184900");
    assert.deepEqual(fake.mzkCalls.sort(), ["264", "341", "343"]);
    const mzkRows = rows.filter((r) => r.operator === "MZK");
    assert.equal(mzkRows.length, 4);
    assert.equal(new Set(mzkRows.map((r) => r.trip_execution_id)).size, 4);
  });

  it("a failed MZK fetch is reported as a warning instead of looking like 'no MZK departures'", async () => {
    fake.mzkFail = true;
    fake.kbRows["19146:39714"] = [{ trip_execution_id: "kb1", line_name: "120", static_time: "15:03", time: "15:03" }];
    const res = await departures("19146:39714");
    assert.deepEqual(res.rows.map((r) => r.operator), ["KB"]);
    assert.deepEqual(res.warnings, ["mzk"]);
    fake.mzkFail = false;
    assert.equal((await departures("19146:39714")).warnings, undefined);
  });
});

describe("GET /api/stops conditional requests", () => {
  it("answers a weakened or listed validator (a proxy may turn our strong ETag into W/\"...\")", async () => {
    const etag = (await getStops(new Request("http://x/api/stops"))).headers.get("etag")!;
    for (const h of [`W/${etag}`, `"zzz", ${etag}`, "*"]) {
      const res = await getStops(new Request("http://x/api/stops", { headers: { "if-none-match": h } }));
      assert.equal(res.status, 304, h);
    }
    const other = await getStops(new Request("http://x/api/stops", { headers: { "if-none-match": '"nope"' } }));
    assert.equal(other.status, 200);
  });
});

describe("departures: a hub's extra symbols are stops of their own", () => {
  it("opening the MZK-only entry of an extra symbol queries just that symbol", async () => {
    fake.mzkRows["341"] = [mzkDep(11, "8", 54060)];
    const { rows } = await departures("mzk:341");
    assert.deepEqual(fake.mzkCalls, ["341"]);
    assert.deepEqual(rows.map((r) => r.operator), ["MZK"]);
  });

  it("a failed KB fetch is reported too (the BOTH panel would show MZK rows only)", async () => {
    fake.kbFail = true;
    fake.mzkRows["265"] = [mzkDep(1, "6", 54000)];
    const res = await departures("19146:39714");
    assert.deepEqual(res.rows.map((r) => r.operator), ["MZK"]);
    assert.deepEqual(res.warnings, ["kb"]);
  });
});

describe("GET /api/stop/[designator]/timetable", () => {
  const timetable = async (designator: string) => {
    const res = await getTimetable(new Request(`http://x/api/stop/${designator}/timetable?date=2026-10-02`), { params: Promise.resolve({ designator }) });
    return { res, body: (await res.json()) as { departures: Array<{ operator: string }>; warnings?: string[] } };
  };

  it("BOTH stop: both operators, cacheable for 15 min", async () => {
    const { res, body } = await timetable("19146:39714");
    assert.deepEqual(body.departures.map((d) => d.operator).sort(), ["KB", "MZK"]);
    assert.equal(body.warnings, undefined);
    assert.equal(res.headers.get("cache-control"), "public, max-age=900");
  });

  it("a failed MZK schedule is a warning and is NOT cacheable (it used to be a 200 pinned for 15 min as 'no MZK buses')", async () => {
    fake.schedFail = true;
    const { res, body } = await timetable("19146:39714");
    assert.deepEqual(body.departures.map((d) => d.operator), ["KB"]);
    assert.deepEqual(body.warnings, ["mzk"]);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("an MZK-only stop that fails answers the same way", async () => {
    fake.schedFail = true;
    const { res, body } = await timetable("mzk:341");
    assert.deepEqual(body.departures, []);
    assert.deepEqual(body.warnings, ["mzk"]);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("GET /api/health (stop-list counters)", () => {
  it("reports the MZK list and the merge (informational, never degrades)", async () => {
    const res = await getHealth();
    assert.equal(res.status, 200);
    const h = (await res.json()) as { mzk_stops: number; merged_stops: { both: number; kb: number; mzk: number; partial: boolean } };
    assert.equal(h.mzk_stops, MZK_STOPS.length);
    assert.equal(h.merged_stops.both, 2); // Piastowska Lubertowicza + the D.A. hub
    assert.equal(h.merged_stops.partial, false);
    state.mzkPoller.stops = [];
    const early = (await (await getHealth()).json()) as { status: string; merged_stops: { partial: boolean } };
    assert.equal(early.merged_stops.partial, true);
    assert.equal(early.status, "ok");
  });
});
