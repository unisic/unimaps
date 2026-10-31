import { badRequest, isValidId, upstreamError, zbEnabled, zbIdCity } from "@/lib/api-helpers";
import { getZb, startZb } from "@/lib/gzm";
import { getApi, kbShapeRef, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BATCH_IDS = 300;

/**
 * GET /api/trips?ids=123,456,789 — batch trip detail resolution.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  if (!idsParam) return badRequest("Missing ?ids= query parameter");
  const rawIds = [...new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!rawIds.length) return badRequest("ids list cannot be empty");
  if (rawIds.length > MAX_BATCH_IDS) return badRequest(`Exceeded maximum of ${MAX_BATCH_IDS} ids`);

  for (const id of rawIds) {
    if (!isValidId(id)) return badRequest(`Invalid trip id: ${id}`);
  }

  const api = getApi();
  const zbIds = rawIds.filter((id) => zbIdCity(id) !== null);
  const kbIds = rawIds.filter((id) => !id.startsWith("mzk:") && zbIdCity(id) === null);
  const mzkIds = rawIds.filter((id) => id.startsWith("mzk:"));
  // one token per id that costs an upstream fetch (MZK ids always do), so a batch is not a 300x amplifier
  const cost = Math.max(1, mzkIds.length + kbIds.filter((id) => !api.hasCachedTrip(id)).length);
  if (!allowRequest(clientIp(req), cost)) return tooManyRequests();

  try {
    // a zbiorkom-only batch needs neither BB poller
    if (kbIds.length || mzkIds.length) await startPoller();
    const trips: Record<string, unknown> = {};
    let failed = 0;
    // zbiorkom trips come from the city's local feed (no upstream fetch, no token); while it loads they are absent and uncached
    let gzmLoading = false;
    for (const id of zbIds) {
      const slug = zbIdCity(id)!;
      if (!zbEnabled(slug)) continue;
      void startZb(slug);
      const t = getZb(slug).trip(id);
      if (t === null) gzmLoading = true;
      else if (t !== "unknown") trips[id] = t;
    }

    if (kbIds.length > 0) {
      const kb = await api.fetchTripsBatch(kbIds);
      failed += kb.failed;
      for (const [id, t] of Object.entries(kb.trips)) {
        // cached shared objects — spread, never mutate
        trips[id] = t && typeof t === "object" ? { ...(t as Record<string, unknown>), ...kbShapeRef(t, "background") } : t;
      }
    }

    if (mzkIds.length > 0) {
      const { resolveMzkTrip } = await import("@/lib/mzk-trip");
      const mzkResults = await Promise.all(
        mzkIds.map(async (id) => {
          try {
            const res = await resolveMzkTrip(id, { live: false });
            return [
              id,
              res?.trip
                ? {
                    ...(res.trip as object),
                    shape: res.shape,
                    ...(res.shape_id ? { shape_id: res.shape_id } : {}),
                    shape_status: res.shape_status,
                  }
                : null,
            ] as const;
          } catch {
            failed += 1;
            return [id, null] as const;
          }
        }),
      );
      for (const [id, t] of mzkResults) {
        if (t) trips[id] = t;
      }
    }

    // a failed fetch is not "no such trip": never cache it, and with nothing resolved let the client fall back
    if (failed === rawIds.length) return upstreamError("trips", new Error(`all ${failed} trip fetches failed`));
    const pending = Object.values(trips).some((t) => (t as { shape_status?: string } | null)?.shape_status === "pending");
    const cacheControl = failed > 0 || gzmLoading ? "no-store" : `public, max-age=${pending ? 300 : 3600}`;
    return Response.json({ count: Object.keys(trips).length, trips }, { headers: { "Cache-Control": cacheControl } });
  } catch (err) {
    return upstreamError("trips", err);
  }
}
