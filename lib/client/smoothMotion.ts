/**
 * "Płynny ruch pojazdów" preference — a per-browser on/off switch for the
 * vehicle dead-reckoning animation. Module-level external store
 * (same pattern as favorites.ts) so only the settings switch and the animator
 * react to it — MapApp never re-renders on toggle.
 *
 * Stored as "1"/"0" under kb:smoothMotion; absent = on (the default since the
 * engine stopped reversing buses); an explicit "0" still wins.
 */
import { external } from "@/lib/client/external";

const KEY = "kb:smoothMotion";

/** Pure resolution of the stored value: on unless explicitly switched off. */
export function resolveSmoothMotion(stored: string | null): boolean {
  return stored !== "0";
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let snapshot: boolean | null = null;
const subs = new Set<() => void>();

function compute(): boolean {
  return resolveSmoothMotion(readStored());
}

export function getSmoothMotion(): boolean {
  if (typeof window === "undefined") return false;
  if (snapshot === null) snapshot = compute();
  return snapshot;
}

function refresh(): void {
  const next = compute();
  if (next === snapshot) return;
  snapshot = next;
  subs.forEach((fn) => fn());
}

export function setSmoothMotion(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode — keep it for this session only */
  }
  snapshot = on;
  subs.forEach((fn) => fn());
}

function onStorage(e: StorageEvent): void {
  if (e.key === KEY || e.key === null) refresh();
}

export function subscribeSmoothMotion(fn: () => void): () => void {
  subs.add(fn);
  if (subs.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** Reactive switch state (`.current`); write with setSmoothMotion. */
export const smoothMotion = external(subscribeSmoothMotion, getSmoothMotion);
