/**
 * Small shared helpers for the API routes: input validation for values that get
 * forwarded into upstream URLs, and error responses that don't leak internals.
 */
import { log } from "./logger";

/** Upstream-safe id: letters/digits and ':' '.' '_' '-' only, so the value can
 *  never smuggle a '/', '?', '#', '&' or '%' that would rewrite the upstream URL
 *  path/query. Matches real designators/trip ids (e.g. "19223", "19132:39688"). */
const ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidId(v: string): boolean {
  return ID_RE.test(v);
}

/** Road-shape wire id: "kb:<12 hex>" or "mzk:<variant>", optionally ".<rev6>". */
const SHAPE_ID_RE = /^(?:kb:[0-9a-f]{12}|mzk:[0-9]{1,10})(?:\.[0-9a-f]{6})?$/;

export function isValidShapeId(v: string): boolean {
  return SHAPE_ID_RE.test(v);
}

export function isValidDate(v: string): boolean {
  return DATE_RE.test(v);
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
