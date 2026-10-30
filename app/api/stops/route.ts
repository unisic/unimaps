import { etagMatches, parseCity, upstreamError, warming } from "@/lib/api-helpers";
import { getZb, startZb } from "@/lib/gzm";
import { getMergedStopsView, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/stops — unified stops merged across KB and MZK. */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (city !== "bb") {
    void startZb(city);
    const feed = getZb(city).currentFeed();
    if (!feed) return warming();
    // the feed swaps once a day; the client revalidates like the BB list (focus, every 15 min)
    const headers = { "Content-Type": "application/json", ETag: feed.stopsEtag, "Cache-Control": "public, max-age=60" };
    if (etagMatches(req.headers.get("if-none-match"), feed.stopsEtag)) return new Response(null, { status: 304, headers });
    return new Response(feed.stopsBody, { headers });
  }
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
