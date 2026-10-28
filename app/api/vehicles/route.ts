import { gzipSync } from "node:zlib";

import { parseCity, upstreamError } from "@/lib/api-helpers";
import { getGzm, startGzm } from "@/lib/gzm";
import { getCombinedVehicles, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** gzip of the last GZM body: Next leaves route handler responses uncompressed, and the body changes at most every 5 s */
let gzm: { body: string; gz: Uint8Array<ArrayBuffer> } | null = null;

/** GET /api/vehicles — live vehicle positions as JSON. */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  try {
    const headers = {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      // server clock (epoch ms) for the client motion engine — a header, not a
      // body field, so unchanged payloads still dedupe in SWR
      "X-Server-Time": String(Date.now()),
    };
    if (city === "gzm") {
      void startGzm();
      // prebuilt once per poll (~390 KB): served as is, never re-serialized per request
      const body = getGzm().vehiclesBody();
      const h = { ...headers, "Content-Type": "application/json", Vary: "Accept-Encoding" };
      // ponytail: substring test, a client sending "gzip;q=0" still gets gzip; every browser accepts it
      if (!(req.headers.get("accept-encoding") ?? "").includes("gzip")) return new Response(body, { headers: h });
      if (gzm?.body !== body) gzm = { body, gz: new Uint8Array(gzipSync(body)) };
      return new Response(gzm.gz, { headers: { ...h, "Content-Encoding": "gzip" } });
    }
    await startPoller();
    const url = new URL(req.url);
    const op = url.searchParams.get("operator");
    return Response.json(getCombinedVehicles(op), { headers });
  } catch (err) {
    return upstreamError("vehicles", err);
  }
}
