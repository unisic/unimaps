//! lib/gtfs-trips.ts: KB trip -> line + headsign from the built feed's trips.txt. Upstream's stop timetable carries
//! only trip ids, so without it every KB row costs an upstream /api/trip fetch. No feed = an empty map.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::config;
use crate::gtfs_csv::{FeedCache, col, field, read_text, table};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GtfsTripMeta {
    /// rider-facing line number, e.g. "115"
    pub line: String,
    /// trip_headsign as upstream spells it, e.g. "BIELSKO-BIAŁA D.A."
    pub headsign: String,
}

/// `readGtfsTrips`: upstream trip id -> line + headsign of the feed in `dir`; empty while its trips.txt is missing.
pub fn read_gtfs_trips(dir: &Path) -> HashMap<String, GtfsTripMeta> {
    let mut out = HashMap::new();
    let Some(text) = read_text(&dir.join("trips.txt")) else {
        return out;
    };
    let (h, rows) = table(&text);
    let Some(i_trip) = col(&h, "trip_id") else {
        return out;
    };
    let [i_svc, i_route, i_head, i_short] =
        ["service_id", "route_id", "trip_headsign", "trip_short_name"].map(|n| col(&h, n));
    for f in &rows {
        let Some(mut id) = field(f, Some(i_trip)).filter(|s| !s.is_empty()) else {
            continue;
        };
        // the builder suffixes a trip that runs under several calendars: "<upstream id>_<service_id>"
        if let Some(svc) = field(f, i_svc).filter(|s| !s.is_empty()) {
            id = id.strip_suffix(svc).and_then(|s| s.strip_suffix('_')).unwrap_or(id);
        }
        if out.contains_key(id) {
            continue;
        }
        let route = field(f, i_route).unwrap_or("");
        let line = field(f, i_short)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| route.strip_prefix("L_").unwrap_or(route));
        if line.is_empty() {
            continue;
        }
        let headsign = field(f, i_head).unwrap_or("").into();
        out.insert(
            id.into(),
            GtfsTripMeta {
                line: line.into(),
                headsign,
            },
        );
    }
    out
}

static CACHE: FeedCache<HashMap<String, GtfsTripMeta>> = FeedCache::new();

/// `gtfsTripMeta`: line + headsign of an upstream KB trip id; None when the feed doesn't know it (new trip, no feed).
pub fn gtfs_trip_meta(trip_id: &str) -> Option<GtfsTripMeta> {
    CACHE
        .get(|| read_gtfs_trips(Path::new(config::GTFS_DIR.as_str())))
        .get(trip_id)
        .cloned()
}

/// Drops the map after a GTFS rebuild so the next read sees the new feed.
pub fn invalidate_gtfs_trips() {
    CACHE.invalidate();
}
