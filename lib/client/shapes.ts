/**
 * Client cache of server-stored road shapes (GET /api/shapes). Ids carry a
 * content revision, so responses are immutable-cached by the browser and a
 * shape is fetched once per session. Leaflet-free.
 */
import { decodePolyline, preparePolyline, type LatLng, type Polyline } from "../shared/polyline";

export interface ClientShape {
  /** the requested wire id ("<key>.<rev>") */
  id: string;
  pts: LatLng[];
  pl: Polyline;
  stops: Array<number | null>;
  /** part of a GZM road match: the full one follows */
  partial?: boolean;
}

interface ShapePayload {
  id?: unknown;
  src?: unknown;
  poly?: unknown;
  stops?: unknown;
}

const MAX_CACHE = 300;
const BATCH = 40;
const MAX_INFLIGHT = 2;
const MISSING_RETRY_MS = 60_000;
/** a hung request would hold one of the MAX_INFLIGHT slots (and the fleet queue) until the browser gives up */
const FETCH_TIMEOUT_MS = 15_000;

const cache = new Map<string, ClientShape>();
const negative = new Map<string, number>();
const inflight = new Map<string, Promise<ClientShape | null>>();
const listeners = new Set<(s: ClientShape) => void>();
const queue = new Set<string>();
let running = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;
let netBackoffMs = 30_000;

/** Decode one /api/shapes entry (pure; malformed entries → null). */
export function parseShapePayload(reqId: string, raw: unknown, precision = 6): ClientShape | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as ShapePayload;
  if (typeof p.poly !== "string") return null;
  const pts = decodePolyline(p.poly, precision);
  const pl = preparePolyline(pts);
  if (!pl) return null;
  const stops = Array.isArray(p.stops)
    ? p.stops.map((s) => (typeof s === "number" && Number.isFinite(s) ? s : null))
    : [];
  return { id: reqId, pts, pl, stops, ...(p.src === "partial" ? { partial: true } : {}) };
}

/** Capped like the cache: an evicted entry only allows an earlier retry. */
function markMissing(id: string, until: number): void {
  negative.delete(id);
  negative.set(id, until);
  if (negative.size > MAX_CACHE) negative.delete(negative.keys().next().value!);
}

function remember(s: ClientShape): void {
  cache.delete(s.id);
  cache.set(s.id, s);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  listeners.forEach((fn) => fn(s));
}

export function getShape(id: string): ClientShape | undefined {
  const s = cache.get(id);
  if (s) {
    cache.delete(id);
    cache.set(id, s);
  }
  return s;
}

/** Subscribe to shapes as they arrive. */
export function onShape(fn: (s: ClientShape) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function fetchBatch(ids: string[]): Promise<void> {
  running += 1;
  const p = (async () => {
    try {
      const res = await fetch(`/api/shapes?ids=${ids.map(encodeURIComponent).join(",")}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { precision?: number; shapes?: Record<string, unknown>; missing?: unknown };
      const precision = typeof body.precision === "number" ? body.precision : 6;
      netBackoffMs = 30_000;
      const now = Date.now();
      for (const id of ids) {
        const raw = body.shapes?.[id];
        // a stale revision is answered with the CURRENT geometry under its own
        // id: cache it under that id only — dist_m for the stale id was measured
        // on the old geometry
        const cur = raw && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : id;
        const s = parseShapePayload(cur, raw, precision);
        if (s) remember(s);
        if (!s || cur !== id) markMissing(id, now + MISSING_RETRY_MS);
      }
    } catch {
      const until = Date.now() + netBackoffMs;
      netBackoffMs = Math.min(netBackoffMs * 2, 5 * 60_000);
      for (const id of ids) markMissing(id, until);
    }
  })();
  for (const id of ids) inflight.set(id, p.then(() => cache.get(id) ?? null));
  try {
    await p;
  } finally {
    for (const id of ids) inflight.delete(id);
    running -= 1;
    pump();
  }
}

function pump(): void {
  while (running < MAX_INFLIGHT && queue.size) {
    const ids = [...queue].sort().slice(0, BATCH);
    ids.forEach((id) => queue.delete(id));
    void fetchBatch(ids);
  }
}

function wanted(id: string, now: number): boolean {
  if (!id || cache.has(id) || inflight.has(id) || queue.has(id)) return false;
  const neg = negative.get(id);
  if (neg !== undefined && neg <= now) negative.delete(id);
  return !(neg !== undefined && neg > now);
}

/** Queue shapes for a (debounced, batched) fetch. */
export function requestShapes(ids: Iterable<string>): void {
  const now = Date.now();
  let added = false;
  for (const id of ids) {
    if (!wanted(id, now)) continue;
    queue.add(id);
    added = true;
  }
  if (!added || debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    pump();
  }, 60);
}

/** Fetch one shape now (trip views) — resolves from cache when present. */
export async function loadShape(id: string): Promise<ClientShape | null> {
  const hit = getShape(id);
  if (hit) return hit;
  const pending = inflight.get(id);
  if (pending) return pending;
  queue.delete(id);
  negative.delete(id);
  await fetchBatch([id]);
  return cache.get(id) ?? null;
}

/**
 * The newer revision of shape `id` once the server has one (a stale id is answered with it), else null (an
 * unchanged one is a bodiless 304); skips every cache. `near` ("s,w,n,e") steers a running road match there.
 */
export async function fetchNewerShape(id: string, signal: AbortSignal, near?: string): Promise<ClientShape | null> {
  const res = await fetch(`/api/shapes?ids=${encodeURIComponent(id)}${near ? `&near=${near}` : ""}`, {
    cache: "no-store",
    signal,
    headers: { "If-None-Match": `"${id}"` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { precision?: number; shapes?: Record<string, unknown> };
  const raw = body.shapes?.[id];
  const cur = raw && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : id;
  if (cur === id) return null;
  const s = parseShapePayload(cur, raw, typeof body.precision === "number" ? body.precision : 6);
  if (s) remember(s);
  return s;
}

/** Like loadShape, but a newer revision of the same shape is fine too (trip views). */
export async function loadShapeLatest(id: string): Promise<ClientShape | null> {
  const exact = await loadShape(id);
  if (exact) return exact;
  const base = id.replace(/\.[0-9a-f]{6}$/, "");
  for (const [k, v] of cache) if (k.startsWith(`${base}.`)) return v;
  return null;
}
