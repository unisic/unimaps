/**
 * The line view's model, zbiorkom-style: a line's stop patterns (GET /api/line) folded into at most two directions,
 * each one stop list merged from all of its patterns (the busiest is the trunk, the others' own stops are branch
 * rows), every course's departure at each row, and the line's live vehicles placed between the rows.
 */
import type { LineInfo, LineVariant, Vehicle } from "./types";

/** A live vehicle of `line` (BB: the operator decides, the same number may exist at KB and MZK; another
 *  operator's vehicle in a zbiorkom city carries `agency` and its own numbering). */
export function onLine(v: Vehicle, line: Pick<LineInfo, "name" | "operator">): boolean {
  return !v.agency && v.line === line.name && (v.operator === "MZK") === (line.operator === "MZK");
}

export interface LineRow {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
  /** on the busiest pattern; false = only some courses stop here */
  trunk: boolean;
  /** every course's departure here (minutes from the date's midnight, sorted); a pattern's last stop adds none */
  times: number[];
}

export interface LineDirection {
  /** indices into the variants, busiest first: [0] is the trunk */
  variants: number[];
  headsign: string;
  rows: LineRow[];
  /** per entry of `variants`, its stop index -> row index */
  rowOf: number[][];
}

/** Net count of consecutive shared stops `v` passes in `m`'s order (+) or against it (-). */
function travel(v: LineVariant, m: LineVariant): number {
  const pos = new Map<string, number>();
  m.stops.forEach((s, i) => {
    if (!pos.has(s.id)) pos.set(s.id, i);
  });
  let prev = -1;
  let net = 0;
  for (const s of v.stops) {
    const p = pos.get(s.id);
    if (p == null) continue;
    if (prev >= 0 && p !== prev) net += p > prev ? 1 : -1;
    prev = p;
  }
  return net;
}

/** Variant indices per direction (busiest first): the busiest pattern's way, then the busiest one that does not
 *  run along it; a loop line has one. The feeds carry no direction id, so the stop order decides. */
export function splitDirections(vs: readonly LineVariant[]): number[][] {
  if (vs.length === 0) return [];
  const a = [0];
  let b: number[] | null = null;
  for (let i = 1; i < vs.length; i++) {
    const ta = travel(vs[i], vs[0]);
    if (!b) {
      if (ta > 0) a.push(i);
      else b = [i];
      continue;
    }
    (ta >= travel(vs[i], vs[b[0]]) ? a : b).push(i);
  }
  return b ? [a, b] : [a];
}

/** One direction's merged stop list: the trunk's stops, each other pattern's own stops inserted after the last
 *  stop it shares with the list so far (before the first one for a pattern that starts elsewhere). */
export function buildDirection(vs: readonly LineVariant[], idxs: readonly number[]): LineDirection {
  const trunk = vs[idxs[0]];
  const order: LineRow[] = trunk.stops.map((s) => ({ ...s, trunk: true, times: [] }));
  const mine: LineRow[][] = [order.slice()];
  for (const vi of idxs.slice(1)) {
    const rows: LineRow[] = [];
    let at = -1;
    for (const s of vs[vi].stops) {
      let j = order.findIndex((r, k) => k > at && r.id === s.id);
      if (j < 0) {
        j = at + 1;
        order.splice(j, 0, { ...s, trunk: false, times: [] });
      }
      rows.push(order[j]);
      at = j;
    }
    mine.push(rows);
  }
  const index = new Map(order.map((r, i) => [r, i]));
  idxs.forEach((vi, n) => {
    const v = vs[vi];
    const last = v.stops.length - 1;
    for (const t of v.times) for (let p = 0; p < last; p++) mine[n][p].times.push(t[p]);
  });
  for (const r of order) r.times.sort((x, y) => x - y);
  return {
    variants: [...idxs],
    headsign: trunk.headsign || trunk.stops[trunk.stops.length - 1]?.name || "",
    rows: order,
    rowOf: mine.map((rows) => rows.map((r) => index.get(r) ?? 0)),
  };
}

/** A router trip id as a vehicle names it: an MZK course without its `:<variant>` tail. */
function courseKey(id: string): string {
  if (!id.startsWith("mzk:")) return id;
  const cut = id.indexOf(":", 4);
  return cut < 0 ? id : id.slice(0, cut);
}

/** The router trip a live vehicle serves (KB: its static timetable trip, MZK: its course, zbiorkom: its trip). */
function vehicleKey(v: Vehicle): string {
  if (v.operator === "MZK") return `mzk:${v.trip_id}`;
  return v.sched_trip_id || v.trip_id;
}

/** 0..1 along a -> b of p (equirectangular, fine over a few hundred metres) */
function along(a: { lat: number; lon: number }, b: { lat: number; lon: number }, p: { lat: number; lon: number }): number {
  const k = Math.cos((a.lat * Math.PI) / 180);
  const bx = (b.lon - a.lon) * k;
  const by = b.lat - a.lat;
  const len = bx * bx + by * by;
  if (len === 0) return 0;
  const f = (((p.lon - a.lon) * k) * bx + (p.lat - a.lat) * by) / len;
  return Math.min(1, Math.max(0, f));
}

export interface Bead {
  v: Vehicle;
  /** fractional row index: 3 = at row 3, 2.5 = halfway from row 2 to row 3 */
  at: number;
}

/** The direction's live vehicles on its rows, by the trip each one serves (one serving another pattern or
 *  direction, or none, is left out). The next stop is the pattern's stop of that name nearest the vehicle's
 *  sequence hint; between it and the one before, the vehicle sits where its fix projects. */
export function placeVehicles(vs: readonly LineVariant[], dir: LineDirection, vehicles: readonly Vehicle[]): Bead[] {
  const byTrip = new Map<string, number>();
  dir.variants.forEach((vi, n) => {
    for (const id of vs[vi].trips ?? []) byTrip.set(courseKey(id), n);
  });
  const out: Bead[] = [];
  for (const v of vehicles) {
    const n = byTrip.get(vehicleKey(v));
    if (n == null) continue;
    const stops = vs[dir.variants[n]].stops;
    const rowOf = dir.rowOf[n];
    if (v.not_started) {
      out.push({ v, at: rowOf[0] });
      continue;
    }
    const hint = v.next_stop_seq ?? (v.current_stop_sequence != null ? v.current_stop_sequence + 1 : 0);
    let k = -1;
    stops.forEach((s, i) => {
      if (s.name === v.next_stop_name && (k < 0 || Math.abs(i - hint) < Math.abs(k - hint))) k = i;
    });
    if (k < 0) k = Math.min(Math.max(hint, 0), stops.length - 1);
    const a = stops[k - 1];
    const b = stops[k];
    let at = rowOf[k];
    if (a && a.lat != null && a.lon != null && b.lat != null && b.lon != null && Number.isFinite(v.lat)) {
      const f = along({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }, v);
      at = rowOf[k - 1] + (rowOf[k] - rowOf[k - 1]) * f;
    }
    out.push({ v, at });
  }
  return out.sort((x, y) => x.at - y.at);
}
