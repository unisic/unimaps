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
