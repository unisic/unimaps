/**
 * Static line catalog, read from the built GTFS feed's `routes.txt`.
 *
 * Gives the command palette the full set of lines — including ones with no
 * vehicle currently running (live vehicles only ever surface active lines).
 * Same contract as stop-directions: if the feed is absent the catalog is
 * simply empty (graceful, never throws).
 */
import fs from "node:fs";
import path from "node:path";

import * as config from "./config";
import { col, parseCsvLine, splitLines } from "./gtfs-csv";

export interface LineInfo {
  /** GTFS route_id, e.g. "L_102" */
  id: string;
  /** rider-facing line number, e.g. "102" */
  name: string;
  /** route_long_name — the terminus, e.g. "KANIÓW" */
  terminus: string;
}

// on globalThis, not in a module variable: Next bundles instrumentation (whose nightly rebuild
// invalidates) and each route with its own copy of this module
const CACHE_KEY = Symbol.for("kb-gtfs.lines-cache");
const g = globalThis as typeof globalThis & { [CACHE_KEY]?: LineInfo[] | null };

function compute(): LineInfo[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(config.GTFS_DIR, "routes.txt"), "utf-8");
  } catch {
    return []; // no feed → no catalog
  }
  const lines = splitLines(text);
  const header = parseCsvLine(lines[0]);
  const iId = col(header, "route_id");
  const iName = col(header, "route_short_name");
  const iLong = col(header, "route_long_name");
  if (iId < 0 || iName < 0) return [];
  const out: LineInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (!f[iId] || !f[iName]) continue;
    out.push({ id: f[iId], name: f[iName], terminus: iLong >= 0 ? f[iLong] ?? "" : "" });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "pl", { numeric: true }));
  return out;
}

/** Lazily computed, process-lifetime cache of the GTFS line catalog. */
export function getLines(): LineInfo[] {
  return (g[CACHE_KEY] ??= compute());
}

/** Drop the cache after a GTFS rebuild so the next read sees the new feed. */
export function invalidateLines(): void {
  g[CACHE_KEY] = null;
}
