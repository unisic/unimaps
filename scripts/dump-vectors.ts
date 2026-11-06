/**
 * Golden vectors for the Rust port: the TS functions run on fixed inputs and backend/tests/*.rs read their answers
 * from backend/tests/vectors/*.json. Rerun after changing a ported function, from the repo root:
 *   node --import tsx scripts/dump-vectors.ts
 */
import fs from "node:fs";
import path from "node:path";

import { hhmm, preSortRows, type TimingRow } from "../lib/shared/departures";
import { cleanStopName, mergeStops, type FormattedStop } from "../lib/stop-merge";

const OUT = "backend/tests/vectors";

function write(name: string, data: unknown, indent = 1): void {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(data, null, indent)}\n`);
}

// lib/lines.ts, lib/gzm-feed.ts and lib/shared/departures.ts sort line names with the numeric "pl" collator,
// lib/shared/fleet.ts compareLineNames falls back to the plain one
const names: string[] = JSON.parse(fs.readFileSync("test/fixtures/line-names.json", "utf8"));
const numeric = new Intl.Collator("pl", { numeric: true });
write("collation", {
  icu: process.versions.icu,
  pl: [...names].sort((a, b) => a.localeCompare(b, "pl")),
  pl_numeric: [...names].sort(numeric.compare),
});

// lib/shared/departures.ts: the server pre-sort of a board and the wall clock of a row
{
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const now = 1_791_000_000.5;
  const lines = ["1", "2", "10", "17", "119", "N1", "M1", "T7", "02", "2", undefined];
  const boards = [];
  for (let b = 0; b < 100; b++) {
    // odd boards are dense: few minutes, lines and plans, so the later tie-breaks (plan, key) decide
    const dense = b % 2 === 1;
    const rows: TimingRow[] = [];
    for (let i = 0, n = 2 + Math.floor(rnd() * 14); i < n; i++) {
      const plan = rnd() < (dense ? 0.3 : 0.08) ? null : dense ? now + pick([299.5, 300, 330, 360]) : Math.round(now + rnd() * 7200 - 600);
      const eta = dense
        ? pick([null, now + 301, now + 329])
        : rnd() < 0.3 ? null : (plan ?? now) + Math.round(rnd() * 1200 - 120) + pick([0, 0.25, 0.5, -0.5]);
      rows.push({
        operator: pick(["KB", "MZK", "GZM"] as const),
        line_name: dense ? pick(["17", "017", "119", undefined]) : pick(lines),
        plan_ts: plan,
        eta_ts: eta,
        at_stop: rnd() < 0.08,
        canceled: rnd() < 0.08,
        not_started: rnd() < 0.1,
        row_key: pick(["gzm:a#1", "gzm:b#2", "mzk:7#3", "Z#1", "a#10", "a#9", "ż#1", "\u{1f68c}#1", "\u{ff5e}#1"]) + (rnd() < 0.5 ? "" : String(i)),
      });
    }
    const sorted = preSortRows(rows, now);
    boards.push({ rows, order: sorted.map((r) => rows.indexOf(r)) });
  }
  const instants = [0, -0.0005, -1.5, 59.999, 1_774_745_999, 1_774_746_000, 1_774_749_599.9, 1_792_889_999, 1_792_890_000, 1_792_893_600, now];
  for (let i = 0; i < 100; i++) instants.push(1_760_000_000 + Math.floor(rnd() * 90_000_000) + pick([0, 0.4, 0.9999]));
  write("departures", { now, boards, hhmm: instants.map((t) => [t, hhmm(t)]) });
}

// lib/stop-merge.ts: the whole merged list (the TS tests check only the pairing) on the captured fixture and on
// seeded clusters (twins, hubs, opposite carriageways, request stops, learned MZK bearings), plus cleanStopName
{
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  const fx = JSON.parse(fs.readFileSync("test/fixtures/stop-merge-live.json", "utf8")) as { kb: FormattedStop[]; mzk: FormattedStop[] };
  const kbAll = fx.kb.map((k) => ({ ...k, operator: "KB" as const }));
  const mzkAll = fx.mzk.map((m) => ({ ...m, operator: "MZK" as const }));
  const learned = new Map(mzkAll.filter((m) => m.dirs?.length).map((m) => [m.symbol!, m.dirs!] as const));
  const bare = mzkAll.map((m) => ({ ...m, dirs: undefined }));
  const cases: unknown[] = [
    { kb: kbAll, mzk: mzkAll, result: mergeStops(kbAll, mzkAll) },
    { kb: kbAll, mzk: bare, mzkDirs: Object.fromEntries(learned), result: mergeStops(kbAll, bare, { mzkDirs: learned }) },
  ];
  const NAMES = ["Testowa", "Dworzec", "Warszawska Dworzec", "D.A.", "Dworzec Autobusowy", "Strefa", "AB", "Szkoła Podstawowa", "Szkoła NŻ"];
  const bearing = () => (rnd() < 0.5 ? int(360) : Math.round(rnd() * 36000) / 100);
  const off = () => (rnd() - 0.5) * 0.0016; // about +-90 m of latitude: dense clusters, big components
  for (let i = 0; i < 400; i++) {
    const kb: FormattedStop[] = Array.from({ length: 1 + int(5) }, (_, j) => {
      const s: FormattedStop = { id: String(10000 + j), designator: `d${j}`, name: (rnd() < 0.8 ? "BIELSKO-BIAŁA " : "") + pick(NAMES), lat: 49.8 + off(), lon: 19 + off(), operator: "KB" };
      if (rnd() < 0.6) s.dirs = rnd() < 0.3 ? [bearing(), bearing()] : [bearing()];
      if (rnd() < 0.25) s.isStation = true;
      if (rnd() < 0.3) s.showPlatforms = rnd() < 0.5;
      if (rnd() < 0.15) s.onRequest = true;
      return s;
    });
    // a bus station with its poles close by: the hub fan-out
    if (i % 3 === 0) Object.assign(kb[0], { name: pick(["BIELSKO-BIAŁA D.A.", "KOZY DWORZEC AUTOBUSOWY", "BYSTRA DWORZEC"]), isStation: true });
    const near = () => (rnd() - 0.5) * 0.0004;
    const mzkDirs = new Map<string, number[]>();
    const mzk: FormattedStop[] = Array.from({ length: i % 3 === 0 ? 3 + int(8) : int(8) }, (_, j) => {
      const sym = rnd() < 0.05 ? "" : String(100 + j);
      const s: FormattedStop = { id: `mzk:${100 + j}`, designator: `mzk:${100 + j}`, name: pick(NAMES), lat: 49.8 + off(), lon: 19 + off(), operator: "MZK", symbol: sym };
      if (i % 3 === 0 && rnd() < 0.7) Object.assign(s, { lat: kb[0].lat + near(), lon: kb[0].lon + near(), name: pick(["Dworzec", "Warszawska Dworzec", "Testowa"]) });
      // a KB bearing give or take 70 degrees half the time: arrows that collapse or stay apart
      const b = () => (rnd() < 0.5 ? bearing() : ((pick(kb).dirs?.[0] ?? 0) + int(140) - 70 + 360) % 360);
      if (rnd() < 0.3) s.dirs = [b()];
      else if (rnd() < 0.5) mzkDirs.set(sym, rnd() < 0.2 ? [] : [b()]);
      if (rnd() < 0.1) s.isStation = true;
      if (rnd() < 0.15) s.onRequest = true;
      if (rnd() < 0.15) s.gettingOut = true;
      return s;
    });
    cases.push({ kb, mzk, mzkDirs: Object.fromEntries(mzkDirs), result: mergeStops(kb, mzk, { mzkDirs }) });
  }
  const names = [
    ...kbAll.map((s) => s.name), ...mzkAll.map((s) => s.name),
    "bielsko-biała d.a.", "BIELSKO-BIAŁAD.A.", "XD.A.", "Kozy\u00a0D.A", "Dworzec\tautobusowy", "dworzec  AUTOBUSOWY ",
    "KOZYDWORZEC AUTOBUSOWY", " Jaworze  Centrum ", "JAWORZE", "Szczyrk Biła NŻ", "ß-straße", "Plac Żwirki i Wigury",
    "BYSTRA\u2003Szkoła", "Porąbka (Kościół)", "", "D.A", "a.D.A.", "BESTWINA D.A. D.A.",
  ];
  write("stop_merge", { clean: names.map((n) => [n, cleanStopName(n)]), cases }, 0);
}

// lib/router.ts: connection search and the line view on the fixture feed (KB + the captured MZK
// timetable) and on a seeded synthetic zbiorkom-style index (dates, pickup flags, overtaking trips, live delays)
void (async () => {
  process.env.KB_GTFS_DIR = path.join(process.cwd(), "test", "fixtures", "gtfs");
  process.env.KB_MZK_TIMETABLE_FILE = path.join(process.cwd(), "test", "fixtures", "mzk-timetable.v1.json");
  // the agency clock: 2026-09-30 (Wednesday) 10:15 Warsaw, so `today` searches and their fallback days are pinned
  const NOW = Date.UTC(2026, 8, 30, 8, 15, 0);
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(NOW);
      else super(...(args as [string]));
    }
    static now(): number {
      return NOW;
    }
  } as DateConstructor;
  const router = await import("../lib/router");
  const { gzmStopKey } = await import("../lib/shared/gzm-stop-key");
  const { NO_DROP_OFF, NO_PICKUP } = await import("../lib/gtfs-csv");
  const config = await import("../lib/config");
  const today = config.todayLocalISO();
  const nowSecs = (await import("../lib/poller")).nowSecs();

  let seed = 29;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];

  type Q = Omit<import("../lib/router").RouteQuery, "live"> & { live?: boolean };

  // fixture feed
  const stopsTxt = fs.readFileSync("test/fixtures/gtfs/stops.txt", "utf8").trim().split("\n").slice(1);
  const kbStops = stopsTxt.map((l) => {
    const [id, name, lat, lon] = l.split(",");
    return { id, name, lat: Number(lat), lon: Number(lon) };
  });
  const mzk = JSON.parse(fs.readFileSync("test/fixtures/mzk-timetable.v1.json", "utf8"));
  const mzkIds = Object.keys(mzk.stops).map((s) => `mzk:${s}`);
  const ids = [...kbStops.map((s) => s.id), ...mzkIds];
  const names = [...new Set(kbStops.map((s) => s.name))];
  const fragments = ["Kęty", "SZCZYRK", "bielsko", "d.a.", "Wapienica", "-", "x", "ŻYWIEC", "Pietrzykowice, Kościół", "3 Maja Dworzec", "kozy", "  ", "Szczyrk Biła", "Łodygowice"];

  const feedQueries: Q[] = [
    { from: "10000", to: "21141", fromIds: ["10000"], toIds: ["21141"], date: "2026-09-30", afterSecs: 10 * 3600 },
    { from: "10431", to: "21141", fromIds: ["10431"], toIds: ["21141"], date: "2026-09-30", afterSecs: 8 * 3600 },
    { from: "21031", to: "40000", fromIds: ["21031"], toIds: ["40000"], date: "2026-09-30", afterSecs: 11 * 3600 },
    { from: "25461", to: "40000", fromIds: ["25461"], toIds: ["40000"], date: "2026-09-30", afterSecs: 15 * 3600 },
    { from: "10000", to: "40000", fromIds: ["10000"], toIds: ["40000"], date: "2026-09-30", afterSecs: 22 * 3600 + 1800 },
    { from: "22191", to: "mzk:456", date: "2026-09-30", afterSecs: 21 * 3600 },
    { from: "mzk:2", to: "mzk:456", date: "2026-10-04" },
    { from: "mzk:2", to: "mzk:456", date: "2026-10-01" },
    { from: "no such stop", fromIds: ["10021", "mzk:2"], to: "mzk:456", date: "2026-09-30" },
    { from: "BIELSKO-BIAŁA WAPIENICA CENTRUM", to: "SZCZYRK SKALITE", limit: 3 },
    { from: "BIELSKO-BIAŁA WAPIENICA CENTRUM", to: "SZCZYRK SKALITE", limit: 3, afterSecs: 23 * 3600 },
    { from: "SZCZYRK CENTRUM", to: "KĘTY", afterSecs: 20 * 3600 + 52 * 60, limit: 3 },
    { from: "PIETRZYKOWICE, KOŚCIÓŁ", to: "KĘTY, D.A. UL. SIENKIEWICZA", date: "2026-09-14", afterSecs: 15 * 3600 },
    { from: "BIELSKO-BIAŁA D.A.", to: "SZCZYRK SKALITE", date: "2026-09-14", dayLabel: "Jutro", afterSecs: 14 * 3600 },
    { from: "-", to: "SZCZYRK SKALITE", date: "2026-09-30", afterSecs: 14 * 3600 },
    { from: "geo", fromPoint: { lat: 49.8225, lon: 19.0444 }, to: "SZCZYRK SKALITE", date: "2026-09-30", afterSecs: 9 * 3600 },
    { from: "geo", fromPoint: { lat: 49.8225, lon: 19.0444, walkM: 300 }, to: "geo", toPoint: { lat: 49.7175, lon: 19.0300, walkM: 1500 }, date: "2026-09-30", afterSecs: 9 * 3600 },
    { from: "10000", to: "21141", fromIds: ["10000"], toIds: ["21141"], date: "2026-09-30", afterSecs: 18 * 3600, arriveBy: true, limit: 4 },
    { from: "10000", to: "40000", fromIds: ["10000"], toIds: ["40000"], date: "2026-09-30", afterSecs: 6 * 3600, arriveBy: true },
  ];
  for (let i = 0; i < 70; i++) {
    const byName = rnd() < 0.25;
    const from = byName ? pick([...names, ...fragments]) : pick(ids);
    const to = byName ? pick([...names, ...fragments]) : pick(ids);
    const q: Q = byName ? { from, to } : { from, to, fromIds: [from], toIds: [to] };
    if (rnd() < 0.85) q.date = pick(["2026-09-30", "2026-10-03", "2026-10-04", "2026-09-14", today]);
    if (rnd() < 0.85) q.afterSecs = int(26 * 3600);
    if (rnd() < 0.15) q.arriveBy = true;
    if (rnd() < 0.15) q.directOnly = true;
    if (rnd() < 0.4) q.sortBy = pick(["departure", "duration", "arrival", "transfers", "walk"] as const);
    if (rnd() < 0.3) q.limit = 1 + int(25);
    if (rnd() < 0.2) q.minTransferSecs = 60 * int(15);
    if (rnd() < 0.2) q.maxTransferSecs = 60 * int(30);
    if (rnd() < 0.1) q.avoidLines = [String(pick([100, 103, 112, 120, 22, 57]))];
    if (rnd() < 0.1) q.fallbackDays = int(4);
    if (rnd() < 0.1) q.fromPoint = { lat: 49.75 + rnd() * 0.15, lon: 18.95 + rnd() * 0.3, walkM: 200 + int(1300) };
    if (rnd() < 0.1) q.toPoint = { lat: 49.75 + rnd() * 0.15, lon: 18.95 + rnd() * 0.3 };
    feedQueries.push(q);
  }
  const feed = feedQueries.map((q) => ({ query: q, result: router.findConnections(q as import("../lib/router").RouteQuery) }));

  const lines = [...new Set(fs.readFileSync("test/fixtures/gtfs/trips.txt", "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[4]))];
  const mzkLines = [...new Set(mzk.trips.map((t: { line: string }) => t.line))] as string[];
  const lineViews = [];
  for (const date of ["2026-09-30", "2026-10-04", "2026-10-03"]) {
    for (const line of lines) lineViews.push({ line, operator: "KB", date, result: router.lineTimetable(line, "KB", date) });
    for (const line of mzkLines) lineViews.push({ line, operator: "MZK", date, result: router.lineTimetable(line, "MZK", date) });
  }
  const clean = [...names, ...fragments, ...Object.values(mzk.stops).map((s) => (s as [string])[0])].map((s) => [s, router.cleanText(s)]);
  const dates = [];
  for (let i = 0; i < 60; i++) {
    const d = `${String(int(10000)).padStart(4, "0")}-${String(int(14)).padStart(2, "0")}-${String(int(33)).padStart(2, "0")}`;
    const o = int(800) - 400;
    dates.push([d, o, router.offsetDate(d, o), router.weekdayMonday0(d)]);
  }

  // synthetic zbiorkom-style city: posts of one stop share a key, lines cross on a ~250 m grid (walking transfers)
  const D = today;
  const gStops = [];
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 7; x++) {
      const name = `S${y}${x}`;
      for (let post = 1; post <= 1 + int(2); post++) {
        const lat = 50.25 + y * 0.0022 + (rnd() - 0.5) * 0.0004;
        const lon = 19.0 + x * 0.0035 + (rnd() - 0.5) * 0.0004;
        gStops.push({ id: `gzm:${name}_${post}`, name: `${name} 0${post}`, lat, lon, key: gzmStopKey(`${name} 0${post}`) });
      }
    }
  }
  const gTrips = [];
  for (let l = 0; l < 12; l++) {
    const path: string[] = [];
    let y = int(6);
    let x = int(7);
    for (let n = 0, len = 4 + int(8); n < len; n++) {
      const posts = gStops.filter((s) => s.id.startsWith(`gzm:S${y}${x}_`));
      const id = pick(posts).id;
      if (!path.includes(id)) path.push(id);
      if (rnd() < 0.5) x = Math.max(0, Math.min(6, x + pick([-1, 1])));
      else y = Math.max(0, Math.min(5, y + pick([-1, 1])));
    }
    if (path.length < 2) continue;
    const line = String(l + 1);
    const routeId = l % 3 === 0 ? "tram" : "bus";
    const hops = path.slice(1).map(() => 60 + int(4) * 60);
    const flags = rnd() < 0.3 ? path.map((_, i) => (i > 0 && i < path.length - 1 && rnd() < 0.3 ? pick([NO_PICKUP, NO_DROP_OFF, 3]) : 0)) : undefined;
    for (let t = 5 * 3600 + int(1800), k = 0; t < 25 * 3600; t += 600 + int(4) * 300, k++) {
      const express = rnd() < 0.1;
      let at = t;
      const calls = path.map((stopId, i) => {
        if (i > 0) at += express ? 60 : hops[i - 1];
        return [stopId, at, at + (i > 0 && rnd() < 0.2 ? 60 : 0)] as [string, number, number];
      });
      const dates = [-1, 0, 1, 2].filter(() => rnd() < 0.8).map((o) => router.offsetDate(D, o));
      gTrips.push({ tripId: `gzm:${line}_${k}`, line, routeId, headsign: `Kierunek ${line}`, calls, dates, ...(flags && rnd() < 0.7 ? { flags } : {}) });
    }
  }
  const live: Record<string, number> = {};
  for (const t of gTrips) if (rnd() < 0.2) live[`${t.tripId}|${pick([D, D, router.offsetDate(D, -1)])}`] = int(1200) - 180;
  const gIdx = router.buildRouterIndex({
    stops: gStops.map((s) => ({ ...s })),
    trips: new Map(
      gTrips.map((t) => [
        t.tripId,
        {
          tripId: t.tripId,
          serviceId: "s",
          routeId: t.routeId,
          line: t.line,
          headsign: t.headsign,
          ...router.callColumns(t.calls.map(([stopId, arr, dep], i) => ({ stopId, seq: i + 1, arr, dep })), new Map()),
          nums: new Int32Array(0),
          pattern: "",
          dates: new Set(t.dates),
          ...(t.flags ? { flags: Uint8Array.from(t.flags) } : {}),
        },
      ]),
    ),
  });
  const gIds = gStops.map((s) => s.id);
  const gServed = [...new Set(gTrips.flatMap((t) => t.calls.map((c) => c[0])))];
  const gQueries: Q[] = [];
  for (let i = 0; i < 80; i++) {
    const from = pick(rnd() < 0.85 ? gServed : gIds);
    const to = pick(rnd() < 0.85 ? gServed : gIds);
    const q: Q = { from, to, fromIds: [from], toIds: [to], date: pick([D, D, router.offsetDate(D, 1)]), afterSecs: 4 * 3600 + int(21 * 3600) };
    if (rnd() < 0.6) q.live = true;
    if (rnd() < 0.15) q.arriveBy = true;
    if (rnd() < 0.1) q.directOnly = true;
    if (rnd() < 0.4) q.sortBy = pick(["departure", "duration", "arrival", "transfers", "walk"] as const);
    if (rnd() < 0.3) q.limit = 1 + int(12);
    if (rnd() < 0.2) q.minTransferSecs = 60 * int(6);
    if (rnd() < 0.2) q.maxTransferSecs = 60 * int(20);
    if (rnd() < 0.15) q.avoidLines = [String(1 + int(12))];
    if (rnd() < 0.15) q.avoidRoutes = ["tram"];
    if (rnd() < 0.15) q.fromPoint = { lat: 50.25 + rnd() * 0.011, lon: 19.0 + rnd() * 0.021, walkM: 200 + int(1000) };
    if (rnd() < 0.15) q.toPoint = { lat: 50.25 + rnd() * 0.011, lon: 19.0 + rnd() * 0.021 };
    if (rnd() < 0.1) q.from = q.fromIds![0].slice(4).replace("_", " ");
    gQueries.push(q);
  }
  const liveFn = (id: string, d: string) => live[`${id}|${d}`];
  const synthetic = gQueries.map((q) => ({
    query: q,
    result: router.findConnections({ ...q, live: q.live ? liveFn : undefined } as import("../lib/router").RouteQuery, gIdx),
  }));
  const gEvents = [];
  for (let i = 0; i < 20; i++) {
    const poles = Array.from({ length: 1 + int(4) }, () => pick(gIds));
    const date = pick([D, router.offsetDate(D, 1)]);
    const from = int(26 * 3600);
    const to = from + int(3 * 3600);
    const limit = rnd() < 0.3 ? 1 + int(8) : undefined;
    const ev = router.stopEvents(gIdx, poles, date, from, to, limit);
    gEvents.push({ poles, date, from, to, limit, result: ev.map((e) => [e.trip.tripId, e.pos, e.arr, e.dep, e.serviceDate]) });
  }
  const gLines = Array.from({ length: 12 }, (_, l) => ({ line: String(l + 1), result: router.lineTimetable(String(l + 1), "GZM", D, gIdx) }));
  const foot = gIds.map((id) => gIdx.foot[gIdx.stopNum.get(id)!].map((f) => [gIdx.stopIds[f.to], f.secs]));

  globalThis.Date = RealDate;
  write("router", {
    today,
    now_secs: nowSecs,
    clean,
    dates,
    feed,
    line_views: lineViews,
    synthetic: { stops: gStops, trips: gTrips, live, queries: synthetic, events: gEvents, lines: gLines, foot },
  });
})();
