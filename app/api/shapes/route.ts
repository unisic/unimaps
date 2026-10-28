import { badRequest, internalError, isGzmId, isValidShapeId } from "@/lib/api-helpers";
import { GZM_ENABLED } from "@/lib/config";
import { getGzm, startGzm } from "@/lib/gzm";
import { getShapes, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

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
 */
export async function GET(req: Request): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const param = new URL(req.url).searchParams.get("ids") ?? "";
  if (!param) return badRequest("Missing ?ids= query parameter");
  if (param.length > MAX_IDS_PARAM) return badRequest("ids parameter too long");
  const ids = [...new Set(param.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return badRequest("ids list cannot be empty");
  if (ids.length > MAX_IDS) return badRequest(`Exceeded maximum of ${MAX_IDS} ids`);
  if (!ids.every(isValidShapeId)) return badRequest("Invalid shape id");
  try {
    // GZM shapes live in its feed, the rest in the store; a disabled city's ids are just missing
    const gzmIds = ids.filter(isGzmId);
    const storeIds = ids.filter((id) => !isGzmId(id));
    // lazy start like every other route; lookups never wait on upstream
    if (storeIds.length) void startPoller().catch(() => {});
    const store = storeIds.length ? getShapes().lookup(storeIds) : { shapes: {}, missing: [], exact: true };
    if (gzmIds.length && GZM_ENABLED) void startGzm();
    const gzm = !gzmIds.length ? { shapes: {}, missing: [], exact: true } : GZM_ENABLED ? getGzm().shapes(gzmIds) : { shapes: {}, missing: gzmIds, exact: false };
    const shapes = { ...store.shapes, ...gzm.shapes };
    const missing = [...store.missing, ...gzm.missing];
    const exact = store.exact && gzm.exact;
    return Response.json(
      { precision: 6, shapes, missing },
      {
        headers: {
          "Cache-Control": exact ? "public, max-age=31536000, immutable" : "public, max-age=30",
        },
      },
    );
  } catch (err) {
    return internalError("shapes", err);
  }
}
