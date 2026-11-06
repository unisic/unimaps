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

/// `envInt`: `Math.trunc(Number(v.trim()))`, the default when unset, empty, not finite or below `min`. One gap:
/// `Number` also reads "0x10" as 16, here it is the default.
pub fn env_int(name: &str, def: i64, min: i64) -> i64 {
    let Ok(v) = std::env::var(name) else { return def };
    match v.trim_matches(crate::js::is_space).parse::<f64>() {
        Ok(n) if n.is_finite() && n.trunc() >= min as f64 => n.trunc() as i64,
        _ => def,
    }
}

pub static AGENCY_TIMEZONE: LazyLock<String> = LazyLock::new(|| env_str("KB_AGENCY_TIMEZONE", "Europe/Warsaw"));
pub static RATE_LIMIT_GLOBAL: LazyLock<i64> = LazyLock::new(|| env_int("KB_RATE_LIMIT_GLOBAL", 500, 1));
pub static GZM_ENABLED: LazyLock<bool> = LazyLock::new(|| env_int("KB_GZM", 1, 0) != 0);
pub static ZB_ENABLED: LazyLock<bool> = LazyLock::new(|| env_int("KB_ZB", 1, 0) != 0);
