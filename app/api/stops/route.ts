import { upstreamError } from "@/lib/api-helpers";
import { getMergedStopsView, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** RFC 9110 weak comparison: any listed tag (W/ prefix ignored) or "*" — a proxy may weaken our strong ETag. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const want = etag.replace(/^W\//, "");
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//, "") === want;
  });
}

/** GET /api/stops — unified stops merged across KB and MZK. */
export async function GET(req: Request): Promise<Response> {
  try {
    await startPoller();
    const view = getMergedStopsView();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ETag: view.etag,
      // a list still missing one operator (MZK upstream down at boot) is never reused without asking the server
      // (no-cache = revalidate every time — a 304 while nothing changed); a complete one may be reused for a minute.
      // The client refetches on focus / every 15 min, a partial one every 20 s (`partial` in the body).
      "Cache-Control": view.partial ? "no-cache" : "public, max-age=60",
    };
    if (etagMatches(req.headers.get("if-none-match"), view.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(view.body, { headers });
  } catch (err) {
    return upstreamError("stops", err);
  }
}
