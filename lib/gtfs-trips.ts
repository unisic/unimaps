/**
 * KB trip → line + headsign, read from the built GTFS feed's `trips.txt`.
 *
 * Upstream's stop timetable carries neither (only trip ids), so without this
 * every KB row costs one upstream /api/trip fetch before the departure can be
 * labelled. Same contract as lines.ts: if the feed is absent the map is simply
 * empty and callers keep their old fallback (graceful, never throws).
 */
import fs from "node:fs";
import path from "node:path";

import * as config from "./config";
import { col, parseCsvLine, splitLines } from "./gtfs-csv";

export interface GtfsTripMeta {
  /** rider-facing line number, e.g. "115" */
  line: string;
  /** trip_headsign as upstream spells it, e.g. "BIELSKO-BIAŁA D.A." */
  headsign: string;
}

// on globalThis, not in a module variable: Next bundles instrumentation (whose nightly rebuild
// invalidates) and each route with its own copy of this module
const CACHE_KEY = Symbol.for("kb-gtfs.gtfs-trips-cache");
const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<string, GtfsTripMeta> | null };

function compute(): Map<string, GtfsTripMeta> {
  const out = new Map<string, GtfsTripMeta>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(config.GTFS_DIR, "trips.txt"), "utf-8");
  } catch {
    return out; // no feed → no lookup
  }
  const lines = splitLines(text);
  const header = parseCsvLine(lines[0] ?? "");
  const iTrip = col(header, "trip_id");
  const iSvc = col(header, "service_id");
  const iRoute = col(header, "route_id");
  const iHead = col(header, "trip_headsign");
  const iShort = col(header, "trip_short_name");
  if (iTrip < 0) return out;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    let id = f[iTrip];
    if (!id) continue;
    // the builder suffixes a trip that runs under several calendars: "<upstream id>_<service_id>"
    const svc = iSvc >= 0 ? f[iSvc] : "";
    if (svc && id.endsWith(`_${svc}`)) id = id.slice(0, -(svc.length + 1));
    if (out.has(id)) continue;
    const route = iRoute >= 0 ? f[iRoute] ?? "" : "";
    const line = (iShort >= 0 ? f[iShort] : "") || route.replace(/^L_/, "");
    if (!line) continue;
    out.set(id, { line, headsign: iHead >= 0 ? f[iHead] ?? "" : "" });
  }
  return out;
}

/** Line + headsign of an upstream KB trip id; null when the feed doesn't know it (new trip, no feed yet). */
export function gtfsTripMeta(tripId: string | number): GtfsTripMeta | null {
  return (g[CACHE_KEY] ??= compute()).get(String(tripId)) ?? null;
}

/** Drop the cache after a GTFS rebuild so the next read sees the new feed. */
export function invalidateGtfsTrips(): void {
  g[CACHE_KEY] = null;
}
