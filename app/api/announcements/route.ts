import { upstreamError } from "@/lib/api-helpers";
import { pyTruthy } from "@/lib/kb-api";
import { getApi, getMzkApi, startPoller } from "@/lib/poller-singleton";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/announcements — combined announcements from KB & MZK. */
export async function GET(req: Request): Promise<Response> {
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  try {
    await startPoller();
    const [kbData, mzkMsgs] = await Promise.allSettled([
      getApi().fetchAnnouncements(),
      getMzkApi().fetchMessages(),
    ]);

    const kbAnnouncements =
      kbData.status === "fulfilled" && pyTruthy(kbData.value) && typeof kbData.value === "object"
        ? ((kbData.value as { announcements?: Array<{ id: number; rev: number; content_markdown: string; operator?: string }> }).announcements ?? [])
        : [];

    kbAnnouncements.forEach((a) => {
      a.operator = "KB";
    });

    const mzkAnnouncements =
      mzkMsgs.status === "fulfilled" && Array.isArray(mzkMsgs.value)
        ? mzkMsgs.value.map((m) => ({
            id: m.loid,
            rev: 1,
            content_markdown: `**[MZK Bielsko-Biała] ${m.title}**\n\n${m.intro}`,
            operator: "MZK",
          }))
        : [];

    const combined = [...kbAnnouncements, ...mzkAnnouncements];
    const hash = String(combined.map((a) => `${a.id}:${a.rev}`).join("|"));

    return Response.json({ announcements: combined, hash });
  } catch (err) {
    return upstreamError("announcements", err);
  }
}

