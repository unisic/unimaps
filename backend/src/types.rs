//! lib/types.ts: the BB upstream and wire types. `VehiclePos` lives in `crate::vehicle`, `WireStop` and `Operator` in
//! `crate::stop_merge`; the loosely typed upstream records (`DepartureRow`, `TripExecutionResponse`...) are plain
//! [`UpstreamRecord`]s read field by field.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::js::JsNum;
use crate::stop_merge::{Operator, WireStop};

/// A generic upstream JSON object we only loosely trust.
pub type UpstreamRecord = Map<String, Value>;

/// A stop of GET /stops?rev=... positional arrays (KB) or of OnTime's list (MZK).
// ponytail: `operators`, `kbId`, `mzkId`, `kbDesignator`, `mzkDesignator`, `mzkSymbol` and `dirs` of the TS
// interface are left out: no producer sets them on a Stop (the merged view carries them on `WireStop`)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stop {
    /// field[0]: designator string used in URLs, e.g. "19223" or "19132:39688"
    pub url_id: String,
    /// field[1]: clean numeric id, e.g. 20111
    pub internal_id: i64,
    pub name: String,
    /// field[3] / 1e6
    pub lon: f64,
    /// field[4] / 1e6
    pub lat: f64,
    pub only_disembarking: bool,
    pub is_station: bool,
    pub show_platforms: bool,
    /// `String(internalId)` (KB) or "mzk:<symbol>" (MZK)
    pub stop_id: String,
    pub operator: Option<Operator>,
    pub symbol: Option<String>,
    pub on_request: Option<bool>,
    pub getting_out: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LineInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator: Option<Operator>,
}

/// One entry of a trip's "times" array.
#[derive(Debug, Clone, PartialEq)]
pub struct TripStop {
    pub stop_name: String,
    /// internal id
    pub designator: Option<i64>,
    /// url designator
    pub place_id: Option<String>,
    /// "HH:MM"
    pub departure_time: String,
    pub index: i64,
    pub platform: Option<String>,
}

/// A parsed trip detail.
// ponytail: the TS `operator?` is left out, parseTrip never sets it
#[derive(Debug, Clone, PartialEq)]
pub struct Trip {
    pub trip_id: String,
    pub times: Vec<TripStop>,
    pub direction: String,
    pub line_name: String,
    pub line_type: Option<String>,
    pub show_name: bool,
    pub vehicle_type: Option<i64>,
    pub current_station_id: Option<i64>,
}

/// GET /api/vehicles response; `vehicles` are `vehicle_to_json` maps (plus the route extras).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct VehiclesResponse {
    pub timestamp: JsNum,
    pub scan_count: u64,
    pub last_scan: JsNum,
    pub count: usize,
    pub vehicles: Vec<Map<String, Value>>,
}

/// GET /api/stops response.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StopsResponse {
    pub count: usize,
    pub stops: Vec<WireStop>,
    /// Some(true) while one operator's stop list is still missing (the client re-fetches soon)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
}
