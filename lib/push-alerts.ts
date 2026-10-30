/**
 * Server half of "Powiadom mnie": an alert whose browser handed over a push subscription also fires
 * from here, so it arrives with the app closed. A 30 s tick (armed only while an alert is pending)
 * reads each alerted stop's board once (the same micro-cached board the departures route serves,
 * the GZM one from the local feed) and pushes what `alertAction` decides. The page's own watcher
 * may fire the same alert: one tag, the later notification replaces the earlier one.
 * Bounded: MAX_TOTAL alerts in all (a full store refuses), MAX_PER_SUB per subscription, each one
 * dropped at its `until`. Kept in PUSH_DIR/alerts.v1.json (atomic write, 2 s debounce) so a
 * restart keeps them.
 * ponytail: one board read per alerted stop per tick, at most 4 at once: 300 alerts on 300 stops =
 * 10 board reads/s against upstream. A shared board snapshot from the poller's scan if it grows.
 */
import fs from "node:fs";
import path from "node:path";

import pLimit from "p-limit";

import { isGzmId, isValidId } from "./api-helpers";
import { GZM_ENABLED, PUSH_DIR } from "./config";
import { getGzm, startGzm } from "./gzm";
import { log } from "./logger";
import { startPoller } from "./poller-singleton";
import { ALERT_LEADS, alertAction, alertMessage, MAX_ALERTS, type Alert } from "./shared/alerts";
import type { TimingRow } from "./shared/departures";
import { stopBoard } from "./stop-board";
import { isPushSub, sendPush, type PushSub } from "./web-push";

export const MAX_TOTAL = 300;
/** both cities' alerts of one browser */
const MAX_PER_SUB = MAX_ALERTS * 2;
const TICK_MS = 30_000;
/** "za 3 min" is useless later: a phone offline longer never gets it */
const PUSH_TTL_SEC = 300;
const SAVE_DEBOUNCE_MS = 2000;

interface Entry {
  sub: PushSub;
  alerts: Alert[];
}

/** Server-side check of what a browser sends; the same fields the page stores. */
export function isAlertInput(v: unknown, nowSec = Date.now() / 1000): v is Alert {
  const a = v as Alert;
  const str = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 120;
  return (
    !!a &&
    str(a.key) &&
    str(a.designator) &&
    isValidId(a.designator) &&
    str(a.stopName) &&
    str(a.line) &&
    str(a.dest) &&
    (ALERT_LEADS as readonly number[]).includes(a.leadMin) &&
    Number.isFinite(a.until) &&
    a.until > nowSec &&
    a.until < nowSec + 24 * 3600
  );
}

/** The fields we keep: never store what else a client put in the JSON. */
const pick = (a: Alert): Alert => ({
  key: a.key,
  designator: a.designator,
  stopName: a.stopName,
  line: a.line,
  dest: a.dest,
  leadMin: a.leadMin,
  until: a.until,
});

export class PushAlerts {
  private readonly subs = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly file = path.join(PUSH_DIR, "alerts.v1.json"),
    private readonly send: typeof sendPush = sendPush,
    private readonly board: (designator: string) => Promise<{ rows: readonly TimingRow[]; nowTs: number } | null> = readBoard,
  ) {
    this.load();
  }

  get size(): number {
    let n = 0;
    for (const e of this.subs.values()) n += e.alerts.length;
    return n;
  }

  /** false = the store (or this browser's share of it) is full */
  add(sub: PushSub, alert: Alert): boolean {
    const cur = this.subs.get(sub.endpoint);
    const rest = (cur?.alerts ?? []).filter((a) => a.key !== alert.key);
    if (rest.length >= MAX_PER_SUB || this.size - (cur?.alerts.length ?? 0) + rest.length >= MAX_TOTAL) return false;
    this.subs.set(sub.endpoint, { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, alerts: [...rest, pick(alert)] });
    this.changed();
    return true;
  }

  remove(endpoint: string, key: string): void {
    const cur = this.subs.get(endpoint);
    if (!cur || !cur.alerts.some((a) => a.key === key)) return;
    cur.alerts = cur.alerts.filter((a) => a.key !== key);
    if (cur.alerts.length === 0) this.subs.delete(endpoint);
    this.changed();
  }

  /** One pass: every alerted stop's board once, the fired / cancelled / expired alerts dropped. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const stops = new Set<string>();
      for (const e of this.subs.values()) for (const a of e.alerts) stops.add(a.designator);
      const limit = pLimit(4);
      await Promise.all(
        [...stops].map((d) =>
          limit(async () => {
            // a failed board: the next tick asks again, `until` still bounds the wait
            const b = await this.board(d).catch((err: unknown) => (log.warn("push", `board ${d}: ${err}`), null));
            if (b) this.decide(d, b.rows, b.nowTs);
          }),
        ),
      );
      // stops no board answered for: their expired alerts still go
      const now = Date.now() / 1000;
      for (const [endpoint, e] of this.subs) this.drop(endpoint, e, new Set(e.alerts.filter((a) => a.until < now).map((a) => a.key)));
    } finally {
      this.busy = false;
    }
  }

  private decide(designator: string, rows: readonly TimingRow[], nowTs: number): void {
    for (const [endpoint, e] of this.subs) {
      const done = new Set<string>();
      for (const a of e.alerts) {
        if (a.designator !== designator) continue;
        const r = alertAction(a, rows, nowTs);
        if (r.act === "wait") continue;
        done.add(a.key);
        const m = alertMessage(a, r);
        if (m) void this.deliver(e.sub, m);
      }
      this.drop(endpoint, e, done);
    }
  }

  private drop(endpoint: string, e: Entry, keys: ReadonlySet<string>): void {
    if (keys.size === 0) return;
    e.alerts = e.alerts.filter((a) => !keys.has(a.key));
    if (e.alerts.length === 0) this.subs.delete(endpoint);
    this.changed();
  }

  private async deliver(sub: PushSub, msg: object): Promise<void> {
    const host = new URL(sub.endpoint).hostname;
    try {
      const status = await this.send(sub, msg, PUSH_TTL_SEC);
      // gone: the browser unsubscribed or the user revoked the permission
      if (status === 404 || status === 410) {
        this.subs.delete(sub.endpoint);
        this.changed();
      } else if (status >= 300) log.warn("push", `${host} answered ${status}`);
    } catch (err) {
      log.warn("push", `${host}: ${err}`);
    }
  }

  private changed(): void {
    this.arm();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** the tick runs only while an alert is pending */
  private arm(): void {
    if (this.subs.size > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    } else if (this.subs.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      // endpoints are capability URLs: owner-only
      fs.writeFileSync(tmp, JSON.stringify([...this.subs.values()]), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.warn("push", `save failed: ${err}`);
    }
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("push", `load failed, starting empty: ${err}`);
      return;
    }
    if (!Array.isArray(raw)) return;
    const now = Date.now() / 1000;
    let n = 0;
    for (const e of raw as Entry[]) {
      if (!isPushSub(e?.sub) || !Array.isArray(e.alerts)) continue;
      const alerts = e.alerts.filter((a) => isAlertInput(a, now)).slice(0, MAX_PER_SUB);
      if (alerts.length === 0 || n + alerts.length > MAX_TOTAL) continue;
      n += alerts.length;
      this.subs.set(e.sub.endpoint, { sub: e.sub, alerts: alerts.map(pick) });
    }
    this.arm();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.timer = this.saveTimer = null;
  }
}

async function readBoard(designator: string): Promise<{ rows: readonly TimingRow[]; nowTs: number } | null> {
  if (isGzmId(designator)) {
    if (!GZM_ENABLED) return null;
    void startGzm();
    const b = getGzm().departures(designator);
    return b && b !== "unknown" ? { rows: b.rows as TimingRow[], nowTs: b.server_ts } : null;
  }
  await startPoller();
  const b = await stopBoard(designator);
  // every leg failed: not "no departures", ask again next tick
  return b.failedLegs >= b.legs ? null : { rows: b.rows as TimingRow[], nowTs: Date.now() / 1000 };
}

const KEY = Symbol.for("kb-gtfs.push-alerts");
type G = typeof globalThis & { [KEY]?: PushAlerts };

/** The process-wide store (HMR-safe on globalThis); loads the persisted alerts and arms the tick. */
export function getPushAlerts(): PushAlerts {
  const g = globalThis as G;
  return (g[KEY] ??= new PushAlerts());
}
