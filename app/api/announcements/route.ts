import { notFound, parseCity, upstreamError } from "@/lib/api-helpers";
import { fetchAnnouncements } from "@/lib/announcements";
import { GZM_NEWS_URL } from "@/lib/config";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/announcements[?city=gzm]: KB + MZK announcements, or GZM's scraped news (KB_GZM_NEWS_URL=off = 404). */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  // only BB and GZM have a news source
  if (city === "gzm" ? !GZM_NEWS_URL : city !== "bb") return notFound();
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  try {
    return Response.json(await fetchAnnouncements(city));
  } catch (err) {
    return upstreamError("announcements", err);
  }
}
