/**
 * "Powiadamiaj o utrudnieniach": a web push when a city's announcements list gains an item. One
 * subscription per browser with the cities it chose; a TICK_MS tick (armed only while anyone is
 * subscribed) fetches each wanted city's list (lib/announcements.ts, the same memoized sources
 * the route serves) and pushes the headline of what is new. "New" = a `operator:id:rev` key not
 * seen before, so an edited item notifies again; the first list of a city is only recorded. Seen
 * keys are kept as a bounded, insertion-ordered set (MAX_SEEN per city), so a leg that fails for
 * a tick and comes back does not re-notify. Kept in PUSH_DIR/news.v1.json (0600, atomic write).
 * ponytail: one fetch per city per tick for everyone; 500 subs = 500 pushes in a burst every 15 min at worst.
 */
import fs from "node:fs";
import path from "node:path";

import { announcementKey, announcementTitle, type Announcements, fetchAnnouncements } from "./announcements";
import { PUSH_DIR } from "./config";
import { log } from "./logger";
import { isPushSub, sendPush, type PushSub } from "./web-push";

export const MAX_SUBS = 500;
const MAX_SEEN = 500;
const TICK_MS = 15 * 60_000;
/** news keeps: a phone offline for the afternoon still gets it */
const PUSH_TTL_SEC = 4 * 3600;
const SAVE_DEBOUNCE_MS = 2000;
/** the cities with a news source (lib/announcements.ts) */
export type City = "bb" | "gzm";
const CITIES: readonly City[] = ["bb", "gzm"];

interface Entry {
  sub: PushSub;
  cities: City[];
}

interface Persisted {
  subs: Entry[];
  seen: Record<City, string[]>;
}

export const isCity = (v: unknown): v is City => v === "bb" || v === "gzm";

export class PushNews {
  private readonly subs = new Map<string, Entry>();
  private readonly seen: Record<City, Set<string>> = { bb: new Set(), gzm: new Set() };
  private timer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly file = path.join(PUSH_DIR, "news.v1.json"),
    private readonly send: typeof sendPush = sendPush,
    private readonly list: (city: City) => Promise<Announcements> = fetchAnnouncements,
  ) {
    this.load();
  }

  get size(): number {
    return this.subs.size;
  }

  /** false = store full (the caller answers 503) */
  add(sub: PushSub, city: City): boolean {
    const e = this.subs.get(sub.endpoint);
    if (e) {
      if (!e.cities.includes(city)) e.cities.push(city);
      e.sub = sub;
    } else {
      if (this.subs.size >= MAX_SUBS) return false;
      this.subs.set(sub.endpoint, { sub, cities: [city] });
    }
    this.changed();
    return true;
  }

  remove(endpoint: string, city: City): void {
    const e = this.subs.get(endpoint);
    if (!e) return;
    e.cities = e.cities.filter((c) => c !== city);
    if (e.cities.length === 0) this.subs.delete(endpoint);
    this.changed();
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const city of CITIES) {
        const subs = [...this.subs.values()].filter((e) => e.cities.includes(city));
        if (subs.length === 0) continue;
        let items: Announcements["announcements"];
        try {
          items = (await this.list(city)).announcements;
        } catch (err) {
          log.warn("push-news", `${city}: list failed: ${err}`);
          continue;
        }
        const seen = this.seen[city];
        const fresh = items.filter((a) => !seen.has(announcementKey(a)));
        if (fresh.length === 0) continue;
        const first = seen.size === 0;
        for (const a of fresh) seen.add(announcementKey(a));
        while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string);
        this.changed();
        if (first) continue;
        const title = announcementTitle(fresh[0]);
        const msg = {
          title: "Utrudnienia",
          body: fresh.length > 1 ? `${title} (+${fresh.length - 1})` : title,
          tag: `news:${city}`,
          url: city === "gzm" ? "/?city=gzm" : "/",
        };
        for (const e of subs) await this.deliver(e.sub, msg);
      }
    } finally {
      this.busy = false;
    }
  }

  private async deliver(sub: PushSub, msg: object): Promise<void> {
    const host = new URL(sub.endpoint).hostname;
    try {
      const status = await this.send(sub, msg, PUSH_TTL_SEC);
      // gone: the browser unsubscribed or the user revoked the permission
      if (status === 404 || status === 410) {
        this.subs.delete(sub.endpoint);
        this.changed();
      } else if (status >= 300) log.warn("push-news", `${host} answered ${status}`);
    } catch (err) {
      log.warn("push-news", `${host}: ${err}`);
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
      const data: Persisted = { subs: [...this.subs.values()], seen: { bb: [...this.seen.bb], gzm: [...this.seen.gzm] } };
      // endpoints are capability URLs: owner-only
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.warn("push-news", `save failed: ${err}`);
    }
  }

  private load(): void {
    let raw: Partial<Persisted>;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Persisted>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("push-news", `load failed, starting empty: ${err}`);
      return;
    }
    for (const e of Array.isArray(raw?.subs) ? raw.subs : []) {
      if (!isPushSub(e?.sub) || !Array.isArray(e.cities)) continue;
      const cities = e.cities.filter(isCity);
      if (cities.length === 0 || this.subs.size >= MAX_SUBS) continue;
      this.subs.set(e.sub.endpoint, { sub: e.sub, cities });
    }
    for (const city of CITIES) {
      const keys = raw?.seen?.[city];
      if (Array.isArray(keys)) for (const k of keys.slice(-MAX_SEEN)) if (typeof k === "string") this.seen[city].add(k);
    }
    this.arm();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.timer = this.saveTimer = null;
  }
}

const KEY = Symbol.for("kb-gtfs.push-news");
type G = typeof globalThis & { [KEY]?: PushNews };

/** The process-wide store (HMR-safe on globalThis); loads the persisted subscriptions and arms the tick. */
export function getPushNews(): PushNews {
  const g = globalThis as G;
  return (g[KEY] ??= new PushNews());
}
