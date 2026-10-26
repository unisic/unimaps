import type { NextRequest } from "next/server";

/*
 * Read-only app: every route handler is a GET, there are no Server Actions and no forms. A request
 * that carries a body has no legitimate target, so it is refused here and never reaches the
 * RSC / Server Action decoder (the code path behind the React2Shell RCE and the Server Action DoS).
 * A POST handler or a Server Action added later has to be allowed here explicitly.
 */
const ALLOWED = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(req: NextRequest): Response | undefined {
  if (ALLOWED.has(req.method)) return undefined;
  return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
}

export const config = {
  // __nextjs_* is the dev overlay, which POSTs stack frames
  matcher: "/((?!__nextjs).*)",
};
