//! lib/config.ts: the `KB_*` settings, each read on first use (after main loaded the .env files), so a change
//! needs a restart there too.

use std::sync::LazyLock;

/// `envStr`: unset or empty = the default.
pub fn env_str(name: &str, def: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| def.to_owned())
}

/// `envInt`: `Math.trunc(Number(v.trim()))`, the default when unset, empty, not finite or below `min`.
pub fn env_int(name: &str, def: i64, min: i64) -> i64 {
    let Ok(v) = std::env::var(name) else { return def };
    let v = v.trim_matches(crate::js::is_space);
    let n = crate::js::number(v).trunc();
    if v.is_empty() || !n.is_finite() || n < min as f64 {
        def
    } else {
        n as i64
    }
}

fn in_output(name: &str) -> String {
    std::path::Path::new(&*OUTPUT_DIR)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

pub static BASE_URL: LazyLock<String> =
    LazyLock::new(|| env_str("KB_BASE_URL", "https://komunikacjabeskidzka.kiedyprzyjedzie.pl"));
pub static AGENCY_TIMEZONE: LazyLock<String> = LazyLock::new(|| env_str("KB_AGENCY_TIMEZONE", "Europe/Warsaw"));
pub static AGENCY_NAME: LazyLock<String> = LazyLock::new(|| env_str("KB_AGENCY_NAME", "Komunikacja Beskidzka S.A."));
pub static AGENCY_ID: LazyLock<String> = LazyLock::new(|| env_str("KB_AGENCY_ID", "KB"));
pub static AGENCY_URL: LazyLock<String> =
    LazyLock::new(|| env_str("KB_AGENCY_URL", "https://komunikacjabeskidzka.kiedyprzyjedzie.pl"));
pub static AGENCY_LANG: LazyLock<String> = LazyLock::new(|| env_str("KB_AGENCY_LANG", "pl"));

/// `routeTypeFor`: an upstream line type as a GTFS route_type.
pub fn route_type_for(line_type: Option<&str>) -> u8 {
    match line_type.unwrap_or("").to_lowercase().as_str() {
        "tram" => 0,
        "rail" | "train" => 2,
        "metro" | "subway" => 1,
        "ferry" => 4,
        "trolleybus" | "trolley" => 11,
        _ => 3,
    }
}
pub static DEFAULT_STOPS_REVISION: LazyLock<String> = LazyLock::new(|| env_str("KB_STOPS_REVISION", "6829"));
/// HTTP timeout in seconds (aiohttp "total" equivalent).
pub static HTTP_TIMEOUT: LazyLock<i64> = LazyLock::new(|| env_int("KB_HTTP_TIMEOUT", 20, 1));
pub static DEFAULT_CONCURRENCY: LazyLock<i64> = LazyLock::new(|| env_int("KB_CONCURRENCY", 40, 1));
pub static RATE_LIMIT_GLOBAL: LazyLock<i64> = LazyLock::new(|| env_int("KB_RATE_LIMIT_GLOBAL", 500, 1));

/// Live poller tuning (seconds unless noted).
pub static LIVE_FULL_SCAN_INTERVAL: LazyLock<i64> = LazyLock::new(|| env_int("KB_SCAN_INTERVAL", 90, 1));
pub static LIVE_REFRESH_INTERVAL: LazyLock<i64> = LazyLock::new(|| env_int("KB_REFRESH_INTERVAL", 10, 1));
pub static LIVE_CANDIDATE_HORIZON_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_CANDIDATE_HORIZON", 7200, 1));
pub static LIVE_404_CACHE_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_404_CACHE", 30, 0));
pub static LIVE_STOP_EMPTY_CACHE_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_STOP_EMPTY_CACHE", 120, 0));
pub static LIVE_STOP_FAR_CACHE_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_STOP_FAR_CACHE", 180, 0));
pub static LIVE_STOP_FAR_THRESHOLD_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_STOP_FAR_THRESHOLD", 1800, 1));
pub static LIVE_SMART_SCAN_INTERVAL: LazyLock<i64> = LazyLock::new(|| env_int("KB_SMART_SCAN_INTERVAL", 30, 1));
pub static LIVE_SMART_SCAN_WINDOW_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_SMART_SCAN_WINDOW", 600, 0));
/// Max stops per departures request: upstream silently caps every `/api/departures?places=` reply at 6 boards.
pub static LIVE_BATCH_SIZE: LazyLock<i64> = LazyLock::new(|| env_int("KB_BATCH_SIZE", 6, 1));
/// Ghost filter: hidden once not moved more than STALE_MOVE_EPS m for STALE_VEHICLE s with no live delay.
pub static LIVE_STALE_VEHICLE_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_STALE_VEHICLE_SEC", 300, 1));
pub static LIVE_STALE_MOVE_EPS_M: LazyLock<i64> = LazyLock::new(|| env_int("KB_STALE_MOVE_EPS_M", 15, 0));
/// GPS correction of the KB live delay (lib/kb-progress.ts); KB_GPS_DELAY=0 keeps upstream's value.
pub static GPS_DELAY: LazyLock<bool> = LazyLock::new(|| env_str("KB_GPS_DELAY", "1") != "0");
/// No good upstream poll for this long = degraded health (above the 600 s overnight all-cached window).
pub static HEALTH_STALE_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_HEALTH_STALE_SEC", 1200, 1));
/// How often the poller re-fetches the stop list; a failed reload keeps the old list and retries in 30 min.
pub static STOPS_RELOAD_SEC: LazyLock<i64> = LazyLock::new(|| env_int("KB_STOPS_RELOAD_SEC", 86_400, 1));
/// In-process daily GTFS feed rebuild; "0" disables it.
pub static GTFS_AUTOBUILD: LazyLock<bool> = LazyLock::new(|| env_str("KB_GTFS_AUTOBUILD", "1") != "0");
/// Agency-local hour after which the daily rebuild may run.
pub static GTFS_BUILD_HOUR: LazyLock<i64> = LazyLock::new(|| env_int("KB_GTFS_BUILD_HOUR", 3, 0));
pub static GTFS_BUILD_CONCURRENCY: LazyLock<i64> = LazyLock::new(|| env_int("KB_GTFS_BUILD_CONCURRENCY", 10, 1));
pub static GZM_ENABLED: LazyLock<bool> = LazyLock::new(|| env_int("KB_GZM", 1, 0) != 0);
pub static ZB_ENABLED: LazyLock<bool> = LazyLock::new(|| env_int("KB_ZB", 1, 0) != 0);

/// Output paths, relative to the process working directory.
pub static OUTPUT_DIR: LazyLock<String> = LazyLock::new(|| {
    let cwd = std::env::current_dir().unwrap_or_default();
    env_str("KB_OUTPUT_DIR", &cwd.join("output").to_string_lossy())
});
pub static GTFS_DIR: LazyLock<String> = LazyLock::new(|| env_str("KB_GTFS_DIR", &in_output("gtfs")));
/// MZK static timetable built from OnTime for the connection search (lib/mzk-timetable.ts).
pub static MZK_TIMETABLE_FILE: LazyLock<String> =
    LazyLock::new(|| env_str("KB_MZK_TIMETABLE_FILE", &in_output("mzk-timetable.v1.json")));
/// MZK stop bearings learned from running courses (lib/mzk-stop-dirs.ts).
pub static MZK_STOP_DIRS_FILE: LazyLock<String> =
    LazyLock::new(|| env_str("KB_MZK_STOP_DIRS_FILE", &in_output("mzk-stop-dirs.v1.json")));
/// Road shapes older than this are re-routed gradually (one per 2 min).
pub static SHAPES_MAX_AGE_DAYS: LazyLock<i64> = LazyLock::new(|| env_int("KB_SHAPES_MAX_AGE_DAYS", 14, 1));
/// Persisted shape store (outside output/gtfs, which the builder swaps atomically).
pub static SHAPES_FILE: LazyLock<String> =
    LazyLock::new(|| env_str("KB_SHAPES_FILE", &in_output("shapes/route-shapes.v1.json")));

/// Web push: `KB_PUSH=0` turns it off (/api/push and /api/push/news answer 404, boot arms no push tick).
/// The VAPID pair and pending alerts live in PUSH_DIR; the subject is the contact push services see (mailto: or https:).
pub static PUSH_ENABLED: LazyLock<bool> = LazyLock::new(|| env_int("KB_PUSH", 1, 0) != 0);
pub static PUSH_DIR: LazyLock<String> = LazyLock::new(|| env_str("KB_PUSH_DIR", &in_output("push")));
pub static PUSH_SUBJECT: LazyLock<String> =
    LazyLock::new(|| env_str("KB_PUSH_SUBJECT", "https://github.com/unisic/unimaps"));

/// The identifying User-Agent every upstream request sends.
pub static USER_AGENT: LazyLock<String> =
    LazyLock::new(|| env_str("KB_USER_AGENT", "unimaps/2.0 (+https://github.com/unisic/unimaps)"));

/// `KB_OSRM_URL` (route service base), None when set to `off`.
pub static OSRM_URL: LazyLock<Option<String>> = LazyLock::new(|| {
    let v = env_str("KB_OSRM_URL", "https://router.project-osrm.org/route/v1/driving");
    let v = v.trim_matches(crate::js::is_space);
    (!v.eq_ignore_ascii_case("off")).then(|| v.to_owned())
});
/// The public demo host: its policy wants an identifying User-Agent and at most 1 request/s.
pub static PUBLIC_OSRM: LazyLock<bool> = LazyLock::new(|| {
    OSRM_URL.as_deref().is_some_and(|u| {
        // /(^|\/\/)router\.project-osrm\.org\b/
        const HOST: &str = "router.project-osrm.org";
        u.match_indices(HOST).any(|(i, _)| {
            (i == 0 || u[..i].ends_with("//"))
                && !u[i + HOST.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    })
});
/// Minimum spacing between OSRM requests: at least 1000 ms on the public host.
pub static OSRM_MIN_INTERVAL_MS: LazyLock<i64> =
    LazyLock::new(|| env_int("KB_OSRM_MIN_INTERVAL_MS", 1100, 250).max(if *PUBLIC_OSRM { 1000 } else { 0 }));
pub static OSRM_USER_AGENT: LazyLock<String> = LazyLock::new(|| env_str("KB_OSRM_USER_AGENT", &USER_AGENT));
/// `KB_GEOCODER_URL` (a Photon API behind /api/geocode), None when `off` or blank.
pub static GEOCODER_URL: LazyLock<Option<String>> = LazyLock::new(|| {
    let v = env_str("KB_GEOCODER_URL", "https://photon.komoot.io/api/");
    let v = v.trim_matches(crate::js::is_space);
    (!v.is_empty() && !v.eq_ignore_ascii_case("off")).then(|| v.to_owned())
});

/// `KB_FOOT_PBF_URL`: the OSM extract the walking paths come from (`backend/src/footpaths.rs`), None when `off`.
pub static FOOT_PBF_URL: LazyLock<Option<String>> = LazyLock::new(|| {
    let v = env_str(
        "KB_FOOT_PBF_URL",
        "https://download.geofabrik.de/europe/poland/slaskie-latest.osm.pbf",
    );
    let v = v.trim_matches(crate::js::is_space);
    (!v.is_empty() && !v.eq_ignore_ascii_case("off")).then(|| v.to_owned())
});

/// `KB_TOMTOM_KEY`: a TomTom API key for /api/traffic, None (route off) when unset or blank.
pub static TOMTOM_KEY: LazyLock<Option<String>> = LazyLock::new(|| {
    let v = env_str("KB_TOMTOM_KEY", "");
    let v = v.trim_matches(crate::js::is_space);
    (!v.is_empty()).then(|| v.to_owned())
});

/// Metropolia GZM and the other zbiorkom cities: feeds, positions, SDIP overlay, news.
pub static GZM_GTFS_URL: LazyLock<String> = LazyLock::new(|| {
    env_str(
        "KB_GZM_GTFS_URL",
        "https://api.zbiorkom.live/api6-open/gzm/gtfs/default",
    )
});
pub static GZM_POSITIONS_URL: LazyLock<String> = LazyLock::new(|| {
    env_str(
        "KB_GZM_POSITIONS_URL",
        "https://api.zbiorkom.live/api6-open/gzm/positions/18.3,49.9,19.7,50.7",
    )
});
pub static GZM_SDIP_ENABLED: LazyLock<bool> = LazyLock::new(|| env_int("KB_GZM_SDIP", 1, 0) != 0);
pub static GZM_SDIP_URL: LazyLock<String> =
    LazyLock::new(|| env_str("KB_GZM_SDIP_URL", "https://sdip.transportgzm.pl/vm/main"));
/// None when set to `off` or blank (TS: null or "", both falsy: no GZM announcements).
pub static GZM_NEWS_URL: LazyLock<Option<String>> = LazyLock::new(|| {
    let v = env_str("KB_GZM_NEWS_URL", "https://rj.transportgzm.pl/v2/news/");
    let v = v.trim_matches(crate::js::is_space);
    (!v.is_empty() && !v.eq_ignore_ascii_case("off")).then(|| v.to_owned())
});
pub static FLEET_HISTORY_DAYS: LazyLock<i64> = LazyLock::new(|| env_int("KB_FLEET_HISTORY_DAYS", 365, 1));
pub static GZM_DIR: LazyLock<String> = LazyLock::new(|| env_str("KB_GZM_DIR", &in_output("gzm")));
pub static GZM_FLEET_HISTORY_DAYS: LazyLock<i64> = LazyLock::new(|| env_int("KB_GZM_FLEET_HISTORY_DAYS", 30, 1));
pub static ZB_API_URL: LazyLock<String> = LazyLock::new(|| {
    env_str("KB_ZB_API_URL", "https://api.zbiorkom.live/api6-open")
        .trim_end_matches('/')
        .to_owned()
});
pub static ZB_RESIDENT: LazyLock<i64> = LazyLock::new(|| env_int("KB_ZB_RESIDENT", 2, 1));
pub static ZB_IDLE_MIN: LazyLock<i64> = LazyLock::new(|| env_int("KB_ZB_IDLE_MIN", 30, 1));
