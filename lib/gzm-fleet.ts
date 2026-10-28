/**
 * Metropolia GZM fleet ("brygady"): a FleetTracker (lib/fleet-tracker.ts) fed with the GZM
 * poller's vehicles. GZM has no static fleet list, so a vehicle exists from its first live
 * sighting of the day; the GTFS brigade gives the next course instead of a guess.
 * History: GZM_DIR/fleet-history-<YYYY-MM-DD>.json, kept GZM_FLEET_HISTORY_DAYS days.
 */
import { createHash } from "node:crypto";
import { GZM_DIR, GZM_FLEET_HISTORY_DAYS } from "./config";
import { FleetTracker, type FleetRunningInput, type FleetVehicleInfo } from "./fleet-tracker";
import type { FleetVehicleDetail } from "./shared/fleet";
import { log } from "./logger";

export interface GzmFleetSource {
  side: string; // "<op>_<fleet>", e.g. "283_4285"; the map vehicle id is `gzm:${side}`
  label: string; // display fleet number, e.g. "4285" (95 labels collide across companies, so `side` is the key)
  model: string | null;
  vehicleType: string; // GTFS route_type: "0" tram, "11" trolleybus, "3" bus
  line: string; // route_short_name
  brigade: string | null;
  tripId: string; // raw 16-hex GTFS trip_id
  headsign: string;
  stops: Array<{ id: string; name: string; dep: number; distM: number | null }>; // dep = service-day seconds (may exceed 86 400), distM = along-route metres
  servedIdx: number | null; // index in stops of the last stop served
  nextIdx: number | null;
  reachedM: number | null; // along-route distance driven
  atStop: boolean;
  notStarted: boolean;
  delaySec: number | null;
  lat: number;
  lon: number;
  bearing: number | null; // compass degrees
  fixAt: number | null; // epoch s of the GPS fix
  nextTrip: { line: string; headsign: string; firstStopName: string; firstStopId: string; dep: number } | null; // the brigade's next GTFS trip, dep = service-day seconds
}

/**
 * Operating companies by the code before "_" in the vehicle key: the `organization` of the same
 * keys in SDIP (sdip.transportgzm.pl), captured 2026-10-28 (all 1 342 SDIP keys were in the feed).
 * ponytail: static list of 18; a new company shows as "Przewoźnik <code>" until added here.
 */
const GZM_COMPANIES: Readonly<Record<string, string>> = {
  "2": "ZTM",
  "104": "PKM Świerklaniec",
  "107": "Kłosok",
  "108": "PKM Katowice",
  "109": "SimKol",
  "110": "Transgór",
  "114": "Nowak Transport",
  "116": "Lazar",
  "117": "PKS Grodzisk",
  "118": "METEOR",
  "119": "PKM Sosnowiec",
  "120": "PKM Gliwice",
  "122": "Pawelec",
  "125": "Tramwaje Śląskie",
  "131": "PKS Południe",
  "134": "PKS Gostynin",
  "283": "PKM Tychy",
  "284": "TLT",
};

export function gzmCompany(side: string): string {
  const code = side.split("_")[0];
  return Object.hasOwn(GZM_COMPANIES, code) ? GZM_COMPANIES[code] : `Przewoźnik ${code}`;
}

/** A GZM vehicle key as the fleet routes accept it: "<company code>_<fleet number>". */
export const GZM_SIDE_RE = /^\d{1,4}_\d{1,6}$/;

/** The first 12 hex digits key the course: a trip id that has none cannot be tracked. */
const TRIP_KEY_RE = /^[0-9a-f]{12}/i;

/** One GZM vehicle as the tracker reads it. Along-route metres become per-stop segments only when every stop has one. */
export function gzmFleetInput(src: GzmFleetSource): FleetRunningInput {
  const dist = src.stops.map((s) => s.distM);
  const measured = dist.length > 0 && dist.every((d): d is number => typeof d === "number" && Number.isFinite(d));
  return {
    vehicleId: src.side,
    lineName: src.line,
    // ponytail: 48 of the trip_id's 64 bits (exact in a double); two trips of a day sharing their first
    // 12 hex digits would merge into one course (~1 in 2^49 per pair). Upgrade: a string course key.
    courseLoid: Number.parseInt(src.tripId.slice(0, 12), 16),
    direction: src.headsign,
    // ponytail: an unknown delay counts as on time; the 2026-10-28 sample had 0 of 1 363 null.
    // Add a "delay unknown" flag to the course if the feed starts sending nulls.
    delaySec: src.delaySec ?? 0,
    latitude: src.lat,
    longitude: src.lon,
    ...(src.bearing !== null ? { angle: src.bearing } : {}),
    ...(src.fixAt !== null ? { lastPingDate: src.fixAt * 1000 } : {}),
    ...(measured && src.reachedM !== null ? { reachedMeters: Math.max(0, src.reachedM - dist[0]) } : {}),
    onStopPoint: src.atStop,
    stopPoints: src.stops.map((s, i) => ({
      symbol: s.id,
      name: s.name,
      orderNo: i,
      distance: measured && i > 0 ? Math.max(0, dist[i] - dist[i - 1]) : 0,
      // unused: stopSecs below carries the schedule
      scheduledDeparture: 0,
      plannedDeparture: 0,
    })),
    notStarted: src.notStarted,
    servedIdx: src.servedIdx,
    nextIdx: src.nextIdx,
    stopSecs: src.stops.map((s) => s.dep),
    brigade: src.brigade,
    nextTrip: src.nextTrip,
    label: src.label,
    model: src.model,
    company: gzmCompany(src.side),
  };
}

/** GZM publishes no equipment data: the live record's model, everything else unknown. */
function gzmInfo(side: string, label: string | undefined, model: string | null | undefined): FleetVehicleInfo {
  return {
    sideNumber: side,
    label: label ?? side.slice(side.indexOf("_") + 1),
    company: gzmCompany(side),
    model: model ?? "",
    producer: "",
    lengthCategory: null,
    fuelType: null,
    features: {},
  };
}

const gzmDetails = (v: FleetRunningInput): FleetVehicleInfo => gzmInfo(String(v.vehicleId), v.label, v.model);

/**
 * The card of a vehicle on the map that the tracker never saw on a course: off a trip since the
 * server started (about half the fleet late in the evening). Without it the card says "unknown vehicle".
 */
export function gzmIdleDetail(
  side: string,
  live: { label: string; model: string | null; line: string; lat: number; lon: number; fixAt: number },
): FleetVehicleDetail {
  return getGzmFleetTracker().idleDetail(gzmInfo(side, live.label, live.model), {
    at: live.fixAt,
    lat: live.lat,
    lon: live.lon,
    name: `Na mapie bez kursu, linia ${live.line}`,
  });
}

const TRACKER_KEY = Symbol.for("kb-gtfs.gzm-fleet");
type GlobalWithGzmFleet = typeof globalThis & { [TRACKER_KEY]?: FleetTracker };

/** The GZM-configured tracker; production goes through getGzmFleetTracker(), tests pass historyDir null. */
export function createGzmFleetTracker(historyDir: string | null = GZM_DIR): FleetTracker {
  return new FleetTracker({
    operator: "GZM",
    historyDir,
    keepDays: GZM_FLEET_HISTORY_DAYS,
    // ponytail: the day file is written synchronously. An estimated ~27 000 courses a day x ~25 stops would make it
    // ~90 MB, so finished courses keep no stop table (~12 MB, plus the running courses' stops) and
    // 2 min between writes bounds the stringify; a crash loses at most 2 min. Upgrade: an append log.
    saveDebounceMs: 120_000,
    archiveStops: false,
    staticFleet: null,
    details: gzmDetails,
  });
}

export function getGzmFleetTracker(): FleetTracker {
  const g = globalThis as GlobalWithGzmFleet;
  g[TRACKER_KEY] ??= createGzmFleetTracker();
  return g[TRACKER_KEY];
}

/** Graceful shutdown: writes a pending debounced save. Does not create the tracker. */
export function flushGzmFleet(): void {
  (globalThis as GlobalWithGzmFleet)[TRACKER_KEY]?.flushSync();
}

/**
 * Feeds one GZM poll to the tracker. Call ONLY after a successful, non-empty poll: an empty
 * list reads as every vehicle leaving service and closes all running courses. Never throws,
 * so a tracker bug cannot abort the poll.
 */
export function feedGzmFleet(sources: readonly GzmFleetSource[]): void {
  try {
    const running: FleetRunningInput[] = [];
    for (const s of sources) {
      if (TRIP_KEY_RE.test(s.tripId)) running.push(gzmFleetInput(s));
    }
    getGzmFleetTracker().updateFromRunningVehicles(running);
  } catch (err) {
    log.warn("gzm-fleet", `FleetTracker update failed: ${err}`);
  }
}

let listCache: { tracker: FleetTracker; version: number; body: string; etag: string } | null = null;

/**
 * The /api/fleet?city=gzm body (~1 350 rows), serialized and hashed at most once per tracker
 * update instead of once per request. No serverNow inside: a cached body would carry a stale
 * one, so the route sends the server clock as the X-Server-Time header.
 */
export function gzmFleetListBody(): { body: string; etag: string } {
  const tracker = getGzmFleetTracker();
  const version = tracker.getVersion();
  if (listCache?.tracker !== tracker || listCache.version !== version) {
    const vehicles = tracker.getFleetSummary();
    const body = JSON.stringify({ stats: tracker.getStats(), count: vehicles.length, vehicles });
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
    listCache = { tracker, version, body, etag };
  }
  return listCache;
}
