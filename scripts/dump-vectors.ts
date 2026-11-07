/**
 * Golden vectors for the Rust port: the TS functions run on fixed inputs and backend/tests/*.rs read their answers
 * from backend/tests/vectors/*.json. Rerun after changing a ported function, from the repo root:
 *   node --import tsx scripts/dump-vectors.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  plannedAt,
  progressAt,
  scheduleDelay,
  stepArrivals,
  stepKbProgress,
  straightGeom,
  trackAlong,
  type KbArrivals,
  type KbProgState,
} from "../lib/kb-progress";
import { mzkRemapDist, mzkShapeFromCourseDetails, mzkStopIndices } from "../lib/mzk-shape";
import { clampPlannedMonotone, hasPlannedDip, isMzkNotStarted, mzkRowTiming } from "../lib/mzk-state";
import { estimateFixAt, kbAheadM, kbDistAlong, nextSpeed, schedSpeed } from "../lib/route-info";
import { buildKbPattern, rawTripId, readGtfsPatternSeeds, type ResolvedStop } from "../lib/shape-patterns";
import { finalizeShape, type ShapeSrc } from "../lib/shape-store";
import { ALERT_LEADS, alertAction, alertMessage, type Alert } from "../lib/shared/alerts";
import { adjustStopRoutePoint, injectDetourPoints } from "../lib/shared/detours";
import {
  enrichKbRow,
  hhmm,
  kbAnchorTs,
  mzkWireFields,
  parseClockNear,
  parseRelMinutes,
  preSortRows,
  rowKey,
  type TimingRow,
} from "../lib/shared/departures";
import { pointAt, preparePolyline, type LatLng } from "../lib/shared/polyline";
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

// lib/kb-progress.ts: stepKbProgress replayed over the real captures (test/fixtures/kb-delay) and seeded variants of
// them: a stalled upstream index, dropped polls (cold starts), GPS noise and off-route fixes, shifted clocks,
// unresolved stops and unknown plan times, a bus parked at or driving away from its terminus. After the router block:
// lib/poller loads lib/config, which reads the KB_GTFS_DIR set there at module load
void (async () => {
  const { kbNextStopIndex } = await import("../lib/poller");
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const int = (n: number) => Math.floor(rnd() * n);
  const secs = (s: string | null): number | null => {
    if (!s) return null;
    const [h, m] = s.split(":").map(Number);
    return h * 3600 + m * 60;
  };
  const wrap = (x: number): number => (x > 43200 ? x - 86400 : x < -43200 ? x + 86400 : x);
  const hm = (x: number): string => `${String(Math.floor(x / 3600) % 24).padStart(2, "0")}:${String(Math.floor(x / 60) % 60).padStart(2, "0")}`;
  interface Sample { t: number; local: number; lat: number; lon: number; vti: number | null; ndi: number | null; at: boolean; est0: string | null }
  interface Fx { stops: { lat: number | null; lon: number | null; plan: string }[]; samples: Sample[] }
  const cases = [];
  for (const name of ["healthy-120-loop", "spur-136", "stall-116", "stall-116-b"]) {
    const fx = JSON.parse(fs.readFileSync(`test/fixtures/kb-delay/${name}.json`, "utf8")) as Fx;
    for (let v = 0; v < 24; v++) {
      const pts: (LatLng | null)[] = fx.stops.map((s) => (s.lat !== null && s.lon !== null ? [s.lat, s.lon] : null));
      const plan = fx.stops.map((s) => secs(s.plan));
      let samples = fx.samples.map((s) => ({ ...s }));
      if (v > 0) {
        if (v % 6 === 3) for (let k = 0; k < 2; k++) pts[1 + int(pts.length - 2)] = null;
        if (v % 6 === 4) for (let k = 0; k < 3; k++) plan[int(plan.length)] = null;
        if (v % 3 === 1) {
          const shift = (int(2) ? 1 : -1) * (300 + int(3000));
          for (const s of samples) s.local = (s.local + shift + 86400) % 86400;
        }
        if (rnd() < 0.7) {
          // upstream's index freezes from some poll on, estimates[0] clamped to the current minute
          const from = int(samples.length);
          const vti = int(2) ? samples[from].vti : int(fx.stops.length - 1);
          for (const s of samples.slice(from)) Object.assign(s, { vti, ndi: vti === null ? null : vti + 1, at: false, est0: hm(s.local) });
        }
        if (rnd() < 0.5) {
          const a = int(samples.length);
          samples.splice(a, 4 + int(10));
        }
        if (v % 2 === 0) samples = samples.filter(() => rnd() > 0.15);
        for (const s of samples) {
          s.lat += ((rnd() - 0.5) * 60) / 111_320;
          s.lon += ((rnd() - 0.5) * 60) / 71_800;
          if (rnd() < 0.04) s.lat += 0.02;
        }
        const last = samples[samples.length - 1];
        const end = pts.filter((p): p is LatLng => p !== null).at(-1);
        if (last && end && v % 4 === 2) {
          // parked X m before the terminus and Y m to the side of it (values around END_LEFT_M / END_NEAR_M), then
          // gone off the route
          const before = pts.filter((p): p is LatLng => p !== null).at(-2)!;
          const segM = Math.hypot((end[0] - before[0]) * 111_320, (end[1] - before[1]) * 71_800);
          const f = Math.min(1, ([0, 60, 92, 97, 103, 112, 150][int(7)] + rnd() * 6) / segM);
          const side = ([0, 40, 80, 112, 118, 124, 140][int(7)] + rnd() * 4) / 111_320;
          let { t, local } = last;
          for (let k = 1; k <= 10; k++) {
            const dt = 5 + int(k > 4 ? 40 : 20);
            t += dt * 1000;
            local = (local + dt) % 86400;
            const pt: LatLng = k > 4 ? [end[0] + 0.01 * (k - 4), end[1]] : [end[0] + (before[0] - end[0]) * f + side, end[1] + (before[1] - end[1]) * f];
            samples.push({ ...last, t, local, lat: pt[0], lon: pt[1], est0: hm(local) });
          }
        }
        if (v % 4 === 1) {
          // a run of off-route fixes mid-route: the held delay expires after HOLD_CARRY_S
          const a = int(Math.max(1, samples.length - 20));
          for (const s of samples.slice(a, a + 20)) s.lat += 0.02;
        }
      }
      const geom = straightGeom(pts);
      if (!geom) continue;
      let st: KbProgState | null = null;
      const steps = samples.map((s) => {
        const tgt = s.ndi !== null && s.ndi >= 0 && s.ndi < plan.length ? s.ndi : s.vti;
        const arr = secs(s.est0);
        const sched = tgt !== null ? plan[tgt] : null;
        const delayUp = arr !== null && sched !== null && sched !== undefined ? Math.trunc(wrap(arr - sched)) : null;
        const inp = { lat: s.lat, lon: s.lon, tEpoch: s.t / 1000, localSecs: s.local, vti: s.vti, nextUp: kbNextStopIndex(s.vti, s.ndi, s.at, plan.length), delayUp };
        const out = stepKbProgress({ geom, plan, ...inp }, st);
        st = out.state;
        return { in: inp, out };
      });
      cases.push({ name: `${name}#${v}`, pts, plan, steps });
    }
  }

  // the pure helpers on random stop/plan arrays: midnight wraps and big backward plan jumps, unplaced stops,
  // positions around the origin (ORIGIN_TOL_M) and around upstream's next stop (PASS_TOL_M / STALE_PAST_M)
  const helpers = [];
  for (let k = 0; k < 800; k++) {
    const n = 2 + int(8);
    const stops: (number | null)[] = [];
    const plan: (number | null)[] = [];
    let s = 0;
    let p = int(86400);
    for (let i = 0; i < n; i++) {
      stops.push(rnd() < 0.15 ? null : s);
      plan.push(rnd() < 0.1 ? null : rnd() < 0.1 ? int(86400) : p % 86400);
      s += 50 + int(1500);
      p += 30 + int(400);
    }
    const d = rnd() < 0.25 ? rnd() * 60 : -100 + rnd() * (s + 200);
    const nextUp = rnd() < 0.2 ? null : int(n + 1) - 1;
    const base = plannedAt(stops, plan, d);
    const localSecs = base === null || rnd() < 0.2 ? int(86400) : Math.round(base + 86400 + (rnd() - 0.5) * 1200) % 86400;
    helpers.push({ stops, plan, d, nextUp, localSecs, planned: base, delay: scheduleDelay(stops, plan, d, localSecs), progress: progressAt(stops, d, nextUp) });
  }

  // trackAlong on random out-and-back routes (twin stops 5-60 m apart): cold starts that have to pick a leg
  // (COLD_MARGIN_S, the 60 m candidate merge, the distance term of the score), warm windows, lower bounds
  const K = 111_320 * Math.cos((49.8 * Math.PI) / 180);
  const P = (e: number, n: number): LatLng => [49.8 + n / 111_320, 19 + e / K];

  // sweeps across END_LEFT_M (a stale bus last placed x m before the terminus goes off the route) and END_NEAR_M
  // (a warm arrival y m to the side of the last stop) on a straight 3 km route, stops every km from 10:00
  {
    const pts = [0, 1000, 2000, 3000].map((e) => P(e, 0));
    const plan = [36000, 36120, 36240, 36360];
    const geom = straightGeom(pts)!;
    const run = (name: string, fixes: { at: LatLng; t: number }[]) => {
      let st: KbProgState | null = null;
      const steps = fixes.map(({ at, t }) => {
        const inp = { lat: at[0], lon: at[1], tEpoch: t, localSecs: 36300 + (t - 1000), vti: 0, nextUp: 1, delayUp: 300 };
        const out = stepKbProgress({ geom, plan, ...inp }, st);
        st = out.state;
        return { in: inp, out };
      });
      cases.push({ name, pts, plan, steps });
    };
    const around = (from: number, to: number, step: number, edge: number) => [
      ...Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step),
      ...[-3, -2, -1, -0.5, -0.2, -0.1, 0.1, 0.5, 1, 2].map((e) => edge + e),
    ];
    for (const x of around(80, 160, 4, 100)) run(`end-left-${x}`, [{ at: P(3000 - x, 3), t: 1000 }, { at: P(3000 - x, 3000), t: 1030 }]);
    for (const y of around(90, 150, 3, 120)) run(`end-near-${y}`, [{ at: P(2900, 3), t: 1000 }, { at: P(3000, y), t: 1010 }]);
  }
  const tracks = [];
  for (let k = 0; k < 2500; k++) {
    const len = 500 + int(2500);
    const twin = 5 + int(55);
    const m = 1 + int(5);
    const pts: (LatLng | null)[] = [];
    for (let i = 0; i <= m; i++) pts.push(P((len * i) / m, 0));
    for (let i = m - 1; i >= 0; i--) pts.push(P((len * i) / m, twin));
    if (rnd() < 0.2) pts[1 + int(pts.length - 2)] = null;
    const pace = 30 + int(200);
    const start = int(86400);
    const plan = pts.map((_, i) => (rnd() < 0.05 ? null : (start + i * pace) % 86400));
    const geom = straightGeom(pts);
    if (!geom) continue;
    const back = rnd() < 0.5;
    const x = rnd() * len;
    const off = rnd() < 0.05 ? 300 : (rnd() - 0.5) * 2 * (rnd() < 0.5 ? 10 : 45);
    const [lat, lon] = P(back ? len - x : x, (back ? twin : 0) + off);
    const along = back ? len + twin + x : x;
    const localSecs = (start + Math.round((along / (2 * len)) * pts.length * pace + (rnd() - 0.5) * 2 * pace * (1 + int(4))) + 86400) % 86400;
    const vti = rnd() < 0.15 ? null : int(pts.length + 1) - 1;
    const nextUp = rnd() < 0.15 ? null : vti === null ? int(pts.length) : Math.min(pts.length - 1, vti + int(2));
    const tEpoch = 1_790_000_000 + int(100_000);
    const prev = rnd() < 0.5 ? null : { D: Math.max(0, along + (rnd() - 0.6) * 400), t: tEpoch - int(260) };
    tracks.push({ pts, plan, lat, lon, tEpoch, localSecs, vti, nextUp, prev, out: trackAlong(geom, lat, lon, tEpoch, localSecs, plan, vti, nextUp, prev) });
  }

  // stepArrivals over random index walks: polls 5-125 s apart, steps of 0-6 stops and an occasional step back
  const arrivals = [];
  for (let k = 0; k < 80; k++) {
    let reached = -1 + int(3);
    let t = 1_790_000_000 + int(100_000);
    let st: KbArrivals | undefined;
    const steps = [];
    for (let i = 0; i < 40; i++) {
      reached = Math.max(-1, reached + (rnd() < 0.35 ? 0 : rnd() < 0.1 ? -1 : 1 + int(rnd() < 0.8 ? 2 : 6)));
      t += 5 + int(rnd() < 0.85 ? 60 : 120);
      const fixAt = t - int(10);
      st = stepArrivals(st, reached, t, fixAt);
      steps.push({ reached, t, fixAt, out: structuredClone(st) });
    }
    arrivals.push(steps);
  }
  write("kb_progress", { cases, helpers, tracks, arrivals }, 0);
})();

// lib/mzk-state.ts: random OnTime-shaped records (absent, null and wrongly typed fields included); every input goes
// through JSON first so TS and Rust read the same value
{
  let seed = 41;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const ABSENT = Symbol("absent");
  const rt = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const notStarted = [];
  for (let n = 0; n < 2000; n++) {
    const first = { lat: 49.6 + rnd() * 0.4, lon: 18.8 + rnd() * 0.4 };
    const off = pick([0, 50, 100, 300, 398, 399.5, 400.5, 402, 600, rnd() * 900]);
    const ang = rnd() * 2 * Math.PI;
    const fields: Record<string, unknown> = {
      orderInCourse: pick([0, 0, 0, 0, 1, 2, "0", null, -1, 0.5, ABSENT]),
      lastStopOrderNo: pick([null, null, 0, 0, 1, "0", ABSENT]),
      reachedMeters: pick([0, 5, 28, 29.9, 30, 30.1, 64, rnd() * 60, "5", null, ABSENT]),
      latitude: pick([first.lat + (off * Math.cos(ang)) / 111_320, first.lat + (off * Math.cos(ang)) / 111_320, "49.8", null, ABSENT]),
      longitude: pick([
        first.lon + (off * Math.sin(ang)) / (111_320 * Math.cos((first.lat * Math.PI) / 180)),
        first.lon + (off * Math.sin(ang)) / (111_320 * Math.cos((first.lat * Math.PI) / 180)),
        null,
        ABSENT,
      ]),
    };
    const rec = rt(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ABSENT)));
    const firstStop = rnd() < 0.8 ? first : null;
    notStarted.push({ rec, firstStop, out: isMzkNotStarted(rec, firstStop) });
  }
  const clamps = [];
  for (let n = 0; n < 800; n++) {
    const len = Math.floor(rnd() * 11);
    const planned = rt(Array.from({ length: len }, () => (rnd() < 0.2 ? null : 1_790_000_000_000 + Math.floor(rnd() * 40) * 30_000)));
    const fromIdx = pick([-1, 0, 0, 1, 2, 3, 5, 9, 2.5, Math.floor(rnd() * len)]);
    clamps.push({ planned, fromIdx, out: clampPlannedMonotone(planned, fromIdx), dip: hasPlannedDip(planned, fromIdx) });
  }
  const rows = [];
  for (let n = 0; n < 1500; n++) {
    const sched = 1_790_900_000_000 + Math.floor(rnd() * 86_400) * 1000;
    const inp = rt({
      scheduledDepartureSec: pick([0, 59, 86_399, 86_400, 90_061, -1, -61, 45_000.7, Math.floor(rnd() * 100_000) - 5_000]),
      scheduledDeparture: pick([sched, sched, 0]),
      realDeparture: pick([null, 0, sched + (Math.floor(rnd() * 4000) - 600) * 500, sched - 500, sched + 500, sched - 1500]),
      ...(rnd() < 0.5 ? { lack: rnd() < 0.3 } : {}),
      notStarted: rnd() < 0.4,
      firstScheduledMs: pick([null, sched - 300_000, sched + 120_000, sched - 500]),
      nowMs: sched + (Math.floor(rnd() * 4000) - 2000) * 500,
    });
    rows.push({ in: inp, out: mzkRowTiming(inp) });
  }
  write("mzk_state", { notStarted, clamps, rows }, 0);
}

// lib/route-info.ts, lib/mzk-shape.ts and finalizeShape (lib/shape-store.ts): random geometries and fixes; the
// shape rev is part of the wire id, so it must match byte for byte
{
  let seed = 53;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const int = (n: number) => Math.floor(rnd() * n);
  const rt = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const KX = 111_320 * Math.cos((49.8 * Math.PI) / 180);
  const at = (o: LatLng, east: number, north: number): LatLng => [o[0] + north / 111_320, o[1] + east / KX];
  // a random walk, sometimes folded back on itself 5-40 m to the side (out-and-back, U-turn, loop)
  const walk = (): LatLng[] => {
    const o: LatLng = [49.6 + rnd() * 0.4, 18.8 + rnd() * 0.4];
    const pts: LatLng[] = [o];
    let [x, y, h] = [0, 0, rnd() * 2 * Math.PI];
    for (let k = int(12) + 1; k > 0; k--) {
      h += (rnd() - 0.5) * 1.6;
      const len = 20 + rnd() * 600;
      x += len * Math.cos(h);
      y += len * Math.sin(h);
      pts.push(at(o, x, y));
    }
    if (rnd() < 0.5) {
      const side = 5 + rnd() * 35;
      const back = pts.slice(0, -1).reverse().map(([la, lo]) => [la + side / 111_320, lo] as LatLng);
      pts.push(at(pts[pts.length - 1], 0, side), ...back);
    }
    return rt(pts);
  };
  const geoms = [];
  const dist = [];
  for (let g = 0; g < 60; g++) {
    const pts = walk();
    const pl = preparePolyline(pts)!;
    const nStops = int(10) + 2;
    const stops = rt(
      Array.from({ length: nStops }, (_, k) => (rnd() < 0.15 ? null : Math.round((pl.length * k) / (nStops - 1) + (rnd() - 0.5) * 40))),
    );
    const src: ShapeSrc = pick(["osrm", "straight", "gtfs", "partial"]);
    geoms.push({ pts, stops, src });
    const geom = { pl, stops, rev: "000000", src };
    for (let n = 0; n < 60; n++) {
      const s = rnd() * pl.length;
      const pa = pointAt(pl, s);
      const off = pick([0, 3, 10, 30, 39, 41, 59, 61, 100, 149, 151, 300, rnd() * 200]);
      const ang = rnd() * 2 * Math.PI;
      const [lat, lon] = rt(at([pa.lat, pa.lon], off * Math.cos(ang), off * Math.sin(ang)));
      const vti = pick([null, null, -1, 0, int(nStops), int(nStops), nStops - 1, nStops + 2]);
      const next = pick([null, vti === null ? null : vti + 1, vti === null ? 1 : vti, vti === null ? 2 : vti + 3, int(nStops)]);
      const hint = pick([undefined, undefined, s, s - 30, s - 100, s + 20, s - 700, s + 700, rnd() * pl.length].map((h) => (h === undefined ? h : rt(h))));
      const aheadM = pick([undefined, kbAheadM(rnd() * 120), 2000]);
      const inp = { g, lat, lon, vti, next, ...(hint === undefined ? {} : { hint }), ...(aheadM === undefined ? {} : { aheadM }) };
      dist.push({ in: inp, out: kbDistAlong(geom, lat, lon, vti, next, hint, aheadM === undefined ? {} : { aheadM }) });
    }
  }
  const sched = [];
  for (let n = 0; n < 800; n++) {
    const len = int(9) + 1;
    let [c, t] = [0, rnd() < 0.2 ? 86_400 - int(600) : int(80_000)];
    const stops: Array<number | null> = [];
    const times: Array<number | null> = [];
    for (let k = 0; k < len; k++) {
      stops.push(rnd() < 0.1 ? null : c);
      times.push(rnd() < 0.1 ? null : t % 86_400);
      c += pick([0, 50, 300, 800, rnd() * 2000]);
      t += pick([0, 60, 60, 120, 180, 600]);
    }
    const d = pick([-5, 0, c / 2, rnd() * c, c, c + 10, stops[int(len)] ?? 0]);
    const inp = rt({ stops, times: rnd() < 0.1 ? times.slice(0, -1) : times, d });
    sched.push({ in: inp, out: schedSpeed(inp.stops, inp.times, inp.d) });
  }
  // EMA chains: each step feeds the previous answer back, as the pollers do (Math.exp parity)
  const speed = [];
  for (let n = 0; n < 150; n++) {
    let prev: number | null = pick([null, 8.5, rnd() * 25]);
    for (let k = 0; k < 10; k++) {
      const inp = rt({
        prevSpeed: prev,
        ...(rnd() < 0.05 ? {} : { prevMoveDs: pick([19.9, 20, 120, 20 + rnd() * 300, 20 + rnd() * 300]) }),
        ds: pick([19.9, 20, 150, rnd() * 600, 20 + rnd() * 300, 20 + rnd() * 300]),
        dt: pick([2.9, 3, 10, 12, 44.5, 45, 46, rnd() * 50, 6 + rnd() * 20, 6 + rnd() * 20]),
        prevHeldSec: pick([0, 0, 0, 0, 30, 31, rnd() * 40]),
        inStopZone: rnd() < 0.05,
      });
      const out = nextSpeed(inp.prevSpeed, inp.prevMoveDs, inp.ds, inp.dt, inp.prevHeldSec, inp.inStopZone);
      speed.push({ in: inp, out });
      if (out !== null) prev = out;
    }
  }
  const fix = [];
  for (let n = 0; n < 300; n++) {
    const prev = pick([undefined, { updatedAt: 1000 }, { fixAt: 990 + rnd() * 10, updatedAt: 1000 }]);
    const inp = rt({ ...(prev ? { prev } : {}), updatedAt: pick([990, 1000, 1010 + rnd() * 100, 1500]), moved: rnd() < 0.7, capSec: pick([30, 60, 2.5]) });
    fix.push({ in: inp, out: estimateFixAt(inp.prev, inp.updatedAt, inp.moved, inp.capSec) });
  }
  const junk = () => pick<unknown>(["49.8", null, true, undefined]);
  const course = () => {
    const pts = walk();
    const ll = ([latitude, longitude]: LatLng) => (rnd() < 0.05 ? { latitude: junk(), longitude } : { latitude, longitude });
    const cut = [0, ...Array.from({ length: int(5) }, () => int(pts.length)).sort((a, b) => a - b), pts.length - 1];
    const segments = cut.slice(1).map((e, k) => (rnd() < 0.05 ? pick([null, {}, { nodes: [] }]) : { nodes: pts.slice(cut[k], e + 1).map(ll) }));
    const stopCount = rnd() < 0.7 ? segments.length + 1 : int(segments.length + 3);
    const stopPoints = Array.from({ length: stopCount }, (_, k) => ll(at(pts[Math.min(pts.length - 1, cut[Math.min(k, cut.length - 1)])], rnd() * 30, rnd() * 30)));
    return rt(rnd() < 0.03 ? pick([{}, { segments: "x" }, { stopPoints }]) : { segments, stopPoints });
  };
  const mzkShapes = [];
  for (let n = 0; n < 150; n++) {
    const raw = course();
    mzkShapes.push({ in: raw, out: mzkShapeFromCourseDetails(raw) });
  }
  const remap = [];
  for (let n = 0; n < 800; n++) {
    const len = int(7);
    let c = 0;
    const stops = Array.from({ length: len }, () => (rnd() < 0.1 ? null : (c += rnd() * 900)));
    const segDist = Array.from({ length: len + pick([0, 0, 0, -1]) }, (_, k) => (k === 0 ? 0 : rnd() < 0.05 ? pick<unknown>([null, -3, "500"]) : rnd() * 900));
    const reached = pick([-1, 0, rnd() * 3000, rnd() * 3000, rnd() * 6000, 450]);
    const inp = rt({ reached, segDist, stops });
    remap.push({ in: inp, out: mzkRemapDist(inp.reached, inp.segDist as number[], inp.stops) });
  }
  const indices = [];
  for (let n = 0; n < 1000; n++) {
    const len = int(7);
    const syms = ["a", "b", "c", 2, "2", null, 0, "0"];
    const stopPoints = Array.from({ length: len }, () => (rnd() < 0.05 ? pick<unknown>([null, 3, {}]) : { symbol: pick(syms) }));
    const v = rt({
      onStopPoint: pick<unknown>([undefined, null, false, "", true, 0, "0", 2, "2", "a", "b", "c", "x"]),
      orderInCourse: pick<unknown>([undefined, null, -1, 0, 1, 2, 1.5, "1", len, len + 3]),
      nearestSymbolOrderNo: pick<unknown>([undefined, null, -1, 0, 1, 2, 3, 2.5, "2", len]),
      stopPoints: rnd() < 0.05 ? pick<unknown>([undefined, null, "x"]) : stopPoints,
    });
    indices.push({ in: v, out: mzkStopIndices(v as Parameters<typeof mzkStopIndices>[0]) });
  }
  const finals = [];
  for (let n = 0; n < 200; n++) {
    const pts = walk();
    const refs = Array.from({ length: int(8) }, () => (rnd() < 0.1 ? null : at(pts[int(pts.length)], (rnd() - 0.5) * 200, (rnd() - 0.5) * 200)));
    const src: ShapeSrc = pick(["osrm", "partial", "straight", "mzk", "gtfs"]);
    const inp = rt({ pts: rnd() < 0.03 ? pts.slice(0, 1) : pts, refs, src });
    finals.push({ in: inp, out: finalizeShape(inp.pts, inp.refs, inp.src) });
  }
  write("route_info", { geoms, dist, sched, speed, fix, mzkShapes, remap, indices, finals }, 0);
}

// lib/web-push.ts isPushSub: the URL allowlist (WHATWG parsing), UTF-16 lengths, Buffer's lenient base64url and the
// point encodings OpenSSL accepts (hybrid included). Imported late: lib/web-push loads lib/config, see the router block
void (async () => {
  const { isPushSub } = await import("../lib/web-push");
  const P = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const A = "BTBZMqHH6r4Tts7J_aSIgg";
  const raw = Buffer.from(P, "base64url");
  const b64 = (b: Buffer) => b.toString("base64url");
  const retag = (t: number) => b64(Buffer.concat([Buffer.from([t]), raw.subarray(1)]));
  const odd = raw[64] & 1;
  const E = "https://fcm.googleapis.com/fcm/send/x";
  const pad = (n: number) => E + "\u{1F600}".repeat((n - E.length) >> 1) + "a".repeat((n - E.length) & 1);
  const k = (p256dh: unknown, auth: unknown = A) => ({ p256dh, auth });
  const cases: [string, unknown][] = [
    ["ok", { endpoint: E, keys: k(P) }],
    ["apple", { endpoint: "https://web.push.apple.com/x", keys: k(P) }],
    ["wns", { endpoint: "https://wns2-par02p.notify.windows.com/w/?token=1", keys: k(P) }],
    ["mozilla", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys: k(P) }],
    ["http", { endpoint: "http://fcm.googleapis.com/x", keys: k(P) }],
    ["ip", { endpoint: "https://127.0.0.1/x", keys: k(P) }],
    ["suffix", { endpoint: "https://evilfcm.googleapis.com.example/x", keys: k(P) }],
    ["glued", { endpoint: "https://xfcm.googleapis.com/x", keys: k(P) }],
    ["port", { endpoint: "https://fcm.googleapis.com:8443/x", keys: k(P) }],
    ["port 443", { endpoint: "https://fcm.googleapis.com:443/x", keys: k(P) }],
    ["upper", { endpoint: "HTTPS://FCM.GoogleApis.com/x", keys: k(P) }],
    ["trailing dot", { endpoint: "https://fcm.googleapis.com./x", keys: k(P) }],
    ["userinfo", { endpoint: "https://u:p@fcm.googleapis.com/x", keys: k(P) }],
    ["spaces", { endpoint: "  https://fcm.googleapis.com/x\t", keys: k(P) }],
    ["backslash", { endpoint: "https:\\\\fcm.googleapis.com\\x", keys: k(P) }],
    ["ideographic dot", { endpoint: "https://fcm\u3002googleapis\u3002com/x", keys: k(P) }],
    ["not a url", { endpoint: "fcm.googleapis.com/x", keys: k(P) }],
    ["len 1024", { endpoint: E + "a".repeat(1024 - E.length), keys: k(P) }],
    ["len 1025", { endpoint: E + "a".repeat(1025 - E.length), keys: k(P) }],
    ["1024 utf-16 units", { endpoint: pad(1024), keys: k(P) }],
    ["1025 utf-16 units", { endpoint: pad(1025), keys: k(P) }],
    ["p256dh AAAA", { endpoint: E, keys: k("AAAA") }],
    ["auth AAAA", { endpoint: E, keys: k(P, "AAAA") }],
    ["auth spaced", { endpoint: E, keys: k(P, "BTBZ MqHH 6r4T ts7J _aSI gg") }],
    ["auth padded", { endpoint: E, keys: k(P, A + "==") }],
    ["auth number", { endpoint: E, keys: k(P, 1) }],
    ["auth missing", { endpoint: E, keys: { p256dh: P } }],
    ["p256dh standard alphabet", { endpoint: E, keys: k(raw.toString("base64")) }],
    ["p256dh split array", { endpoint: E, keys: k([P.slice(0, 40), P.slice(40)]) }],
    ["p256dh number", { endpoint: E, keys: k(12345) }],
    ["p256dh missing", { endpoint: E, keys: { auth: A } }],
    ["p256dh compressed", { endpoint: E, keys: k(retag(2 + odd).slice(0, 44)) }],
    ["p256dh hybrid", { endpoint: E, keys: k(retag(6 + odd)) }],
    ["p256dh hybrid wrong parity", { endpoint: E, keys: k(retag(7 - odd)) }],
    ["p256dh tag 5", { endpoint: E, keys: k(retag(5)) }],
    ["p256dh off curve", { endpoint: E, keys: k(b64(Buffer.concat([raw.subarray(0, 64), Buffer.from([raw[64] ^ 1])]))) }],
    ["p256dh trailing junk", { endpoint: E, keys: k(P + "A") }],
    ["keys array", { endpoint: E, keys: [P, A] }],
    ["keys null", { endpoint: E, keys: null }],
    ["keys string", { endpoint: E, keys: "x" }],
    ["endpoint number", { endpoint: 1, keys: k(P) }],
    ["null", null],
    ["array", [E]],
  ];
  write("web_push", cases.map(([name, v]) => ({ name, in: v, out: isPushSub(v) })));
})();

// lib/shared/departures.ts row normalisers (KB enrichKbRow, MZK mzkWireFields, rowKey) and lib/shared/alerts.ts.
// test/rust-vectors.test.ts reads the same files back through the TS, so client and server cannot drift apart.
{
  let seed = 29;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const rt = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const strs = [
    "5 min", "< 1 min", "<1 min", " 12 min ", "5 Min.", "0 min", "999 min", "1000 min", "007 min", "1 h 5 min", "",
    "min", "<2 min", "< 1min", "<1", " 3 min　", "3 min", "３ min", "23:12", "04:05", "4:05",
    " 23:59:30 ", "24:00", "23:60", "123:45", "12:345", "12:34:5", "12:34:", "12:34: ", "00:00", "12:30\n", "﻿1:07", "1:7", "12:3o",
    null, undefined, 5, true,
  ];
  // spring and autumn DST switches of 2026, Warsaw midnights, and plain days
  const anchors = [1_774_746_000, 1_774_742_400, 1_774_749_600, 1_792_890_000, 1_792_886_400, 1_792_893_600, 1_791_324_000, 1_791_000_000.5];
  const anchor = () => pick(anchors) + pick([0, -3600, 3600, -7200, 1800]) + Math.floor(rnd() * 600) + pick([0, 0.25, 0.999]);

  const rel = strs.map((s) => [s ?? null, parseRelMinutes(s)]);
  const clock = [];
  for (const s of strs) for (let i = 0; i < 4; i++) {
    const a = anchor();
    clock.push([s ?? null, a, parseClockNear(s, a)]);
  }
  for (let i = 0; i < 300; i++) {
    const a = anchor();
    const s = `${Math.floor(rnd() * 24)}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}`;
    clock.push([s, a, parseClockNear(s, a)]);
  }

  const directions = [
    JSON.parse('{"1":"Os. Polskie","2":"","1.5":"Half","__proto__":"Proto","0":"Zero","true":"T","x":5}'),
    ["Zero", "One"],
    {},
    null,
    "x",
    7,
    undefined,
  ];
  const kb = [];
  for (let i = 0; i < 400; i++) {
    const row: Record<string, unknown> = {};
    if (rnd() < 0.2) row.direction = pick(["Wapienica", "", 5, null]);
    if (rnd() < 0.15) row.row_key = "old";
    if (rnd() < 0.9) row.trip_execution_id = pick(["e1", "ZXhlYw==", "", null, 7]);
    if (rnd() < 0.9) row.trip_index = pick([0, 3, 12, null, "4"]);
    row.line_name = pick(["17", "119", "N1"]);
    row.time = pick(strs);
    row.static_time = pick(strs);
    row.time_diff = pick([0, 2, -1, 0.5, 1.25, -0.5, 2.5, -0.01, "3", null, undefined]);
    row.is_estimated = pick([true, false, "true", 1, undefined]);
    row.at_stop = pick([true, false, false, false, 1, undefined]);
    row.canceled = pick([true, false, false, undefined, "true"]);
    row.direction_id = pick([undefined, null, 1, "1", 2, 1.5, "__proto__", "toString", "0", 0, true, "length", "01", " 1"]);
    if (rnd() < 0.2) row.operator = "X";
    if (rnd() < 0.1) row.plan_ts = 1;
    const dirs = pick(directions);
    const a = anchor();
    kb.push({ row: rt(row), directions: dirs === undefined ? undefined : rt(dirs), anchor: a, out: rt(enrichKbRow(rt(row), dirs === undefined ? undefined : rt(dirs), a)) });
  }
  const anchorTs = [];
  for (let i = 0; i < 40; i++) {
    const local = pick(anchors) + Math.floor(rnd() * 100) + pick([0, 0.5]);
    const b = pick([local - 30, local + 119.9, local - 120, local + 120, local - 119.5, local + 500, "x", null, undefined, true]);
    anchorTs.push([b ?? null, local, kbAnchorTs(b, local)]);
  }

  const mzk = [];
  for (let i = 0; i < 200; i++) {
    const ms = Math.floor(pick(anchors)) * 1000 + Math.floor(rnd() * 3_600_000);
    const d: Record<string, unknown> = {
      courseId: pick([123, "77", 0, 1.5, null, undefined]),
      orderInCourse: pick([0, 4, null, undefined, "3"]),
      scheduledDeparture: pick([ms, ms, 0, -5, null, "1791000000000", undefined]),
      realDeparture: pick([ms + Math.floor(rnd() * 600_000) - 60_000, ms - 30_500, ms + 499, 0, null]),
      lack: pick([false, false, true, undefined, 0, 1, "", "false", null]),
      onStopPoint: pick([true, false]),
    };
    mzk.push({ d: rt(d), out: rt(mzkWireFields(rt(d) as never)) });
  }

  const keys = [];
  for (let i = 0; i < 60; i++) {
    const row: Record<string, unknown> = {};
    if (rnd() < 0.3) row.row_key = pick(["k", "", null, 0]);
    if (rnd() < 0.8) row.trip_execution_id = pick(["e", "", null, 0, 5]);
    if (rnd() < 0.8) row.trip_id = pick([12, "t", null, 0]);
    if (rnd() < 0.8) row.trip_index = pick([3, 0, null]);
    if (rnd() < 0.8) row.static_time = pick(["12:00", "5 min", "", null]);
    keys.push([rt(row), rowKey(rt(row) as TimingRow)]);
  }

  const alerts = [];
  const akeys = ["e1#3", "mzk:77#4", "gzm:t1#2", "e#3#12:00", "#"];
  for (let i = 0; i < 300; i++) {
    const now = 1_791_000_000 + Math.floor(rnd() * 1000) + pick([0, 0.5]);
    const plan = now + Math.floor(rnd() * 1500) - 300;
    const alert: Alert = {
      key: pick(akeys),
      designator: pick(["1234", "kb:12:3", "a b/c?d&e=f#", "Żywiec ąę", "~!*'()-_.", "\u{1f68c}", "gzm:5_1"]),
      stopName: pick(["Dworzec", "Os. Polskie NŻ"]),
      line: pick(["17", "N1", "M1"]),
      dest: pick(["Wapienica", "Katowice Brynów"]),
      leadMin: pick(ALERT_LEADS),
      until: rnd() < 0.1 ? now : plan + pick([1800, -400, 0]),
    };
    const rows: Record<string, unknown>[] = [];
    for (let j = 0, n = Math.floor(rnd() * 4); j < n; j++) {
      const row: Record<string, unknown> = {
        operator: pick(["KB", "MZK", "GZM"]),
        plan_ts: pick([plan, plan, null]),
        eta_ts: pick([plan + Math.floor(rnd() * 600) - 60 + pick([0, 0.5, 29]), null]),
        at_stop: rnd() < 0.15,
        canceled: rnd() < 0.15,
        not_started: rnd() < 0.15,
      };
      if (rnd() < 0.85) row.row_key = pick([alert.key, alert.key, "other"]);
      else Object.assign(row, { trip_execution_id: "e", trip_index: 3, static_time: "12:00" });
      rows.push(row);
    }
    const action = alertAction(alert, rows as TimingRow[], now);
    alerts.push({ alert, rows, now, action, message: alertMessage(alert, action) });
  }
  write("board_rows", { rel, clock, kb, anchor: anchorTs, mzk, keys }, 0);
  write("alerts", rt(alerts), 0);
}

// Number#toFixed, lib/shared/detours.ts and lib/shape-patterns.ts: the pattern key and wpSig name every stored road
// shape (output/shapes), so a drift here reroutes every pattern through OSRM.
{
  let seed = 31;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const fixed: Array<[number, number, string]> = [];
  for (const x of [0.015625, 49.015625, 2.5, -2.5, 0.5, -0.5, 1.5, 9.5, 99.5, -99.5, 0.125, 0.375, 1.005, -0, 0, 1e21, 1e20, 123.456, 9.999995, -0.000001, 49.703, 19.002])
    for (const d of [0, 1, 2, 5, 6]) fixed.push([x, d, x.toFixed(d)]);
  for (let i = 0; i < 400; i++) {
    const m = 1 + Math.floor(rnd() * 12);
    const x = (Math.floor(rnd() * 200) - 100 + (2 * Math.floor(rnd() * 2 ** (m - 1)) + 1) / 2 ** m) * pick([1, 1, -1]);
    const d = Math.floor(rnd() * 9);
    fixed.push([x, d, x.toFixed(d)]);
  }
  for (let i = 0; i < 200; i++) {
    const x = pick([49.8, 19.0, 49.95, 19.26]) + rnd() * 0.1;
    fixed.push([x, 5, x.toFixed(5)]);
  }

  const areas: LatLng[] = [[49.825, 19.0425], [49.95, 19.265]];
  const near: LatLng[] = [[49.823333, 19.034472], [49.820083, 19.029194], [49.9455, 19.2612], [49.9498, 19.2685]];
  const pt = (): LatLng => {
    if (rnd() < 0.15) {
      const w = pick(near);
      return [w[0] + (rnd() - 0.5) * 0.004, w[1] + (rnd() - 0.5) * 0.004];
    }
    const c = pick(areas);
    return [c[0] + (rnd() - 0.5) * 0.06, c[1] + (rnd() - 0.5) * 0.08];
  };
  const lines = ["121", "134", " 134\t", "141", "143", "999", "", undefined];
  const dirs = [undefined, "", "Hulanka", "BIELSKO-BIAŁA D.A."];
  const detours = [];
  for (let i = 0; i < 400; i++) {
    const points = Array.from({ length: Math.floor(rnd() * 9) }, pt);
    const line = pick(lines);
    const dir = pick(dirs);
    const res = injectDetourPoints(points, line, dir);
    detours.push({ points, line: line ?? null, dir: dir ?? null, out: res.points === points ? null : res.points, id: res.detour?.id ?? null });
  }
  // edges of the trigger box, a segment starting and ending at one point (the forward test ties)
  for (const points of [
    [[49.83, 19.06], [49.82, 19.04], [49.815, 19.04], [49.81, 19.04]],
    [[49.83, 19.06], [49.835, 19.05], [49.82, 19.03], [49.81, 19.02]],
    [[49.84, 19.06], [49.83, 19.055], [49.82, 19.04], [49.81, 19.04]],
    [[49.81, 19.04], [49.82, 19.04], [49.825, 19.045], [49.82, 19.04], [49.81, 19.04]],
  ] as LatLng[][]) {
    const res = injectDetourPoints(points, "121");
    detours.push({ points, line: "121", dir: null, out: res.points === points ? null : res.points, id: res.detour?.id ?? null });
  }
  const adjust = ["21181", "21231", "1", "", undefined].map((id) => [id ?? null, adjustStopRoutePoint(id, [49.8, 19.0])]);

  const stops: Record<string, ResolvedStop> = {};
  for (let id = 1; id <= 40; id++) {
    const [lat, lon] = pt();
    stops[id] = { id: String(id), lat, lon };
  }
  stops[21181] = { id: "21181", lat: 49.703, lon: 19.002 };
  stops[21231] = { id: "21231", lat: 49.7005, lon: 18.9965 };
  // on the Osiek via-points: the detour applies as a banner only
  stops[41] = { id: "41", lat: 49.9455, lon: 19.2612 };
  stops[42] = { id: "42", lat: 49.9498, lon: 19.2685 };
  const ids = Object.keys(stops).map(Number);
  const resolve = (t: Record<string, unknown>): ResolvedStop | null =>
    typeof t.designator === "number" && Object.hasOwn(stops, t.designator) ? stops[t.designator] : null;
  const patterns = [];
  for (let i = 0; i < 300; i++) {
    const times = Array.from({ length: Math.floor(rnd() * 10) }, () =>
      pick<unknown>([{ designator: pick(ids) }, { designator: pick(ids) }, { designator: pick(ids) }, { designator: "5" }, null, 5, [], {}]),
    );
    const line = pick(lines) ?? "17";
    const dir = pick(dirs) ?? "X";
    patterns.push({ times, line, dir, out: buildKbPattern(times, line, dir, resolve) });
  }
  for (const line of ["141", "999"]) {
    const times = [{ designator: 41 }, { designator: 42 }];
    patterns.push({ times, line, dir: "", out: buildKbPattern(times, line, "", resolve) });
  }

  const feed = {
    "routes.txt": 'route_id,route_short_name\r\nR1,17\r\nR2,"1,7"\r\nR3\r\n',
    "trips.txt":
      'route_id,service_id,trip_id,trip_headsign\nR1,S,100_KB_SAT,Wapienica\nR1,S,100_KB_SUN,Other\nR2,S,200,"Os. ""Polskie"""\n' +
      "R3,S,300,\nR9,S,400,Ghost\nR1,S,_500,Lead\n\nR1,S,600,Wapienica\nR1,S,800,Wapienica\nR1,S,900,Far\nR1,S,950,Shuffled\n",
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
      ["100_KB_SAT,,,11,0", "100_KB_SAT,,,12,1", "100_KB_SUN,,,13,1", "100_KB_SUN,,,x,0", "200,,,21,0", "200,,,23,2",
        "300,,,31,1.5", "300,,,32,-1", "300,,,33,501", "300,,,34, 3 ", "300,,,,4", "300,,,0x1F,5", "300,,,abc,6",
        "400,,,41,0", "400,,,42,1", "_500,,,51,0", "_500,,,52,1", "600,,,11,0", "600,,,13,1", "700,,,71,0", "800,,,11,0",
        "800,,,13,1", "800,,,1.5,2", "800,,,-0,3", "800,,,1e3,4", "900,,,91,0", "900,,,92,500",
        // duplicate sequences in shuffled order: only a stable sort keeps the last row per sequence
        ...Array.from({ length: 60 }, (_, i) => `950,,,${100 + i},${(i * 7) % 30}`)].join("\r\n") + "\r\n",
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-seeds-"));
  for (const [name, text] of Object.entries(feed)) fs.writeFileSync(path.join(dir, name), text);
  const crafted = readGtfsPatternSeeds(dir);
  fs.rmSync(dir, { recursive: true });
  const fixture = readGtfsPatternSeeds(path.join("test", "fixtures", "gtfs"));
  const raw = ["35678182_KB_SATURDAY", "35678182", "_5", "", "a_b_c"].map((t) => [t, rawTripId(t)]);

  write("shape_patterns", { fixed, detours, adjust, stops, patterns, feed, crafted, fixture, raw }, 0);
}

// lib/lines.ts, lib/gtfs-trips.ts, lib/stop-directions.ts: the three feed readers on the fixture feed and on crafted
// feeds (CRLF, quotes, short rows, BOM headers, missing columns, odd stop_sequence cells, station names, seeded hubs
// whose trips leave the main way and the opposite way in varying numbers). Dynamic imports: lib/config must load after
// the router block set KB_GTFS_DIR.
void (async () => {
  const { readLines } = await import("../lib/lines");
  const { readGtfsTrips } = await import("../lib/gtfs-trips");
  const { readStopDirections } = await import("../lib/stop-directions");
  let seed = 37;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const int = (n: number) => Math.floor(rnd() * n);
  const read = (dir: string) => ({
    lines: readLines(dir),
    trips: Object.fromEntries(readGtfsTrips(dir)),
    dirs: Object.fromEntries(readStopDirections(dir)),
  });

  const edge: Record<string, string> = {
    "routes.txt": [
      "route_id,agency_id,route_short_name,route_long_name",
      "L_10,KB,10,KANIÓW", "L_2,KB,2,\"BYSTRA, SZKOŁA\"", ",KB,7,NO ID", "L_X,KB,,NO NAME", "L_S,KB,8",
      "L_1A,KB,1A,A", "L_01,KB,01,B", "L_N1,KB,N1,C", "L_Z,KB,Ż1,D", "L_a,KB,a,E", "L_B,KB,B,F", "L_10b,KB,10,DUP",
      "", "L_100,KB,100,\"Q \"\"X\"\"\"",
    ].join("\r\n"),
    "trips.txt": [
      "route_id,service_id,trip_id,trip_headsign,trip_short_name",
      "L_5,KB_SAT,123_KB_SAT,A,", "L_5,KB_SAT,124_KB_X,B,", "L_5,S,_S,C,", "X_L_5,S,200,D,", "L_,S,201,E,",
      "L_,S,202,F,", "L_7,S,202,G,", "L_7,S,202,H,77", "L_9,KB_SUN,123_KB_SUN,I,9", "L_9", "L_9,S,203",
      "L_9,S,,J,9", "L_9,S,\"204,5\",\"K, L\",9", "L_9,,205_,M,", "L_1,KB,300_KB,N,1x", "L_L_5,S,206,O,",
    ].join("\r\n"),
    "stops.txt": [
      "stop_id,stop_name,stop_lat,stop_lon,location_type",
      "1,PLAIN,49.800000,19.000000,0", "2,EAST,49.800000,19.010000,0", "3,NORTH,49.810000,19.000000,0",
      "4,BIELSKO-BIAŁA D.A.,49.805000,19.005000,0", "5,KĘTY D.A,49.806000,19.006000,0",
      "6,X (D.A.),49.807000,19.007000,0", "7,dworzec  autobusowy,49.808000,19.008000,0",
      "8,Dworzec Autobusowy Bystra,49.809000,19.009000,0", "9,XD.A.,49.801000,19.001000,0",
      "10,D.A.B,49.802000,19.002000,0", "11,a.D.A.,49.803000,19.003000,0", "12,DWORZEC AUTOBUSOWYX,49.804000,19.004000,0",
      "13,HUB,49.799000,18.999000,1", "14,EMPTY LAT,,19.000000,0", "15,NAN,abc,19.000000,0", "16,SHORT,49.79",
      "17,DUP,49.700000,19.000000,0", "17,DUP,49.790000,19.020000,0", ",NO ID,49.8,19.0,0", "18,\"Q, D.A.\",49.811,19.011,0",
      "19,D.A.),49.812,19.012,0", "20,(DWORZEC\tAUTOBUSOWY),49.813,19.013,0", "21,D.A..,49.814,19.014,0",
      "22, 49.815 ,  49.815 , 19.015 ,0", "23,KĘTY D.A.\u2003X,49.816,19.016,0", "24,DWORZECAUTOBUSOWY,49.817,19.017,0",
      "30,M0,49.75,19.1", "31,M1,49.76,19.1", "32,M2,49.76,19.11", "33,N0,49.74,19.1", "34,N1,49.74,19.12", "35,L0,49.73,19.1",
      // 40: one trip at ~52 degrees, its mirror at ~308 and one due north, which is 52 off both cluster means
      "40,T,49.9,19.5", "41,,49.89,19.48", "42,,49.91,19.52", "43,,49.89,19.52", "44,,49.91,19.48", "45,,49.89,19.5",
      "46,,49.91,19.5",
    ].join("\r\n"),
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "a,,,1,0", "a,,,2,1", "a,,,3,2", "b,,,3,0", "b,,,1,1", "b,,,2,2", "c,,,2,5", "c,,,1,0x1", "c,,,17,1e1",
      "d,,,1,", "d,,,2,1.5", "d,,,3, 2 ", "d,,,1,-1", "e,,,1,0", "e,,,1,1", "e,,,2,2", "f,,,1,0", "f,,,9,1", "f,,,2,2",
      "g,,,4,0", "g,,,5,1", "g,,,6,2", "g,,,7,3", "g,,,8,4", "g,,,9,5", "g,,,10,6", "g,,,11,7", "g,,,12,8", "g,,,13,9",
      "g,,,18,10", "g,,,19,11", "g,,,20,12", "g,,,21,13", "g,,,22,14", "g,,,1,15", "h,,,14,0", "h,,,15,1", "h,,,16,2",
      "h,,,99,3", "h,,,3,4", "i,,,2,1", "i,,,3,1", "i,,,1,1", ",,,1,0", "j,,,,0", "j,,,2,x", "k,,,3,0",
      "g,,,23,16", "g,,,24,17", "g,,,2,18", "l,,,35,0", "l,,,14,1", "m,,,30,0", "m,,,31,", "m,,,32,1", "n,,,34,0",
      "n,,,33,-0", "o1,,,41,0", "o1,,,40,1", "o1,,,42,2", "o2,,,43,0", "o2,,,40,1", "o2,,,44,2", "o3,,,45,0", "o3,,,40,1",
      "o3,,,46,2",
    ].join("\r\n"),
  };
  const sparse: Record<string, string> = {
    "routes.txt": "route_short_name,route_id\n5,L_5\n4,L_4\n",
    "trips.txt": "trip_id,route_id\n1,L_5\n2,5\n3,L_\n",
    "stops.txt": "stop_lat,stop_lon,stop_id\n49.8,19.0,a\n49.81,19.0,b\n49.82,19.01,c\n",
    "stop_times.txt": "stop_sequence,stop_id,trip_id\n0,a,t\n1,b,t\n2,c,t\n",
  };
  const bom: Record<string, string> = Object.fromEntries(Object.entries(sparse).map(([k, v]) => [k, `﻿${v}`]));
  const routesOnly: Record<string, string> = { "routes.txt": "route_id,route_short_name\nL_1,1\n", "stops.txt": "stop_id\n" };
  const empty: Record<string, string> = { "routes.txt": "", "trips.txt": "", "stops.txt": "", "stop_times.txt": "" };

  // hubs: `main` trips through the hub at one heading, `opp` 60-180 degrees off it, `noise` anywhere
  const hubStops: string[] = ["stop_id,stop_name,stop_lat,stop_lon"];
  const hubTimes: string[] = ["trip_id,stop_id,stop_sequence"];
  const hubTrips: string[] = ["route_id,service_id,trip_id,trip_headsign,trip_short_name"];
  let next = 1000;
  for (let h = 0; h < 60; h++) {
    const lat = 49.7 + int(3000) / 10000;
    const lon = 18.9 + int(3000) / 10000;
    hubStops.push(`H${h},HUB ${h},${lat.toFixed(6)},${lon.toFixed(6)}`);
    const heading = int(360);
    const groups: Array<[number, number]> = [
      [1 + int(25), heading],
      [int(7), heading + 60 + int(241)],
      [int(4), int(360)],
    ];
    for (const [n, base] of groups) {
      for (let k = 0; k < n; k++) {
        const a = ((base + int(41) - 20) * Math.PI) / 180;
        const d = 0.002 + int(20) / 10000;
        const trip = `${int(1000)}t${next++}`;
        const [p, q] = [`p${next}`, `q${next}`];
        hubStops.push(`${p},P,${(lat - d * Math.cos(a)).toFixed(6)},${(lon - d * Math.sin(a)).toFixed(6)}`);
        hubStops.push(`${q},Q,${(lat + d * Math.cos(a)).toFixed(6)},${(lon + d * Math.sin(a)).toFixed(6)}`);
        const calls = int(5) === 0 ? [`H${h}`, q] : int(5) === 0 ? [p, `H${h}`] : [p, `H${h}`, q];
        // shuffled rows: the reader orders a trip by stop_sequence, file order breaks ties
        const rows = calls.map((s, i) => `${trip},${s},${i * (1 + int(3))}`);
        for (let i = rows.length - 1; i > 0; i--) {
          const j = int(i + 1);
          [rows[i], rows[j]] = [rows[j], rows[i]];
        }
        hubTimes.push(...rows);
        hubTrips.push(`L_${int(40)},S${int(3)},${int(4) === 0 ? `${trip}_S1` : trip},HEAD ${int(9)},${int(3) === 0 ? "" : int(40)}`);
      }
    }
  }
  const hubs: Record<string, string> = {
    "routes.txt": `route_id,route_short_name,route_long_name\n${Array.from({ length: 40 }, (_, i) => `L_${i},${int(3) === 0 ? `N${int(4)}` : int(12)},T${i}`).join("\n")}\n`,
    "trips.txt": `${hubTrips.join("\n")}\n`,
    "stops.txt": `${hubStops.join("\n")}\n`,
    "stop_times.txt": `${hubTimes.join("\n")}\n`,
  };

  const feeds = [edge, sparse, bom, routesOnly, empty, hubs].map((files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tables-"));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const out = { files, ...read(dir) };
    fs.rmSync(dir, { recursive: true });
    return out;
  });
  write("gtfs_tables", { fixture: read(path.join("test", "fixtures", "gtfs")), feeds }, 0);
})();
