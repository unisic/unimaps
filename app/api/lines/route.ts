import { getLines } from "@/lib/lines";
import { getCombinedLines, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/lines — combined line catalog from KB and MZK. */
export async function GET(): Promise<Response> {
  try {
    await startPoller();
    const kbLines = getLines().map((l) => ({ ...l, operator: "KB" as const }));
    const lines = getCombinedLines(kbLines);
    return Response.json(
      { count: lines.length, lines },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
