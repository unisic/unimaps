/**
 * Road-matched GZM shapes. zbiorkom's shapes.txt is sparse (line 27: 411 points over 38 km, segments up to
 * 670 m), so a route drawn on it cuts corners through buildings. A bus or trolleybus shape is map-matched
 * through OSRM /match when a trip of it is opened, newest open first, one geometry at a time on the shared
 * OSRM pace, persisted by the raw polyline's hash (shapes with the same geometry share one match: GZM has
 * 4161 bus and trolleybus shapes but 2642 geometries) and applied by every later feed build. Trams stay raw:
 * the car profile has no rails.
 * The part of the route on screen goes first: chunks inside the focus box (the opened vehicle, then the
 * viewer's map from focusShapeMatch) are matched before the rest and published at once as a `partial`
 * shape, so the road appears where the rider looks after a request or two instead of the whole ~20 s.
 * Every request goes to the route opened or watched last: a newer open waits one request, not for the
 * whole older match, which resumes where it stopped.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as config from "./config";
import type { GzmShapes } from "./gzm-feed";
import { isRecord } from "./kb-api";
import { log } from "./logger";
import {
  chunkWaypoints,
  MATCH_CHUNK,
  MATCH_CHUNK_PUBLIC,
  matchChunk,
  mergeChunkGeometries,
  OSRM_PACE,
  osrmMatchBase,
  paceRequest,
} from "./osrm";
import { decodePolyline, encodePolyline, simplifyPolyline, type LatLng, type LatLonBox } from "./shared/polyline";

const FILE = path.join(config.GZM_DIR, "matched-shapes.v1.json");
const FORMAT = "unimaps/gzm-matched-shapes";
/** Douglas-Peucker before matching: line 27 goes 411 -> 167 points (19 requests), each within 10 m of the raw shape. */
const SIMPLIFY_M = 10;
/** Geometries waiting for a match; the oldest is dropped for a new one (its next open asks again). */
const QUEUE_MAX = 20;
const WRITE_DELAY_MS = 5000;

interface Target {
  shapes: GzmShapes;
  rev: string;
  refs: ReadonlyArray<readonly [number, number] | null>;
}

interface Job {
  raw: string;
  /** every opened shape with this geometry, by shape key */
  targets: Map<string, Target>;
  /** what the rider sees: chunks crossing it are matched first */
  focus: LatLonBox | null;
  /** the simplified trace in requests of the OSRM chunk size, their boxes and their matches so far */
  chunks: LatLng[][];
  boxes: LatLonBox[];
  parts: Array<LatLng[] | null>;
  t0: number;
  kept: number;
  firstMs: number;
}

const base = config.OSRM_URL ? osrmMatchBase(config.OSRM_URL) : null;
/** rawKey -> matched polyline */
let store: Map<string, string> | null = null;
/** the route opened or watched last first */
const queue: Job[] = [];
/** every queued or running job by rawKey */
const queued = new Map<string, Job>();
let running = false;
let pausedUntil = 0;
let writeTimer: NodeJS.Timeout | null = null;

function load(): Map<string, string> {
  if (store) return store;
  store = new Map();
  try {
    const j: unknown = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const shapes = isRecord(j) && j.format === FORMAT && isRecord(j.shapes) ? j.shapes : {};
    for (const [k, v] of Object.entries(shapes)) {
      if (typeof v === "string") store.set(k, v);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("gzm-match", `unreadable ${FILE}, starting empty: ${err}`);
  }
  return store;
}

// ponytail: last writer wins when two processes share output/ (a match the other one made is redone on its next open)
function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, shapes: Object.fromEntries(load()) }));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      log.warn("gzm-match", `write failed: ${err}`);
    }
  }, WRITE_DELAY_MS);
  writeTimer.unref();
}

/** Store key of a zbiorkom polyline. */
export function rawKey(poly: string): string {
  return createHash("sha1").update(poly).digest("hex").slice(0, 16);
}

/** The matched points of zbiorkom polyline `poly`. */
export function matchedPoints(poly: string): LatLng[] | null {
  const s = load();
  const m = s.size ? s.get(rawKey(poly)) : undefined;
  return m ? decodePolyline(m) : null;
}

/** Forget the matches of geometries the feed in use no longer has: the file stays the feed's size. */
export function pruneMatched(shapes: GzmShapes): void {
  const s = load();
  if (!s.size) return;
  const keep = shapes.rawKeys();
  let changed = false;
  for (const k of s.keys()) {
    if (keep.has(k)) continue;
    s.delete(k);
    changed = true;
  }
  if (changed) scheduleWrite();
}

/**
 * Match shape `key` of `shapes` (its stops at `refs`) in the background, the part in `focus` first; a stored
 * match applies at once. True while a match of it is queued or running.
 */
export function requestShapeMatch(
  shapes: GzmShapes,
  key: string,
  refs: ReadonlyArray<readonly [number, number] | null>,
  focus: LatLonBox | null = null,
): boolean {
  const e = shapes.unmatched(key);
  if (!e || !base) return false;
  const raw = rawKey(e.poly);
  const m = load().get(raw);
  if (m) {
    shapes.upgrade(key, e.rev, decodePolyline(m), refs);
    return false;
  }
  const target: Target = { shapes, rev: e.rev, refs };
  const job = queued.get(raw);
  if (job) {
    job.targets.set(key, target);
    // the viewer's map (focusShapeMatch) wins over the vehicle box a trip refresh brings again
    job.focus ??= focus;
    toFront(job);
    return true;
  }
  if (Date.now() < pausedUntil) return false;
  if (queue.length >= QUEUE_MAX) queued.delete(queue.pop()!.raw);
  const chunks = chunkWaypoints(simplifyPolyline(decodePolyline(e.poly), SIMPLIFY_M), config.PUBLIC_OSRM ? MATCH_CHUNK_PUBLIC : MATCH_CHUNK);
  const fresh: Job = {
    raw,
    targets: new Map([[key, target]]),
    focus,
    chunks,
    boxes: chunks.map(boxOf),
    parts: chunks.map(() => null),
    t0: Date.now(),
    kept: 0,
    firstMs: 0,
  };
  queued.set(raw, fresh);
  queue.unshift(fresh);
  void work();
  return true;
}

/** Move the match of shape `key` to what the rider now sees and make it next; never starts one. */
export function focusShapeMatch(shapes: GzmShapes, key: string, focus: LatLonBox): void {
  const e = shapes.unmatched(key);
  const job = e && queued.get(rawKey(e.poly));
  if (!job) return;
  job.focus = focus;
  toFront(job);
}

function toFront(job: Job): void {
  const i = queue.indexOf(job);
  if (i <= 0) return;
  queue.splice(i, 1);
  queue.unshift(job);
}

function drop(job: Job): void {
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
  if (queued.get(job.raw) === job) queued.delete(job.raw);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

async function work(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // the slot is booked before the job is picked: a route opened or watched meanwhile goes next
      await paceRequest(OSRM_PACE, config.OSRM_MIN_INTERVAL_MS, Date.now(), sleep);
      const job = queue[0];
      if (!job) break;
      try {
        if (await step(job)) drop(job);
      } catch (err) {
        log.warn("gzm-match", `${job.raw}: ${err}`);
        drop(job);
      }
    }
  } finally {
    running = false;
  }
}

function boxOf(pts: readonly LatLng[]): LatLonBox {
  const b = { s: Infinity, w: Infinity, n: -Infinity, e: -Infinity };
  for (const [lat, lon] of pts) {
    b.s = Math.min(b.s, lat);
    b.n = Math.max(b.n, lat);
    b.w = Math.min(b.w, lon);
    b.e = Math.max(b.e, lon);
  }
  return b;
}

const overlaps = (a: LatLonBox, b: LatLonBox): boolean => a.s <= b.n && a.n >= b.s && a.w <= b.e && a.e >= b.w;

/** One OSRM request for `job`, a chunk in its focus first; true once the job is finished or gone. */
async function step(job: Job): Promise<boolean> {
  if (!base || ![...job.targets].some(([k, t]) => t.shapes.unmatched(k)?.rev === t.rev)) return true;
  const { chunks, boxes, parts } = job;
  const inView = (i: number) => parts[i] === null && job.focus !== null && overlaps(boxes[i], job.focus);
  let i = parts.findIndex((_, j) => inView(j));
  const focused = i >= 0;
  if (!focused) i = parts.indexOf(null);
  // the worker paces itself
  const o = { base, fetchImpl: globalThis.fetch.bind(globalThis), userAgent: config.OSRM_USER_AGENT, throttle: async () => {} };
  const r = await matchChunk(chunks[i], o);
  if (!r.ok) {
    const ms = r.kind === "ratelimited" ? (r.retryAfterSec ?? 60) * 1000 : r.kind === "unavailable" ? 300_000 : 3_600_000;
    pausedUntil = Date.now() + ms;
    for (const j of queue) queued.delete(j.raw);
    queue.length = 0;
    log.warn("gzm-match", `${[...job.targets.keys()].join(" ")}: ${r.kind} (${r.detail}), paused ${Math.round(ms / 60_000)} min`);
    return true;
  }
  parts[i] = r.pts;
  if (r.kept) job.kept += 1;
  const merged = () => mergeChunkGeometries(parts.map((p, j) => p ?? chunks[j]));
  if (parts.includes(null)) {
    // the view is matched and the rest is not: show it now, the raw rest stays off screen until the full match
    if (focused && !parts.some((_, j) => inView(j))) {
      const pts = merged();
      for (const [k, t] of job.targets) t.shapes.upgrade(k, t.rev, pts, t.refs, true);
      job.firstMs ||= Date.now() - job.t0;
    }
    return false;
  }
  const pts = merged();
  load().set(job.raw, encodePolyline(pts));
  scheduleWrite();
  for (const [k, t] of job.targets) t.shapes.upgrade(k, t.rev, pts, t.refs);
  log.info(
    "gzm-match",
    `${[...job.targets.keys()].join(" ")}: ${chunks.length} requests, ${job.kept} kept raw, view in ${job.firstMs || "-"} ms, all in ${Date.now() - job.t0} ms`,
  );
  return true;
}
