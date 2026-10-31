import { upstreamError } from "@/lib/api-helpers";
import { getPoller, startPoller } from "@/lib/poller-singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/gtfs-rt.pb — binary GTFS-Realtime VehiclePositions feed. */
export async function GET(): Promise<Response> {
  try {
    await startPoller();
    const data = getPoller().toProtobuf();
    return new Response(data, {
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Disposition": "attachment; filename=VehiclePositions.pb",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return upstreamError("gtfs-rt", err);
  }
}
