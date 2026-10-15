/**
 * Vehicle photos from phototrans (MZK Bielsko-Biała only: KB publishes no side numbers).
 * phototrans.pl sits behind a Cloudflare browser challenge; phototrans.eu serves the same
 * database as plain HTML. A lookup reads two pages: the vehicle search by operator + number,
 * then the vehicle's page, which lists its photos newest first. Only this metadata passes
 * through the server; the browser loads the thumbnail from phototrans itself.
 */
import type { VehiclePhoto } from "./shared/fleet";

const BASE = "https://phototrans.eu/";
/** phototrans operator id of MZK Bielsko-Biała */
const MZK_OPERATOR = 35;
const UA = "kb-map/2.0 (MZK Bielsko-Biala vehicle photos)";
const TIMEOUT_MS = 8_000;
/** photos change rarely; a day keeps it to ~2 requests per vehicle per day */
const TTL_MS = 24 * 3600_000;
/** above the MZK fleet (~150), so a full day of lookups stays cached */
const MAX_ENTRIES = 256;
/** newest photos kept per vehicle (a page lists them all, 50+ for an old bus) */
export const MAX_PHOTOS = 12;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const cache = new Map<string, { at: number; photos: VehiclePhoto[] }>();
const inflight = new Map<string, Promise<VehiclePhoto[]>>();

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Vehicle page id for side number `side` in the search results. A number can be reused after a
 * bus leaves the fleet: the one still in service wins, then the latest to join.
 * ponytail: column positions follow phototrans' result table; a layout change yields null (no photo).
 */
export function pickVehicle(html: string, side: string): number | null {
  let best: { id: number; active: boolean; since: number } | null = null;
  for (const m of html.matchAll(/<tr><td><a href="15,(\d+),0\.html">[\s\S]*?<\/a><\/td>([\s\S]*?)<\/tr>/g)) {
    // VIN, build no., built, year of get, year of remove, scrapped, plate, no., ...
    const cells = [...m[2].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => decode(c[1]));
    if (cells[7] !== side) continue;
    const row = {
      id: Number(m[1]),
      active: (cells[4] === "" || cells[4] === "No") && (cells[5] === "" || cells[5] === "No"),
      since: Number(cells[3]) || 0,
    };
    if (!best || (row.active && !best.active) || (row.active === best.active && row.since > best.since)) best = row;
  }
  return best?.id ?? null;
}

/** The newest `max` photos on a vehicle page, newest first. */
export function parsePhotos(html: string, max = MAX_PHOTOS): VehiclePhoto[] {
  const out: VehiclePhoto[] = [];
  for (const block of html.split("class=rowtable>").slice(1)) {
    if (out.length >= max) break;
    const img = /<a href="(14,\d+,0[^"]*\.html)"><img src="\/?images\/photos\/thumbnail\/(\d+\/\d+\.jpg)"/.exec(block);
    const author = /Author: <a href="(16,\d+,0\.html)">([^<]+)<\/a>/.exec(block);
    if (!img || !author) continue;
    const d = /<b>(\d{1,2}) ([a-z]+) (\d{4})<\/b>/.exec(block);
    const month = d ? MONTHS.indexOf(d[2]) + 1 : 0;
    out.push({
      thumb: `${BASE}images/photos/thumbnail/${img[2]}`,
      page: BASE + img[1],
      author: decode(author[2]),
      authorPage: BASE + author[1],
      date: d && month ? `${d[3]}-${String(month).padStart(2, "0")}-${d[1].padStart(2, "0")}` : null,
    });
  }
  return out;
}

async function page(path: string): Promise<string> {
  const res = await fetch(BASE + path, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`phototrans HTTP ${res.status}`);
  return res.text();
}

async function lookup(side: string): Promise<VehiclePhoto[]> {
  const id = pickVehicle(await page(`autobusy.php?s=5015&operator=${MZK_OPERATOR}&numer=${side}&r=Se`), side);
  return id === null ? [] : parsePhotos(await page(`15,${id},0.html`));
}

/** Newest photos of MZK vehicle `side` (digits only, validated by the caller). Failures throw and are
 *  not cached; a vehicle without photos is. */
export function findVehiclePhotos(side: string): Promise<VehiclePhoto[]> {
  const hit = cache.get(side);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.photos);
  let p = inflight.get(side);
  if (!p) {
    p = lookup(side)
      .then((photos) => {
        cache.delete(side);
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
        cache.set(side, { at: Date.now(), photos });
        return photos;
      })
      .finally(() => inflight.delete(side));
    inflight.set(side, p);
  }
  return p;
}
