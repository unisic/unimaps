import { badRequest, internalError, notFound, readJsonBody } from "@/lib/api-helpers";
import { PUSH_ENABLED } from "@/lib/config";
import { getPushAlerts, isAlertInput } from "@/lib/push-alerts";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { isPushSub, vapidKeys } from "@/lib/web-push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/push: the VAPID public key a browser subscribes with; 404 = push is off (KB_PUSH=0). */
export function GET(req: Request): Response {
  if (!PUSH_ENABLED) return notFound();
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  try {
    return Response.json({ key: vapidKeys().pub }, { headers: { "Cache-Control": "no-cache" } });
  } catch (err) {
    return internalError("push-key", err);
  }
}

/** POST /api/push {subscription, alert}: the server also fires this alert, as a web push. 204, or 503 when full. */
export async function POST(req: Request): Promise<Response> {
  if (!PUSH_ENABLED) return notFound();
  if (!allowRequest(clientIp(req), 5)) return tooManyRequests();
  const body = await readJsonBody(req);
  if (!body || !isPushSub(body.subscription) || !isAlertInput(body.alert)) return badRequest("Invalid subscription or alert");
  if (!getPushAlerts().add(body.subscription, body.alert))
    return Response.json({ error: "Too many alerts" }, { status: 503, headers: { "Retry-After": "300" } });
  return new Response(null, { status: 204 });
}

/** DELETE /api/push {subscription, key}: the alert was switched off on the page. */
export async function DELETE(req: Request): Promise<Response> {
  if (!PUSH_ENABLED) return notFound();
  if (!allowRequest(clientIp(req))) return tooManyRequests();
  const body = await readJsonBody(req);
  if (!body || !isPushSub(body.subscription) || typeof body.key !== "string") return badRequest("Invalid subscription or key");
  getPushAlerts().remove(body.subscription.endpoint, body.key);
  return new Response(null, { status: 204 });
}
