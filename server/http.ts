/**
 * The HTTP layer: one node:http server answers the API from the route table and hands every other request to
 * the frontend (the static build in production, the dev server in development). Replaces `next start`, whose
 * request pipeline cost ~2 ms CPU per API request where a bare node:http handler costs ~0.15 ms (measured
 * 2026-10-31, 3000 requests at concurrency 10).
 */
import http from "node:http";
import { GZM_ENABLED, PUSH_ENABLED } from "@/lib/config";
import { startGzm } from "@/lib/gzm";
import { log } from "@/lib/logger";
import { startPoller } from "@/lib/poller-singleton";
import { getPushAlerts } from "@/lib/push-alerts";
import { getPushNews } from "@/lib/push-news";
import { ROUTES, type Method, type Route } from "./routes";

export type Frontend = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** push subscriptions are ~1 KB; nothing the API accepts comes near this */
const MAX_BODY = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve(null);
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function plain(res: http.ServerResponse, status: number, body: string, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  let r: Route | undefined;
  let match: RegExpExecArray | null = null;
  for (r of ROUTES) if ((match = r.re.exec(pathname))) break;
  if (!r || !match) return plain(res, 404, '{"error":"Not found"}');
  const method = req.method === "HEAD" ? "GET" : req.method;
  const allow = `${Object.keys(r.methods).join(", ")}, HEAD, OPTIONS`;
  if (method === "OPTIONS") {
    res.writeHead(204, { allow });
    return void res.end();
  }
  const handler = r.methods[method as Method];
  if (!handler) return plain(res, 405, '{"error":"Method not allowed"}', { allow });

  const params: Record<string, string> = {};
  try {
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1])));
  } catch {
    return plain(res, 400, '{"error":"Malformed URL"}');
  }
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  // like Next: a request with no proxy in front is keyed on its socket (lib/rate-limit.ts clientIp)
  if (!headers.has("x-forwarded-for") && req.socket.remoteAddress) headers.set("x-forwarded-for", req.socket.remoteAddress);
  let body: Buffer | null = null;
  if (method !== "GET") {
    body = await readBody(req);
    if (!body) return plain(res, 413, '{"error":"Body too large"}');
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
  let request: Request;
  try {
    request = new Request(url, { method, headers, body: body && Uint8Array.from(body) });
  } catch {
    return plain(res, 400, '{"error":"Bad request"}');
  }

  let out: Response;
  try {
    out = await handler(request, { params: Promise.resolve(params) });
  } catch (err) {
    log.error("http", `${method} ${pathname} failed: ${err}`);
    return plain(res, 500, '{"error":"Internal error"}');
  }
  const head: http.OutgoingHttpHeaders = {};
  out.headers.forEach((v, k) => {
    if (k !== "set-cookie") head[k] = v;
  });
  const cookies = out.headers.getSetCookie();
  if (cookies.length) head["set-cookie"] = cookies;
  const buf = out.body ? Buffer.from(await out.arrayBuffer()) : null;
  if (buf) head["content-length"] = buf.length;
  res.writeHead(out.status, head);
  res.end(req.method === "HEAD" ? undefined : buf);
}

export function createServer(frontend: Frontend): http.Server {
  return http.createServer((req, res) => {
    const q = req.url?.indexOf("?") ?? -1;
    const pathname = q < 0 ? (req.url ?? "/") : req.url!.slice(0, q);
    if (pathname.length > 1 && pathname.endsWith("/")) {
      // leading slashes and backslashes collapsed: `//host/` or `/\host/` must not redirect off-site
      res.writeHead(308, { location: "/" + pathname.replace(/^[/\\]+|\/+$/g, "") + (q < 0 ? "" : req.url!.slice(q)) });
      return void res.end();
    }
    if (pathname !== "/api" && !pathname.startsWith("/api/")) return frontend(req, res);
    api(req, res, pathname).catch((err: unknown) => {
      log.error("http", `${req.method} ${pathname}: ${err}`);
      if (!res.headersSent) plain(res, 500, '{"error":"Internal error"}');
      else res.destroy();
    });
  });
}

/** What Next's instrumentation hook did: the BB pollers, GZM beside them (its failure must not touch BB), and the
 *  push ticks, so alerts persisted before a restart fire without waiting for a request. */
export function boot(): void {
  void startPoller().catch((err: unknown) => log.error("rt", `background poller start failed: ${err}`));
  if (GZM_ENABLED) void startGzm().catch((err: unknown) => log.error("gzm", `GZM start failed: ${err}`));
  if (PUSH_ENABLED) {
    getPushAlerts();
    getPushNews();
  }
}

/** Listen on PORT / HOST (8080 on every interface, as scripts/start-server.mjs did; never HOSTNAME, which shells
 *  and Docker set to the machine name) and exit on SIGTERM/SIGINT after lib/poller-singleton's own handlers
 *  flushed the stores (all listeners of one signal run in the same emit). */
export function listen(server: http.Server): void {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => log.info("http", `listening on http://${host}:${port}`));
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      server.close();
      setTimeout(() => process.exit(0), 100);
    });
  }
}
