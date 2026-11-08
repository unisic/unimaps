//! lib/shared/fleet.ts: the fleet ("brygady") wire types and the rules both sides agree on (punctuality classes,
//! text folding, line order, the vehicle search). Field order is the key order of the TS object literals that
//! build each shape (lib/fleet-tracker.ts, lib/fleet-history.ts, lib/phototrans.ts).

use std::cmp::Ordering;

use icu_normalizer::DecomposingNormalizerBorrowed;
use serde::{Deserialize, Serialize};

use crate::js::{self, JsNum};
use crate::mzk_fleet::VehicleFeatures;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FleetFuelType {
    Diesel,
    Electric,
    Hydrogen,
    Hybrid,
    Cng,
}

impl FleetFuelType {
    /// The wire name ("diesel", ...) as a variant; None for any other string.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "diesel" => Self::Diesel,
            "electric" => Self::Electric,
            "hydrogen" => Self::Hydrogen,
            "hybrid" => Self::Hybrid,
            "cng" => Self::Cng,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum FleetLengthCategory {
    Mini,
    Midi,
    Maxi,
    Mega,
}

impl FleetLengthCategory {
    /// The wire name ("MINI", ...) as a variant; None for any other string.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "MINI" => Self::Mini,
            "MIDI" => Self::Midi,
            "MAXI" => Self::Maxi,
            "MEGA" => Self::Mega,
            _ => return None,
        })
    }
}

/// `VehicleFeatures` as a fleet card carries it. MZK sets the six flags (`From<VehicleFeatures>`); GZM only its
/// propulsion (`{ electric: true }`) or nothing (`{}`), so every flag is optional here and absent ones stay off the
/// wire. TS reads a flag as truthy: compare with `Some(true)`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetFeatures {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub air_condition: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_floor: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub electric: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydrogen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hybrid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_vehicle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket_machine: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eco_vehicle: Option<bool>,
}

impl From<VehicleFeatures> for FleetFeatures {
    fn from(f: VehicleFeatures) -> Self {
        Self {
            air_condition: Some(f.air_condition),
            low_floor: Some(f.low_floor),
            electric: Some(f.electric),
            hydrogen: Some(f.hydrogen),
            hybrid: Some(f.hybrid),
            long_vehicle: Some(f.long_vehicle),
            ticket_machine: f.ticket_machine,
            eco_vehicle: f.eco_vehicle,
        }
    }
}

/// A phototrans photo: the browser loads `thumb` from phototrans, `page` shows the original.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VehiclePhoto {
    pub thumb: String,
    pub page: String,
    pub author: String,
    /// YYYY-MM-DD, None when phototrans gives none
    pub date: Option<String>,
}

/// Technical data from phototrans that the fleet sources lack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VehicleTech {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gearbox: Option<String>,
    /// door layout, e.g. "2-2-2"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doors: Option<String>,
    /// production year
    #[serde(skip_serializing_if = "Option::is_none")]
    pub built: Option<i64>,
    /// year the operator took the vehicle over
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
    /// the vehicle's phototrans page (source credit)
    pub page: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CourseStopStatus {
    Passed,
    Current,
    Upcoming,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleCourseStop {
    pub symbol: String,
    pub name: String,
    /// HH:MM
    pub scheduled_time: String,
    /// HH:MM
    pub planned_time: String,
    pub status: CourseStopStatus,
    /// metres from the previous stop (OnTime per-segment distance; 0 on the first stop)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance_meters: Option<JsNum>,
}

/// A course's state; a history course is only ever `Completed` or `Cancelled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CourseStatus {
    Completed,
    InProgress,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleCourseRecord {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub course_loid: Option<i64>,
    pub line_name: String,
    pub direction: String,
    pub first_stop_name: String,
    pub last_stop_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_stop_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_stop_symbol: Option<String>,
    /// HH:MM, scheduled
    pub start_time: String,
    /// HH:MM, scheduled
    pub end_time: String,
    /// agency seconds since midnight, scheduled
    pub start_secs: i64,
    pub end_secs: i64,
    /// GZM: the trip's GTFS brigade, shown as "<line>/<brigade>" (MZK publishes none)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brigade: Option<String>,
    /// last observed delay of the course (about the arrival delay for a finished one)
    pub delay_sec: i64,
    pub stops_count: i64,
    pub status: CourseStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled_at_stop_name: Option<String>,
    /// epoch secs when the course left the live feed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    /// planned course length: sum of the per-segment stop distances
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_meters: Option<JsNum>,
    /// metres driven: the whole course once completed, up to the last stop reached when interrupted
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driven_meters: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stops: Option<Vec<VehicleCourseStop>>,
}

/// The running course (TS `FleetCurrentCourse extends VehicleCourseRecord`), in the key order of the tracker's
/// literal; `cancelledReason`, `cancelledAtStopName` and `completedAt` are never set on a live course.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetCurrentCourse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub course_loid: Option<i64>,
    pub line_name: String,
    pub direction: String,
    pub first_stop_name: String,
    pub last_stop_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_stop_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_stop_symbol: Option<String>,
    pub start_time: String,
    pub end_time: String,
    pub start_secs: i64,
    pub end_secs: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brigade: Option<String>,
    /// 0 while `not_started`: never shown or counted then
    pub delay_sec: i64,
    /// waiting at the first stop
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_started: Option<bool>,
    /// standing at `current_stop_name` (OnTime onStopPoint)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_stop: Option<bool>,
    pub stops_count: i64,
    /// index of the last stop served (the first stop while not started)
    pub current_stop_index: i64,
    pub current_stop_name: String,
    pub next_stop_name: Option<String>,
    pub lat: JsNum,
    pub lon: JsNum,
    pub bearing: Option<JsNum>,
    /// epoch s of the GPS fix; last_seen_at is only the poll time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_at: Option<i64>,
    /// by distance driven when OnTime sent stop distances, else by stop index
    pub progress_pct: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_meters: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driven_meters: Option<JsNum>,
    pub status: CourseStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stops: Option<Vec<VehicleCourseStop>>,
}

/// "high" = the GZM brigade schedule, or history that agreed nearly every time
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PredictionConfidence {
    High,
    Medium,
    Low,
}

/// schedule = GZM brigade (GTFS); history = what this course was followed by on past days of the same kind;
/// timetable = the next MZK course from the same terminus; estimate = same line back after a layover
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PredictionSource {
    Schedule,
    History,
    Timetable,
    Estimate,
}

/// history only: the successor on `days` of the `of` past days that ran this course
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PredictionSeen {
    pub days: i64,
    pub of: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedNextCourse {
    pub line_name: String,
    pub direction: String,
    /// HH:MM
    pub departure_time: String,
    /// a JsNum: the MZK timetable's seconds are f64 (`MzkDayCourse::start`)
    pub departure_secs: JsNum,
    pub from_stop_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_stop_symbol: Option<String>,
    /// minutes between the expected arrival and the estimated departure
    pub pause_minutes: i64,
    pub confidence: PredictionConfidence,
    pub source: PredictionSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen: Option<PredictionSeen>,
    pub reason: String,
    /// the courses after this one, same sources, at most 4; absent for an estimate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub later: Option<Vec<PredictedLaterCourse>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedLaterCourse {
    pub line_name: String,
    pub direction: String,
    pub departure_time: String,
    pub from_stop_name: String,
    pub confidence: PredictionConfidence,
}

/// One past course of a vehicle (/api/fleet/<side>/history): the slim record the history keeps.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetHistoryCourse {
    pub line_name: String,
    pub direction: String,
    pub first_stop_name: String,
    pub last_stop_name: String,
    pub start_secs: i64,
    pub end_secs: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brigade: Option<String>,
    pub delay_sec: i64,
    /// `Completed` or `Cancelled`
    pub status: CourseStatus,
    pub driven_meters: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled_at_stop_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FleetHistoryDay {
    /// YYYY-MM-DD, Warsaw
    pub date: String,
    /// by scheduled start
    pub courses: Vec<FleetHistoryCourse>,
}

/// `Default` = the TS `emptyStats()`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetVehicleStats {
    /// courses begun today (finished, interrupted and the running one)
    pub total_courses_today: i64,
    pub completed_courses_today: i64,
    pub cancelled_courses_today: i64,
    /// km driven today, from OnTime stop distances
    pub km_today: JsNum,
    /// courses with a measured delay (completed + the running one once begun)
    pub measured_courses: i64,
    /// signed mean delay of the measured courses (early cancels late)
    pub average_delay_secs: i64,
    /// on-time share of the measured courses; None when none was measured
    pub punctuality_pct: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum FleetOperator {
    Mzk,
    Kb,
    Gzm,
}

/// "active" = in the operator's running list right now
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VehicleStatus {
    Active,
    #[default]
    Depot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastKnownLocation {
    pub lat: JsNum,
    pub lon: JsNum,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetVehicleDetail {
    pub side_number: String,
    pub operator: FleetOperator,
    /// GZM: the printed fleet number (side_number is "<company code>_<fleet number>")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// GZM: the operating company
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    pub model: String,
    pub producer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    /// None = unknown (GZM publishes no equipment data)
    pub length_category: Option<FleetLengthCategory>,
    pub fuel_type: Option<FleetFuelType>,
    pub features: FleetFeatures,
    pub status: VehicleStatus,
    /// lines served today, in order of first service
    pub lines: Vec<String>,
    /// the line with the most courses today (ties: the latest), None before the first course
    pub main_line: Option<String>,
    pub current_course: Option<FleetCurrentCourse>,
    pub predicted_next_course: Option<PredictedNextCourse>,
    /// finished/interrupted courses, newest first
    pub today_courses: Vec<VehicleCourseRecord>,
    /// epoch secs of the last live sighting; 0 = not seen today
    pub last_seen_at: i64,
    pub last_known_location: Option<LastKnownLocation>,
    pub stats: FleetVehicleStats,
    /// from the phototrans index; absent when phototrans has no such vehicle
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tech: Option<VehicleTech>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photos: Option<Vec<VehiclePhoto>>,
}

/// One row of /api/fleet, polled every 10 s for the whole fleet: only what the list and the stats show.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSummaryItem {
    pub side_number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    pub model: String,
    pub producer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    pub length_category: Option<FleetLengthCategory>,
    pub fuel_type: Option<FleetFuelType>,
    pub status: VehicleStatus,
    pub lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brigade: Option<String>,
    /// scheduled departure from the first stop of the current course, HH:MM
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_stop_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_stop_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_stop_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_stop: Option<bool>,
    /// None while the course has not begun (OnTime's delay is a placeholder then)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_sec: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_started: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_pct: Option<i64>,
    pub courses_count_today: i64,
    pub cancelled_courses_today: i64,
    pub km_today: JsNum,
    pub last_seen_at: i64,
    /// line of the latest course, for a vehicle that is not running now
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_line_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetStats {
    pub total_fleet: i64,
    pub active_count: i64,
    pub depot_count: i64,
    /// running vehicles whose course has not begun
    pub waiting_count: i64,
    /// running vehicles with a measured delay
    pub measured_count: i64,
    pub electric_count: i64,
    pub hydrogen_count: i64,
    pub hybrid_count: i64,
    pub mega_count: i64,
    /// signed mean over measured vehicles; 0 when none
    pub average_delay_sec: i64,
    /// None when no vehicle has a measured delay
    pub median_delay_sec: Option<i64>,
    /// 100 when nothing is measured: read it together with measured_count
    pub on_time_percentage: i64,
    pub active_lines: Vec<String>,
    /// vehicles seen in service today (running now or earlier)
    pub seen_today_count: i64,
    pub km_today: JsNum,
    pub courses_completed_today: i64,
    pub courses_cancelled_today: i64,
    /// epoch secs of the last poller update; 0 = none since start
    pub updated_at: i64,
}

/// Snapshot of the running fleet for one 5-minute slot of the day (the last sample in the slot).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetTimelinePoint {
    /// slot start, agency seconds since midnight
    pub t: i64,
    pub waiting: i64,
    pub early: i64,
    pub on_time: i64,
    pub late: i64,
    pub very_late: i64,
}

pub const TIMELINE_SLOT_SECS: i64 = 300;

/// On time = at most 1 min early and at most 3 min late (the usual Polish operator rule).
pub const ON_TIME_MIN_SEC: i64 = -60;
pub const ON_TIME_MAX_SEC: i64 = 180;
pub const VERY_LATE_SEC: i64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelayClass {
    Early,
    OnTime,
    Late,
    VeryLate,
}

pub fn classify_delay(delay_sec: i64) -> DelayClass {
    if delay_sec < ON_TIME_MIN_SEC {
        DelayClass::Early
    } else if delay_sec <= ON_TIME_MAX_SEC {
        DelayClass::OnTime
    } else if delay_sec <= VERY_LATE_SEC {
        DelayClass::Late
    } else {
        DelayClass::VeryLate
    }
}

pub fn is_on_time(delay_sec: i64) -> bool {
    classify_delay(delay_sec) == DelayClass::OnTime
}

pub fn median(values: &[i64]) -> Option<f64> {
    let mut s = values.to_vec();
    s.sort_unstable();
    let mid = s.len() / 2;
    match s.len() {
        0 => None,
        n if n % 2 == 1 => Some(s[mid] as f64),
        _ => Some((s[mid - 1] + s[mid]) as f64 / 2.0),
    }
}

/// Lowercase, diacritics folded (ł included, which NFD leaves alone): "Żywiec" ~ "zywiec".
pub fn fold_text(s: &str) -> String {
    let lower = s.to_lowercase().replace('ł', "l");
    DecomposingNormalizerBorrowed::new_nfd()
        .normalize(&lower)
        .chars()
        .filter(|c| !('\u{300}'..='\u{36F}').contains(c))
        .collect()
}

/// Numeric lines first in numeric order ("2" < "10"), then the rest alphabetically.
pub fn compare_line_names(a: &str, b: &str) -> Ordering {
    let (na, nb) = (js::parse_int(a), js::parse_int(b));
    let (fa, fb) = (na.is_finite(), nb.is_finite());
    if fa && fb && na != nb {
        return na.total_cmp(&nb);
    }
    if fa != fb {
        return if fa { Ordering::Less } else { Ordering::Greater };
    }
    js::compare_pl(a, b)
}

/// Free-text vehicle search: a side number ("#23..." by prefix, or 3+ digits; GZM: the printed label, or the whole
/// "<company>_<fleet>" key), a line number (exact, current or served today: "1" must not list side numbers 100-199),
/// a GZM brigade as printed ("69/1", "69/" for all of line 69), or a folded substring of model, producer, company,
/// direction, stop. A bare number is never a text substring: "1" means line 1, not every "Urbino 12".
pub fn matches_fleet_query(v: &FleetSummaryItem, query: &str) -> bool {
    let q = fold_text(query.trim_matches(js::is_space));
    if q.is_empty() {
        return true;
    }
    let (hash, bare) = match q.strip_prefix('#') {
        Some(rest) => (true, rest.trim_matches(js::is_space)),
        None => (false, q.as_str()),
    };
    // a lone "#" is the start of a side number being typed: keep the list until a digit narrows it
    if hash && bare.is_empty() {
        return true;
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if digits(bare) && (hash || bare.len() >= 3) && v.label.as_deref().unwrap_or(&v.side_number).starts_with(bare) {
        return true;
    }
    // MZK side numbers are digits only: a "_" query can only be a GZM key
    if bare.contains('_') && v.side_number.starts_with(bare) {
        return true;
    }
    if hash {
        return false;
    }
    let line = v.line_name.as_deref().filter(|l| !l.is_empty());
    if line.is_some_and(|l| fold_text(l) == q) || v.lines.iter().any(|l| fold_text(l) == q) {
        return true;
    }
    if let (Some(b), Some(l)) = (v.brigade.as_deref().filter(|b| !b.is_empty()), line)
        && q.contains('/')
        && fold_text(&format!("{l}/{b}")).starts_with(&q)
    {
        return true;
    }
    if digits(&q) {
        return false;
    }
    [
        Some(v.model.as_str()),
        Some(v.producer.as_str()),
        v.company.as_deref(),
        v.direction.as_deref(),
        v.current_stop_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|f| !f.is_empty() && fold_text(f).contains(&q))
}
