//! lib/shared/cities.ts: the zbiorkom city registry, read from the same lib/shared/cities.json.

use std::sync::LazyLock;

use serde::Deserialize;

/// The fields the server reads; the client's colours and map view stay in the JSON only.
#[derive(Debug, Deserialize)]
pub struct ZbCity {
    pub name: String,
}

/// Every slug in the file's order (gzm first), as `ZB_SLUGS`.
pub static ZB_CITIES: LazyLock<Vec<(String, ZbCity)>> = LazyLock::new(|| {
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(include_str!("../../../lib/shared/cities.json")).expect("lib/shared/cities.json");
    map.into_iter()
        .map(|(slug, v)| {
            let city = serde_json::from_value(v).unwrap_or_else(|e| panic!("cities.json {slug}: {e}"));
            (slug, city)
        })
        .collect()
});

pub fn zb_city(slug: &str) -> Option<&'static ZbCity> {
    ZB_CITIES.iter().find(|(s, _)| s == slug).map(|(_, c)| c)
}

/// `v` as the registry's own slug, None when it is not one.
pub fn zb_slug(v: &str) -> Option<&'static str> {
    ZB_CITIES.iter().find(|(s, _)| s == v).map(|(s, _)| s.as_str())
}

pub fn is_zb_slug(v: &str) -> bool {
    zb_slug(v).is_some()
}

/// The zbiorkom city of a prefixed id ("krakow:1234", "gzm:283_4285"); None for a BB id (kb:, mzk:, plain).
pub fn zb_city_of(id: &str) -> Option<&'static str> {
    zb_slug(id.split_once(':')?.0)
}
