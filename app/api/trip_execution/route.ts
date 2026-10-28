import { badRequest, internalError, isGzmId, notFound, upstreamError } from "@/lib/api-helpers";
import { GZM_ENABLED } from "@/lib/config";
import { getGzm, startGzm } from "@/lib/gzm";
import { asRecord, isRecord, parseIntStrict, pyTruthy } from "@/lib/kb-api";
import { resolveMzkTrip } from "@/lib/mzk-trip";
import { getApi, getPoller, kbShapeRef, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `gzm:<op>_<fleet>`: answered from memory, never sent anywhere, but still validated like every id */
const GZM_EXEC_RE = /^gzm:\d{1,4}_\d{1,6}$/;

/** GET /api/trip_execution?exec_id=<raw id>&index=0 — upstream trip execution passthrough. */
export async function GET(req: Request): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const params = new URL(req.url).searchParams;
  const execId = params.get("exec_id");
  if (!execId) return badRequest("exec_id query parameter is required");
  const rawIndex = params.get("index");
  const index = rawIndex === null ? 0 : parseIntStrict(rawIndex);
  if (index === null) return badRequest("index must be an integer");
  if (isGzmId(execId)) {
    if (!GZM_ENABLED) return notFound();
    if (!GZM_EXEC_RE.test(execId)) return badRequest("Invalid exec_id");
    void startGzm();
    try {
      return Response.json(getGzm().tripExecution(execId) ?? {}, {
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" },
      });
    } catch (err) {
      return internalError("gzm-trip-execution", err);
    }
  }
  try {
    await startPoller();

    if (execId.startsWith("mzk:")) {
      const mzkTrip = await resolveMzkTrip(execId);
      return Response.json(mzkTrip || {}, {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
        },
      });
    }

    const reqMs = Date.now(); // a reply landing after a newer poller fix must not overwrite it
    const data = await getApi().fetchTripExecution(execId, index);
    let body: unknown = pyTruthy(data) ? data : {};
    if (pyTruthy(data) && isRecord(data)) {
      const pos = getPoller().ingestTripExecution(execId, data, reqMs);
      // stored road geometry for this trip's stop pattern (never mutate `data`); `arrived` = recorded arrival
      // epoch secs per times[] position, which upstream drops for passed stops
      body = { ...data, ...kbShapeRef(asRecord(data.trip)), ...(pos?.arrivals ? { arrived: pos.arrivals.arrived } : {}) };
    }
    return Response.json(body, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    });
  } catch (err) {
    return upstreamError("trip_execution", err);
  }
}

