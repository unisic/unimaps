/**
 * Central configuration — TypeScript port of kb_gtfs/config.py.
 *
 * Every value can be overridden with a KB_* environment variable; the
 * defaults match the Python originals exactly.
 */
import path from "node:path";

/** Read a string env var, falling back to `def` when unset or empty. */
function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : def;
}

/** Read an integer env var, falling back to `def` when unset/invalid or below `min`. */
function envInt(name: string, def: number, min = 1): number {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") return def;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min ? n : def;
}

export const BASE_URL = envStr("KB_BASE_URL", "https://komunikacjabeskidzka.kiedyprzyjedzie.pl");
export const AGENCY_NAME = envStr("KB_AGENCY_NAME", "Komunikacja Beskidzka S.A.");
export const AGENCY_ID = envStr("KB_AGENCY_ID", "KB");
export const AGENCY_URL = envStr("KB_AGENCY_URL", "https://komunikacjabeskidzka.kiedyprzyjedzie.pl");
export const AGENCY_TIMEZONE = envStr("KB_AGENCY_TIMEZONE", "Europe/Warsaw");
export const AGENCY_LANG = envStr("KB_AGENCY_LANG", "pl");

export const DEFAULT_STOPS_REVISION = envStr("KB_STOPS_REVISION", "6829");

/** Output paths, relative to the process working directory. */
export const OUTPUT_DIR = envStr("KB_OUTPUT_DIR", path.join(process.cwd(), "output"));
export const GTFS_DIR = envStr("KB_GTFS_DIR", path.join(OUTPUT_DIR, "gtfs"));
export const RT_DIR = envStr("KB_RT_DIR", path.join(OUTPUT_DIR, "rt"));

/** HTTP timeout in seconds (aiohttp "total" equivalent). */
export const HTTP_TIMEOUT = envInt("KB_HTTP_TIMEOUT", 20);
export const DEFAULT_CONCURRENCY = envInt("KB_CONCURRENCY", 40);

/** Global rate-limit backstop across all clients (sustained requests/sec). */
export const RATE_LIMIT_GLOBAL = envInt("KB_RATE_LIMIT_GLOBAL", 500);

/** Live poller tuning (all in seconds unless noted). */
export const LIVE_FULL_SCAN_INTERVAL = envInt("KB_SCAN_INTERVAL", 90);
export const LIVE_REFRESH_INTERVAL = envInt("KB_REFRESH_INTERVAL", 10);
export const LIVE_CANDIDATE_HORIZON_SEC = envInt("KB_CANDIDATE_HORIZON", 7200);
export const LIVE_404_CACHE_SEC = envInt("KB_404_CACHE", 30, 0);
export const LIVE_STOP_EMPTY_CACHE_SEC = envInt("KB_STOP_EMPTY_CACHE", 120, 0);
export const LIVE_STOP_FAR_CACHE_SEC = envInt("KB_STOP_FAR_CACHE", 180, 0);
export const LIVE_STOP_FAR_THRESHOLD_SEC = envInt("KB_STOP_FAR_THRESHOLD", 1800);
export const LIVE_SMART_SCAN_INTERVAL = envInt("KB_SMART_SCAN_INTERVAL", 30);
export const LIVE_SMART_SCAN_WINDOW_SEC = envInt("KB_SMART_SCAN_WINDOW", 600, 0);
/**
 * Max stops per departures request. The upstream silently caps every
 * `/api/departures?places=` response at 6 boards — stops past the cap are
 * simply absent from the reply — so batches larger than 6 lose data.
 */
export const LIVE_BATCH_SIZE = envInt("KB_BATCH_SIZE", 6);

/**
 * Stale-vehicle ("ghost") filter. The upstream keeps returning a vehicle's
 * last-known position after it stops transmitting, so a bus that finished /
 * lost its feed lingers frozen on the map with no delay. We hide a vehicle once
 * it has not moved more than STALE_MOVE_EPS metres for STALE_VEHICLE seconds AND
 * has no live delay estimate. Real GPS always jitters, so a position that stays
 * put this long is a frozen feed, not a parked-but-live bus.
 */
export const LIVE_STALE_VEHICLE_SEC = envInt("KB_STALE_VEHICLE_SEC", 300);
export const LIVE_STALE_MOVE_EPS_M = envInt("KB_STALE_MOVE_EPS_M", 15, 0);

/**
 * GPS correction of the live delay (lib/kb-progress.ts). Upstream's stop index
 * stalls when a bus drives past stops without dwelling and the delay derived
 * from it then grows +1 min/min; with this on, a bus whose GPS position is
 * already beyond upstream's "next" stop gets the schedule deviation at its real
 * position instead. KB_GPS_DELAY=0 restores the pure upstream value.
 */
export const GPS_DELAY = envStr("KB_GPS_DELAY", "1") !== "0";

/**
 * Feed age (secs since the last proven upstream contact) beyond which
 * /api/health reports "degraded" (HTTP 503). Must exceed
 * LIVE_STOP_EMPTY_CACHE_SEC (600): overnight a full scan can legitimately find
 * every stop cached and make zero upstream requests.
 */
export const HEALTH_STALE_SEC = envInt("KB_HEALTH_STALE_SEC", 1200);

/** How often the poller re-fetches the stop list (default: daily). A failed
 *  reload keeps the previous list and retries in 30 min. */
export const STOPS_RELOAD_SEC = envInt("KB_STOPS_RELOAD_SEC", 86_400);

/** In-process daily GTFS feed rebuild (KB_GTFS_AUTOBUILD=0 disables — e.g. in
 *  dev when the poller alone should hit upstream). */
export const GTFS_AUTOBUILD = envStr("KB_GTFS_AUTOBUILD", "1") !== "0";
/** Agency-local hour after which the daily rebuild may run (no buses ~22:00–4:30,
 *  and the new date's timetables are certainly published by then). */
export const GTFS_BUILD_HOUR = envInt("KB_GTFS_BUILD_HOUR", 3, 0);
/** Upstream concurrency for the in-process rebuild — politer than the CLI's
 *  default 40 because the server keeps scanning while it builds. */
export const GTFS_BUILD_CONCURRENCY = envInt("KB_GTFS_BUILD_CONCURRENCY", 10);
/** Days of output/fleet-history-<day>.json kept on disk; older day files are
 *  deleted at the midnight rollover. Only today's file is ever read. */
export const FLEET_HISTORY_DAYS = envInt("KB_FLEET_HISTORY_DAYS", 365);

export const USER_AGENT = envStr(
  "KB_USER_AGENT",
  "unimaps/2.0 (+https://github.com/unisic/unimaps)",
);

/**
 * Server-side road routing for the shape store (lib/shape-store.ts). The
 * public OSRM demo server is shared: its policy requires an identifying
 * User-Agent and ≤1 request/s. KB_OSRM_URL=off disables routing (KB vehicles
 * then move straight towards the next stop; MZK shapes are unaffected).
 */
export const OSRM_URL: string | null = (() => {
  const v = envStr("KB_OSRM_URL", "https://router.project-osrm.org/route/v1/driving").trim();
  return v.toLowerCase() === "off" ? null : v;
})();
const PUBLIC_OSRM = OSRM_URL !== null && /(^|\/\/)router\.project-osrm\.org\b/.test(OSRM_URL);
/** Minimum spacing between OSRM requests (clamped to ≥1000 ms on the public demo host). */
export const OSRM_MIN_INTERVAL_MS = Math.max(PUBLIC_OSRM ? 1000 : 0, envInt("KB_OSRM_MIN_INTERVAL_MS", 1100, 250));
export const OSRM_USER_AGENT = envStr("KB_OSRM_USER_AGENT", USER_AGENT);
/**
 * Address search behind /api/geocode (a Photon API, OpenStreetMap data). The
 * public komoot host is fair-use only: the route caches answers and caps the
 * requests in flight. KB_GEOCODER_URL=off disables the address search.
 */
export const GEOCODER_URL: string | null = (() => {
  const v = envStr("KB_GEOCODER_URL", "https://photon.komoot.io/api/").trim();
  return v.toLowerCase() === "off" ? null : v;
})();
/** Road shapes older than this are re-routed gradually (one per 2 min). */
export const SHAPES_MAX_AGE_DAYS = envInt("KB_SHAPES_MAX_AGE_DAYS", 14);
/** Persisted shape store (outside output/gtfs, which the builder swaps atomically). */
export const SHAPES_FILE = envStr("KB_SHAPES_FILE", path.join(OUTPUT_DIR, "shapes", "route-shapes.v1.json"));
/** MZK stop travel directions learned from running courses (lib/mzk-stop-dirs.ts); outside output/gtfs for the same reason. */
export const MZK_STOP_DIRS_FILE = envStr("KB_MZK_STOP_DIRS_FILE", path.join(OUTPUT_DIR, "mzk-stop-dirs.v1.json"));
/** MZK static timetable built from OnTime for the connection search (lib/mzk-timetable.ts); outside output/gtfs for the same reason. */
export const MZK_TIMETABLE_FILE = envStr("KB_MZK_TIMETABLE_FILE", path.join(OUTPUT_DIR, "mzk-timetable.v1.json"));

/**
 * Metropolia GZM (lib/gzm.ts, lib/gzm-feed.ts): a second city served from the same process, isolated
 * from the BB pollers. KB_GZM=0 switches it off (every ?city=gzm / gzm: request then answers 404).
 */
export const GZM_ENABLED = envInt("KB_GZM", 1, 0) !== 0;
/** zbiorkom api6-open: merged GTFS Schedule (stops, trips, shapes, brigades) and the live positions. */
export const GZM_GTFS_URL = envStr("KB_GZM_GTFS_URL", "https://api.zbiorkom.live/api6-open/gzm/gtfs/default");
export const GZM_POSITIONS_URL = envStr(
  "KB_GZM_POSITIONS_URL",
  "https://api.zbiorkom.live/api6-open/gzm/positions/18.3,49.9,19.7,50.7",
);
/** SDIP (sdip.transportgzm.pl) vehicle overlay, polled every 5 s only while someone watches GZM. */
export const GZM_SDIP_ENABLED = envInt("KB_GZM_SDIP", 1, 0) !== 0;
export const GZM_SDIP_URL = envStr("KB_GZM_SDIP_URL", "https://sdip.transportgzm.pl/vm/main");
/** GZM state on disk: the last good GTFS zip and the GZM fleet history (outside output/gtfs). */
export const GZM_DIR = envStr("KB_GZM_DIR", path.join(OUTPUT_DIR, "gzm"));
/** Days of GZM fleet history kept on disk (~12-14 MB per day: ~22 000 finished courses x ~530 B, plus the running ones). */
export const GZM_FLEET_HISTORY_DAYS = envInt("KB_GZM_FLEET_HISTORY_DAYS", 30);

/**
 * Web push of departure alerts (lib/push-alerts.ts, lib/web-push.ts): KB_PUSH=0 switches it off
 * (/api/push answers 404, alerts then fire only while the app is open). The VAPID key pair and the
 * pending alerts live in KB_PUSH_DIR; KB_PUSH_SUBJECT is the contact push services see (mailto: or https:).
 */
export const PUSH_ENABLED = envInt("KB_PUSH", 1, 0) !== 0;
export const PUSH_DIR = envStr("KB_PUSH_DIR", path.join(OUTPUT_DIR, "push"));
export const PUSH_SUBJECT = envStr("KB_PUSH_SUBJECT", "https://github.com/unisic/unimaps");

/** Map an upstream line type to a GTFS route_type (port of route_type_for). */
export function routeTypeFor(lineType: string | null | undefined, _vehicleType?: number | null): number {
  const t = (lineType ?? "").toLowerCase();
  if (t === "tram") return 0;
  if (t === "rail" || t === "train") return 2;
  if (t === "metro" || t === "subway") return 1;
  if (t === "ferry") return 4;
  if (t === "trolleybus" || t === "trolley") return 11;
  return 3;
}

let isoDateFmt: Intl.DateTimeFormat | undefined;

/**
 * Agency-local "YYYY-MM-DD" (matching Python's datetime.date.today().isoformat()).
 * Uses AGENCY_TIMEZONE explicitly instead of the process-local clock, so the
 * default date stays correct when the server runs on UTC — see nowSecs() in
 * lib/poller.ts.
 */
export function todayLocalISO(at: Date = new Date()): string {
  try {
    isoDateFmt ??= new Intl.DateTimeFormat("en-CA", {
      timeZone: AGENCY_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return isoDateFmt.format(at);
  } catch {
    const d = at;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
}

