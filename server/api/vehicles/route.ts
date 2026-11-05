import { gzipSync } from "node:zlib";

import { parseCity, prebuiltJson, upstreamError } from "@/lib/api-helpers";
import { getZb, startZb, type GzmLive } from "@/lib/gzm";
import { getCombinedVehicles, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** gzip of each zbiorkom city's last body (a body changes at most every 5 s); dies with its GzmLive when dropZb drops it */
const gz = new WeakMap<GzmLive, { body: string; gz: Uint8Array<ArrayBuffer> }>();

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
      const live = getZb(city);
      // prebuilt once per poll (GZM ~390 KB): served as is, never re-serialized per request
      const body = live.vehiclesBody();
      const next = live.nextBodyAt();
      // epoch ms of the server's next body, so the client polls right after it instead of on its own phase
      const h = { ...headers, "Content-Type": "application/json", Vary: "Accept-Encoding", ...(next ? { "X-Next-Update": String(next) } : {}) };
      // ponytail: substring test, a client sending "gzip;q=0" still gets gzip; every browser accepts it
      if (!(req.headers.get("accept-encoding") ?? "").includes("gzip")) return new Response(body, { headers: h });
      let e = gz.get(live);
      if (e?.body !== body) gz.set(live, (e = { body, gz: new Uint8Array(gzipSync(body)) }));
      return new Response(e.gz, { headers: { ...h, "Content-Encoding": "gzip" } });
    }
    await startPoller();
    const url = new URL(req.url);
    const v = getCombinedVehicles(url.searchParams.get("operator"));
    return prebuiltJson(req, v, () => JSON.stringify(v), headers);
  } catch (err) {
    return upstreamError("vehicles", err);
  }
}
