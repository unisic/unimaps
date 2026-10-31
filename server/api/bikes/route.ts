import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { etagMatches, notFound, parseCity, upstreamError } from "@/lib/api-helpers";
import { GZM_GBFS_URL } from "@/lib/config";
import { fetchBikes, type BikesSnapshot } from "@/lib/gbfs";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** the last snapshot's body, ETag and gzip (it changes at most every 60 s; Next leaves route handler responses uncompressed) */
let last: { snap: BikesSnapshot; body: string; etag: string; gz: Uint8Array<ArrayBuffer> } | null = null;

/** GET /api/bikes?city=gzm: Metrorower stations with the bikes available now. BB has no bike share: 404. */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (city !== "gzm" || !GZM_GBFS_URL) return notFound();
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  let snap: BikesSnapshot;
  try {
    snap = await fetchBikes();
  } catch (err) {
    return upstreamError("bikes", err);
  }
  if (last?.snap !== snap) {
    const body = JSON.stringify(snap);
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
    last = { snap, body, etag, gz: new Uint8Array(gzipSync(body)) };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-cache", ETag: last.etag };
  if (etagMatches(req.headers.get("if-none-match"), last.etag)) return new Response(null, { status: 304, headers });
  if (!(req.headers.get("accept-encoding") ?? "").includes("gzip")) return new Response(last.body, { headers });
  return new Response(last.gz, { headers: { ...headers, "Content-Encoding": "gzip" } });
}
