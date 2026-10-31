/**
 * "Motyw" preference: system (nothing stored), light or dark under kb:theme. The inline script in
 * app/head.ts applies it before first paint and follows system changes; this store only backs
 * the settings switch and re-applies on a change (same resolution as that script).
 */
import { external } from "@/lib/client/external";

export type ThemePref = "system" | "light" | "dark";

const KEY = "kb:theme";
/** --color-bg of each theme, for the browser chrome */
const CHROME = { light: "#f2f3f5", dark: "#0d1013" } as const;

let snapshot: ThemePref | null = null;
const subs = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function getThemePref(): ThemePref {
  return (snapshot ??= read());
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    /* private mode: this page keeps it */
  }
  snapshot = pref;
  const theme = pref === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = theme;
  document.getElementById("kb-theme-color")?.setAttribute("content", CHROME[theme]);
  subs.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export const themePref = external(subscribe, getThemePref);
