"use client";

/**
 * "Powiadom mnie": a notification when a departure is N minutes away. A module-level store (the
 * lib/client/favorites.ts pattern) persisted in localStorage, plus one watcher per stop with alerts.
 * The watcher polls that stop's board on its own (`isVisible: () => true`): the 4 s vehicle poll and
 * StopView's board both stop in a hidden tab, an alert must not.
 * Platform ceiling: Chrome throttles a hidden tab's timers to about once a minute after 5 min, iOS
 * suspends JS in the background. So an alert also goes to the server as a web push subscription
 * (lib/push-alerts.ts), which fires it with the app closed; both fire under one tag, the later
 * notification replaces the earlier one.
 */
import { useSyncExternalStore } from "react";

import { fetchJSON } from "@/lib/client/api";
import { cityKey, cityOfId, type City } from "@/lib/client/city";
import { nowSecs } from "@/lib/client/format";
import { createLivePoll, type LivePoll } from "@/lib/client/live-poll";
import type { DeparturesResponse } from "@/lib/client/types";
import { alertAction, alertMessage, MAX_ALERTS, type Alert } from "@/lib/shared/alerts";
import { gzmRowKey, kbRowKey, mzkRowKey } from "@/lib/shared/departures";

export { ALERT_LEADS, MAX_ALERTS, alertAction, type Alert, type AlertAction } from "@/lib/shared/alerts";

const KEY = "kb:alerts";
const STORED_MAX = MAX_ALERTS * 2;
const EXPIRE_AFTER_SEC = 30 * 60;
const EMPTY: readonly Alert[] = [];

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
 *  key on the course alone (the vehicle can be assigned later). GZM rows key on the static trip id
 *  (`tripId`, "gzm:<id>") and the stop_sequence, never on the vehicle; null without a trip id. */
export function tripAlertKey(execId: string, index: number, tripId?: string | number | null): string | null {
  const zb = cityOfId(execId);
  if (zb !== "bb") {
    const raw = tripId == null ? "" : String(tripId);
    const id = raw.startsWith(`${zb}:`) ? raw.slice(zb.length + 1) : raw;
    return id ? gzmRowKey(id, index) : null;
  }
  return execId.startsWith("mzk:") ? mzkRowKey(execId.split(":")[1], index) : kbRowKey(execId, index);
}

/* the city this page load shows (set by startAlertWatchers): the other city's alerts stay stored
   untouched, they neither poll nor count against this city's cap */
let alertsCity: City = "bb";
const mine = (a: Alert): boolean => cityOfId(a.designator) === alertsCity;

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
    return Array.isArray(parsed) ? parsed.filter(isAlert).filter((a) => a.until > now).slice(0, STORED_MAX) : EMPTY;
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

/** Adds (or re-times) the alert for one departure; false when MAX_ALERTS other ones are set in this city. */
export function addAlert(a: Alert): boolean {
  const rest = getSnapshot().filter((x) => x.key !== a.key);
  if (rest.filter(mine).length >= MAX_ALERTS) return false;
  mutate([...rest, a]);
  pushSync("POST", { alert: a });
  return true;
}

export function removeAlert(key: string): void {
  const cur = getSnapshot();
  if (!cur.some((a) => a.key === key)) return;
  mutate(cur.filter((a) => a.key !== key));
  pushSync("DELETE", { key });
}

/* ---- watchers: one board poll per stop that has alerts ---- */

const watchers = new Map<string, LivePoll>();

function onBoard(designator: string, res: DeparturesResponse): void {
  const nowTs = typeof res.server_ts === "number" ? res.server_ts : Date.now() / 1000;
  const rows = res.rows ?? [];
  const done = new Set<string>();
  for (const a of getSnapshot()) {
    if (a.designator !== designator || !mine(a)) continue;
    const r = alertAction(a, rows, nowTs);
    if (r.act === "wait") continue;
    done.add(a.key);
    const m = alertMessage(a, r);
    if (m) void notify(m.title, m.body, m.tag, m.url);
  }
  if (done.size > 0) mutate(getSnapshot().filter((a) => !done.has(a.key)));
}

function syncWatchers(): void {
  const want = new Set(getSnapshot().filter(mine).map((a) => a.designator));
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

/** Resume the watchers of this city's alerts persisted by an earlier page load (call once on mount). */
export function startAlertWatchers(city: City = "bb"): void {
  alertsCity = city;
  syncWatchers();
  // the server forgets a subscription it could not reach (410) or lost its file: re-announce ours
  if (newsPushOn(city)) void setNewsPush(city, true);
}

/* ---- "Powiadamiaj o utrudnieniach": the server pushes new announcements of a city ---- */

const newsKey = (city: City): string => cityKey("kb:newsPush", city);

/** The user's choice for this city (localStorage); the subscription itself lives on the server. */
export function newsPushOn(city: City): boolean {
  try {
    return window.localStorage.getItem(newsKey(city)) === "1";
  } catch {
    return false;
  }
}

/** Subscribe (or unsubscribe) this browser to the city's announcements push; false = no push here. */
export async function setNewsPush(city: City, on: boolean): Promise<boolean> {
  try {
    const sub = await pushSubscription(on);
    const ok =
      !!sub &&
      (
        await fetch("/api/push/news", {
          method: on ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON(), city }),
        })
      ).ok;
    window.localStorage.setItem(newsKey(city), on && ok ? "1" : "0");
    return ok;
  } catch {
    return false;
  }
}

/** A system notification through the SW (it survives the tab), else a page one; `tag` replaces an earlier one. */
export async function notify(title: string, body: string, tag: string, url: string): Promise<void> {
  const opts = { body, tag, icon: "/icon-192.png", data: { url } };
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

/* ---- web push: the server fires the same alert with the app closed ---- */

let pushKey: Promise<string | null> | null = null;

async function pushSubscription(create: boolean): Promise<PushSubscription | null> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg?.pushManager) return null;
  const sub = await reg.pushManager.getSubscription();
  if (sub || !create) return sub;
  // 404 = push off on this server
  pushKey ??= fetchJSON<{ key: string }>("/api/push").then((r) => r.key, () => null);
  const key = await pushKey;
  if (!key) return null;
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
}

function pushSync(method: "POST" | "DELETE", body: object): void {
  void pushSubscription(method === "POST")
    .then(
      (sub) =>
        sub &&
        fetch("/api/push", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON(), ...body }),
        }),
    )
    .catch(() => {
      /* no push (iOS outside an installed app, a blocked push service): the page watcher still fires */
    });
}
