/**
 * /status: is each city's live data flowing right now. Bielsko-Biała from the in-process pollers, every zbiorkom
 * city from one positions request of its own (whether or not the city is resident here: a resident city's state
 * is in /api/health), GZM also from SDIP, the operator's own map, so an outage upstream of both shows as such.
 * One sweep serves every viewer for STATUS_TTL_MS and a sweep in flight is shared: at most ~55 requests per
 * 2 min (~600 KB gzip, ~5 MB of JSON parsed 8 at a time), and none while nobody opens the page.
 */
import pLimit from "p-limit";

import * as config from "./config";
import { cappedText, parseSdip, parseZbiorkom, POLAND, sdipListText, sdipSession } from "./gzm";
import { getCombinedVehicles, getMzkPoller, getPoller } from "./poller-singleton";
import { ZB_CITIES, ZB_SLUGS, type ZbSlug } from "./shared/cities";

/** ok = positions coming in, empty = upstream answers with no vehicle (normal at night), down = no valid answer */
export type SourceState = "ok" | "empty" | "down";

export interface SourceStatus {
  name: string;
  state: SourceState;
  vehicles: number;
  /** seconds since the newest position (zbiorkom) or the last good poll (BB); null = not known */
  age: number | null;
  /** why it is down: "HTTP <code>", "timeout", "network error" or "invalid response" */
  error?: string;
}

export interface CityStatus {
  city: "bb" | ZbSlug;
  name: string;
  sources: SourceStatus[];
}

export interface StatusBody {
  /** epoch seconds of the sweep */
  checked_at: number;
  cities: CityStatus[];
}

const STATUS_TTL_MS = 120_000;
const PROBE_TIMEOUT_MS = 6_000;
// ponytail: 8 at a time keeps a full zbiorkom outage (every probe timing out) under ~45 s
const PROBE_CONCURRENCY = 8;
const MAX_BODY = 16 * 1024 * 1024;

function reason(err: unknown): string {
  if (!(err instanceof Error)) return "invalid response";
  if (err.name === "TimeoutError") return "timeout";
  const http = /HTTP \d{3}/.exec(err.message);
  if (http) return http[0];
  // undici's "fetch failed": DNS, refused or reset connection
  return err instanceof TypeError ? "network error" : "invalid response";
}

const down = (name: string, err: unknown): SourceStatus => ({ name, state: "down", vehicles: 0, age: null, error: reason(err) });

/** One zbiorkom positions request over all of Poland (the slug alone scopes the answer). */
export async function probeZb(slug: ZbSlug, fetchImpl: typeof fetch, nowMs: number): Promise<SourceStatus> {
  try {
    const url = `${config.ZB_API_URL}/${encodeURIComponent(slug)}/positions/${POLAND.lonMin},${POLAND.latMin},${POLAND.lonMax},${POLAND.latMax}`;
    const res = await fetchImpl(url, {
      headers: { "User-Agent": config.USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const recs = parseZbiorkom(JSON.parse(await cappedText(res, MAX_BODY)), nowMs, POLAND, slug !== "gzm");
    const newest = recs.reduce((m, r) => Math.max(m, r.ts), 0);
    return {
      name: "zbiorkom",
      state: recs.length ? "ok" : "empty",
      vehicles: recs.length,
      age: recs.length ? Math.max(0, Math.round((nowMs - newest) / 1000)) : null,
    };
  } catch (err) {
    return down("zbiorkom", err);
  }
}

/** SDIP's vehicle count: a fresh session, then the list. */
export async function probeSdip(fetchImpl: typeof fetch, url: string): Promise<SourceStatus> {
  try {
    const n = parseSdip(JSON.parse(await sdipListText(fetchImpl, url, await sdipSession(fetchImpl, url)))).size;
    return { name: "SDIP", state: n ? "ok" : "empty", vehicles: n, age: null };
  } catch (err) {
    return down("SDIP", err);
  }
}

function pollerSource(name: string, vehicles: number, lastGood: number, nowS: number): SourceStatus {
  const age = Math.max(0, Math.round(nowS - lastGood));
  // the /api/health rule: no good upstream poll for this long = the feed is gone, whatever the map still shows
  if (age > config.HEALTH_STALE_SEC) return { name, state: "down", vehicles, age, error: "no good poll" };
  return { name, state: vehicles ? "ok" : "empty", vehicles, age };
}

function bbSources(nowS: number): SourceStatus[] {
  const list = getCombinedVehicles().vehicles;
  const count = (op: string) => list.filter((v) => v.operator === op).length;
  return [
    pollerSource("KB", count("KB"), getPoller().lastGoodRefresh, nowS),
    pollerSource("MZK", count("MZK"), getMzkPoller().lastGoodRefresh, nowS),
  ];
}

async function sweep(fetchImpl: typeof fetch, nowMs: number): Promise<StatusBody> {
  const limit = pLimit(PROBE_CONCURRENCY);
  const slugs = ZB_SLUGS.filter((s) => (s === "gzm" ? config.GZM_ENABLED : config.ZB_ENABLED));
  const [sdip, zb] = await Promise.all([
    config.GZM_ENABLED && config.GZM_SDIP_ENABLED ? limit(() => probeSdip(fetchImpl, config.GZM_SDIP_URL)) : null,
    Promise.all(slugs.map((s) => limit(() => probeZb(s, fetchImpl, nowMs)))),
  ]);
  return {
    checked_at: Math.round(nowMs / 1000),
    cities: [
      { city: "bb", name: "Bielsko-Biała", sources: bbSources(Date.now() / 1000) },
      ...slugs.map((s, i) => ({ city: s, name: ZB_CITIES[s].name, sources: s === "gzm" && sdip ? [zb[i], sdip] : [zb[i]] })),
    ],
  };
}

let memo: { at: number; body: Promise<StatusBody> } | null = null;

/** The status of every city, swept at most once per STATUS_TTL_MS for everyone. */
export function cityStatus(nowMs = Date.now()): Promise<StatusBody> {
  if (memo && nowMs - memo.at <= STATUS_TTL_MS) return memo.body;
  const body = sweep((input, init) => fetch(input, init), nowMs);
  const entry = (memo = { at: nowMs, body });
  // a failed sweep (the BB pollers threw) is not served for 2 min: the next request tries again
  body.catch(() => {
    if (memo === entry) memo = null;
  });
  return body;
}
