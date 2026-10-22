/**
 * Travel direction of every MZK stop, learned from the stop ORDER of the courses the poller already
 * receives (getRunningVehicles → stopPoints). getStops.json carries no direction, and the merge of
 * KB and MZK stops needs one to pair the two carriageways correctly (lib/stop-merge.ts).
 *
 * For every stop a bearing is credited per variant — the tangent prev → next (like
 * stop-directions.ts does for the KB GTFS feed) — and clustered into 1–2 opposite bearings.
 * Pure + persistable: no network, no poller imports.
 */
import fs from "node:fs";
import path from "node:path";
import { bearing, metersBetween } from "./geo";

export interface StopCoord {
  lat: number;
  lon: number;
}

const MERGE_THRESHOLD = 75;
const MAX_SAMPLES = 64;

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function circularMean(bs: readonly number[]): number {
  let sin = 0;
  let cos = 0;
  for (const b of bs) {
    const r = (b * Math.PI) / 180;
    sin += Math.sin(r);
    cos += Math.cos(r);
  }
  return Math.round(((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360);
}

/** 1 bearing, or 2 when the stop is served in both (opposite) directions. */
export function clusterBearings(bearings: readonly number[]): number[] {
  if (bearings.length === 0) return [];
  const clusters: number[][] = [];
  for (const b of bearings) {
    let best = -1;
    let bestDiff = MERGE_THRESHOLD;
    for (let i = 0; i < clusters.length; i++) {
      const d = angleDiff(b, circularMean(clusters[i]));
      if (d < bestDiff) {
        bestDiff = d;
        best = i;
      }
    }
    if (best >= 0) clusters[best].push(b);
    else clusters.push([b]);
  }
  clusters.sort((a, b) => b.length - a.length);
  const primary = circularMean(clusters[0]);
  const out = [primary];
  for (let i = 1; i < clusters.length; i++) {
    const mean = circularMean(clusters[i]);
    if (angleDiff(primary, mean) >= 100 && clusters[i].length >= 2 && clusters[i].length >= clusters[0].length * 0.15) {
      out.push(mean);
      break;
    }
  }
  return out;
}

export interface MzkStopDirsState {
  v: 2;
  variants: number[];
  samples: Record<string, number[]>;
  /** coordinates each symbol had when its samples were taken — a stop that moved/vanished invalidates them */
  at: Record<string, [number, number]>;
}

/** A stop that moved further than this since it was learned (upstream re-versioned its data) drops all learning. */
const RECONCILE_M = 15;

function sameDirs(a: ReadonlyMap<string, readonly number[]>, b: ReadonlyMap<string, readonly number[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.length !== v.length || v.some((x, i) => x !== w[i])) return false;
  }
  return true;
}

export class MzkStopDirs {
  private samples = new Map<string, number[]>();
  private at = new Map<string, [number, number]>();
  private seen = new Set<number>();
  private current = new Map<string, number[]>();
  private dirty = false;

  /**
   * Learn from one variant's ordered stop list (null = unknown stop, e.g. the depot "00").
   * Each variant counts once it taught something (one whose stops are all still unknown, e.g. before the stop
   * list loaded, is retried). Returns true when something was learned.
   */
  learn(variantId: number, stops: ReadonlyArray<{ symbol: string; at: StopCoord | null }>): boolean {
    if (!Number.isFinite(variantId) || variantId <= 0 || this.seen.has(variantId)) return false;
    let added = false;
    for (let i = 0; i < stops.length; i++) {
      const cur = stops[i].at;
      if (!cur) continue;
      const prev = i > 0 ? stops[i - 1].at : null;
      const next = i < stops.length - 1 ? stops[i + 1].at : null;
      let b: number | null = null;
      if (prev && next) b = bearing(prev.lat, prev.lon, next.lat, next.lon);
      else if (next) b = bearing(cur.lat, cur.lon, next.lat, next.lon);
      else if (prev) b = bearing(prev.lat, prev.lon, cur.lat, cur.lon);
      if (b === null) continue;
      const sym = stops[i].symbol;
      let arr = this.samples.get(sym);
      if (!arr) this.samples.set(sym, (arr = []));
      if (arr.length < MAX_SAMPLES) arr.push(Math.round(b));
      if (!this.at.has(sym)) this.at.set(sym, [cur.lat, cur.lon]);
      added = true;
    }
    if (added) {
      this.seen.add(variantId);
      this.dirty = true;
    }
    return added;
  }

  /**
   * symbol → 1–2 bearings. The SAME Map instance is returned until some stop's bearings actually change, so
   * consumers can memoize on identity (a newly learned variant that changes nothing costs nobody a rebuild).
   */
  dirs(): Map<string, number[]> {
    if (this.dirty) {
      const next = new Map<string, number[]>();
      for (const [sym, bs] of this.samples) {
        const c = clusterBearings(bs);
        if (c.length) next.set(sym, c);
      }
      if (!sameDirs(this.current, next)) this.current = next;
      this.dirty = false;
    }
    return this.current;
  }

  get size(): number {
    return this.samples.size;
  }

  /** number of distinct course variants learned from */
  get variants(): number {
    return this.seen.size;
  }

  /**
   * Check the learned stops against the CURRENT stop list (after every getStops load): a symbol that vanished
   * or moved by more than RECONCILE_M means upstream re-versioned its data, so everything learned is dropped
   * and re-learned from the running courses. Returns true when the learning was reset.
   */
  reconcile(bySymbol: ReadonlyMap<string, StopCoord>): boolean {
    for (const sym of this.samples.keys()) {
      const cur = bySymbol.get(sym);
      const rec = this.at.get(sym);
      if (!cur || (rec && metersBetween(rec[0], rec[1], cur.lat, cur.lon) > RECONCILE_M)) {
        this.samples.clear();
        this.at.clear();
        this.seen.clear();
        this.dirty = true;
        return true;
      }
      if (!rec) this.at.set(sym, [cur.lat, cur.lon]); // older state file: adopt the current position
    }
    return false;
  }

  snapshot(): MzkStopDirsState {
    return {
      v: 2,
      variants: [...this.seen],
      samples: Object.fromEntries(this.samples),
      at: Object.fromEntries(this.at),
    };
  }

  static restore(data: unknown): MzkStopDirs {
    const inst = new MzkStopDirs();
    const d = (data && typeof data === "object" ? data : {}) as {
      v?: unknown;
      variants?: unknown;
      samples?: Record<string, unknown>;
      at?: Record<string, unknown>;
    };
    if (d.v !== 1 && d.v !== 2) return inst;
    for (const v of Array.isArray(d.variants) ? d.variants : []) if (Number.isFinite(v)) inst.seen.add(Number(v));
    for (const [sym, bs] of Object.entries(d.samples ?? {})) {
      const clean = (Array.isArray(bs) ? bs : []).filter((x): x is number => typeof x === "number" && Number.isFinite(x)).slice(0, MAX_SAMPLES);
      if (clean.length) inst.samples.set(sym, clean);
    }
    for (const [sym, p] of Object.entries(d.at ?? {})) {
      if (Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x)) && inst.samples.has(sym)) {
        inst.at.set(sym, [p[0], p[1]]);
      }
    }
    inst.dirty = inst.samples.size > 0;
    return inst;
  }
}

/** Best-effort persistence next to the other generated state (atomic tmp+rename; never throws). */
export function loadMzkStopDirs(file: string): MzkStopDirs {
  try {
    return MzkStopDirs.restore(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return new MzkStopDirs();
  }
}

export function saveMzkStopDirs(file: string, inst: MzkStopDirs): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(inst.snapshot()));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
