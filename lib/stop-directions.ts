/**
 * Per-stop travel direction(s), derived offline from the built GTFS feed.
 *
 * For every trip we walk consecutive stops (A → B) and credit stop A with the
 * compass bearing toward B — "the way buses leave A". A stop is usually served
 * in two opposite ways (peron 1 / peron 2), so the collected bearings are
 * clustered and the 1–2 dominant directions are kept. The result is merged into
 * GET /api/stops so the map can draw a bus-stop icon pointing the right way.
 *
 * Reads the already-built `output/gtfs/{stops,stop_times}.txt`; if the feed is
 * absent the map simply shows no arrows (graceful, never throws).
 */
import fs from "node:fs";
import path from "node:path";

import * as config from "./config";
import { bearing } from "./geo";
import { col, parseCsvLine, splitLines } from "./gtfs-csv";

/** Smallest absolute angle between two compass bearings, degrees [0,180]. */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Circular mean of compass bearings, in degrees [0, 360). */
function circularMean(bearings: number[]): number {
  let sin = 0;
  let cos = 0;
  for (const b of bearings) {
    const r = (b * Math.PI) / 180;
    sin += Math.sin(r);
    cos += Math.cos(r);
  }
  return Math.round(((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360);
}

/**
 * Cluster tangent bearings along the road. Bearings within MERGE_THRESHOLD (75°)
 * represent the same direction of travel along the street (e.g. buses that branch
 * or turn at a junction further down).
 *
 * A second cluster is kept ONLY if it represents the opposite direction of traffic
 * along the road (angleDiff >= 100°, typically ~180°) with sufficient trip support.
 * Bus stations (D.A.) are explicitly stripped of arrows.
 */
function clusterRoadDirections(bearings: number[]): number[] {
  if (!bearings.length) return [];
  const MERGE_THRESHOLD = 75;
  const clusters: number[][] = [];

  for (const b of bearings) {
    let bestIdx = -1;
    let bestDiff = MERGE_THRESHOLD;
    for (let i = 0; i < clusters.length; i++) {
      const mean = circularMean(clusters[i]);
      const diff = angleDiff(b, mean);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].push(b);
    } else {
      clusters.push([b]);
    }
  }

  clusters.sort((a, b) => b.length - a.length);

  const primary = circularMean(clusters[0]);
  const result = [primary];

  for (let i = 1; i < clusters.length; i++) {
    const mean = circularMean(clusters[i]);
    const diff = angleDiff(primary, mean);
    if (diff >= 100 && clusters[i].length >= 2 && clusters[i].length >= clusters[0].length * 0.15) {
      result.push(mean);
      break; // At most 2 opposite directions along a road
    }
  }

  return result;
}

// on globalThis, not in a module variable: Next bundles instrumentation (whose nightly rebuild
// invalidates) and each route with its own copy of this module
const CACHE_KEY = Symbol.for("kb-gtfs.stop-directions-cache");
const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<string, number[]> | null };

function compute(): Map<string, number[]> {
  const dir = config.GTFS_DIR;
  const result = new Map<string, number[]>();
  let stopsTxt: string;
  let timesTxt: string;
  try {
    stopsTxt = fs.readFileSync(path.join(dir, "stops.txt"), "utf-8");
    timesTxt = fs.readFileSync(path.join(dir, "stop_times.txt"), "utf-8");
  } catch {
    return result; // no feed → no arrows
  }

  // stop_id → [lat, lon] and station identification
  const coords = new Map<string, [number, number]>();
  const stationStops = new Set<string>();
  {
    const lines = splitLines(stopsTxt);
    const header = parseCsvLine(lines[0]);
    const iId = col(header, "stop_id");
    const iName = col(header, "stop_name");
    const iLat = col(header, "stop_lat");
    const iLon = col(header, "stop_lon");
    const iLocType = col(header, "location_type");
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = parseCsvLine(lines[i]);
      // guard empty cells: Number("") is 0, which would place a phantom (0,0) stop
      if (!f[iId] || f[iLat] === "" || f[iLon] === "") continue;
      const lat = Number(f[iLat]);
      const lon = Number(f[iLon]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        coords.set(f[iId], [lat, lon]);
      }
      const name = f[iName] ?? "";
      const locType = f[iLocType] ?? "";
      if (locType === "1" || /(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i.test(name)) {
        stationStops.add(f[iId]);
      }
    }
  }

  // trip_id → [ (seq, stop_id) ] in file order, then sorted by seq per trip
  const lines = splitLines(timesTxt);
  const header = parseCsvLine(lines[0]);
  const iTrip = col(header, "trip_id");
  const iStop = col(header, "stop_id");
  const iSeq = col(header, "stop_sequence");
  const perTrip = new Map<string, Array<[number, string]>>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    const trip = f[iTrip];
    const stopId = f[iStop];
    const rawSeq = f[iSeq];
    const seq = Number(rawSeq);
    // skip empty seq cells (Number("") === 0 would fabricate a stop_sequence 0)
    if (!trip || !stopId || !rawSeq || !Number.isFinite(seq)) continue;
    let arr = perTrip.get(trip);
    if (!arr) { arr = []; perTrip.set(trip, arr); }
    arr.push([seq, stopId]);
  }

  // accumulate road tangent bearings per stop
  const acc = new Map<string, number[]>();
  for (const arr of perTrip.values()) {
    arr.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < arr.length; i++) {
      const currId = arr[i][1];
      if (stationStops.has(currId)) continue; // Never give arrows to D.A. / stations

      const c = coords.get(currId);
      if (!c) continue;

      const p = i > 0 ? coords.get(arr[i - 1][1]) : null;
      const n = i < arr.length - 1 ? coords.get(arr[i + 1][1]) : null;

      let brg: number | null = null;
      if (p && n) {
        // Tangent of the road through curr
        brg = bearing(p[0], p[1], n[0], n[1]);
      } else if (n) {
        // First stop: outgoing direction
        brg = bearing(c[0], c[1], n[0], n[1]);
      } else if (p) {
        // Last stop: incoming direction
        brg = bearing(p[0], p[1], c[0], c[1]);
      }

      if (brg === null) continue;
      let list = acc.get(currId);
      if (!list) { list = []; acc.set(currId, list); }
      list.push(brg);
    }
  }

  for (const [stopId, bearings] of acc) {
    const dirs = clusterRoadDirections(bearings);
    if (dirs.length) result.set(stopId, dirs);
  }
  return result;
}

/** Lazily computed, process-lifetime cache of stop_id → up to two bearings. */
export function getStopDirections(): Map<string, number[]> {
  return (g[CACHE_KEY] ??= compute());
}

/** Drop the cache after a GTFS rebuild so the next read sees the new feed. */
export function invalidateStopDirections(): void {
  g[CACHE_KEY] = null;
}
