import { badRequest, etagMatches, internalError, isValidShapeId, zbEnabled, zbIdCity } from "@/lib/api-helpers";
import { getZb, startZb } from "@/lib/gzm";
import { getShapes, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import type { LatLonBox } from "@/lib/shared/polyline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IDS = 50;
const MAX_IDS_PARAM = 1300;

/**
 * GET /api/shapes?ids=kb:3f9a0c11d2e4.7b21c0,mzk:13954.0c9e1f — stored road
 * geometry (encoded polyline, precision 6) plus per-stop along-route metres.
 * Read-only: never routes or fetches upstream, so enumerating ids can't
 * amplify load. Exact `<key>.<rev>` hits are immutable (a rebuilt shape gets a
 * new rev, which the vehicle feed then advertises).
 * `near=s,w,n,e` (the open trip's map) moves a GZM road match already running
 * for these shapes to that box (lib/gzm-match.ts); it never starts one. One
 * exact id with `If-None-Match: "<id>"` is a 304: the trip view polls this
 * while its shape is being matched.
 */
export async function GET(req: Request): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const sp = new URL(req.url).searchParams;
  const param = sp.get("ids") ?? "";
  const near = sp.get("near");
  const focus = near === null ? null : parseBox(near);
  if (near !== null && !focus) return badRequest("Invalid near box");
  if (!param) return badRequest("Missing ?ids= query parameter");
  if (param.length > MAX_IDS_PARAM) return badRequest("ids parameter too long");
  const ids = [...new Set(param.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return badRequest("ids list cannot be empty");
  if (ids.length > MAX_IDS) return badRequest(`Exceeded maximum of ${MAX_IDS} ids`);
  if (!ids.every(isValidShapeId)) return badRequest("Invalid shape id");
  try {
    // a zbiorkom city's shapes live in its feed, the rest in the store; a disabled city's ids are just missing
    const byCity = new Map<string, string[]>();
    const storeIds: string[] = [];
    for (const id of ids) {
      const slug = zbIdCity(id);
      if (slug) byCity.set(slug, [...(byCity.get(slug) ?? []), id]);
      else storeIds.push(id);
    }
    // lazy start like every other route; lookups never wait on upstream
    if (storeIds.length) void startPoller().catch(() => {});
    const store = storeIds.length ? getShapes().lookup(storeIds) : { shapes: {}, missing: [], exact: true };
    const shapes: Record<string, unknown> = { ...store.shapes };
    const missing = [...store.missing];
    let exact = store.exact;
    for (const [slug, cityIds] of byCity) {
      if (!zbEnabled(slug)) {
        missing.push(...cityIds);
        exact = false;
        continue;
      }
      void startZb(slug);
      if (focus) getZb(slug).focusMatch(cityIds, focus);
      const r = getZb(slug).shapes(cityIds);
      Object.assign(shapes, r.shapes);
      missing.push(...r.missing);
      exact &&= r.exact;
    }
    const cacheControl = exact ? "public, max-age=31536000, immutable" : "public, max-age=30";
    if (exact && ids.length === 1 && etagMatches(req.headers.get("if-none-match"), `"${ids[0]}"`)) {
      return new Response(null, { status: 304, headers: { "Cache-Control": cacheControl } });
    }
    return Response.json({ precision: 6, shapes, missing }, { headers: { "Cache-Control": cacheControl } });
  } catch (err) {
    return internalError("shapes", err);
  }
}

function parseBox(v: string): LatLonBox | null {
  const p = v.split(",").map(Number);
  if (v.length > 100 || p.length !== 4 || !p.every(Number.isFinite)) return null;
  const [s, w, n, e] = p;
  return s < n && w < e && s >= -90 && n <= 90 && w >= -180 && e <= 180 ? { s, w, n, e } : null;
}
