import { gzipSync } from "node:zlib";

import { parseCity, upstreamError } from "@/lib/api-helpers";
import { getZb, startZb } from "@/lib/gzm";
import { getCombinedVehicles, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** gzip of each zbiorkom city's last body: Next leaves route handler responses uncompressed, and a body changes at
 *  most every 5 s. ponytail: one entry per city ever requested (~50 KB each, at most the registry's size). */
const gz = new Map<string, { body: string; gz: Uint8Array<ArrayBuffer> }>();

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
    if (city !== "bb") {
      void startZb(city);
      // prebuilt once per poll (GZM ~390 KB): served as is, never re-serialized per request
      const body = getZb(city).vehiclesBody();
      const h = { ...headers, "Content-Type": "application/json", Vary: "Accept-Encoding" };
      // ponytail: substring test, a client sending "gzip;q=0" still gets gzip; every browser accepts it
      if (!(req.headers.get("accept-encoding") ?? "").includes("gzip")) return new Response(body, { headers: h });
      let e = gz.get(city);
      if (e?.body !== body) gz.set(city, (e = { body, gz: new Uint8Array(gzipSync(body)) }));
      return new Response(e.gz, { headers: { ...h, "Content-Encoding": "gzip" } });
    }
    await startPoller();
    const url = new URL(req.url);
    const op = url.searchParams.get("operator");
    return Response.json(getCombinedVehicles(op), { headers });
  } catch (err) {
    return upstreamError("vehicles", err);
  }
}
