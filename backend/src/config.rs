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

pub static AGENCY_TIMEZONE: LazyLock<String> = LazyLock::new(|| env_str("KB_AGENCY_TIMEZONE", "Europe/Warsaw"));
pub static RATE_LIMIT_GLOBAL: LazyLock<i64> = LazyLock::new(|| env_int("KB_RATE_LIMIT_GLOBAL", 500, 1));
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

/// Web push: the VAPID pair and pending alerts; the subject is the contact push services see (mailto: or https:).
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
/// Minimum spacing between OSRM requests, at least 1000 ms on the public host.
pub static OSRM_MIN_INTERVAL_MS: LazyLock<i64> =
    LazyLock::new(|| env_int("KB_OSRM_MIN_INTERVAL_MS", 1100, 250).max(if *PUBLIC_OSRM { 1000 } else { 0 }));
pub static OSRM_USER_AGENT: LazyLock<String> = LazyLock::new(|| env_str("KB_OSRM_USER_AGENT", &USER_AGENT));

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
