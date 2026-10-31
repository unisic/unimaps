/**
 * The few parts of SWR the app used, for Svelte: one shared entry per URL (every reader of a key shares one
 * request, one timer and one copy of the data), deduped requests, refresh on an interval chosen from the
 * latest data, revalidation on focus / reconnect, no polling in a hidden tab, retry with backoff, and an
 * unchanged payload keeps its identity (a deep compare), so a poll that brings nothing new triggers nothing.
 */
import { untrack } from "svelte";

export interface SwrOptions<T> {
  refreshInterval?: number | ((latest: T | undefined) => number);
  /** a request for the key started this recently is reused (default 2 s) */
  dedupingInterval?: number;
  revalidateOnFocus?: boolean;
  /** at most one focus revalidation per this window (default 5 s) */
  focusThrottleInterval?: number;
  revalidateOnReconnect?: boolean;
  /** false: a reader that mounts with cached data does not refetch it */
  revalidateIfStale?: boolean;
  shouldRetryOnError?: (err: unknown) => boolean;
}

export interface Swr<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly isValidating: boolean;
  mutate(): Promise<void>;
}

const RETRY_MS = 5000;
const MAX_ENTRIES = 64;

class Entry<T> {
  data = $state.raw<T | undefined>(undefined);
  error = $state.raw<unknown>(undefined);
  validating = $state(false);
  inflight: Promise<void> | null = null;
  startedAt = 0;
  focusAt = 0;
  retries = 0;
  users = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  opts: SwrOptions<T> = {};
  constructor(
    readonly key: string,
    readonly fetcher: (url: string) => Promise<T>,
  ) {}
}

const cache = new Map<string, Entry<unknown>>();

function entry<T>(key: string, fetcher: (url: string) => Promise<T>): Entry<T> {
  let e = cache.get(key) as Entry<T> | undefined;
  if (!e) {
    e = new Entry(key, fetcher);
    cache.set(key, e as Entry<unknown>);
    // keys are URLs of one city: a handful, but a long session must not keep every vehicle card it opened
    if (cache.size > MAX_ENTRIES) {
      for (const [k, old] of cache) {
        if (cache.size <= MAX_ENTRIES) break;
        if (old.users === 0 && !old.inflight) cache.delete(k);
      }
    }
  }
  return e;
}

/** Structural equality of two JSON values. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function revalidate<T>(e: Entry<T>, dedupeMs: number): Promise<void> {
  if (e.inflight && performance.now() - e.startedAt < dedupeMs) return e.inflight;
  e.startedAt = performance.now();
  e.validating = true;
  const p: Promise<void> = e.fetcher(e.key)
    .then(
      (body) => {
        e.retries = 0;
        if (e.error !== undefined) e.error = undefined;
        if (!same(e.data, body)) e.data = body;
      },
      (err: unknown) => {
        e.error = err;
      },
    )
    .finally(() => {
      if (e.inflight !== p) return;
      e.inflight = null;
      e.validating = false;
    });
  e.inflight = p;
  return p;
}

/* One timer per entry, whoever mounted it: two readers of one key never poll twice. */
function run<T>(e: Entry<T>): Promise<void> {
  return revalidate(e, e.opts.dedupingInterval ?? 2000).then(() => next(e));
}

function next<T>(e: Entry<T>): void {
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (e.users === 0) return;
  const r = e.opts.refreshInterval;
  const every = typeof r === "function" ? r(e.data) : (r ?? 0);
  let ms = every;
  if (e.error !== undefined && (e.opts.shouldRetryOnError?.(e.error) ?? true)) {
    // SWR's backoff: 5 s x 2^n (n capped at 8), jittered x0.5-1.5
    const retry = Math.floor((Math.random() + 0.5) * (1 << Math.min(e.retries++, 8))) * RETRY_MS;
    ms = every > 0 ? Math.min(every, retry) : retry;
  }
  if (ms > 0) e.timer = setTimeout(() => tick(e), ms);
}

function tick<T>(e: Entry<T>): void {
  e.timer = null;
  // a hidden or offline tab skips the poll; focus / reconnect catch up
  if (document.hidden || !navigator.onLine) return next(e);
  void run(e);
}

/** Starts the request for `key` now (before any reader mounts); a reader mounting within the dedupe window reuses it. */
export function preload<T>(key: string, fetcher: (url: string) => Promise<T>): void {
  void revalidate(entry(key, fetcher), 2000);
}

/**
 * Reads `key()` (null = nothing to fetch) through the shared cache. Call it while a component initialises:
 * the timers and listeners live as long as the component, and follow the key when it changes.
 */
export function swr<T>(key: () => string | null, fetcher: (url: string) => Promise<T>, opts: SwrOptions<T> = {}): Swr<T> {
  const current = $derived.by(() => {
    const k = key();
    return k == null ? null : entry(k, fetcher);
  });

  $effect(() => {
    const e = current;
    if (!e) return;
    return untrack(() => {
      e.users++;
      e.opts = opts;
      const onFocus = () => {
        if (document.hidden) return;
        const now = performance.now();
        if (now - e.focusAt < (opts.focusThrottleInterval ?? 5000)) return;
        e.focusAt = now;
        void run(e);
      };
      const onOnline = () => void run(e);
      if (opts.revalidateOnFocus ?? true) {
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onFocus);
      }
      if (opts.revalidateOnReconnect ?? true) window.addEventListener("online", onOnline);
      // SWR ignores focus right after mount: the mount fetch covers it
      e.focusAt = performance.now();
      if (e.data === undefined || (opts.revalidateIfStale ?? true)) void run(e);
      else if (!e.timer) next(e);
      return () => {
        if (--e.users === 0 && e.timer) {
          clearTimeout(e.timer);
          e.timer = null;
        }
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onFocus);
        window.removeEventListener("online", onOnline);
      };
    });
  });

  return {
    get data() {
      return current?.data;
    },
    get error() {
      return current?.error;
    },
    get isLoading() {
      return !!current && current.validating && current.data === undefined;
    },
    get isValidating() {
      return !!current?.validating;
    },
    mutate: () => {
      const e = current;
      return e ? revalidate(e, 0).then(() => next(e)) : Promise.resolve();
    },
  };
}
