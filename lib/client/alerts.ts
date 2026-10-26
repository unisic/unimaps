"use client";

/**
 * "Powiadom mnie": a notification when a departure is N minutes away. A module-level store (the
 * lib/client/favorites.ts pattern) persisted in localStorage, plus one watcher per stop with alerts.
 * The watcher polls that stop's board on its own (`isVisible: () => true`): the 4 s vehicle poll and
 * StopView's board both stop in a hidden tab, an alert must not.
 * Platform ceiling: Chrome throttles a hidden tab's timers to about once a minute after 5 min, iOS
 * suspends JS in the background; there it fires only while the app is open. Real web push would need
 * a push server (VAPID, subscriptions, a POST endpoint).
 */
import { useSyncExternalStore } from "react";

import { fetchJSON } from "@/lib/client/api";
import { nowSecs } from "@/lib/client/format";
import { createLivePoll, type LivePoll } from "@/lib/client/live-poll";
import type { DepartureRow, DeparturesResponse } from "@/lib/client/types";
import { kbRowKey, minutesUntil, mzkRowKey, resolveTiming, rowKey } from "@/lib/shared/departures";

export interface Alert {
  /** rowKey of the departure: stable across refetches (KB exec + visit, MZK course + order) */
  key: string;
  designator: string;
  stopName: string;
  line: string;
  dest: string;
  leadMin: number;
  /** epoch s after which the alert is dropped unfired (plan + 30 min) */
  until: number;
}

export const ALERT_LEADS = [3, 5, 10] as const;
export const MAX_ALERTS = 3;
const KEY = "kb:alerts";
const EXPIRE_AFTER_SEC = 30 * 60;
const EMPTY: readonly Alert[] = [];

export type AlertAction = { act: "wait" | "cancelled" | "expired" } | { act: "fire"; mins: number };

/**
 * What one board refresh means for an alert. The ETA is the board's own (`resolveTiming` without a
 * vehicle). ponytail: StopView may refine an MZK row with the live bus's delay; the watcher lives
 * outside React and skips that, so it can fire up to that correction early or late.
 */
export function alertAction(a: Alert, rows: readonly DepartureRow[], nowTs: number): AlertAction {
  if (nowTs > a.until) return { act: "expired" };
  const row = rows.find((r) => rowKey(r) === a.key);
  // not on the board (truncated, or gone): keep waiting until `until`
  if (!row) return { act: "wait" };
  const t = resolveTiming(row, null);
  if (t.canceled) return { act: "cancelled" };
  const mins = minutesUntil(t, nowTs);
  // set with less time left than the lead: fires on the first board, with the real minutes
  return mins <= a.leadMin ? { act: "fire", mins } : { act: "wait" };
}

/** Epoch s at which an unfired alert gives up: 30 min after the plan, `plannedSecs` being Warsaw
 *  seconds since midnight taken within ±12 h of now (a course across midnight). */
export function alertUntil(plannedSecs: number, nowTs = Date.now() / 1000): number {
  let d = plannedSecs - nowSecs(new Date(nowTs * 1000));
  if (d > 43200) d -= 86400;
  else if (d < -43200) d += 86400;
  return Math.round(nowTs) + d + EXPIRE_AFTER_SEC;
}

/** The board rowKey of a trip's visit to its stop `index`: a board row's KB `trip_index` and MZK
 *  `orderInCourse` are the trip's own stop index. MZK exec ids are `mzk:<course>:<vehicle>`, its rows
 *  key on the course alone (the vehicle can be assigned later). */
export function tripAlertKey(execId: string, index: number): string {
  return execId.startsWith("mzk:") ? mzkRowKey(execId.split(":")[1], index) : kbRowKey(execId, index);
}

function isAlert(v: unknown): v is Alert {
  const a = v as Alert;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.key === "string" &&
    typeof a.designator === "string" &&
    typeof a.leadMin === "number" &&
    typeof a.until === "number"
  );
}

function load(): readonly Alert[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    const now = Date.now() / 1000;
    return Array.isArray(parsed) ? parsed.filter(isAlert).filter((a) => a.until > now).slice(0, MAX_ALERTS) : EMPTY;
  } catch {
    return EMPTY;
  }
}

let snapshot: readonly Alert[] | null = null;
const subs = new Set<() => void>();

function getSnapshot(): readonly Alert[] {
  if (snapshot === null) snapshot = load();
  return snapshot;
}

function mutate(next: readonly Alert[]): void {
  snapshot = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: alerts still work until the tab closes */
  }
  subs.forEach((f) => f());
  syncWatchers();
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function useAlerts(): readonly Alert[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** Adds (or re-times) the alert for one departure; false when MAX_ALERTS other ones are set. */
export function addAlert(a: Alert): boolean {
  const rest = getSnapshot().filter((x) => x.key !== a.key);
  if (rest.length >= MAX_ALERTS) return false;
  mutate([...rest, a]);
  return true;
}

export function removeAlert(key: string): void {
  const cur = getSnapshot();
  if (cur.some((a) => a.key === key)) mutate(cur.filter((a) => a.key !== key));
}

/* ---- watchers: one board poll per stop that has alerts ---- */

const watchers = new Map<string, LivePoll>();

function onBoard(designator: string, res: DeparturesResponse): void {
  const nowTs = typeof res.server_ts === "number" ? res.server_ts : Date.now() / 1000;
  const rows = res.rows ?? [];
  const done = new Set<string>();
  for (const a of getSnapshot()) {
    if (a.designator !== designator) continue;
    const r = alertAction(a, rows, nowTs);
    if (r.act === "wait") continue;
    done.add(a.key);
    const where = `${a.dest}, przystanek ${a.stopName}`;
    if (r.act === "fire") void notify(`${a.line} ${r.mins > 0 ? `za ${r.mins} min` : "odjeżdża"}`, where, a);
    else if (r.act === "cancelled") void notify(`${a.line}: kurs odwołany`, where, a);
  }
  if (done.size > 0) mutate(getSnapshot().filter((a) => !done.has(a.key)));
}

function syncWatchers(): void {
  const want = new Set(getSnapshot().map((a) => a.designator));
  for (const [d, p] of watchers) {
    if (!want.has(d)) {
      p.stop();
      watchers.delete(d);
    }
  }
  for (const d of want) {
    if (watchers.has(d)) continue;
    const p = createLivePoll<DeparturesResponse>({
      load: (signal) =>
        fetchJSON<DeparturesResponse>(`/api/stop/${encodeURIComponent(d)}/departures`, { cache: "no-store", signal }),
      onOk: (res) => onBoard(d, res),
      onFail: () => {},
      isVisible: () => true,
    });
    watchers.set(d, p);
    p.start();
  }
}

/** Resume the watchers of alerts persisted by an earlier page load (call once on mount). */
export function startAlertWatchers(): void {
  syncWatchers();
}

async function notify(title: string, body: string, a: Alert): Promise<void> {
  const opts = { body, tag: a.key, icon: "/icon-192.png", data: { url: `/?stop=${encodeURIComponent(a.designator)}` } };
  try {
    // getRegistration, not .ready: .ready never settles without a SW (dev)
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts);
  } catch {
    /* fall through to the page notification */
  }
  try {
    new Notification(title, opts);
  } catch {
    /* permission revoked meanwhile */
  }
}
