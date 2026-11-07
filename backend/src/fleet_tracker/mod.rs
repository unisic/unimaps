//! Vehicle fleet tracker ("brygady", lib/fleet-tracker.ts) for MZK Bielsko-Biała and, constructed with GZM options
//! by `gzm_fleet`, for Metropolia GZM.
//!
//! Fed by the poller with the running vehicles; keeps per vehicle the course it runs now and the courses it finished
//! or broke off today, plus a 5-minute punctuality timeline of the running fleet. Persisted per day to
//! `<history dir>/fleet-history-<YYYY-MM-DD>.json` so a restart keeps the day.

mod update;
mod views;

pub use views::{FleetSighting, FleetSummaryFilter, FleetVehicleHistory};

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::runtime::{Handle, RuntimeFlavor};

use crate::config::{FLEET_HISTORY_DAYS, OUTPUT_DIR};
use crate::fleet_history::{self, FleetHistory, file_day, minus_days};
use crate::gzm::{GzmNextTrip, NowFn};
use crate::js;
use crate::logger;
use crate::mzk_fleet::{VehicleFleetInfo, all_fleet_vehicles, fleet_details};
use crate::mzk_state::MzkLifecycleInput;
use crate::mzk_timetable::{MzkDaySchedule, mzk_day_schedule};
use crate::shared::fleet::{
    CourseStatus, CourseStopStatus, FleetCurrentCourse, FleetFeatures, FleetFuelType, FleetLengthCategory,
    FleetOperator, FleetTimelinePoint, FleetVehicleDetail, FleetVehicleStats, LastKnownLocation, VehicleCourseRecord,
    VehicleCourseStop, VehicleStatus,
};
use crate::time::agency_clock;

/// One stop of a running course as the tracker reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FleetStopPoint {
    pub symbol: String,
    pub name: String,
    /// metres from the previous stop (NaN when the record has none)
    pub distance: f64,
    /// epoch ms (MZK); 0 for GZM, whose schedule is `stop_secs`
    pub scheduled_departure: f64,
    /// epoch ms, 0 = none
    pub planned_departure: f64,
}

/// What the tracker reads of a running vehicle (TS `FleetRunningInput`): an OnTime record (MZK) or the GZM feed's
/// equivalent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FleetRunningInput {
    pub vehicle_id: String,
    pub line_name: String,
    pub course_loid: i64,
    pub direction: String,
    pub optional_direction: Option<String>,
    pub delay_sec: f64,
    pub latitude: f64,
    pub longitude: f64,
    pub angle: Option<f64>,
    /// epoch ms of the GPS fix (OnTime lastPingDate)
    pub last_ping_date: Option<f64>,
    pub reached_meters: Option<f64>,
    /// `Boolean(onStopPoint)` of the record
    pub on_stop_point: bool,
    pub stop_points: Vec<FleetStopPoint>,
    /// MZK: `MzkLifecycleInput::from_json` of the raw record, read only while `not_started` is None
    pub lifecycle: MzkLifecycleInput,
    /// GZM: the feed's verdict (skips `is_mzk_not_started`)
    pub not_started: Option<bool>,
    /// index in `stop_points` of the last stop served / of the next one: GZM the feed's, MZK `mzk_stop_indices` of
    /// the raw record
    pub served_idx: Option<usize>,
    pub next_idx: Option<usize>,
    /// GZM: scheduled departure per stop point, service-day seconds (may exceed 86 400)
    pub stop_secs: Option<Vec<i64>>,
    pub brigade: Option<String>,
    /// GZM: the brigade's next scheduled trips in order (at most 5); empty = none given
    pub next_trips: Vec<GzmNextTrip>,
    /// naming read by the details source of a tracker without a static fleet
    pub label: Option<String>,
    pub model: Option<String>,
    pub company: Option<String>,
}

/// What the tracker knows of a vehicle besides its day: the static fleet entry or the details source. Serializes
/// like the TS `infoOf` literal.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetVehicleInfo {
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
    pub features: FleetFeatures,
}

impl From<VehicleFleetInfo> for FleetVehicleInfo {
    fn from(f: VehicleFleetInfo) -> Self {
        Self {
            length_category: FleetLengthCategory::parse(&f.length_category),
            fuel_type: FleetFuelType::parse(&f.fuel_type),
            side_number: f.side_number,
            label: None,
            company: None,
            model: f.model,
            producer: f.producer,
            year: f.year,
            features: f.features.into(),
        }
    }
}

impl FleetVehicleInfo {
    /// A saved `info` (no static fleet) as `{ ...info, sideNumber: side, features: info.features ?? {} }`; None
    /// unless `model` is a string. Mistyped fields read as absent.
    fn from_saved(info: &Value, side: &str) -> Option<Self> {
        let s = |k: &str| info.get(k).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            side_number: side.to_owned(),
            label: s("label"),
            company: s("company"),
            model: s("model")?,
            producer: s("producer").unwrap_or_default(),
            year: s("year"),
            length_category: info
                .get("lengthCategory")
                .and_then(Value::as_str)
                .and_then(FleetLengthCategory::parse),
            fuel_type: info
                .get("fuelType")
                .and_then(Value::as_str)
                .and_then(FleetFuelType::parse),
            features: info
                .get("features")
                .and_then(|f| FleetFeatures::deserialize(f).ok())
                .unwrap_or_default(),
        })
    }
}

pub type StaticFleetFn = Arc<dyn Fn() -> Vec<FleetVehicleInfo> + Send + Sync>;
/// (running vehicle, OnTime's static vehicle record) -> what the tracker shows of it
pub type DetailsFn = Arc<dyn Fn(&FleetRunningInput, Option<&Value>) -> FleetVehicleInfo + Send + Sync>;
pub type RestoreInfoFn = Arc<dyn Fn(FleetVehicleInfo) -> FleetVehicleInfo + Send + Sync>;
pub type ScheduleFn = Arc<dyn Fn(&str) -> Option<Arc<MzkDaySchedule>> + Send + Sync>;

/// Defaults reproduce the MZK tracker exactly.
#[derive(Clone)]
pub struct FleetTrackerOptions {
    /// None = memory only
    pub history_dir: Option<PathBuf>,
    pub operator: FleetOperator,
    pub keep_days: i64,
    pub save_debounce_ms: i64,
    /// None = no official list: vehicles come from the details source and the saved `info`
    pub static_fleet: Option<StaticFleetFn>,
    pub details: DetailsFn,
    /// fills what a saved `info` lacks after a restart (GZM); default identity
    pub restore_info: RestoreInfoFn,
    /// keep each finished course's stop list
    pub archive_stops: bool,
    /// past days kept in memory (capped by keep_days)
    pub history_days: i64,
    /// the MZK day timetable: turns on the successor index of the next-course prediction
    pub schedule: Option<ScheduleFn>,
    /// epoch ms; every `Date.now()` of the TS
    pub now: NowFn,
}

impl Default for FleetTrackerOptions {
    fn default() -> Self {
        Self {
            history_dir: Some(PathBuf::from(&*OUTPUT_DIR)),
            operator: FleetOperator::Mzk,
            keep_days: *FLEET_HISTORY_DAYS,
            save_debounce_ms: SAVE_DEBOUNCE_MS,
            static_fleet: Some(Arc::new(|| all_fleet_vehicles().into_iter().map(Into::into).collect())),
            details: Arc::new(|v, static_info| fleet_details(&v.vehicle_id, static_info).into()),
            restore_info: Arc::new(|info| info),
            archive_stops: true,
            history_days: 28,
            schedule: None,
            now: Arc::new(|| Timestamp::now().as_millisecond()),
        }
    }
}

fn secs_to_hhmm(s: f64) -> String {
    if !s.is_finite() {
        return "NaN:NaN".to_owned();
    }
    let norm = day_secs(s);
    format!("{:02}:{:02}", norm / 3600, norm % 3600 / 60)
}

/// Seconds since the agency midnight at an epoch-ms instant; 0 for 0 or NaN.
fn date_to_agency_secs(ms: f64) -> i64 {
    if ms == 0.0 || ms.is_nan() {
        return 0;
    }
    // ponytail: past Date's range (|ms| > 8.64e15) the TS yields NaN, 0 here; OnTime instants never get there.
    Timestamp::from_millisecond(ms.trunc() as i64).map_or(0, |ts| i64::from(agency_clock(ts).1))
}

/// The agency date (YYYY-MM-DD) at an epoch-ms instant.
fn today_key(now_ms: i64) -> String {
    Timestamp::from_millisecond(now_ms)
        .map(|ts| agency_clock(ts).0.to_string())
        .unwrap_or_default()
}

/// Service-day seconds (GTFS, may exceed 86 400) as seconds since the agency midnight, like `date_to_agency_secs`.
fn day_secs(s: f64) -> i64 {
    (s.floor() as i64).rem_euclid(86_400)
}

/// GZM keys "<company code>_<fleet number>" in (company, fleet) numeric order; malformed keys by text.
fn compare_gzm_sides(a: &str, b: &str) -> Ordering {
    let parts = |s: &str| {
        let mut it = s.split('_').map(js::parse_int);
        (it.next().unwrap_or(f64::NAN), it.next().unwrap_or(f64::NAN))
    };
    let ((ao, af), (bo, bf)) = (parts(a), parts(b));
    for d in [ao - bo, af - bf] {
        if d != 0.0 && !d.is_nan() {
            return if d < 0.0 { Ordering::Less } else { Ordering::Greater };
        }
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

fn finite_non_neg(x: Option<f64>) -> Option<f64> {
    x.filter(|v| v.is_finite() && *v >= 0.0)
}

/// Courses newest first: by scheduled start, then end, descending.
pub fn sort_courses_desc(a: &VehicleCourseRecord, b: &VehicleCourseRecord) -> Ordering {
    b.start_secs
        .cmp(&a.start_secs)
        .then(b.end_secs.cmp(&a.end_secs))
        .then_with(|| js::compare_pl(&b.start_time, &a.start_time))
}

/// A course this close to its planned length (OnTime's reachedMeters) counts as run to the end.
const END_SLACK_M: f64 = 300.0;

/// What `determine_course_outcome` reads of a course.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CourseOutcomeInput<'a> {
    pub current_stop_index: i64,
    pub stops_count: i64,
    pub delay_sec: i64,
    pub current_stop_name: &'a str,
    pub length_meters: Option<f64>,
    pub driven_meters: Option<f64>,
    /// the bus moved straight on to another course
    pub switched: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CourseOutcome {
    /// Completed or Cancelled
    pub status: CourseStatus,
    pub cancelled_reason: Option<String>,
    pub cancelled_at_stop_name: Option<String>,
}

/// Whether a course that left the live feed ran to the end or was broken off: leaving before its last leg (and more
/// than END_SLACK_M short of its length) while 10+ min late is an interruption.
pub fn determine_course_outcome(course: &CourseOutcomeInput<'_>) -> CourseOutcome {
    let completed = CourseOutcome {
        status: CourseStatus::Completed,
        cancelled_reason: None,
        cancelled_at_stop_name: None,
    };
    if course.stops_count <= 1 {
        return completed;
    }
    let on_last_leg = course.current_stop_index >= course.stops_count - 2;
    let length = course.length_meters.unwrap_or(0.0);
    let near_end = length > 0.0 && length - course.driven_meters.unwrap_or(0.0) <= END_SLACK_M;
    if on_last_leg || near_end || course.delay_sec < 10 * 60 {
        return completed;
    }
    let mins = js::number_to_string(js::round(course.delay_sec as f64 / 60.0));
    let name = course.current_stop_name;
    CourseOutcome {
        status: CourseStatus::Cancelled,
        cancelled_reason: Some(if course.switched {
            format!("Kurs skrócony: pojazd przeszedł na kolejny kurs po przystanku {name} przy opóźnieniu +{mins} min")
        } else {
            format!(
                "Kurs przerwany: pojazd zniknął z systemu na przystanku {name} przy opóźnieniu +{mins} min (awaria, utrata GPS lub zjazd)"
            )
        }),
        cancelled_at_stop_name: Some(name.to_owned()),
    }
}

/// Index of the stop with status "current"; -1 when none (or no stop list).
fn current_stop_index(stops: Option<&[VehicleCourseStop]>) -> i64 {
    stops
        .and_then(|st| st.iter().position(|s| s.status == CourseStopStatus::Current))
        .map_or(-1, |i| i as i64)
}

/// A saved "cancelled" course judged again under today's rule: files written before 2026-10-19 flag late arrivals.
fn rejudge_cancelled(c: VehicleCourseRecord) -> VehicleCourseRecord {
    if c.status != CourseStatus::Cancelled {
        return c;
    }
    let outcome = determine_course_outcome(&CourseOutcomeInput {
        current_stop_index: current_stop_index(c.stops.as_deref()),
        stops_count: c.stops_count,
        delay_sec: c.delay_sec,
        current_stop_name: c.cancelled_at_stop_name.as_deref().unwrap_or(""),
        length_meters: c.length_meters.map(|x| x.0),
        driven_meters: c.driven_meters.map(|x| x.0),
        switched: false,
    });
    if outcome.status == CourseStatus::Cancelled {
        return c;
    }
    // ponytail: a record without drivenMeters gets it in struct order, the TS spread appends it after `stops`;
    // only files from before drivenMeters existed have such records.
    VehicleCourseRecord {
        status: CourseStatus::Completed,
        cancelled_reason: None,
        cancelled_at_stop_name: None,
        driven_meters: c.length_meters,
        ..c
    }
}

/// Planned length of a course: the sum of the per-segment stop distances, up to `upto` (inclusive) when given.
fn stops_length_meters(stops: Option<&[VehicleCourseStop]>, upto: Option<i64>) -> f64 {
    let Some(stops) = stops else {
        return 0.0;
    };
    let n = stops.len() as i64;
    let last = upto.map_or(n - 1, |u| u.min(n - 1));
    stops
        .iter()
        .take(usize::try_from(last + 1).unwrap_or(0))
        .map(|s| finite_non_neg(s.distance_meters.map(|d| d.0)).unwrap_or(0.0))
        .sum()
}

/// Metres driven on a finished course (records saved before drivenMeters existed fall back to the stop list).
pub fn course_driven_meters(c: &VehicleCourseRecord) -> f64 {
    if let Some(d) = finite_non_neg(c.driven_meters.map(|d| d.0)) {
        return d;
    }
    if c.status == CourseStatus::Completed {
        return finite_non_neg(c.length_meters.map(|d| d.0))
            .unwrap_or_else(|| stops_length_meters(c.stops.as_deref(), None));
    }
    let reached = current_stop_index(c.stops.as_deref());
    if reached >= 0 {
        stops_length_meters(c.stops.as_deref(), Some(reached))
    } else {
        0.0
    }
}

/// Typical turnaround at a terminus when this vehicle has not shown its own yet.
const DEFAULT_LAYOVER_MIN: i64 = 8;
/// A late bus still stands this long at the terminus before it leaves again.
const MIN_LAYOVER_SEC: i64 = 3 * 60;
/// Course gaps longer than this are a break or duty change, not a layover.
const MAX_LAYOVER_SEC: i64 = 45 * 60;
/// A persisted live course is resumed after a restart only when it was seen this recently.
const RESUME_LIVE_MAX_AGE_SEC: i64 = 10 * 60;
const SAVE_DEBOUNCE_MS: i64 = 30_000;
const HISTORY_FORMAT: i64 = 2;
/// a pause below minus half a day is a departure after midnight
const HALF_DAY_SEC: i64 = 43_200;

/// The vehicle tracker: a cheap handle, every method locks the state briefly.
#[derive(Clone)]
pub struct FleetTracker {
    state: Arc<Mutex<TrackerState>>,
}

struct TrackerState {
    /// the save timer's way back to this state
    me: Weak<Mutex<TrackerState>>,
    opts: FleetTrackerOptions,
    /// by side number, in first-seen order (JS Map)
    vehicles: IndexMap<String, FleetVehicleDetail>,
    /// side numbers whose features were refreshed from OnTime's getVehicles.json today
    live_features: HashSet<String>,
    /// by slot start, agency seconds (at most 288 a day)
    timeline: BTreeMap<i64, FleetTimelinePoint>,
    /// epoch secs of the last update
    updated_at: i64,
    /// epoch ms of the last save
    last_save_at: i64,
    /// id of the armed debounced save, None = nothing pending
    save_pending: Option<u64>,
    save_seq: u64,
    current_day: String,
    /// bumped on every update and day rollover: a cached rendering of this tracker is fresh while it matches
    version: u64,
    history: FleetHistory,
}

fn lock(m: &Mutex<TrackerState>) -> MutexGuard<'_, TrackerState> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs blocking file IO: through `block_in_place` on a multi-thread runtime, so the worker's other tasks move off
/// it; directly elsewhere (no runtime, a blocking-pool thread, a current-thread runtime).
pub(crate) fn blocking_io<R>(f: impl FnOnce() -> R) -> R {
    match Handle::try_current() {
        Ok(h) if h.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

/// Write-then-rename: a crash mid-write must not leave a torn file that loses the whole day.
fn write_file(file: &Path, body: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, file)
}

/// One top-level value of a day file.
#[derive(Serialize)]
#[serde(untagged)]
enum SavedEntry<'a> {
    Format(i64),
    Timeline(Vec<&'a FleetTimelinePoint>),
    Vehicle(SavedVehicle<'a>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedVehicle<'a> {
    /// only without a static fleet (GZM): what recreates the vehicle after a restart
    #[serde(skip_serializing_if = "Option::is_none")]
    info: Option<FleetVehicleInfo>,
    today_courses: &'a [VehicleCourseRecord],
    current_course: Option<&'a FleetCurrentCourse>,
    last_seen_at: i64,
    last_known_location: Option<&'a LastKnownLocation>,
}

fn info_of(v: &FleetVehicleDetail) -> FleetVehicleInfo {
    FleetVehicleInfo {
        side_number: v.side_number.clone(),
        label: v.label.clone(),
        company: v.company.clone(),
        model: v.model.clone(),
        producer: v.producer.clone(),
        year: v.year.clone(),
        length_category: v.length_category,
        fuel_type: v.fuel_type,
        features: v.features.clone(),
    }
}

impl FleetTracker {
    pub fn new(mut opts: FleetTrackerOptions) -> Self {
        opts.history_dir = opts.history_dir.filter(|d| !d.as_os_str().is_empty());
        let current_day = today_key((opts.now)());
        let mut history = FleetHistory::new(opts.keep_days.min(opts.history_days), opts.schedule.is_some());
        history.set_today(&current_day);
        let rt = Handle::try_current().ok();
        if rt.is_none()
            && let Some(dir) = &opts.history_dir
        {
            history.load_sync(dir, rejudge_cancelled);
        }
        let dir = opts.history_dir.clone();
        let state = Arc::new_cyclic(|me| {
            Mutex::new(TrackerState {
                me: me.clone(),
                opts,
                vehicles: IndexMap::new(),
                live_features: HashSet::new(),
                timeline: BTreeMap::new(),
                updated_at: 0,
                last_save_at: 0,
                save_pending: None,
                save_seq: 0,
                current_day,
                version: 0,
                history,
            })
        });
        if let (Some(rt), Some(dir)) = (rt, dir) {
            let w = Arc::downgrade(&state);
            rt.spawn(fleet_history::load_async(dir, rejudge_cancelled, move |f| {
                let Some(s) = w.upgrade() else {
                    return false;
                };
                f(&mut lock(&s).history);
                true
            }));
        }
        {
            let mut s = lock(&state);
            s.init_from_static_fleet();
            s.load_history_from_disk();
        }
        Self { state }
    }

    fn lock(&self) -> MutexGuard<'_, TrackerState> {
        lock(&self.state)
    }

    /// The same tracker (one state), not merely an equal one: what a cache keyed on the tracker compares.
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    /// Bumped on every update and day rollover.
    pub fn version(&self) -> u64 {
        self.lock().version
    }

    /// Writes a pending debounced save now (graceful shutdown); a no-op when nothing is pending.
    pub fn flush_sync(&self) {
        let mut s = self.lock();
        if s.save_pending.take().is_some() {
            s.save_history_to_disk();
        }
    }
}

impl TrackerState {
    fn now_ms(&self) -> i64 {
        (self.opts.now)()
    }

    /// (Re)starts the day: every official fleet vehicle, idle. Vehicles that appeared only live are dropped and come
    /// back when they run again.
    fn init_from_static_fleet(&mut self) {
        self.vehicles.clear();
        self.live_features.clear();
        self.timeline.clear();
        let fleet = self.opts.static_fleet.as_ref().map(|f| f()).unwrap_or_default();
        for f in fleet {
            let side = f.side_number.clone();
            let v = self.new_vehicle(f);
            self.vehicles.insert(side, v);
        }
    }

    fn new_vehicle(&self, f: FleetVehicleInfo) -> FleetVehicleDetail {
        FleetVehicleDetail {
            side_number: f.side_number,
            operator: self.opts.operator,
            label: f.label,
            company: f.company,
            model: f.model,
            producer: f.producer,
            year: f.year,
            length_category: f.length_category,
            fuel_type: f.fuel_type,
            features: f.features,
            status: VehicleStatus::Depot,
            lines: Vec::new(),
            main_line: None,
            current_course: None,
            predicted_next_course: None,
            today_courses: Vec::new(),
            last_seen_at: 0,
            last_known_location: None,
            stats: FleetVehicleStats::default(),
            tech: None,
            photos: None,
        }
    }

    fn roll_over(&mut self, today: &str) {
        // the old day's last ~30 s would otherwise be lost (the pending save would land in the new file)
        self.save_pending = None;
        self.save_history_to_disk();
        let ended = std::mem::replace(&mut self.current_day, today.to_owned());
        self.version += 1;
        self.history.set_today(today);
        self.history.add_day(
            &ended,
            self.vehicles
                .iter()
                .map(|(side, v)| (side.as_str(), v.today_courses.as_slice())),
        );
        self.init_from_static_fleet();
        self.load_history_from_disk();
        self.prune_history();
    }

    /// Deletes day files older than keep_days (exact name pattern only), once per rollover.
    fn prune_history(&self) {
        let Some(dir) = &self.opts.history_dir else {
            return;
        };
        let cutoff = minus_days(&self.current_day, self.opts.keep_days);
        let res = blocking_io(|| -> std::io::Result<()> {
            for e in std::fs::read_dir(dir)? {
                let name = e?.file_name();
                if name
                    .to_str()
                    .and_then(file_day)
                    .is_some_and(|day| day < cutoff.as_str())
                {
                    std::fs::remove_file(dir.join(&name))?;
                }
            }
            Ok(())
        });
        if let Err(e) = res {
            logger::warn("fleet-tracker", format_args!("Failed pruning old history files: {e}"));
        }
    }

    /// Arms the debounced save: at most one per save_debounce_ms. Needs a tokio runtime; without one the save stays
    /// pending until `flush_sync` or the next rollover.
    fn schedule_save(&mut self) {
        if self.opts.history_dir.is_none() || self.save_pending.is_some() {
            return;
        }
        let wait = (self.last_save_at + self.opts.save_debounce_ms - self.now_ms()).max(0);
        self.save_seq += 1;
        let id = self.save_seq;
        self.save_pending = Some(id);
        let Ok(rt) = Handle::try_current() else {
            return;
        };
        let me = self.me.clone();
        rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(wait.unsigned_abs())).await;
            let _ = tokio::task::spawn_blocking(move || {
                let Some(state) = me.upgrade() else {
                    return;
                };
                let mut s = lock(&state);
                if s.save_pending == Some(id) {
                    s.save_pending = None;
                    s.save_history_to_disk();
                }
            })
            .await;
        });
    }

    fn history_file(&self, day: &str) -> Option<PathBuf> {
        self.opts
            .history_dir
            .as_ref()
            .map(|d| d.join(format!("fleet-history-{day}.json")))
    }

    /// The day file: `_v`, `_timeline`, then every vehicle with a course today, keys in `Object.keys` order.
    fn history_json(&self) -> serde_json::Result<String> {
        let mut payload: IndexMap<String, SavedEntry<'_>> = IndexMap::new();
        payload.insert("_v".to_owned(), SavedEntry::Format(HISTORY_FORMAT));
        payload.insert(
            "_timeline".to_owned(),
            SavedEntry::Timeline(self.timeline.values().collect()),
        );
        for (side, v) in &self.vehicles {
            if v.today_courses.is_empty() && v.current_course.is_none() {
                continue;
            }
            let saved = SavedVehicle {
                info: self.opts.static_fleet.is_none().then(|| info_of(v)),
                today_courses: &v.today_courses,
                current_course: if v.status == VehicleStatus::Active {
                    v.current_course.as_ref()
                } else {
                    None
                },
                last_seen_at: v.last_seen_at,
                last_known_location: v.last_known_location.as_ref(),
            };
            payload.insert(side.clone(), SavedEntry::Vehicle(saved));
        }
        js::sort_object_keys(&mut payload);
        serde_json::to_string(&payload)
    }

    // ponytail: the save runs under the tracker lock (the TS blocks its event loop the same way); a day file is
    // a few hundred KB. Upgrade: serialize under the lock, write after releasing it.
    fn save_history_to_disk(&mut self) {
        let Some(file) = self.history_file(&self.current_day) else {
            return;
        };
        self.last_save_at = self.now_ms();
        let res = self
            .history_json()
            .map_err(std::io::Error::other)
            .and_then(|body| blocking_io(|| write_file(&file, &body)));
        if let Err(e) = res {
            logger::warn("fleet-tracker", format_args!("Failed saving history to disk: {e}"));
        }
    }

    /// Restores today's file: the timeline, each vehicle's finished courses and, when seen within
    /// RESUME_LIVE_MAX_AGE_SEC, its live course. Malformed entries are skipped.
    fn load_history_from_disk(&mut self) {
        let Some(file) = self.history_file(&self.current_day) else {
            return;
        };
        let text = match blocking_io(|| std::fs::read_to_string(&file)) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                logger::warn("fleet-tracker", format_args!("Failed restoring history from disk: {e}"));
                return;
            }
        };
        let map = match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => m,
            Ok(_) => {
                logger::warn("fleet-tracker", "Failed restoring history from disk: not an object");
                return;
            }
            Err(e) => {
                logger::warn("fleet-tracker", format_args!("Failed restoring history from disk: {e}"));
                return;
            }
        };
        let now_epoch = self.now_ms().div_euclid(1000);
        if let Some(Value::Array(points)) = map.get("_timeline") {
            for p in points {
                if let Ok(pt) = FleetTimelinePoint::deserialize(p) {
                    self.timeline.insert(pt.t, pt);
                }
            }
        }
        let mut entries: IndexMap<String, Value> = map.into_iter().collect();
        js::sort_object_keys(&mut entries);
        let no_saved = serde_json::Map::new();
        for (side, raw) in &entries {
            let saved = match raw {
                _ if side.starts_with('_') => continue,
                Value::Object(o) => o,
                Value::Array(_) => &no_saved,
                _ => continue,
            };
            // no static fleet (GZM): the file is the only list of the vehicles seen today
            if !self.vehicles.contains_key(side)
                && self.opts.static_fleet.is_none()
                && let Some(info) = saved.get("info").and_then(|i| FleetVehicleInfo::from_saved(i, side))
            {
                let v = self.new_vehicle((self.opts.restore_info)(info));
                self.vehicles.insert(side.clone(), v);
            }
            let Some(v) = self.vehicles.get_mut(side) else {
                continue;
            };
            if let Some(Value::Array(courses)) = saved.get("todayCourses") {
                let mut list: Vec<VehicleCourseRecord> = courses
                    .iter()
                    // files written before 2026-10-04 carry invented "synth-*" courses: never real
                    .filter(|c| {
                        c.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.starts_with("synth-"))
                    })
                    .filter_map(|c| VehicleCourseRecord::deserialize(c).ok())
                    .map(rejudge_cancelled)
                    .map(|mut c| {
                        if c.status == CourseStatus::Completed
                            && let Some(stops) = &mut c.stops
                        {
                            for s in stops {
                                s.status = CourseStopStatus::Passed;
                            }
                        }
                        c
                    })
                    .collect();
                list.sort_by(sort_courses_desc);
                v.today_courses = list;
            }
            if let Some(t) = saved.get("lastSeenAt").and_then(Value::as_f64) {
                v.last_seen_at = t as i64;
            }
            if let Some(l) = saved
                .get("lastKnownLocation")
                .and_then(|l| LastKnownLocation::deserialize(l).ok())
            {
                v.last_known_location = Some(l);
            }
            // a course live at the last save resumes (the next poll continues or archives it), unless that was long ago
            if let Some(cur) = saved
                .get("currentCourse")
                .and_then(|c| FleetCurrentCourse::deserialize(c).ok())
                && now_epoch - v.last_seen_at <= RESUME_LIVE_MAX_AGE_SEC
            {
                v.current_course = Some(cur);
                v.status = VehicleStatus::Active;
            }
            Self::recalculate_stats(v);
            if v.status == VehicleStatus::Active {
                let next = self.predict_next_course(side, &[]);
                if let Some(v) = self.vehicles.get_mut(side) {
                    v.predicted_next_course = next;
                }
            }
        }
        logger::info(
            "fleet-tracker",
            format_args!("Restored fleet history from {}", file.display()),
        );
    }
}

static FLEET_TRACKER: LazyLock<FleetTracker> = LazyLock::new(|| {
    FleetTracker::new(FleetTrackerOptions {
        schedule: Some(Arc::new(mzk_day_schedule)),
        ..FleetTrackerOptions::default()
    })
});

/// The process-wide MZK tracker.
pub fn get_fleet_tracker() -> &'static FleetTracker {
    &FLEET_TRACKER
}

#[cfg(test)]
mod tests {
    use super::*;

    // The debounce timer (a Rust-only task holding a Weak): it saves once, and a flush_sync in between cancels it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn debounced_save_fires_once_and_flush_cancels_the_timer() {
        let dir = std::env::temp_dir().join(format!("unimaps-fleet-tracker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let now_ms = 1_791_108_000_000; // 2026-10-04 10:00 UTC
        let tracker = FleetTracker::new(FleetTrackerOptions {
            history_dir: Some(dir.clone()),
            static_fleet: None,
            save_debounce_ms: 300,
            now: Arc::new(move || now_ms),
            ..FleetTrackerOptions::default()
        });
        let file = dir.join("fleet-history-2026-10-04.json");

        tracker.lock().schedule_save();
        for _ in 0..200 {
            if file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::fs::read_to_string(&file).ok().as_deref(),
            Some(r#"{"_v":2,"_timeline":[]}"#)
        );
        assert_eq!(tracker.lock().save_pending, None);

        tracker.lock().schedule_save();
        tracker.flush_sync();
        assert!(file.exists());
        std::fs::remove_file(&file).ok();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!file.exists(), "the cancelled timer saved again");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
