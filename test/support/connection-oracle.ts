/**
 * Brute-force reference for lib/router.ts, written without its data structures: it reads the GTFS feed and
 * the MZK timetable file itself, scans every trip instance of D-1/D/D+1 in every round and recomputes the
 * earliest arrival from scratch for each departure time. Same rules as the router: a transfer at one pole
 * takes `change` secs, a walk to a pole <= 350 m away takes max(change, walk + 90 s) (poles < 4 m apart: no walk),
 * no walking at either end.
 */
import fs from "node:fs";
import path from "node:path";

import { col, parseCsvLine, splitLines } from "../../lib/gtfs-csv";
import type { ConnectionItinerary } from "../../lib/router";

interface Instance {
  tripId: string;
  stops: number[];
  arr: number[];
  dep: number[];
}

export interface OracleNet {
  ids: string[];
  num: Map<string, number>;
  names: string[];
  instances: Instance[];
  foot: { to: number; secs: number }[][];
}

export interface ProfileEntry {
  dep: number;
  arr: number;
  transfers: number;
}

const INF = Number.MAX_SAFE_INTEGER;

function csv(file: string): Record<string, string>[] {
  const lines = splitLines(fs.readFileSync(file, "utf-8"));
  const hdr = parseCsvLine(lines[0]);
  return lines.slice(1).flatMap((line) => {
    if (!line) return [];
    const f = parseCsvLine(line);
    return [Object.fromEntries(hdr.map((h) => [h, f[col(hdr, h)] ?? ""]))];
  });
}

function secs(hms: string): number {
  const [h, m, s] = hms.split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function isoShift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fixTimes(times: [number, number][]): [number, number][] {
  let wrap = 0;
  let prev = -INF;
  return times.map(([a, d]) => {
    let arr = a + wrap;
    if (arr < prev - 43200) {
      wrap += 86400;
      arr += 86400;
    }
    arr = Math.max(arr, prev);
    prev = Math.max(d + wrap, arr);
    return [arr, prev];
  });
}

/** The network of service day `date`: trip instances of the day before (times -24 h), the day and the day after (+24 h). */
export function loadOracleNet(gtfsDir: string, mzkFile: string | null, date: string): OracleNet {
  const ids: string[] = [];
  const num = new Map<string, number>();
  const names: string[] = [];
  const coords: [number, number][] = [];
  const id = (s: string): number => {
    let n = num.get(s);
    if (n === undefined) {
      n = ids.length;
      ids.push(s);
      num.set(s, n);
      names.push(s);
      coords.push([0, 0]);
    }
    return n;
  };
  for (const s of csv(path.join(gtfsDir, "stops.txt"))) {
    const n = id(s.stop_id);
    names[n] = s.stop_name;
    coords[n] = [Number(s.stop_lat) || 0, Number(s.stop_lon) || 0];
  }
  type Mzk = { calendar: Record<string, string>; stops: Record<string, [string, number, number]>; trips: { id: string; dayType: string; calls: [string, number][] }[] };
  const mzk: Mzk | null = mzkFile && fs.existsSync(mzkFile) ? JSON.parse(fs.readFileSync(mzkFile, "utf-8")) : null;
  for (const [sym, [name, lat, lon]] of Object.entries(mzk?.stops ?? {})) {
    const n = id(`mzk:${sym}`);
    names[n] = name;
    coords[n] = [lat, lon];
  }

  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const calendar = new Map(csv(path.join(gtfsDir, "calendar.txt")).map((c) => [c.service_id, c]));
  const service = new Map(csv(path.join(gtfsDir, "trips.txt")).map((t) => [t.trip_id, t.service_id]));
  const kb = new Map<string, { seq: number; stop: string; arr: number; dep: number }[]>();
  for (const st of csv(path.join(gtfsDir, "stop_times.txt"))) {
    if (!service.has(st.trip_id)) continue;
    let list = kb.get(st.trip_id);
    if (!list) kb.set(st.trip_id, (list = []));
    list.push({ seq: Number(st.stop_sequence), stop: st.stop_id, arr: secs(st.arrival_time || st.departure_time), dep: secs(st.departure_time) });
  }

  const instances: Instance[] = [];
  const add = (tripId: string, stops: string[], times: [number, number][], off: number): void => {
    if (stops.length < 2) return;
    const fixed = fixTimes(times);
    instances.push({ tripId, stops: stops.map(id), arr: fixed.map(([a]) => a + off), dep: fixed.map(([, d]) => d + off) });
  };
  for (let o = -1; o <= 1; o++) {
    const day = isoShift(date, o);
    const weekday = weekdays[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7];
    for (const [tripId, list] of kb) {
      const cal = calendar.get(service.get(tripId) ?? "");
      if (cal && cal[weekday] !== "1") continue;
      list.sort((a, b) => a.seq - b.seq);
      add(tripId, list.map((s) => s.stop), list.map((s) => [s.arr, s.dep]), o * 86400);
    }
    for (const t of mzk?.trips ?? []) {
      if (mzk?.calendar[day] !== t.dayType) continue;
      add(t.id, t.calls.map(([sym]) => `mzk:${sym}`), t.calls.map(([, s]) => [s, s]), o * 86400);
    }
  }

  const foot = ids.map((): { to: number; secs: number }[] => []);
  for (let a = 0; a < ids.length; a++) {
    for (let b = 0; b < ids.length; b++) {
      const [la, oa] = coords[a];
      const [lb, ob] = coords[b];
      if (a === b || !la || !oa || !lb || !ob) continue;
      const dy = (lb - la) * 111320;
      const dx = (ob - oa) * 111320 * Math.cos(((la + lb) / 2) * (Math.PI / 180));
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 350) foot[a].push({ to: b, secs: d < 4 ? 0 : 60 * Math.max(1, Math.ceil(d / 1.1 / 60)) });
    }
  }
  return { ids, num, names, instances, foot };
}

/** Earliest arrival at every stop (`[k][stop]`) with at most k rides, leaving the origins at or after `tau`. */
export function earliestAll(net: OracleNet, origins: number[], tau: number, rides: number, change = 180): number[][] {
  const n = net.ids.length;
  let ready = new Array<number>(n).fill(INF);
  let best = new Array<number>(n).fill(INF);
  for (const o of origins) ready[o] = tau;
  const out = [best];
  for (let k = 1; k <= rides; k++) {
    const arr = best.slice();
    for (const inst of net.instances) {
      let on = false;
      for (let p = 0; p < inst.stops.length; p++) {
        if (on && inst.arr[p] < arr[inst.stops[p]]) arr[inst.stops[p]] = inst.arr[p];
        if (p < inst.stops.length - 1 && ready[inst.stops[p]] <= inst.dep[p]) on = true;
      }
    }
    const next = ready.slice();
    for (let s = 0; s < n; s++) {
      if (arr[s] >= INF) continue;
      next[s] = Math.min(next[s], arr[s] + change);
      for (const f of net.foot[s]) next[f.to] = Math.min(next[f.to], arr[s] + Math.max(change, f.secs + 90));
    }
    best = arr;
    ready = next;
    out.push(arr);
  }
  return out;
}

/** Departures from the origin poles in [after, after + 24 h), ascending, closed by after + 24 h itself. */
export function departures(net: OracleNet, origins: number[], after: number): number[] {
  const isOrigin = new Set(origins);
  const taus = new Set<number>();
  for (const inst of net.instances) {
    for (let p = 0; p < inst.stops.length - 1; p++) {
      if (isOrigin.has(inst.stops[p]) && inst.dep[p] >= after && inst.dep[p] < after + 86400) taus.add(inst.dep[p]);
    }
  }
  return [...[...taus].sort((a, b) => a - b), after + 86400];
}

/** Pareto entries leaving at `tau`, from the best arrivals per ride count at `tau` (`cur`) and at the next departure (`next`). */
export function entriesAt(tau: number, cur: number[], next: number[], rides: number): ProfileEntry[] {
  const here: ProfileEntry[] = [];
  for (let k = 1; k <= rides; k++) {
    if (cur[k] < INF && cur[k] < cur[k - 1] && cur[k] < next[k]) here.push({ dep: tau, arr: cur[k], transfers: k - 1 });
  }
  return here.sort((a, b) => a.arr - b.arr);
}

/** Stop numbers of every pole sharing the cleaned name of one of `ids` (the router's pole resolution for stop ids). */
export function polesOf(net: OracleNet, ids: string[], clean: (s: string) => string): number[] {
  const keys = new Set(ids.map((s) => clean(net.names[net.num.get(s) ?? -1] ?? s)));
  return net.ids.flatMap((_, i) => (keys.has(clean(net.names[i])) ? [i] : []));
}

/**
 * The first `limit` Pareto-optimal (later departure, earlier arrival, fewer transfers) journeys leaving in
 * [after, after + 24 h), ordered like the router (departure, arrival, transfers).
 */
export function oracleProfile(
  net: OracleNet,
  origins: number[],
  targets: number[],
  after: number,
  limit: number,
  rides = 5,
  change = 180,
): ProfileEntry[] {
  const taus = departures(net, origins, after);
  const atTargets = (tau: number): number[] =>
    earliestAll(net, origins, tau, rides, change).map((arr) => Math.min(...targets.map((t) => arr[t])));
  const out: ProfileEntry[] = [];
  let cur = taus.length > 1 ? atTargets(taus[0]) : [];
  for (let i = 0; i + 1 < taus.length && out.length < limit; i++) {
    const next = atTargets(taus[i + 1]);
    out.push(...entriesAt(taus[i], cur, next, rides));
    cur = next;
  }
  return out.slice(0, limit);
}

/** Why `it` is not a journey of `net` from `origins` to `targets` leaving at or after `after`, or null when it is one. */
export function infeasible(net: OracleNet, it: ConnectionItinerary, origins: number[], targets: number[], after: number, change = 180): string | null {
  if (it.departureSecs < after) return `leaves ${it.departureSecs} before ${after}`;
  if (it.legs.length !== it.transfersCount + 1) return "legs != transfers + 1";
  for (let i = 0; i < it.legs.length; i++) {
    const leg = it.legs[i];
    const from = net.num.get(leg.fromStopId) ?? -1;
    const to = net.num.get(leg.toStopId) ?? -1;
    const ride = net.instances.some((inst) => {
      if (inst.tripId !== leg.tripId) return false;
      for (let b = 0; b < inst.stops.length; b++) {
        if (inst.stops[b] !== from || inst.dep[b] !== leg.departureSecs) continue;
        for (let a = b + 1; a < inst.stops.length; a++) {
          if (inst.stops[a] === to && inst.arr[a] === leg.arrivalSecs && a - b === leg.stopsCount) return true;
        }
      }
      return false;
    });
    if (!ride) return `leg ${i} (${leg.line} ${leg.tripId} ${leg.fromStopId}->${leg.toStopId}) is no ride of the timetable`;
    if (i === 0 && !origins.includes(from)) return "first leg does not start at an origin pole";
    if (i === it.legs.length - 1 && !targets.includes(to)) return "last leg does not end at a target pole";
    if (i === 0) continue;
    const prev = it.legs[i - 1];
    const at = net.num.get(prev.toStopId) ?? -1;
    const walk = at === from ? 0 : net.foot[at]?.find((f) => f.to === from)?.secs;
    if (walk === undefined) return `transfer ${i}: ${prev.toStopId} -> ${leg.fromStopId} is not walkable`;
    const need = walk === 0 ? change : Math.max(change, walk + 90);
    if (leg.departureSecs - prev.arrivalSecs < need) return `transfer ${i}: ${leg.departureSecs - prev.arrivalSecs} s < ${need} s`;
  }
  return null;
}
