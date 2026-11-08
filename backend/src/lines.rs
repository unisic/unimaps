//! lib/lines.ts: the static line catalog from the built feed's routes.txt, so the search also lists lines with no
//! vehicle running. No feed = an empty catalog, never an error.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use crate::config;
use crate::gtfs_csv::{FeedCache, col, field, read_text, table};
use crate::js::compare_pl_numeric;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LineInfo {
    /// GTFS route_id, e.g. "L_102"
    pub id: String,
    /// rider-facing line number, e.g. "102"
    pub name: String,
    /// route_long_name, the terminus, e.g. "KANIÓW"
    pub terminus: String,
}

/// `readLines`: the catalog of the feed in `dir`, sorted by line number; empty while its routes.txt is missing.
pub fn read_lines(dir: &Path) -> Vec<LineInfo> {
    let Some(text) = read_text(&dir.join("routes.txt")) else {
        return Vec::new();
    };
    let (h, rows) = table(&text);
    let (Some(i_id), Some(i_name)) = (col(&h, "route_id"), col(&h, "route_short_name")) else {
        return Vec::new();
    };
    let i_long = col(&h, "route_long_name");
    let mut out: Vec<LineInfo> = rows
        .iter()
        .filter_map(|f| {
            let id = field(f, Some(i_id)).filter(|s| !s.is_empty())?;
            let name = field(f, Some(i_name)).filter(|s| !s.is_empty())?;
            Some(LineInfo {
                id: id.into(),
                name: name.into(),
                terminus: field(f, i_long).unwrap_or("").into(),
            })
        })
        .collect();
    out.sort_by(|a, b| compare_pl_numeric(&a.name, &b.name));
    out
}

static CACHE: FeedCache<Vec<LineInfo>> = FeedCache::new();

/// `getLines`: the catalog of `KB_GTFS_DIR`, read once and kept until `invalidate_lines`.
pub fn get_lines() -> Arc<Vec<LineInfo>> {
    CACHE.get(|| read_lines(Path::new(config::GTFS_DIR.as_str())))
}

/// Drops the catalog after a GTFS rebuild so the next read sees the new feed.
pub fn invalidate_lines() {
    CACHE.invalidate();
}
