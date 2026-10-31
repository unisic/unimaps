import { badRequest, notFound, readJsonBody } from "@/lib/api-helpers";
import { GZM_ENABLED, PUSH_ENABLED } from "@/lib/config";
import { getPushNews, isCity } from "@/lib/push-news";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { isPushSub } from "@/lib/web-push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/push/news {subscription, city}: push this browser the city's new announcements. 204, or 503 when full. */
export async function POST(req: Request): Promise<Response> {
  if (!PUSH_ENABLED) return notFound();
  if (!allowRequest(clientIp(req), 5)) return tooManyRequests();
  const body = await readJsonBody(req);
  if (!body || !isPushSub(body.subscription) || !isCity(body.city) || (body.city === "gzm" && !GZM_ENABLED))
    return badRequest("Invalid subscription or city");
  if (!getPushNews().add(body.subscription, body.city))
    return Response.json({ error: "Too many subscriptions" }, { status: 503, headers: { "Retry-After": "3600" } });
  return new Response(null, { status: 204 });
}

/** DELETE /api/push/news {subscription, city}: switched off on the page. */
export async function DELETE(req: Request): Promise<Response> {
  if (!PUSH_ENABLED) return notFound();
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const body = await readJsonBody(req);
  if (!body || !isPushSub(body.subscription) || !isCity(body.city)) return badRequest("Invalid subscription or city");
  getPushNews().remove(body.subscription.endpoint, body.city);
  return new Response(null, { status: 204 });
}
