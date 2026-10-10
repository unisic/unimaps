import type { WireStop } from "./types";

export type FormattedStop = WireStop;

const CITY_PREFIX_REGEX =
  /^(?:BIELSKO-BIAŁA|BIELSKO BIAŁA|CZECHOWICE-DZIEDZICE|BYSTRA|WILKOWICE|KOZY|JASIENICA|JAWORZE|SZCZYRK|PORĄBKA|BESTWINA)\s+/i;

/**
 * Normalizes a stop name for fuzzy cross-operator matching:
 * - strips known city/municipality prefixes (KB stops include "BIELSKO-BIAŁA", MZK stops don't)
 * - normalizes station suffixes ("D.A.", "DWORZEC AUTOBUSOWY")
 * - strips punctuation and whitespace
 */
export function cleanStopName(name: string): string {
  let n = name.toUpperCase().trim();
  n = n.replace(CITY_PREFIX_REGEX, "");
  n = n.replace(/(?:^|\s+)(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)$/i, " DWORZEC");
  n = n.replace(/[^A-Z0-9ĄĆĘŁŃÓŚŹŻ]/gi, "");
  return n;
}

/** Planar distance approximation in meters between two coordinates. */
export function stopDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dlat = (lat2 - lat1) * 111139;
  const dlon = (lon2 - lon1) * 111139 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dlat, dlon);
}

/**
 * Alias → merged stop: every id / designator / MZK symbol (bare and "mzk:"-prefixed) of every stop, a station
 * hub's EXTRA symbols (`mzkSymbols`) included: those MZK stops are folded into the hub (one marker per station).
 */
export function indexMergedStops(stops: readonly FormattedStop[]): Map<string, FormattedStop> {
  const index = new Map<string, FormattedStop>();
  for (const s of stops) {
    for (const key of [s.designator, s.id, s.kbDesignator, s.mzkDesignator, s.kbId, s.mzkId]) {
      if (key) index.set(key, s);
    }
    for (const sym of new Set([s.mzkSymbol, s.symbol, ...(s.mzkSymbols ?? [])])) {
      if (!sym) continue;
      index.set(sym, s);
      index.set(`mzk:${sym}`, s);
    }
  }
  return index;
}

/** Process-wide lookup of the most recent mergeStops() result (kept for callers/tests that merge directly). */
let registryByDesignator = new Map<string, FormattedStop>();

export function registerMergedStops(stops: FormattedStop[]): void {
  registryByDesignator = indexMergedStops(stops);
}

export function getMergedStop(designatorOrId: string): FormattedStop | undefined {
  return registryByDesignator.get(designatorOrId);
}

/* ------------------------------------------------------------------------- */
/* matching                                                                  */
/* ------------------------------------------------------------------------- */

/** Proximity alone is enough to call two stops the same place. */
export const MERGE_NEAR_M = 35;
/** Same-name stops this close are the same place (different poles / staggered stops). */
export const MERGE_NAME_M = 120;
/** A pair whose travel directions are opposite only merges when it is practically one pole. */
export const MERGE_SAME_POLE_M = 12;
/** A bus station (D.A.) pairs and fans out only to MZK stops on its premises: its cleaned name is the
 *  bare "DWORZEC", which matches every "<street> Dworzec" around it (Bielsko-Biała D.A. is KB-only). */
export const MERGE_HUB_M = MERGE_NEAR_M;
/** Max MZK symbols a station hub fans out to (primary included). */
export const MERGE_MAX_MZK = 6;

const OPPOSITE_DEG = 120;
const SAME_DIR_DEG = 60;
/** cost bumps: unnamed pair, roughly-perpendicular pair, opposite pair (metres-equivalent) */
const COST_NAME_MISS = 25;
const COST_DIR_AMBIGUOUS = 40;
const COST_DIR_OPPOSITE = 400;

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Smallest angle (0..180) between any bearing of `a` and any bearing of `b`;
 * null when either side has no direction information.
 */
export function directionDiff(a?: readonly number[], b?: readonly number[]): number | null {
  if (!a?.length || !b?.length) return null;
  let best = 180;
  for (const x of a) for (const y of b) best = Math.min(best, angleDiff(x, y));
  return best;
}

/** Arrows of a merged stop: KB's bearings first, then MZK's that are not within 45° of one already there — at most two. */
function unionDirs(...lists: Array<readonly number[] | undefined>): number[] | undefined {
  const out: number[] = [];
  for (const list of lists) {
    for (const d of list ?? []) {
      if (out.length < 2 && out.every((x) => angleDiff(x, d) >= 45)) out.push(d);
    }
  }
  return out.length ? out : undefined;
}

function namesMatch(a: string, b: string): boolean {
  return a.length > 2 && b.length > 2 && (a === b || a.includes(b) || b.includes(a));
}

interface Candidate {
  k: number;
  m: number;
  d: number;
  cost: number;
  dd: number | null;
}

/**
 * Min-cost assignment of MZK rows to KB columns on one connected component
 * (Hungarian / Kuhn–Munkres, rectangular: every row may also stay unmatched at
 * UNMATCHED cost, which is far above any real edge so cardinality wins first).
 */
const UNMATCHED = 5_000;
const FORBIDDEN = 1e9;
function hungarian(rows: number, cols: number, cost: (r: number, c: number) => number): number[] {
  // rows <= cols is required; callers pad with dummy columns
  const INF = Infinity;
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const p = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);
  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(cols + 1).fill(INF);
    const used = new Array<boolean>(cols + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const rowToCol = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= cols; j++) if (p[j] !== 0) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

/** m -> k assignment (order independent: depends only on the stops, never on list order). */
function assign(cands: Candidate[]): Map<number, number> {
  const out = new Map<number, number>();
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  for (const c of cands) {
    for (const n of [`k${c.k}`, `m${c.m}`]) if (!parent.has(n)) parent.set(n, n);
    parent.set(find(`k${c.k}`), find(`m${c.m}`));
  }
  const comps = new Map<string, Candidate[]>();
  for (const c of cands) {
    const r = find(`k${c.k}`);
    let arr = comps.get(r);
    if (!arr) comps.set(r, (arr = []));
    arr.push(c);
  }
  for (const comp of comps.values()) {
    const ms = [...new Set(comp.map((c) => c.m))].sort((a, b) => a - b);
    const ks = [...new Set(comp.map((c) => c.k))].sort((a, b) => a - b);
    const cell = new Map<string, number>();
    for (const c of comp) cell.set(`${c.m}:${c.k}`, c.cost);
    const rows = ms.length;
    const cols = ks.length + rows; // + one "stay unmatched" column per row
    const rowToCol = hungarian(rows, cols, (r, col) => {
      if (col >= ks.length) return UNMATCHED;
      return cell.get(`${ms[r]}:${ks[col]}`) ?? FORBIDDEN;
    });
    rowToCol.forEach((col, r) => {
      if (col >= 0 && col < ks.length && cell.has(`${ms[r]}:${ks[col]}`)) out.set(ms[r], ks[col]);
    });
  }
  return out;
}

export interface MergeOptions {
  /**
   * Travel bearings of MZK stops by symbol (learned from running courses, lib/mzk-stop-dirs.ts). Used ONLY to
   * decide the pairing — never copied onto the merged stops, so the wire format keeps today's arrows.
   */
  mzkDirs?: ReadonlyMap<string, readonly number[]>;
}

/**
 * Merges KB stops and MZK stops that represent the same physical bus stop.
 *
 *  - eligibility: <= MERGE_NEAR_M, or <= MERGE_NAME_M with matching cleaned names; a pair whose
 *    travel directions are opposite (both sides know `dirs`) is only eligible when it is
 *    practically one pole (<= MERGE_SAME_POLE_M) — the other carriageway is another stop;
 *  - the pairing is a global min-cost assignment (max cardinality first), so it does not depend on
 *    the order of either list (the old greedy loop paired stops by the order the upstream listed them);
 *  - a bus station (KB `isStation`) additionally FANS OUT to every other unmatched same-name MZK stop
 *    within MERGE_HUB_M (the station's several MZK stops): `mzkSymbols` = [primary, ...extras]. The extras
 *    are folded into the hub (no entry of their own; within MERGE_HUB_M the hub's position stands in for theirs).
 */
export function mergeStops(
  kbStops: FormattedStop[],
  mzkStops: FormattedStop[],
  opts: MergeOptions = {},
): FormattedStop[] {
  const kc = kbStops.map((k) => cleanStopName(k.name));
  const mc = mzkStops.map((m) => cleanStopName(m.name));
  const mzkBearings = (m: number): readonly number[] | undefined =>
    mzkStops[m].dirs ?? (mzkStops[m].symbol ? opts.mzkDirs?.get(mzkStops[m].symbol!) : undefined);

  const cands: Candidate[] = [];
  for (let m = 0; m < mzkStops.length; m++) {
    const mDirs = mzkBearings(m);
    for (let k = 0; k < kbStops.length; k++) {
      const d = stopDistanceMeters(mzkStops[m].lat, mzkStops[m].lon, kbStops[k].lat, kbStops[k].lon);
      const maxD = kbStops[k].isStation ? MERGE_HUB_M : MERGE_NAME_M;
      if (!(d <= maxD)) continue; // also drops NaN (a stop without coordinates is never a partner)
      const name = namesMatch(mc[m], kc[k]);
      const near = d <= MERGE_NEAR_M;
      const hubOk = kbStops[k].isStation && name; // station: same-name stops up to MERGE_HUB_M
      if (!(near || (name && d <= MERGE_NAME_M) || hubOk)) continue;
      const dd = directionDiff(kbStops[k].dirs, mDirs);
      if (dd !== null && dd >= OPPOSITE_DEG && d > MERGE_SAME_POLE_M) continue;
      let cost = d + (name ? 0 : COST_NAME_MISS);
      if (dd !== null) cost += dd <= SAME_DIR_DEG ? 0 : dd < OPPOSITE_DEG ? COST_DIR_AMBIGUOUS : COST_DIR_OPPOSITE;
      cands.push({ k, m, d, cost, dd });
    }
  }

  // 1-to-1 assignment (the primary MZK stop of each merged stop)
  const primary = assign(cands); // m -> k
  const primaryOf = new Map<number, number>(); // k -> m
  for (const [m, k] of primary) primaryOf.set(k, m);

  // station hubs: the other same-name MZK stops the station panel also lists (never the opposite carriageway)
  const extrasOf = new Map<number, number[]>();
  for (const c of [...cands].sort((a, b) => a.cost - b.cost || a.m - b.m)) {
    if (primary.has(c.m) || !primaryOf.has(c.k) || !kbStops[c.k].isStation) continue;
    if (c.dd !== null && c.dd >= OPPOSITE_DEG) continue;
    if (!namesMatch(mc[c.m], kc[c.k])) continue;
    const list = extrasOf.get(c.k) ?? [];
    if (list.length + 1 >= MERGE_MAX_MZK || list.includes(c.m)) continue;
    list.push(c.m);
    extrasOf.set(c.k, list);
  }

  const merged: FormattedStop[] = [];
  for (let k = 0; k < kbStops.length; k++) {
    const pm = primaryOf.get(k);
    if (pm === undefined) continue;
    const bk = kbStops[k];
    const m = mzkStops[pm];
    const extras = extrasOf.get(k) ?? [];
    const stop: FormattedStop = {
      id: bk.id,
      designator: bk.designator,
      name: bk.name,
      lat: bk.lat,
      lon: bk.lon,
      operator: "BOTH",
      operators: ["KB", "MZK"],
      kbId: bk.id,
      mzkId: m.id,
      kbDesignator: bk.designator,
      mzkDesignator: m.designator,
      mzkSymbol: m.symbol,
      // a hub has several symbols — no single "(343)" label in the UI
      symbol: extras.length ? undefined : m.symbol,
      ...(extras.length
        ? { mzkSymbols: [pm, ...extras].map((x) => mzkStops[x].symbol).filter((s): s is string => !!s) }
        : {}),
      dirs: unionDirs(bk.dirs, m.dirs),
      isStation: Boolean(bk.isStation || m.isStation),
      showPlatforms: bk.showPlatforms,
      onRequest: Boolean(bk.onRequest || m.onRequest),
      gettingOut: Boolean(bk.gettingOut || m.gettingOut),
    };
    merged.push(stop);
  }

  // unmatched KB, then unmatched MZK (original order within each group; hub extras are folded into their hub)
  const folded = new Set([...extrasOf.values()].flat());
  kbStops.forEach((k, i) => {
    if (primaryOf.has(i)) return;
    merged.push({ ...k, operator: "KB", operators: ["KB"], kbId: k.id, kbDesignator: k.designator });
  });
  mzkStops.forEach((m, i) => {
    if (primary.has(i) || folded.has(i)) return;
    merged.push({
      ...m,
      operator: "MZK",
      operators: ["MZK"],
      mzkId: m.id,
      mzkDesignator: m.designator,
      mzkSymbol: m.symbol,
    });
  });

  registerMergedStops(merged);
  return merged;
}
