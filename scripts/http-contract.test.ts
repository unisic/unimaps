/**
 * The HTTP contract of the server front (server/http.ts + server/static.ts), checked from outside against a running
 * server, so the same file pins the Node server and the Rust one that replaces it (backend/). Needs a production
 * build in out/ and talks to the live upstreams through /api/health, so it is not part of `npm test` or CI:
 *   BASE_URL=http://127.0.0.1:8080 node --import tsx --test scripts/http-contract.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import zlib from "node:zlib";

const BASE = new URL(process.env.BASE_URL ?? "http://127.0.0.1:8080");

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** node:http, not fetch: fetch decodes bodies, follows redirects and adds its own accept-encoding */
function request(path: string, opts: { method?: string; headers?: http.OutgoingHttpHeaders; body?: Buffer } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: BASE.hostname, port: BASE.port, path, method: opts.method ?? "GET", headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const WEAK_ETAG = /^W\/"[0-9a-f]+-[0-9a-f]+"$/;

test("index page: html, no-cache, weak etag, revalidates to 304", async () => {
  const r = await request("/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.match(r.headers.etag ?? "", WEAK_ETAG);
  assert.equal(r.headers.vary, "Accept-Encoding");
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(Number(r.headers["content-length"]), r.body.length);
  assert.match(r.body.toString(), /<html/i);

  const again = await request("/", { headers: { "if-none-match": r.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, r.headers.etag);
  assert.equal(again.headers["cache-control"], "no-cache");

  assert.equal((await request("/", { headers: { "if-none-match": 'W/"0-0"' } })).status, 200);
  assert.equal((await request("/index.html")).headers.etag, r.headers.etag);
});

test("pages answer with and without .html", async () => {
  const a = await request("/brygady");
  const b = await request("/brygady.html");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.headers.etag, b.headers.etag);
  assert.equal(a.headers["content-type"], "text/html; charset=utf-8");
});

test("hashed asset: immutable, br / gzip / identity by accept-encoding", async () => {
  const html = (await request("/")).body.toString();
  const src = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(src, "index.html links a /assets/*.js bundle");
  const plain = await request(src);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(plain.headers["content-type"], "application/javascript; charset=utf-8");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(Number(plain.headers["content-length"]), plain.body.length);

  const br = await request(src, { headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(Number(br.headers["content-length"]), br.body.length);
  assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);

  const gz = await request(src, { headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(Number(gz.headers["content-length"]), gz.body.length);
  assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);

  assert.equal((await request(src, { headers: { "accept-encoding": "brotli" } })).headers["content-encoding"], undefined);

  const head = await request(src, { method: "HEAD", headers: { "accept-encoding": "br" } });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], br.headers["content-length"]);
});

test("unknown page: the 404 page with status 404", async () => {
  const r = await request("/nope");
  assert.equal(r.status, 404);
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
  assert.ok(r.body.length > 0);
  // a 404 never revalidates to 304, whatever the etag
  assert.equal((await request("/nope", { headers: { "if-none-match": r.headers.etag } })).status, 404);
});

test("pages: 405 for other methods, 400 for a malformed escape", async () => {
  const post = await request("/", { method: "POST", body: Buffer.from("x") });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal(post.body.length, 0);
  assert.equal((await request("/%E0%A4%A")).status, 400);
  assert.equal((await request("/%C5")).status, 400);
});

test("trailing slash: 308 to the bare path, never off-site", async () => {
  const cases: [string, string][] = [
    ["/brygady/?x=1", "/brygady?x=1"],
    ["//evil.com/", "/evil.com"],
    ["///evil.com//", "/evil.com"],
    ["/api/vehicles/", "/api/vehicles"],
  ];
  for (const [from, to] of cases) {
    const r = await request(from);
    assert.equal(r.status, 308, from);
    assert.equal(r.headers.location, to, from);
  }
});

test("api: 404 / 405 / OPTIONS from the route table", async () => {
  for (const p of ["/api", "/api/nope"]) {
    const r = await request(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(r.body.toString()), { error: "Not found" });
  }
  const opt = await request("/api/health", { method: "OPTIONS" });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.allow, "GET, HEAD, OPTIONS");

  const post = await request("/api/vehicles", { method: "POST", body: Buffer.from("{}") });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD, OPTIONS");
  assert.deepEqual(JSON.parse(post.body.toString()), { error: "Method not allowed" });
});

test("api: health answers JSON, HEAD has no body", async () => {
  const r = await request("/api/health");
  assert.ok(r.status === 200 || r.status === 503, `status ${r.status}`);
  assert.match(r.headers["content-type"] ?? "", /^application\/json/);
  assert.equal(typeof JSON.parse(r.body.toString()).status, "string");
  const head = await request("/api/health", { method: "HEAD" });
  assert.equal(head.body.length, 0);
});

test("api: a body over 64 KB is refused with 413", async () => {
  const r = await request("/api/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.alloc(70 * 1024, 0x20),
  });
  assert.equal(r.status, 413);
  assert.deepEqual(JSON.parse(r.body.toString()), { error: "Body too large" });
});
