/**
 * The static frontend: every file of the build dir indexed once at start (metadata only, a request streams the
 * file), served with the .br / .gz siblings scripts/compress-static.mjs wrote next to it, so no request pays
 * for compression. Hashed bundle files are immutable; everything else revalidates by ETag (sw.js must, or a
 * new service worker would never be seen).
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { Frontend } from "./http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const IMMUTABLE = /^\/assets\//;

interface Entry {
  file: string;
  type: string;
  size: number;
  etag: string;
  cache: string;
  /** byte sizes of the precompressed siblings */
  br?: number;
  gz?: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.isFile() && !/\.(br|gz)$/.test(d.name)) out.push(p);
  }
  return out;
}

function index(root: string): Map<string, Entry> {
  const files = new Map<string, Entry>();
  for (const file of walk(root)) {
    const st = fs.statSync(file);
    const url = "/" + path.relative(root, file).split(path.sep).join("/");
    const size = (ext: string) => (fs.existsSync(file + ext) ? fs.statSync(file + ext).size : undefined);
    const e: Entry = {
      file,
      type: TYPES[path.extname(file)] ?? "application/octet-stream",
      size: st.size,
      etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      cache: IMMUTABLE.test(url) ? "public, max-age=31536000, immutable" : url.endsWith(".html") ? "no-cache" : "public, max-age=0",
      br: size(".br"),
      gz: size(".gz"),
    };
    files.set(url, e);
    // /index.html answers /, /brygady.html answers /brygady (Next's export layout without trailing slashes)
    if (url.endsWith("/index.html")) files.set(url.slice(0, -"index.html".length).replace(/(.)\/$/, "$1"), e);
    else if (url.endsWith(".html")) files.set(url.slice(0, -".html".length), e);
  }
  return files;
}

function send(req: http.IncomingMessage, res: http.ServerResponse, e: Entry, status: number): void {
  const head: http.OutgoingHttpHeaders = { "content-type": e.type, "cache-control": e.cache, etag: e.etag };
  if (e.br || e.gz) head.vary = "Accept-Encoding";
  if (status === 200 && req.headers["if-none-match"] === e.etag) {
    res.writeHead(304, head);
    return void res.end();
  }
  const ae = req.headers["accept-encoding"] ?? "";
  const enc = e.br && /\bbr\b/.test(ae) ? "br" : e.gz && /\bgzip\b/.test(ae) ? "gz" : null;
  if (enc) head["content-encoding"] = enc === "br" ? "br" : "gzip";
  head["content-length"] = enc ? e[enc] : e.size;
  res.writeHead(status, head);
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(enc ? `${e.file}.${enc}` : e.file)
    .on("error", () => res.destroy())
    .pipe(res);
}

export function staticFrontend(root: string): Frontend {
  const files = index(root);
  const notFound = files.get("/404");
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      return void res.end();
    }
    const raw = req.url ?? "/";
    const q = raw.indexOf("?");
    let p = q < 0 ? raw : raw.slice(0, q);
    try {
      p = decodeURIComponent(p);
    } catch {
      res.writeHead(400);
      return void res.end();
    }
    const e = files.get(p);
    if (e) return send(req, res, e, 200);
    if (notFound) return send(req, res, notFound, 404);
    res.writeHead(404);
    res.end();
  };
}
