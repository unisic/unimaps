/**
 * Service announcements ("Utrudnienia") — a module-level store modeled on
 * lib/client/favorites.ts, so the TopBar badge and the sheet stay in sync
 * without threading props through MapApp and without touching the 5 s vehicle
 * poll cycle. Fetches at most once per 15 min while the tab is visible.
 * Unread state = upstream's set `hash` vs the last seen hash in localStorage.
 * One city per page load (lib/client/city.ts): the first subscriber fixes it.
 */
import { external } from "@/lib/client/external";

import { fetchJSON } from "./api";
import { cityKey, cityUrl, type City } from "./city";
import type { Announcement, AnnouncementsResponse } from "./types";

let city: City = "bb";
const seenKey = (): string => cityKey("kb:annSeen", city);
const REFRESH_MS = 15 * 60_000;
const STALE_ON_OPEN_MS = 5 * 60_000;
const EMPTY: readonly Announcement[] = [];

export type AnnouncementsStatus = "idle" | "loading" | "ready" | "error";

export interface AnnouncementsSnapshot {
  status: AnnouncementsStatus;
  items: readonly Announcement[];
  /** upstream set hash; null until the first successful fetch */
  hash: string | null;
  /** last hash the user has opened the sheet on */
  seenHash: string | null;
}

const INITIAL: AnnouncementsSnapshot = { status: "idle", items: EMPTY, hash: null, seenHash: null };

let snapshot: AnnouncementsSnapshot = INITIAL;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let ctl: AbortController | null = null;
let lastFetchAt = 0;

function loadSeen(): string | null {
  try {
    return window.localStorage.getItem(seenKey());
  } catch {
    return null;
  }
}

/* snapshot keeps a stable reference between changes (an external store
   contract) — replaced only here */
function emit(next: Partial<AnnouncementsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  subs.forEach((f) => f());
}

/** Fetch now, aborting any in-flight request (the lib/client/api pattern). */
export async function refreshAnnouncements(): Promise<void> {
  ctl?.abort();
  const ac = new AbortController();
  ctl = ac;
  lastFetchAt = Date.now();
  if (snapshot.status !== "ready") emit({ status: "loading" });
  try {
    const resp = await fetchJSON<AnnouncementsResponse>(cityUrl("/api/announcements", city), {
      cache: "no-store",
      signal: ac.signal,
    });
    if (ac.signal.aborted) return;
    // {} from the route = upstream had nothing (pyTruthy-false) — an empty
    // list, not an error. Upstream text carries stray U+FEFF chars — strip.
    const items = (Array.isArray(resp.announcements) ? resp.announcements : [])
      .filter((a): a is Announcement => !!a && typeof a.content_markdown === "string")
      .map((a) => ({ ...a, content_markdown: a.content_markdown.replace(/\uFEFF/g, "").trim() }))
      .filter((a) => a.content_markdown.length > 0);
    emit({ status: "ready", items, hash: typeof resp.hash === "string" ? resp.hash : null });
  } catch {
    if (ac.signal.aborted) return;
    // stale-while-error: a failed refresh keeps a loaded list (and its unread dot)
    if (snapshot.status !== "ready") emit({ status: "error" });
  }
}

export const getAnnouncementsSnapshot = (): AnnouncementsSnapshot => snapshot;
const refresh = (): void => void refreshAnnouncements();

/** Refresh only when the data is older than the sheet-open staleness window. */
export function refreshAnnouncementsIfStale(): void {
  if (Date.now() - lastFetchAt >= STALE_ON_OPEN_MS) void refreshAnnouncements();
}

/** Record the current set as seen (clears the TopBar dot, persists cross-tab). */
export function markAnnouncementsSeen(): void {
  if (snapshot.hash === null || snapshot.hash === snapshot.seenHash) return;
  try {
    window.localStorage.setItem(seenKey(), snapshot.hash);
  } catch {
    /* private mode — keep the in-memory state */
  }
  emit({ seenHash: snapshot.hash });
}

function tick(): void {
  if (document.hidden) return;
  if (Date.now() - lastFetchAt < REFRESH_MS) return;
  void refreshAnnouncements();
}

/* cross-tab: another tab opened the sheet → its markSeen clears our dot too */
function onStorage(e: StorageEvent): void {
  if (e.key === seenKey() || e.key === null) emit({ seenHash: loadSeen() });
}

function subscribe(fn: () => void, c: City): () => void {
  subs.add(fn);
  if (subs.size === 1) {
    city = c;
    snapshot = { ...snapshot, seenHash: loadSeen() };
    window.addEventListener("storage", onStorage);
    // catch-up when the tab returns after being hidden through a refresh window
    document.addEventListener("visibilitychange", tick);
    timer = setInterval(tick, 60_000);
    if (snapshot.status === "idle") void refreshAnnouncements();
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0) {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", tick);
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

/** Reactive announcements of `c` (the page's city): polling runs while something reads it. */
export function announcementsOf(c: City): {
  readonly status: AnnouncementsStatus;
  readonly items: readonly Announcement[];
  readonly unseen: boolean;
  refresh: () => void;
  markSeen: () => void;
} {
  const store = external((fn) => subscribe(fn, c), getAnnouncementsSnapshot);
  return {
    get status() {
      return store.current.status;
    },
    get items() {
      return store.current.items;
    },
    get unseen() {
      const snap = store.current;
      return snap.status === "ready" && snap.items.length > 0 && snap.hash !== null && snap.hash !== snap.seenHash;
    },
    refresh,
    markSeen: markAnnouncementsSeen,
  };
}
