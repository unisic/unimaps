/**
 * Metrorower (the GZM bike share) from nextbike's public GBFS v2 feed (KB_GZM_GBFS_URL):
 * station_information (positions, memo INFO_MS) joined with station_status (bikes, memo = the
 * feed's 60 s ttl). One upstream fetch per interval however many clients poll; a failed fetch
 * keeps the last list. The join is pure and pinned by test/gbfs.test.ts.
 */
import { GZM_GBFS_URL, USER_AGENT } from "./config";
import { log } from "./logger";

export interface BikeStation {
  id: string;
  /** nextbike's station number (the feed has no street names) */
  name: string;
  lat: number;
  lon: number;
  bikes: number;
  docks: number;
  /** rental deep link (opens the nextbike app or web) */
  url: string | null;
}

export interface BikesSnapshot {
  stations: BikeStation[];
  /** epoch seconds of the status feed */
  updated: number;
}

const INFO_MS = 60 * 60_000;
const STATUS_MS = 60_000;
/** ponytail: 944 stations today; the cap only bounds a broken feed */
const MAX_STATIONS = 5000;

function list(doc: unknown): unknown[] {
  const d = doc as { data?: { stations?: unknown } } | null;
  return Array.isArray(d?.data?.stations) ? d.data.stations : [];
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => Math.max(0, Math.floor(num(v) ?? 0));

/** Stations present in both documents, installed and renting, with finite coordinates. */
export function mergeGbfs(info: unknown, status: unknown): BikeStation[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of list(status)) {
    const r = s as Record<string, unknown> | null;
    if (r && typeof r.station_id === "string") byId.set(r.station_id, r);
  }
  const out: BikeStation[] = [];
  for (const s of list(info)) {
    const r = s as Record<string, unknown> | null;
    if (!r || typeof r.station_id !== "string") continue;
    const st = byId.get(r.station_id);
    if (!st || st.is_installed === false || st.is_renting === false) continue;
    const lat = num(r.lat);
    const lon = num(r.lon);
    if (lat === null || lon === null) continue;
    const web = (r.rental_uris as { web?: unknown } | undefined)?.web;
    out.push({
      id: r.station_id,
      name: typeof r.name === "string" && r.name ? r.name : r.station_id,
      lat,
      lon,
      bikes: count(st.num_bikes_available),
      docks: count(st.num_docks_available),
      url: typeof web === "string" && web.startsWith("https://") ? web : null,
    });
    if (out.length === MAX_STATIONS) break;
  }
  return out;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let info: { at: number; doc: unknown } | null = null;
let cache: { at: number; snap: BikesSnapshot } | null = null;
let inflight: Promise<BikesSnapshot> | null = null;

/** The current stations (memo 60 s, in-flight deduped); throws only when nothing was ever fetched. */
export function fetchBikes(): Promise<BikesSnapshot> {
  if (!GZM_GBFS_URL) return Promise.reject(new Error("GBFS off"));
  if (cache && Date.now() - cache.at < STATUS_MS) return Promise.resolve(cache.snap);
  inflight ??= (async () => {
    try {
      if (!info || Date.now() - info.at > INFO_MS) {
        info = { at: Date.now(), doc: await getJson(`${GZM_GBFS_URL}/pl/station_information.json`) };
      }
      const status = await getJson(`${GZM_GBFS_URL}/pl/station_status.json`);
      const stations = mergeGbfs(info.doc, status);
      // an empty join is a changed feed, not "no stations": keep what we had
      if (stations.length === 0 && cache) throw new Error("no stations parsed");
      const updated = num((status as { last_updated?: unknown } | null)?.last_updated) ?? Math.floor(Date.now() / 1000);
      cache = { at: Date.now(), snap: { stations, updated } };
      return cache.snap;
    } catch (err) {
      if (!cache) throw err;
      log.warn("gbfs", `refresh failed, keeping ${cache.snap.stations.length} stations: ${err}`);
      cache.at = Date.now();
      return cache.snap;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
