"use client";

/**
 * "Płynny ruch pojazdów" preference — a per-browser on/off switch for the
 * vehicle dead-reckoning animation. Module-level useSyncExternalStore store
 * (same pattern as favorites.ts) so only the settings switch and the animator
 * react to it — MapApp never re-renders on toggle.
 *
 * Stored as "1"/"0" under kb:smoothMotion; absent = follow the OS
 * reduced-motion setting (on unless the system asks for less motion).
 */
import { useCallback, useSyncExternalStore } from "react";
import { prefersReducedMotion } from "./motion";

const KEY = "kb:smoothMotion";

/** Pure resolution of the stored value against the OS preference. */
export function resolveSmoothMotion(stored: string | null, reducedMotion: boolean): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return !reducedMotion;
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
let mql: MediaQueryList | null = null;

function compute(): boolean {
  return resolveSmoothMotion(readStored(), prefersReducedMotion());
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
    mql = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    mql?.addEventListener?.("change", refresh);
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      mql?.removeEventListener?.("change", refresh);
      mql = null;
    }
  };
}

export function useSmoothMotion(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeSmoothMotion, getSmoothMotion, () => false);
  const set = useCallback((v: boolean) => setSmoothMotion(v), []);
  return [on, set];
}
