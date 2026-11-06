//! lib/mzk-timetable.ts: the file the router reads (`loadMzkTimetable`). The builder and the day schedule of the
//! next-course prediction come with the MZK poller.

use std::path::Path;

use indexmap::IndexMap;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MzkTimetableTrip {
    /// `mzk:<course>:<variant>`
    pub id: String,
    pub line: String,
    pub headsign: String,
    pub day_type: String,
    /// (stop symbol, secs from the service day's midnight) in stop order
    pub calls: Vec<(String, f64)>,
}

#[derive(Deserialize)]
pub struct MzkTimetableFile {
    v: f64,
    /// Warsaw ISO date -> OnTime day type
    pub calendar: IndexMap<String, String>,
    /// symbol -> (name, lat, lon), in `Object.entries` order
    pub stops: IndexMap<String, (String, f64, f64)>,
    pub trips: Vec<MzkTimetableTrip>,
}

/// None when the file is missing (quietly) or not a v1 timetable (with a warning). A malformed trip or stop rejects
/// the whole file here, where the TS took it and misbehaved later.
pub fn load_mzk_timetable(file: &Path) -> Option<MzkTimetableFile> {
    let raw = std::fs::read(file).ok()?;
    let parsed = serde_json::from_slice::<MzkTimetableFile>(&raw)
        .map_err(|e| e.to_string())
        .and_then(|tt| {
            if tt.v == 1.0 {
                Ok(tt)
            } else {
                Err("Error: not a v1 timetable".into())
            }
        });
    match parsed {
        Ok(mut tt) => {
            crate::js::sort_object_keys(&mut tt.stops);
            Some(tt)
        }
        Err(e) => {
            crate::logger::warn("mzk-tt", format!("ignoring {}: {e}", file.display()));
            None
        }
    }
}
