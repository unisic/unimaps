/**
 * Road-shape store: road-following geometry for KB stop patterns (routed
 * server-side via OSRM) and MZK variants (from the operator API), persisted
 * under output/shapes/ and refreshed gradually — so browsers fetch stored,
 * immutable-cached shapes instead of calling OSRM themselves.
 *
 *  - touchKb()/touchMzk() are cheap and never hit the network inline; a new KB
 *    pattern gets a straight stop-to-stop entry immediately and is queued.
 *  - one worker, concurrency 1, every OSRM attempt throttled (≥1 s on the
 *    public demo host); hard failures pause it (circuit breaker) and commit
 *    nothing; a road entry is never downgraded.
 *  - single writer: a lock file next to the store; a process that doesn't own
 *    it is read-only (no worker, no writes) and re-reads the file on change.
 *  - wire ids carry a content revision (`<key>.<rev6>`) so /api/shapes can be
 *    served `immutable`.
 *  - fs calls carry turbopackIgnore: the store is a runtime data file in the
 *    output volume — without it the build would trace the whole project.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { log } from "./logger";
import { mzkShapeFromCourseDetails } from "./mzk-shape";
import { routeWaypoints, type OsrmClientOpts } from "./osrm";
import type { KbPattern } from "./shape-patterns";
import {
  decodePolyline,
  encodePolyline,
  preparePolyline,
  projectStopsAlong,
  pruneSpurs,
  simplifyPolyline,
  type LatLng,
  type Polyline,
} from "./shared/polyline";

export type ShapeSrc = "osrm" | "partial" | "straight" | "mzk";
const RANK: Record<ShapeSrc, number> = { straight: 1, partial: 2, osrm: 3, mzk: 3 };
/** Bump when the build pipeline changes output (entries rebuild gradually). */
export const ALGO_VERSION = 3;
const FORMAT = "kb-map/route-shapes";
const FILE_VERSION = 1;

const DAY_MS = 86_400_000;
const REFRESH_TICK_MS = 120_000;
const HEARTBEAT_MS = 60_000;
const LOCK_STALE_MS = 5 * 60_000;
const FLUSH_DEBOUNCE_MS = 30_000;
const SEEN_FLUSH_MS = 6 * 3_600_000;
const SEEN_WINDOW_MS = 7 * DAY_MS;
const GC_UNSEEN_MS = 30 * DAY_MS;
const PARTIAL_MAX_AGE_MS = DAY_MS;
const MZK_MAX_AGE_MS = 7 * DAY_MS;
const MZK_NEG_CACHE_MS = 10 * 60_000;
const MZK_BG_SPACING_MS = 1_000;
const MAX_ENTRIES = 5000;
const MAX_QUEUE = 1000;
const GEOM_LRU = 300;

export interface ShapeEntry {
  src: ShapeSrc;
  /** encoded polyline, precision 6 */
  poly: string;
  len: number;
  /** along-route metres per trip.times index (KB) / stop order (MZK); null = unplaced */
  stops: Array<number | null>;
  rev: string;
  builtAt: number;
  seenAt: number;
  fails: number;
  retryAt: number;
  algo: number;
  /** straight because every leg was unroutable — no point retrying soon */
  unroutable?: boolean;
  /* KB rebuild inputs */
  wpSig?: string;
  wp?: string;
  sp?: Array<[number, number] | null>;
  line?: string;
  dir?: string;
}

export interface ShapeGeometry {
  pl: Polyline;
  stops: Array<number | null>;
  rev: string;
  src: ShapeSrc;
}

export interface ShapePayload {
  id: string;
  src: ShapeSrc;
  poly: string;
  len: number;
  stops: Array<number | null>;
}

export type ShapeStatus = "road" | "pending" | "none";

export interface ShapeStoreOptions {
  fetchImpl: typeof fetch;
  /** OSRM route service base (…/route/v1/driving); null disables KB routing */
  osrmBase: string | null;
  userAgent: string;
  minIntervalMs: number;
  maxAgeDays: number;
  /** persistence file; null = in-memory only */
  file: string | null;
  mzkFetch?: ((variantId: number) => Promise<unknown>) | null;
  /** epoch ms clock (injectable for tests) */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** false = no background timers (tests drive runNext() by hand) */
  timers?: boolean;
}

export const isRoadSrc = (src: ShapeSrc): boolean => RANK[src] >= 2;

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function revOf(e: Pick<ShapeEntry, "poly" | "stops" | "len" | "src">): string {
  return sha1(`${e.src}|${e.poly}|${e.len.toFixed(1)}|${JSON.stringify(e.stops)}`).slice(0, 6);
}

/** Quantize to the wire format, prepare, and place the stops. */
export function finalizeShape(
  pts: readonly LatLng[],
  stopRefs: ReadonlyArray<readonly [number, number] | null>,
  src: ShapeSrc,
): Pick<ShapeEntry, "poly" | "len" | "stops" | "rev" | "src"> | null {
  const poly = encodePolyline(pts);
  const pl = preparePolyline(decodePolyline(poly));
  if (!pl) return null;
  const stops = projectStopsAlong(pl, stopRefs).map((s) => (s === null ? null : Math.round(s * 10) / 10));
  const len = Math.round(pl.length * 10) / 10;
  const base = { poly, len, stops, src };
  return { ...base, rev: revOf(base) };
}

/** Next KB entry due for a background refresh (oldest first), or null. */
export function pickRefreshCandidate(
  entries: Iterable<[string, ShapeEntry]>,
  nowMs: number,
  maxAgeDays: number,
  skip?: (key: string) => boolean,
): string | null {
  let best: string | null = null;
  let bestAt = Infinity;
  for (const [key, e] of entries) {
    if (!key.startsWith("kb:") || skip?.(key)) continue;
    if (nowMs - e.seenAt > SEEN_WINDOW_MS) continue;
    const age = nowMs - e.builtAt;
    const due =
      e.algo < ALGO_VERSION ||
      (e.src === "osrm" && age > maxAgeDays * DAY_MS) ||
      (e.src === "partial" && age > PARTIAL_MAX_AGE_MS) ||
      (e.src === "straight" && !e.unroutable && nowMs >= e.retryAt) ||
      (e.src === "straight" && e.unroutable && age > maxAgeDays * DAY_MS);
    if (due && e.builtAt < bestAt) {
      best = key;
      bestAt = e.builtAt;
    }
  }
  return best;
}

function validEntry(v: unknown): ShapeEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (typeof e.src !== "string" || !(e.src in RANK)) return null;
  if (typeof e.poly !== "string" || typeof e.rev !== "string" || !/^[0-9a-f]{6}$/.test(e.rev)) return null;
  if (typeof e.len !== "number" || !Number.isFinite(e.len)) return null;
  if (!Array.isArray(e.stops) || !e.stops.every((s) => s === null || (typeof s === "number" && Number.isFinite(s)))) {
    return null;
  }
  const num = (x: unknown, d = 0): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
  const sp = Array.isArray(e.sp)
    ? (e.sp as unknown[]).map((p) =>
        Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === "number" && Number.isFinite(c))
          ? ([p[0], p[1]] as [number, number])
          : null,
      )
    : undefined;
  return {
    src: e.src as ShapeSrc,
    poly: e.poly,
    len: e.len,
    stops: e.stops as Array<number | null>,
    rev: e.rev,
    builtAt: num(e.builtAt),
    seenAt: num(e.seenAt),
    fails: num(e.fails),
    retryAt: num(e.retryAt),
    algo: num(e.algo, 0),
    ...(e.unroutable === true ? { unroutable: true } : {}),
    ...(typeof e.wpSig === "string" ? { wpSig: e.wpSig } : {}),
    ...(typeof e.wp === "string" ? { wp: e.wp } : {}),
    ...(sp ? { sp } : {}),
    ...(typeof e.line === "string" ? { line: e.line } : {}),
    ...(typeof e.dir === "string" ? { dir: e.dir } : {}),
  };
}

type OsrmState = "ok" | "disabled" | "paused" | "blocked" | "config_error";

export class ShapeStore {
  private readonly o: Required<Omit<ShapeStoreOptions, "mzkFetch" | "osrmBase" | "file">> & {
    osrmBase: string | null;
    file: string | null;
    mzkFetch: ((variantId: number) => Promise<unknown>) | null;
  };
  private entries = new Map<string, ShapeEntry>();
  private geomCache = new Map<string, ShapeGeometry>();
  private urgent: string[] = [];
  private background: string[] = [];
  private queued = new Set<string>();
  private mzkNeg = new Map<number, number>();
  private mzkInflight = new Map<number, Promise<ShapeEntry | null>>();
  private rawTripToKey = new Map<string, string>();

  private nextSlot = 0;
  private mzkNextSlot = 0;
  private pausedUntil = 0;
  private backoffMs = 60_000;
  private osrmState: OsrmState;
  private lastError: string | null = null;
  private lastBuildAt = 0;
  private builds = 0;

  private ownsLock = false;
  private readOnly = false;
  /** a file exists that we could not safely load — never overwrite it */
  private loadBlocked = false;
  private fileMtime = 0;
  private contentDirty = false;
  private seenDirty = false;
  private lastFlush = 0;
  private persistError: string | null = null;
  private writeSeq = 0;

  private started = false;
  /** one worker per upstream: KB routing (OSRM) and MZK variant fetches
   *  never wait on each other */
  private pumping = { kb: false, mzk: false };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastGc = 0;

  constructor(opts: ShapeStoreOptions) {
    this.o = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
      timers: true,
      ...opts,
      mzkFetch: opts.mzkFetch ?? null,
    };
    this.osrmState = opts.osrmBase ? "ok" : "disabled";
  }

  private now(): number {
    return this.o.now();
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Load the persisted store, take the writer lock and start the worker. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.load();
    this.ownsLock = this.tryLock();
    this.readOnly = !this.ownsLock;
    if (this.readOnly) log.warn("shapes", `store file locked by another process — read-only (${this.o.file})`);
    if (!this.o.timers) return;
    this.every(HEARTBEAT_MS, () => this.heartbeat());
    this.every(REFRESH_TICK_MS, () => this.refreshTick());
    this.later(30_000, () => this.kick());
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush(true);
    if (this.ownsLock && this.o.file && this.isMine(this.lockOwner())) {
      try {
        fs.unlinkSync(/*turbopackIgnore: true*/ `${this.o.file}.lock`);
      } catch {
        /* already gone */
      }
    }
    this.ownsLock = false;
    this.started = false;
  }

  /** One-shot unref'd timer, tracked so stop() can clear it. */
  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        fn();
      } catch (err) {
        log.error("shapes", `timer task failed: ${err}`);
      }
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  private every(ms: number, fn: () => void): void {
    this.later(ms, () => {
      if (!this.started) return;
      try {
        fn();
      } finally {
        this.every(ms, fn);
      }
    });
  }

  /* ------------------------------------------------------------ public API */

  /** Ensure an entry for a KB pattern exists; queue routing if it isn't road yet. */
  touchKb(p: KbPattern, prio: "urgent" | "background"): void {
    const now = this.now();
    let e = this.entries.get(p.key);
    if (!e) {
      if (this.entries.size >= MAX_ENTRIES) return;
      const straight = finalizeShape(p.waypoints, p.stopPts, "straight");
      if (!straight) return;
      e = {
        ...straight,
        builtAt: 0,
        seenAt: now,
        fails: 0,
        retryAt: 0,
        algo: ALGO_VERSION,
        wpSig: p.wpSig,
        wp: encodePolyline(p.waypoints),
        sp: p.stopPts.map((x) => (x ? [x[0], x[1]] : null)),
        line: p.line,
        dir: p.dir,
      };
      this.entries.set(p.key, e);
      this.markContent();
    } else {
      if (now - e.seenAt > 60_000) {
        e.seenAt = now;
        this.seenDirty = true;
      }
      if (e.wpSig !== p.wpSig) {
        // stops moved / detour edited: keep serving the old geometry, rebuild with new inputs
        e.wpSig = p.wpSig;
        e.wp = encodePolyline(p.waypoints);
        e.sp = p.stopPts.map((x) => (x ? [x[0], x[1]] : null));
        e.retryAt = 0;
        e.unroutable = false;
        if (!isRoadSrc(e.src)) {
          const straight = finalizeShape(p.waypoints, p.stopPts, "straight");
          if (straight) Object.assign(e, straight);
        }
        e.builtAt = Math.min(e.builtAt, 1); // due for refresh
        this.markContent();
        if (this.o.osrmBase) this.enqueue(p.key, prio);
        return;
      }
    }
    if (this.o.osrmBase && e.src === "straight" && !e.unroutable && now >= e.retryAt) this.enqueue(p.key, prio);
  }

  /** Note a running MZK variant; fetch its shape in the background if unknown/old. */
  touchMzk(variantId: number, prio: "urgent" | "background" = "background"): void {
    if (!this.o.mzkFetch || !Number.isInteger(variantId) || variantId <= 0) return;
    const key = `mzk:${variantId}`;
    const now = this.now();
    const e = this.entries.get(key);
    if (e) {
      if (now - e.seenAt > 60_000) {
        e.seenAt = now;
        this.seenDirty = true;
      }
      if (now - e.builtAt > MZK_MAX_AGE_MS) this.enqueue(key, "background");
      return;
    }
    if ((this.mzkNeg.get(variantId) ?? 0) > now) return;
    this.enqueue(key, prio);
  }

  /** Decoded MZK variant polyline (fetched on demand, deduped). For trip views. */
  async getMzkShape(variantId: number): Promise<LatLng[] | null> {
    const key = `mzk:${variantId}`;
    let e: ShapeEntry | null | undefined = this.entries.get(key);
    if (!e) e = await this.fetchMzk(variantId, false);
    return e ? decodePolyline(e.poly) : null;
  }

  /** Forget the raw-trip → pattern map (before re-seeding from a new feed). */
  clearRawTrips(): void {
    this.rawTripToKey.clear();
  }

  /** Remember which GTFS raw trip ids use which pattern (for connection legs). */
  registerRawTrips(rawTripIds: readonly string[], key: string): void {
    for (const id of rawTripIds) this.rawTripToKey.set(id, key);
  }

  keyForRawTrip(rawTripId: string): string | undefined {
    return this.rawTripToKey.get(rawTripId);
  }

  getEntry(key: string): ShapeEntry | undefined {
    return this.entries.get(key);
  }

  /** Prepared geometry for along-route math (LRU-cached per key+rev). */
  geometry(key: string): ShapeGeometry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const hit = this.geomCache.get(key);
    if (hit && hit.rev === e.rev) {
      this.geomCache.delete(key);
      this.geomCache.set(key, hit);
      return hit;
    }
    const pl = preparePolyline(decodePolyline(e.poly));
    if (!pl) return null;
    const g: ShapeGeometry = { pl, stops: e.stops, rev: e.rev, src: e.src };
    this.geomCache.set(key, g);
    if (this.geomCache.size > GEOM_LRU) this.geomCache.delete(this.geomCache.keys().next().value!);
    return g;
  }

  /** Wire id `<key>.<rev>` — only for road geometry (straight shapes aren't served). */
  wireId(key: string): string | null {
    const e = this.entries.get(key);
    return e && isRoadSrc(e.src) ? `${key}.${e.rev}` : null;
  }

  status(key: string | null | undefined): ShapeStatus {
    if (!key) return "none";
    const e = this.entries.get(key);
    if (e && isRoadSrc(e.src)) return "road";
    if (key.startsWith("mzk:")) return this.o.mzkFetch ? "pending" : "none";
    this.expireBlock();
    // blocked/misconfigured: don't send every browser to the router that just refused us
    if (!this.o.osrmBase || this.osrmState === "config_error" || this.osrmState === "blocked") return "none";
    if (e?.unroutable) return "none";
    return "pending";
  }

  /** Stored payloads for /api/shapes. Never touches the network. */
  lookup(ids: readonly string[]): { shapes: Record<string, ShapePayload>; missing: string[]; exact: boolean } {
    const shapes: Record<string, ShapePayload> = {};
    const missing: string[] = [];
    let exact = true;
    for (const id of ids) {
      const dot = id.lastIndexOf(".");
      const key = dot > 0 && /\.[0-9a-f]{6}$/.test(id) ? id.slice(0, dot) : id;
      const rev = key === id ? null : id.slice(dot + 1);
      const e = this.entries.get(key);
      if (!e || !isRoadSrc(e.src)) {
        missing.push(id);
        exact = false;
        continue;
      }
      if (rev !== e.rev) exact = false;
      shapes[id] = { id: `${key}.${e.rev}`, src: e.src, poly: e.poly, len: e.len, stops: e.stops };
    }
    return { shapes, missing, exact };
  }

  health(): Record<string, unknown> {
    const counts: Record<string, number> = { osrm: 0, partial: 0, straight: 0, mzk: 0 };
    for (const e of this.entries.values()) counts[e.src] += 1;
    return {
      entries: this.entries.size,
      road: counts.osrm + counts.partial,
      ...counts,
      queued: this.queued.size,
      builds: this.builds,
      osrm_state: this.effectiveOsrmState(),
      osrm_paused_until: this.pausedUntil > this.now() ? Math.round(this.pausedUntil / 1000) : null,
      last_build_at: this.lastBuildAt ? Math.round(this.lastBuildAt / 1000) : null,
      last_error: this.lastError,
      persist_error: this.persistError,
      read_only: this.readOnly,
    };
  }

  private effectiveOsrmState(): OsrmState {
    this.expireBlock();
    if (this.osrmState === "ok" && this.pausedUntil > this.now()) return "paused";
    return this.osrmState;
  }

  /* ------------------------------------------------------------ worker */

  private enqueue(key: string, prio: "urgent" | "background"): void {
    if (this.readOnly) return;
    if (this.queued.has(key)) {
      if (prio === "urgent") {
        const i = this.background.indexOf(key);
        if (i >= 0) {
          this.background.splice(i, 1);
          this.urgent.push(key);
        }
      }
      return;
    }
    if (this.queued.size >= MAX_QUEUE) return;
    this.queued.add(key);
    (prio === "urgent" ? this.urgent : this.background).push(key);
    if (this.o.timers && this.started) this.kick();
  }

  private kick(): void {
    if (this.readOnly || !this.started) return;
    for (const kind of ["kb", "mzk"] as const) {
      if (this.pumping[kind]) continue;
      this.pumping[kind] = true;
      void (async () => {
        try {
          while (await this.runNext(kind)) {
            /* keep draining */
          }
        } catch (err) {
          log.error("shapes", `${kind} worker crashed: ${err}`);
        } finally {
          this.pumping[kind] = false;
        }
      })();
    }
  }

  private canRouteKb(): boolean {
    this.expireBlock();
    return !!this.o.osrmBase && this.osrmState === "ok" && this.pausedUntil <= this.now();
  }

  /** A 24 h block lapses on its own — try again (the next refusal re-blocks). */
  private expireBlock(): void {
    if (this.osrmState === "blocked" && this.pausedUntil <= this.now()) this.osrmState = "ok";
  }

  /** Process one queued job (of `kind`, or any). False when nothing runnable is queued. */
  async runNext(kind?: "kb" | "mzk"): Promise<boolean> {
    const pick = (q: string[]): string | null => {
      for (let i = 0; i < q.length; i++) {
        const k = q[i];
        if (kind && !k.startsWith(`${kind}:`)) continue;
        if (k.startsWith("kb:") && !this.canRouteKb()) continue;
        q.splice(i, 1);
        return k;
      }
      return null;
    };
    const key = pick(this.urgent) ?? pick(this.background);
    if (!key) {
      // paused with work left: wake up when the pause ends
      if (this.o.timers && this.queued.size && this.pausedUntil > this.now()) {
        this.later(this.pausedUntil - this.now() + 50, () => this.kick());
      }
      return false;
    }
    this.queued.delete(key);
    if (key.startsWith("mzk:")) {
      const wait = this.mzkNextSlot - this.now();
      if (wait > 0) await this.o.sleep(wait);
      this.mzkNextSlot = this.now() + MZK_BG_SPACING_MS;
      await this.fetchMzk(Number(key.slice(4)), true);
    } else {
      await this.buildKb(key);
    }
    this.maybeGc();
    return true;
  }

  private async throttle(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.o.minIntervalMs;
    if (at > now) await this.o.sleep(at - now);
  }

  private async buildKb(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e?.wp || !e.sp || !this.o.osrmBase) return;
    const wps = decodePolyline(e.wp);
    const opts: OsrmClientOpts = {
      base: this.o.osrmBase,
      fetchImpl: this.o.fetchImpl,
      throttle: () => this.throttle(),
      userAgent: this.o.userAgent,
    };
    const r = await routeWaypoints(wps, opts);
    const now = this.now();
    if (!r.ok) {
      this.lastError = `${r.kind}: ${r.detail}`;
      if (r.kind === "config") {
        if (this.osrmState !== "config_error") log.error("shapes", `OSRM config error, routing stopped: ${r.detail}`);
        this.osrmState = "config_error";
      } else if (r.kind === "blocked") {
        log.error("shapes", `OSRM refused us (${r.detail}) — pausing 24 h`);
        this.osrmState = "blocked";
        this.pausedUntil = now + DAY_MS;
      } else if (r.kind === "ratelimited") {
        this.pausedUntil = now + Math.max(60, r.retryAfterSec ?? 60) * 1000;
        log.warn("shapes", `OSRM rate limited — pausing ${Math.round((this.pausedUntil - now) / 1000)} s`);
      } else {
        this.pausedUntil = now + this.backoffMs;
        log.warn("shapes", `OSRM unavailable (${r.detail}) — pausing ${Math.round(this.backoffMs / 1000)} s`);
        this.backoffMs = Math.min(this.backoffMs * 2, 30 * 60_000);
      }
      // not the pattern's fault: put it back at the front, nothing committed
      if (!this.queued.has(key)) {
        this.queued.add(key);
        this.urgent.unshift(key);
      }
      return;
    }
    this.backoffMs = 60_000;
    const src: ShapeSrc = r.straightLegs === 0 ? "osrm" : r.straightLegs >= r.totalLegs ? "straight" : "partial";
    const cleaned = simplifyPolyline(pruneSpurs(r.pts, wps), 2);
    const built = finalizeShape(cleaned, e.sp, src);
    this.builds += 1;
    this.lastBuildAt = now;
    if (!built || RANK[src] < RANK[e.src]) {
      // never downgrade a stored road geometry
      e.fails += 1;
      e.retryAt = now + Math.min(5 * 60_000 * 2 ** e.fails, 6 * 3_600_000);
      if (isRoadSrc(e.src)) e.builtAt = now; // keep it, re-check on the normal cadence
      this.markContent();
      return;
    }
    Object.assign(e, built, { builtAt: now, algo: ALGO_VERSION });
    if (src === "straight") {
      e.fails += 1;
      e.unroutable = true;
      e.retryAt = now + Math.min(5 * 60_000 * 2 ** e.fails, 6 * 3_600_000);
    } else {
      e.fails = 0;
      e.retryAt = 0;
      e.unroutable = false;
    }
    this.geomCache.delete(key);
    this.markContent();
  }

  private fetchMzk(variantId: number, background: boolean): Promise<ShapeEntry | null> {
    const inflight = this.mzkInflight.get(variantId);
    if (inflight) return inflight;
    const fetcher = this.o.mzkFetch;
    if (!fetcher) return Promise.resolve(null);
    const now = this.now();
    const existing = this.entries.get(`mzk:${variantId}`);
    if (!existing && (this.mzkNeg.get(variantId) ?? 0) > now) return Promise.resolve(null);
    const p = (async (): Promise<ShapeEntry | null> => {
      try {
        const raw = await fetcher(variantId);
        const shape = mzkShapeFromCourseDetails(raw);
        const built = shape ? finalizeShape(shape.pts, [], "mzk") : null;
        if (!shape || !built) {
          this.mzkNeg.set(variantId, this.now() + MZK_NEG_CACHE_MS);
          return existing ?? null;
        }
        // stops come from the segment boundaries, already in our metric
        const stops = shape.stops.map((s) => (s === null ? null : Math.round(s * 10) / 10));
        const base = { poly: built.poly, len: built.len, stops, src: "mzk" as const };
        const key = `mzk:${variantId}`;
        const e: ShapeEntry = {
          ...base,
          rev: revOf(base),
          builtAt: this.now(),
          seenAt: this.now(),
          fails: 0,
          retryAt: 0,
          algo: ALGO_VERSION,
        };
        if (!this.entries.has(key) && this.entries.size >= MAX_ENTRIES) return null;
        this.entries.set(key, e);
        this.geomCache.delete(key);
        this.markContent();
        return e;
      } catch (err) {
        if (!background) log.warn("shapes", `MZK variant ${variantId} fetch failed: ${err}`);
        this.mzkNeg.set(variantId, this.now() + MZK_NEG_CACHE_MS);
        return existing ?? null;
      } finally {
        this.mzkInflight.delete(variantId);
      }
    })();
    this.mzkInflight.set(variantId, p);
    return p;
  }

  private refreshTick(): void {
    if (this.readOnly) return;
    const key = pickRefreshCandidate(this.entries, this.now(), this.o.maxAgeDays, (k) => this.queued.has(k));
    if (key && this.o.osrmBase) this.enqueue(key, "background");
    // MZK variants: re-fetch the oldest stale one that's still running
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (k.startsWith("mzk:") && now - e.builtAt > MZK_MAX_AGE_MS && now - e.seenAt < SEEN_WINDOW_MS) {
        this.enqueue(k, "background");
        break;
      }
    }
  }

  private maybeGc(): void {
    const now = this.now();
    if (now - this.lastGc < DAY_MS) return;
    this.lastGc = now;
    let dropped = 0;
    for (const [k, e] of this.entries) {
      if (now - e.seenAt > GC_UNSEEN_MS) {
        this.entries.delete(k);
        this.geomCache.delete(k);
        dropped += 1;
      }
    }
    for (const [id, until] of this.mzkNeg) if (until <= now) this.mzkNeg.delete(id);
    if (dropped) {
      log.info("shapes", `GC dropped ${dropped} unused shapes`);
      this.markContent();
    }
  }

  /* ------------------------------------------------------------ persistence */

  private markContent(): void {
    this.contentDirty = true;
    if (!this.o.timers || this.flushTimer || !this.o.file) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush(false);
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  /** Persist synchronously (content changes, or seenAt-only every 6 h / on shutdown). */
  flush(force: boolean): void {
    if (!this.o.file || !this.ownsLock || this.loadBlocked) return;
    const now = this.now();
    const due = this.contentDirty || (this.seenDirty && (force || now - this.lastFlush > SEEN_FLUSH_MS));
    if (!due) return;
    const file = this.o.file;
    const tmp = `${file}.tmp-${process.pid}-${++this.writeSeq}`;
    try {
      fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
      const data = JSON.stringify({
        format: FORMAT,
        version: FILE_VERSION,
        algo: ALGO_VERSION,
        savedAt: Math.round(now / 1000),
        shapes: Object.fromEntries(this.entries),
      });
      const fd = fs.openSync(/*turbopackIgnore: true*/ tmp, "w");
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.existsSync(/*turbopackIgnore: true*/ file)) fs.copyFileSync(/*turbopackIgnore: true*/ file, `${file}.bak`);
      fs.renameSync(/*turbopackIgnore: true*/ tmp, file);
      this.fileMtime = fs.statSync(/*turbopackIgnore: true*/ file).mtimeMs;
      this.contentDirty = false;
      this.seenDirty = false;
      this.lastFlush = now;
      this.persistError = null;
    } catch (err) {
      this.persistError = err instanceof Error ? err.message : String(err);
      log.error("shapes", `store save failed: ${this.persistError}`);
      try {
        fs.unlinkSync(/*turbopackIgnore: true*/ tmp);
      } catch {
        /* nothing to clean */
      }
      // retry later via the debounce
      if (this.o.timers && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this.flush(false);
        }, 5 * 60_000);
        this.flushTimer.unref?.();
      }
    }
  }

  /** Load the store file (falling back to .bak). Unknown/corrupt files are set aside. */
  load(): void {
    const file = this.o.file;
    if (!file) return;
    for (const p of [file, `${file}.bak`]) {
      let text: string;
      try {
        text = fs.readFileSync(/*turbopackIgnore: true*/ p, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        log.error("shapes", `cannot read ${p}: ${err} — store is read-only`);
        this.loadBlocked = true;
        return;
      }
      let parsed: Record<string, unknown> | null = null;
      try {
        const v = JSON.parse(text) as unknown;
        parsed = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.format !== FORMAT) {
        log.warn("shapes", `${p} is not a valid shape store — setting it aside`);
        if (p === file) {
          try {
            fs.renameSync(/*turbopackIgnore: true*/ p, `${file}.corrupt-${Math.round(this.now() / 1000)}`);
          } catch {
            this.loadBlocked = true;
            return;
          }
        }
        continue;
      }
      if (typeof parsed.version !== "number" || parsed.version > FILE_VERSION) {
        log.warn("shapes", `${p} has a newer format (v${String(parsed.version)}) — not touching it`);
        this.loadBlocked = true;
        return;
      }
      const shapes = parsed.shapes && typeof parsed.shapes === "object" ? (parsed.shapes as Record<string, unknown>) : {};
      const next = new Map<string, ShapeEntry>();
      for (const [k, v] of Object.entries(shapes)) {
        if (!/^(kb:[0-9a-f]{12}|mzk:\d{1,10})$/.test(k)) continue;
        const e = validEntry(v);
        if (e) next.set(k, e);
      }
      this.entries = next;
      this.geomCache.clear();
      try {
        this.fileMtime = fs.statSync(/*turbopackIgnore: true*/ p).mtimeMs;
      } catch {
        /* ignore */
      }
      if (p !== file) this.contentDirty = true;
      log.info("shapes", `loaded ${next.size} stored shapes from ${p}`);
      return;
    }
  }

  private lockOwner(): { pid?: number; host?: string; mtimeMs: number } | null {
    const lock = `${this.o.file}.lock`;
    try {
      const st = fs.statSync(/*turbopackIgnore: true*/ lock);
      const cur = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ lock, "utf-8")) as { pid?: number; host?: string };
      return { pid: cur.pid, host: cur.host, mtimeMs: st.mtimeMs };
    } catch (err) {
      // exists but unreadable/half-written: treat as held (fresh) by someone else
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : { mtimeMs: Date.now() };
    }
  }

  private isMine(o: { pid?: number; host?: string } | null): boolean {
    return !!o && o.pid === process.pid && o.host === os.hostname();
  }

  /**
   * Take the single-writer lock: atomic create (`wx`) when free; a stale lock
   * (no heartbeat for 5 min) is replaced via write-tmp + rename. Verified by
   * re-reading, so two racing processes can't both win.
   */
  private tryLock(): boolean {
    const file = this.o.file;
    if (!file) return true;
    const lock = `${file}.lock`;
    const body = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Math.round(Date.now() / 1000) });
    try {
      fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
      const cur = this.lockOwner();
      if (this.isMine(cur)) return true;
      if (!cur) {
        fs.writeFileSync(/*turbopackIgnore: true*/ lock, body, { flag: "wx" });
      } else if (Date.now() - cur.mtimeMs >= LOCK_STALE_MS) {
        const tmp = `${lock}.tmp-${process.pid}`;
        fs.writeFileSync(/*turbopackIgnore: true*/ tmp, body);
        fs.renameSync(/*turbopackIgnore: true*/ tmp, lock);
      } else {
        return false;
      }
      return this.isMine(this.lockOwner());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") log.warn("shapes", `cannot take lock ${lock}: ${err}`);
      return false;
    }
  }

  private heartbeat(): void {
    const file = this.o.file;
    if (!file) return;
    if (this.ownsLock) {
      // still ours? (after a long stall a peer may have taken over a stale lock)
      if (!this.isMine(this.lockOwner())) {
        log.warn("shapes", "store lock taken over by another process — now read-only");
        this.ownsLock = false;
        this.readOnly = true;
        this.urgent = [];
        this.background = [];
        this.queued.clear();
        return;
      }
      try {
        const t = new Date();
        fs.utimesSync(/*turbopackIgnore: true*/ `${file}.lock`, t, t);
      } catch {
        /* checked again next beat */
      }
      this.flush(false);
      return;
    }
    // read-only: follow the writer's file, and take over a stale lock
    try {
      const m = fs.statSync(/*turbopackIgnore: true*/ file).mtimeMs;
      if (m !== this.fileMtime) this.load();
    } catch {
      /* no file yet */
    }
    if (this.tryLock()) {
      this.ownsLock = true;
      this.readOnly = false;
      this.load();
      log.info("shapes", "acquired store lock — worker enabled");
      this.kick();
    }
  }
}

/* ------------------------------------------------------------ singleton */

const KEY = Symbol.for("kb-gtfs.shape-store");
type GlobalWithStore = typeof globalThis & { [KEY]?: ShapeStore };

/** The process-wide store (created on first use; start() is separate). */
export function getShapeStore(factory: () => ShapeStore): ShapeStore {
  const g = globalThis as GlobalWithStore;
  g[KEY] ??= factory();
  return g[KEY];
}
