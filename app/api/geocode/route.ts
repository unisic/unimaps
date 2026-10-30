import { badRequest, notFound, parseCity, upstreamError, warming } from "@/lib/api-helpers";
import { GEOCODER_URL, USER_AGENT } from "@/lib/config";
import { getGzmFeed } from "@/lib/gzm-feed";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GeoHit {
  name: string;
  detail: string;
  lat: number;
  lon: number;
}

/** minLon, minLat, maxLon, maxLat: each city's stops plus the 800 m a search from a point walks;
 *  any other zbiorkom city uses its feed's stop extent (null while that feed loads) */
const BBOX: Record<string, readonly [number, number, number, number]> = {
  bb: [18.8, 49.65, 19.37, 50.06],
  gzm: [18.39, 49.96, 19.49, 50.59],
};
function bboxOf(city: string): readonly [number, number, number, number] | null {
  const fixed = BBOX[city];
  if (fixed) return fixed;
  const a = getGzmFeed(city)?.area;
  return a ? [a.lonMin, a.latMin, a.lonMax, a.latMax] : null;
}
const MAX_HITS = 6;
/** ~1 KB per answer; a street's coordinates don't change within a day */
const MEMO_MAX = 1000;
const MEMO_TTL_MS = 86_400_000;
/** the public Photon host is fair-use only: past this many requests in flight the rest get 429 */
const MAX_IN_FLIGHT = 4;
/** per-IP tokens per search: the client sends one per typing pause */
const COST = 5;

const memo = new Map<string, { at: number; hits: GeoHit[] }>();
let inFlight = 0;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A Photon feature as a hit: "Sportowa" / "Czeladź", "Sportowa 2" / "Czeladź",
 *  "Hala MOSIR" / "Sportowa 2, Czeladź". Null for one without a name or outside the city. */
function toHit(f: unknown, [x0, y0, x1, y1]: readonly number[]): GeoHit | null {
  const feat = f as { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> } | null;
  const c = feat?.geometry?.coordinates;
  if (!Array.isArray(c)) return null;
  const [lon, lat] = c;
  if (typeof lon !== "number" || typeof lat !== "number" || !(lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1)) return null;
  const p = feat?.properties ?? {};
  const street = [str(p.street), str(p.housenumber)].filter(Boolean).join(" ");
  const name = str(p.name) || street;
  if (!name) return null;
  const place = str(p.city) || str(p.locality) || str(p.county);
  return { name, detail: [name !== street ? street : "", place].filter(Boolean).join(", "), lat, lon };
}

function answer(hits: GeoHit[]): Response {
  return Response.json({ results: hits }, { headers: { "Cache-Control": "public, max-age=3600" } });
}

/**
 * GET /api/geocode?q=<address or place>[&city=gzm]
 *
 * Streets, addresses and places within the city (Photon, OpenStreetMap data), for a connection
 * search from a point. 404 when KB_GEOCODER_URL=off.
 */
export async function GET(req: Request): Promise<Response> {
  if (!allowRequest(clientIp(req), COST)) return tooManyRequests();
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (!GEOCODER_URL) return notFound();
  const q = (new URL(req.url).searchParams.get("q") ?? "").replace(/\s+/g, " ").trim();
  if (q.length < 3 || q.length > 80) return badRequest("Invalid 'q' parameter (3 to 80 characters)");

  const key = `${city}|${q.toLowerCase()}`;
  const now = Date.now();
  const cached = memo.get(key);
  if (cached && now - cached.at < MEMO_TTL_MS) return answer(cached.hits);
  if (inFlight >= MAX_IN_FLIGHT) return tooManyRequests();

  const bbox = bboxOf(city);
  if (!bbox) return warming();
  const params = new URLSearchParams({ q, limit: "10", lang: "default", bbox: bbox.join(",") });
  inFlight++;
  try {
    const r = await fetch(`${GEOCODER_URL}?${params}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { features?: unknown } | null;
    const hits: GeoHit[] = [];
    const seen = new Set<string>();
    for (const f of Array.isArray(body?.features) ? body.features : []) {
      const h = toHit(f, bbox);
      // Photon lists a street once per OSM way: one hit per name and place
      if (!h || seen.has(`${h.name}|${h.detail}`)) continue;
      seen.add(`${h.name}|${h.detail}`);
      hits.push(h);
      if (hits.length === MAX_HITS) break;
    }
    memo.delete(key);
    memo.set(key, { at: now, hits });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
    return answer(hits);
  } catch (err) {
    return upstreamError("geocode", err);
  } finally {
    inFlight--;
  }
}
