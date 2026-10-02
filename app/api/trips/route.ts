import { badRequest, isValidId, upstreamError } from "@/lib/api-helpers";
import { getApi, kbShapeRef, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BATCH_IDS = 300;

async function handleBatch(req: Request, rawIds: string[]): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();

  if (!rawIds.length) return badRequest("ids list cannot be empty");
  if (rawIds.length > MAX_BATCH_IDS) return badRequest(`Exceeded maximum of ${MAX_BATCH_IDS} ids`);

  for (const id of rawIds) {
    if (!isValidId(id)) return badRequest(`Invalid trip id: ${id}`);
  }

  try {
    await startPoller();
    const kbIds = rawIds.filter((id) => !id.startsWith("mzk:"));
    const mzkIds = rawIds.filter((id) => id.startsWith("mzk:"));

    const trips: Record<string, unknown> = {};

    if (kbIds.length > 0) {
      const kbTrips = await getApi().fetchTripsBatch(kbIds);
      for (const [id, t] of Object.entries(kbTrips)) {
        // cached shared objects — spread, never mutate
        trips[id] = t && typeof t === "object" ? { ...(t as Record<string, unknown>), ...kbShapeRef(t, "background") } : t;
      }
    }

    if (mzkIds.length > 0) {
      const { resolveMzkTrip } = await import("@/lib/mzk-trip");
      const mzkResults = await Promise.all(
        mzkIds.map(async (id) => {
          try {
            const res = await resolveMzkTrip(id);
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
            return [id, null] as const;
          }
        }),
      );
      for (const [id, t] of mzkResults) {
        if (t) trips[id] = t;
      }
    }

    return Response.json(
      { count: Object.keys(trips).length, trips },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch (err) {
    return upstreamError("trips", err);
  }
}

/**
 * GET /api/trips?ids=123,456,789 — batch trip detail resolution.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  if (!idsParam) return badRequest("Missing ?ids= query parameter");
  const rawIds = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
  return handleBatch(req, rawIds);
}

/**
 * POST /api/trips — JSON body { ids: string[] } for large batches.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { ids?: unknown };
    if (!body || !Array.isArray(body.ids)) {
      return badRequest("Body must be JSON { ids: string[] }");
    }
    const rawIds = body.ids.map(String).map((s) => s.trim()).filter(Boolean);
    return handleBatch(req, rawIds);
  } catch {
    return badRequest("Invalid JSON body");
  }
}
