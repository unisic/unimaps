import { internalError, parseCity, warming } from "@/lib/api-helpers";
import { getGzm, startGzm } from "@/lib/gzm";
import { getLines } from "@/lib/lines";
import { getCombinedLines, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/lines — combined line catalog from KB and MZK. */
export async function GET(req: Request): Promise<Response> {
  const city = parseCity(req);
  if (city instanceof Response) return city;
  if (city === "gzm") {
    void startGzm();
    const feed = getGzm().currentFeed();
    if (!feed) return warming();
    const lines = feed.lines.map((l) => ({ id: l.id, name: l.name, terminus: l.terminus, type: l.type, operator: "GZM" as const }));
    return Response.json({ count: lines.length, lines }, { headers: { "Cache-Control": "public, max-age=3600" } });
  }
  try {
    await startPoller();
    const kbLines = getLines().map((l) => ({ ...l, operator: "KB" as const }));
    const lines = getCombinedLines(kbLines);
    return Response.json(
      { count: lines.length, lines },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch (err) {
    return internalError("lines", err);
  }
}
