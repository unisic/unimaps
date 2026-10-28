/**
 * Small shared helpers for the API routes: input validation for values that get
 * forwarded into upstream URLs, and error responses that don't leak internals.
 */
import { createHash } from "node:crypto";

import { GZM_ENABLED } from "./config";
import { log } from "./logger";

/** Upstream-safe id: letters/digits and ':' '.' '_' '-' only, so the value can
 *  never smuggle a '/', '?', '#', '&' or '%' that would rewrite the upstream URL
 *  path/query. Matches real designators/trip ids (e.g. "19223", "19132:39688"). */
const ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidId(v: string): boolean {
  // "." / ".." are dot segments: fetch() would normalise /api/trip/../0 into /api/0
  return ID_RE.test(v) && v !== "." && v !== "..";
}

/** Road-shape wire id: "kb:<12 hex>", "mzk:<variant>" or "gzm:<GTFS shape_id>", optionally ".<rev6>". */
const SHAPE_ID_RE = /^(?:kb:[0-9a-f]{12}|mzk:[0-9]{1,10}|gzm:[A-Za-z0-9_]{1,16})(?:\.[0-9a-f]{6})?$/;

export function isValidShapeId(v: string): boolean {
  return SHAPE_ID_RE.test(v);
}

/** A real calendar day: 2026-02-31 would reach KB verbatim while MZK's Date.UTC rolls it into March. */
export function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export type City = "bb" | "gzm";

/** `?city=`: absent = "bb" (the BB paths stay exactly as they were), "gzm" while GZM is enabled;
 *  any other value is a 400, "gzm" with KB_GZM=0 a 404. */
export function parseCity(req: Request): City | Response {
  const v = new URL(req.url).searchParams.get("city");
  if (v === null || v === "bb") return "bb";
  if (v !== "gzm") return badRequest("Unknown city");
  return GZM_ENABLED ? "gzm" : notFound();
}

/** True for an id in the GZM space ("gzm:<id>"). */
export function isGzmId(v: string): boolean {
  return v.startsWith("gzm:");
}

export function notFound(message = "Not found"): Response {
  return Response.json({ error: message }, { status: 404 });
}

/** 503 while a city's data is still loading (the GZM feed parses for a few seconds after a start). */
export function warming(): Response {
  return Response.json({ error: "Data is loading" }, { status: 503, headers: { "Retry-After": "10" } });
}

/** 500 for a failure inside our own code (no upstream involved) — logs the
 *  real error, returns a generic message. */
export function internalError(tag: string, err: unknown): Response {
  log.error(tag, err instanceof Error ? err.message : String(err));
  return Response.json({ error: "Internal error" }, { status: 500 });
}

/** 400 for a malformed path/query value. */
export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/** 502 that logs the real error server-side but returns a generic message —
 *  never leaks the upstream base URL / request path or raw exception text. */
export function upstreamError(tag: string, err: unknown): Response {
  log.error(tag, err instanceof Error ? err.message : String(err));
  return Response.json({ error: "Upstream request failed" }, { status: 502 });
}

/** RFC 9110 weak comparison: any listed tag (W/ prefix ignored) or "*" — a proxy may weaken our strong ETag. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const want = etag.replace(/^W\//, "");
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//, "") === want;
  });
}

/**
 * JSON with a content ETag, for data a page polls although it often has not changed: the browser
 * keeps the copy (`no-cache` = always revalidate, never reuse unasked) and an unchanged body costs
 * a 304 without a body. The client has to fetch with `cache: "no-cache"`; `no-store` never revalidates.
 */
export function jsonWithEtag(req: Request, data: unknown): Response {
  const body = JSON.stringify(data);
  const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache", ETag: etag };
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}
