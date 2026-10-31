/**
 * Synthetic GZM feed shared by the GZM tests: line 7 (tram), brigade 3 runs tA a->c then tB c->a,
 * brigade 4 runs tX a->c sharing tA's first call; every day 2026-10-20..2026-11-10.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";

import { parseGzmZip, serviceDayBase, type GzmFeed } from "../../lib/gzm-feed";

export const DATE = "2026-10-28";
export const LAT = 50.25;
export const LON = { a: 19.0, b: 19.01, c: 19.02 };

// line 7, brigade 3: tA a->c, then tB c->a; brigade 4: tX a->c, sharing tA's first call (a 08:00)
export const FILES: Record<string, string> = {
  "routes.txt": ["route_id,agency_id,route_short_name,route_long_name,route_type", "r7,1,7,Tramwaj 7,0"].join("\n"),
  "stops.txt": [
    "stop_id,stop_name,stop_lat,stop_lon,location_type",
    `a,Alfa 01,${LAT},${LON.a},0`,
    `b,Beta 01,${LAT},${LON.b},0`,
    `c,Gamma 01,${LAT},${LON.c},0`,
  ].join("\n"),
  "trips.txt": [
    "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,brigade",
    "r7,s1,tA,Gamma,0,shA,3",
    "r7,s1,tB,Alfa,1,,3",
    "r7,s1,tX,Gamma,0,,4",
  ].join("\n"),
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    "tA,08:00:00,08:00:00,a,0",
    "tA,08:05:00,08:05:00,b,1",
    "tA,08:10:00,08:10:00,c,2",
    "tB,08:20:00,08:20:00,c,0",
    "tB,08:25:00,08:25:00,b,1",
    "tB,08:30:00,08:30:00,a,2",
    "tX,08:00:00,08:00:00,a,0",
    "tX,08:06:00,08:06:00,b,1",
    "tX,08:12:00,08:12:00,c,2",
  ].join("\n"),
  "shapes.txt": [
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
    `shA,${LAT},${LON.a},1`,
    `shA,${LAT},${LON.b},2`,
    `shA,${LAT},${LON.c},3`,
  ].join("\n"),
  "calendar.txt": [
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    "s1,1,1,1,1,1,1,1,20261020,20261110",
  ].join("\n"),
  "feed_info.txt": ["feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version", "ZTM,https://example.invalid,pl,20261020,20261110,1"].join("\n"),
};

/** Parses `files` (default FILES) as city `slug` once per call into a fresh temp dir (removed again). */
export async function loadGzmFeed(files = FILES, slug = "gzm"): Promise<GzmFeed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-gzm-fixture-"));
  try {
    const file = path.join(dir, "gtfs.zip");
    fs.writeFileSync(file, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
    return await parseGzmZip(file, slug);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = serviceDayBase(DATE);
/** epoch secs of DATE hh:mm(+sec) Warsaw */
export const at = (hhmm: string, sec = 0): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return BASE + h * 3600 + m * 60 + sec;
};

export interface RecOpts {
  key?: string;
  lon?: number;
  lat?: number;
  /** epoch secs */
  ts: number;
  calls: Array<[number, string]>;
  delay?: number;
  brigade?: string;
  line?: string;
}
/** A zbiorkom positions record. */
export const rec = (o: RecOpts) => ({
  vehicle: { id: (o.key ?? "283_4285").split("_")[1], type: "0", agency: "default", model: "Konstal 105Na" },
  routeName: o.line ?? "7",
  brigade: o.brigade ?? "3",
  location: [o.lon ?? LON.b, o.lat ?? LAT],
  timestamp: o.ts * 1000,
  bearing: 90,
  delay: (o.delay ?? 0) * 1000,
  headsign: "Gamma",
  upcomingStops: o.calls.map(([seq, t]) => ({ sequence: seq, name: "x", scheduledArrival: at(t) * 1000, scheduledDeparture: at(t) * 1000 })),
  url: `https://x.invalid/gzm/vehicle/0%3A${o.key ?? "283_4285"}`,
});
