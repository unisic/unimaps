/**
 * Favorite stops — a module-level localStorage-backed store, so the StopView
 * star and the command palette stay in sync without threading props through
 * MapApp (and without re-rendering it on toggle).
 */
import { external } from "@/lib/client/external";

const KEY = "kb:favStops";
const MAX_FAVS = 50;
const EMPTY: readonly string[] = [];

function load(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_FAVS);
  } catch {
    return EMPTY;
  }
}

/* snapshot must keep a stable reference between changes (useSyncExternalStore
   contract) — recreated only inside mutate()/the storage handler */
let snapshot: readonly string[] | null = null;
const subs = new Set<() => void>();

function getSnapshot(): readonly string[] {
  if (snapshot === null) snapshot = load();
  return snapshot;
}

function mutate(next: readonly string[]): void {
  snapshot = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — keep the in-memory state */
  }
  subs.forEach((fn) => fn());
}

/* cross-tab sync: another tab wrote kb:favStops → reload the snapshot */
function onStorage(e: StorageEvent): void {
  if (e.key === KEY || e.key === null) {
    snapshot = load();
    subs.forEach((f) => f());
  }
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (subs.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    subs.delete(fn);
    if (subs.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** Current favourites outside React (timetable prefetch / offline save). */
export function getFavorites(): readonly string[] {
  return getSnapshot();
}

/** Toggle a stop (by designator — stop *names* are not unique). */
export function toggleFavorite(designator: string): void {
  const cur = getSnapshot();
  const next = cur.includes(designator)
    ? cur.filter((d) => d !== designator)
    : [...cur, designator].slice(-MAX_FAVS);
  mutate(next);
}

const store = external(subscribe, getSnapshot);
let setOf: { favs: readonly string[]; set: ReadonlySet<string> } = { favs: EMPTY, set: new Set() };

/** Reactive view of the favourites: reading a field inside a template or effect follows every change. */
export const favorites = {
  get favs(): readonly string[] {
    return store.current;
  },
  get favSet(): ReadonlySet<string> {
    const favs = store.current;
    if (setOf.favs !== favs) setOf = { favs, set: new Set(favs) };
    return setOf.set;
  },
  isFav(designator: string): boolean {
    return this.favSet.has(designator);
  },
  toggle: toggleFavorite,
};
