/**
 * Tiny TTL cache with in-flight coalescing, for hot PUBLIC per-key data (the
 * stop departures board): N viewers of the same stop cost one upstream call
 * per `ttlMs`, and a burst of simultaneous requests shares one load.
 *
 *  - fresh entry        -> returned as-is (`ageMs` = how old the data is)
 *  - load in flight     -> joined (every caller gets the same promise)
 *  - rejection          -> never cached (the next caller retries), seen by all joiners
 *  - `cacheable(value)` -> lets the caller refuse to cache e.g. a partial result
 *  - bounded by `max` (oldest-inserted first), like the other caches in lib/
 *
 * Single-process assumption (see CLAUDE.md): in-memory is the point.
 */
export interface MicroCacheOptions<T> {
  ttlMs: number;
  max?: number;
  now?: () => number;
  cacheable?: (value: T) => boolean;
}

export interface MicroCache<T> {
  get(key: string, load: () => Promise<T>): Promise<{ value: T; ageMs: number }>;
  size(): number;
  clear(): void;
}

interface Entry<T> {
  value: T;
  at: number;
}

export function createMicroCache<T>(opts: MicroCacheOptions<T>): MicroCache<T> {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? 500;
  const done = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<{ value: T; ageMs: number }>>();

  return {
    get(key, load) {
      const t = now();
      const hit = done.get(key);
      if (hit && t - hit.at < opts.ttlMs) return Promise.resolve({ value: hit.value, ageMs: t - hit.at });
      if (hit) done.delete(key);
      const pending = inflight.get(key);
      if (pending) return pending;
      const p = (async () => {
        try {
          const value = await load();
          const at = now();
          if (!opts.cacheable || opts.cacheable(value)) {
            done.set(key, { value, at });
            while (done.size > max) {
              const oldest = done.keys().next().value;
              if (oldest === undefined) break;
              done.delete(oldest);
            }
          }
          return { value, ageMs: 0 };
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    size: () => done.size,
    clear() {
      done.clear();
    },
  };
}
