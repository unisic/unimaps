import { mergeStops } from "@/lib/stop-merge";
import { upstreamError } from "@/lib/api-helpers";
import { getMzkPoller, getPoller, startPoller } from "@/lib/poller-singleton";
import { getStopDirections } from "@/lib/stop-directions";
import type { Stop, StopsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cached: {
  stops: Stop[];
  mzkStops: Stop[];
  dirs: Map<string, number[]>;
  body: string;
} | null = null;

/** GET /api/stops — unified stops merged across KB and MZK. */
export async function GET(): Promise<Response> {
  try {
    await startPoller();
    const poller = getPoller();
    const mzkPoller = getMzkPoller();
    const dirs = getStopDirections();

    if (
      !cached ||
      cached.stops !== poller.stops ||
      cached.mzkStops !== mzkPoller.stops ||
      cached.dirs !== dirs
    ) {
      const kbFormatted = poller.stops.map((s) => {
        const isStn =
          s.showPlatforms ||
          /(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i.test(s.name);
        const d = isStn ? undefined : dirs.get(s.stopId);
        return {
          id: s.stopId,
          designator: s.urlId,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          operator: "KB" as const,
          ...(d && d.length ? { dirs: d } : {}),
          ...(isStn ? { isStation: true } : {}),
          ...(s.showPlatforms ? { showPlatforms: true } : {}),
        };
      });

      const mzkFormatted = mzkPoller.stops.map((s) => ({
        id: s.stopId,
        designator: s.urlId,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        operator: "MZK" as const,
        symbol: s.symbol,
        ...(s.isStation ? { isStation: true } : {}),
        ...(s.onRequest ? { onRequest: true } : {}),
        ...(s.gettingOut ? { gettingOut: true } : {}),
      }));

      const allStops = mergeStops(kbFormatted, mzkFormatted);
      const body: StopsResponse = {
        count: allStops.length,
        stops: allStops,
      };

      cached = {
        stops: poller.stops,
        mzkStops: mzkPoller.stops,
        dirs,
        body: JSON.stringify(body),
      };
    }

    return new Response(cached.body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    return upstreamError("stops", err);
  }
}

