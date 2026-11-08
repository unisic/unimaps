//! `lib/mzk-poller.ts`: the MZK (OnTime) live poller. One `fetch_running_vehicles` per refresh interval becomes the
//! positions snapshot; the stop list, lines and static fleet load at start, while missing, daily and when a running
//! course names an unknown stop symbol; stop bearings are learned from the running courses.

use std::collections::{HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::config;
use crate::fetch::string_err;
use crate::fleet_tracker::{FleetRunningInput, FleetStopPoint, FleetTracker, blocking_io, get_fleet_tracker};
use crate::geo::{bearing, meters_between};
use crate::gzm::NowFn;
use crate::js;
use crate::logger;
use crate::merged_stops::is_station_name;
use crate::mzk_api::{MzkSource, MzkStopPoint};
use crate::mzk_fleet::fleet_details;
use crate::mzk_shape::{mzk_remap_dist, mzk_stop_indices};
use crate::mzk_state::{MzkLifecycleInput, has_planned_dip, is_mzk_not_started};
use crate::mzk_stop_dirs::{MzkStopDirs, StopCoord, load_mzk_stop_dirs, save_mzk_stop_dirs};
use crate::poller::{aborted, interruptible_sleep, panic_msg};
use crate::route_info::{next_speed, sched_speed};
use crate::shape_store::{MzkShapeSink, ShapePrio};
use crate::stop_merge::Operator;
use crate::types::Stop;
use crate::vehicle::VehiclePos;

const TAG: &str = "mzk-poller";
const COURSE_META_MAX: usize = 20_000;
/// A MZK position older than this (seconds) is left out of the live answers.
pub const MZK_STALE_SEC: f64 = 60.0;

/// `mzkAngleToCompassBearing`: OnTime's angle is Cartesian (0 = east, counter-clockwise).
pub fn mzk_angle_to_compass_bearing(angle: f64) -> f64 {
    let b = (90.0 - angle) % 360.0;
    if b < 0.0 { b + 360.0 } else { b }
}

/// What the fleet tracker reads of a raw OnTime running record (the TS passes the record itself).
pub fn mzk_fleet_input(raw: &Value) -> FleetRunningInput {
    let s = |k: &str| raw.get(k).and_then(Value::as_str).map(str::to_owned);
    let n = |k: &str| raw.get(k).and_then(Value::as_f64);
    let idx = mzk_stop_indices(raw);
    let stop_points = stop_points(raw)
        .iter()
        .map(|p| FleetStopPoint {
            symbol: p.get("symbol").and_then(Value::as_str).unwrap_or_default().to_owned(),
            name: p.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            distance: p.get("distance").and_then(Value::as_f64).unwrap_or(f64::NAN),
            scheduled_departure: p.get("scheduledDeparture").and_then(Value::as_f64).unwrap_or(0.0),
            planned_departure: p.get("plannedDeparture").and_then(Value::as_f64).unwrap_or(0.0),
        })
        .collect();
    FleetRunningInput {
        vehicle_id: s("vehicleId").unwrap_or_default(),
        line_name: s("lineName").unwrap_or_default(),
        course_loid: n("courseLoid").map_or(0, |x| x as i64),
        direction: s("direction").unwrap_or_default(),
        optional_direction: s("optionalDirection"),
        delay_sec: n("delaySec").unwrap_or(f64::NAN),
        latitude: n("latitude").unwrap_or(f64::NAN),
        longitude: n("longitude").unwrap_or(f64::NAN),
        angle: n("angle"),
        last_ping_date: n("lastPingDate"),
        reached_meters: n("reachedMeters"),
        on_stop_point: js::truthy(raw.get("onStopPoint")),
        stop_points,
        lifecycle: MzkLifecycleInput::from_json(raw),
        served_idx: idx.served,
        next_idx: idx.next,
        ..FleetRunningInput::default()
    }
}

/// `Array.isArray(v.stopPoints) ? v.stopPoints : []`
fn stop_points(v: &Value) -> &[Value] {
    v.get("stopPoints").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

/// `v.direction || v.optionalDirection || ""`
fn headsign(v: &Value) -> String {
    ["direction", "optionalDirection"]
        .into_iter()
        .find(|k| js::truthy(v.get(*k)))
        .map(|k| js::value_to_string(v.get(k)))
        .unwrap_or_default()
}

fn mzk_stop(s: &MzkStopPoint) -> Stop {
    Stop {
        url_id: format!("mzk:{}", s.symbol),
        // ponytail: OnTime ids are integers; a fractional one would truncate here (the TS keeps the number)
        internal_id: s.id as i64,
        name: s.name.clone(),
        lon: s.longitude,
        lat: s.latitude,
        only_disembarking: s.getting_out,
        is_station: is_station_name(&s.name),
        show_platforms: false,
        stop_id: format!("mzk:{}", s.symbol),
        operator: Some(Operator::MZK),
        symbol: Some(s.symbol.clone()),
        on_request: Some(s.on_request),
        getting_out: Some(s.getting_out),
    }
}

/// One MZK line as `/api/lines` serializes it (TS literal key order).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MzkLineInfo {
    pub id: String,
    pub name: String,
    pub terminus: String,
    pub operator: &'static str,
}

/// `courseMetaMap` entry: what a running course said about itself.
#[derive(Debug, Clone, PartialEq)]
pub struct CourseMeta {
    pub line_name: String,
    pub variant_id: Option<f64>,
    pub direction: String,
}

/// Every mutable `MzkPoller` field (one lock, never held across an await).
#[derive(Default)]
pub struct MzkPollerState {
    /// exec id -> position; replaced wholesale on every poll (identity = `Arc::ptr_eq`), insertion-ordered
    pub positions: Arc<IndexMap<String, Arc<VehiclePos>>>,
    // ponytail: never pruned like the TS Map, bounded by the MZK fleet size (~100 vehicles)
    pub last_positions_by_vehicle: HashMap<String, Arc<VehiclePos>>,
    /// exec id and `String(courseLoid)` -> the raw running record of the last poll
    pub running_vehicles: Arc<HashMap<String, Arc<Value>>>,
    pub stops: Arc<Vec<Stop>>,
    pub stops_by_symbol: Arc<HashMap<String, Stop>>,
    /// symbol -> (lat, lon), swapped with `stops_by_symbol`: the fleet tracker's "course not begun" lookup
    pub stop_coords: Arc<HashMap<String, (f64, f64)>>,
    /// epoch seconds
    pub stops_loaded_at: f64,
    /// epoch ms
    pub stops_reload_attempt_at: i64,
    pub stops_reload_in_flight: bool,
    pub unknown_handled: HashSet<String>,
    pub stop_dirs: MzkStopDirs,
    /// epoch ms
    pub stop_dirs_saved_at: i64,
    stop_dirs_timer: Option<JoinHandle<()>>,
    pub lines: Arc<Vec<MzkLineInfo>>,
    /// OnTime getVehicles.json records by side number
    pub static_vehicles: Arc<HashMap<String, Value>>,
    /// courseLoid -> meta, re-noted at the young end, capped at COURSE_META_MAX
    pub course_meta: IndexMap<i64, CourseMeta>,
    pub last_scan: f64,
    pub scan_count: u64,
    pub started_at: f64,
    pub last_good_refresh: f64,
    pub shapes: Option<Arc<dyn MzkShapeSink>>,
    /// `String(courseLoid)` -> epoch ms of the last dip log; cleared past 500 entries
    pub dip_logged_at: HashMap<String, i64>,
    pub route_err_logged_at: i64,
    pub started: bool,
    stop_tx: Option<watch::Sender<bool>>,
    loop_task: Option<JoinHandle<()>>,
}

impl MzkPollerState {
    fn note_course(&mut self, id: i64, meta: CourseMeta) {
        self.course_meta.shift_remove(&id);
        self.course_meta.insert(id, meta);
        if self.course_meta.len() > COURSE_META_MAX {
            self.course_meta.shift_remove_index(0);
        }
    }
}

/// `MzkPoller`. Construction does nothing: `start()` (or a direct call) loads, polls and spawns.
pub struct MzkPoller<S: MzkSource> {
    api: S,
    refresh_interval_ms: f64,
    now: NowFn,
    stop_dirs_file: Option<PathBuf>,
    fleet: Option<FleetTracker>,
    /// feed `get_fleet_tracker()`, resolved at the first poll (the TS calls it there), when `fleet` is None
    global_fleet: bool,
    state: Mutex<MzkPollerState>,
}

/// A spawned step's outcome as the TS rejection text: its own error, or the panic message.
pub(crate) async fn joined(task: JoinHandle<Result<(), String>>) -> Result<(), String> {
    match task.await {
        Ok(r) => r.map_err(string_err),
        Err(e) if e.is_panic() => Err(panic_msg(&*e.into_panic())),
        Err(e) => Err(e.to_string()),
    }
}

impl<S: MzkSource + 'static> MzkPoller<S> {
    /// Refresh 5000 ms, system clock, stop directions in `config::MZK_STOP_DIRS_FILE`, no fleet tracker, no shapes.
    pub fn new(api: S) -> Self {
        let now: NowFn = Arc::new(|| jiff::Timestamp::now().as_millisecond());
        let state = MzkPollerState {
            last_good_refresh: now().div_euclid(1000) as f64,
            ..MzkPollerState::default()
        };
        Self {
            api,
            refresh_interval_ms: 5000.0,
            now,
            stop_dirs_file: Some(PathBuf::from(config::MZK_STOP_DIRS_FILE.as_str())),
            fleet: None,
            global_fleet: false,
            state: Mutex::new(state),
        }
    }

    /// Injectable epoch-ms clock; re-stamps `last_good_refresh` like a construction at that time.
    pub fn with_now(mut self, now: NowFn) -> Self {
        let lgr = now().div_euclid(1000) as f64;
        self.state
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .last_good_refresh = lgr;
        self.now = now;
        self
    }

    pub fn with_refresh_interval_ms(mut self, ms: f64) -> Self {
        self.refresh_interval_ms = ms;
        self
    }

    /// Where learned stop directions are read (`start`) and saved; None = neither (tests).
    pub fn with_stop_dirs_file(mut self, file: Option<PathBuf>) -> Self {
        self.stop_dirs_file = file;
        self
    }

    /// The tracker fed after every poll (the TS always feeds `getFleetTracker()`); None = no tracker.
    pub fn with_fleet(mut self, fleet: Option<FleetTracker>) -> Self {
        self.fleet = fleet;
        self
    }

    /// Feed the process-wide `get_fleet_tracker()`, looked up at the first poll so construction stays inert (the
    /// tracker loads its history files when created).
    pub fn with_global_fleet(mut self) -> Self {
        self.global_fleet = true;
        self
    }

    /// `mzkPoller.shapes = sink` of the singleton.
    pub fn set_shapes(&self, shapes: Option<Arc<dyn MzkShapeSink>>) {
        self.state().shapes = shapes;
    }

    /// The poller's fields; driven directly by tests and read by the routes. Never held across an await.
    pub fn state(&self) -> MutexGuard<'_, MzkPollerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now_ms(&self) -> i64 {
        (self.now)()
    }

    /// `loadStops`: fetch the stop list and swap it in with its symbol index; an empty list keeps the previous one
    /// (Ok(false)). Driven directly by tests.
    pub async fn load_stops(&self) -> Result<bool, String> {
        let raw = self.api.fetch_stops().await?;
        if raw.is_empty() {
            logger::error(TAG, "stops reload: upstream returned an empty list, keeping previous");
            return Ok(false);
        }
        let stops: Vec<Stop> = raw.iter().map(mzk_stop).collect();
        let mut by_symbol = HashMap::new();
        let mut coords = HashMap::new();
        for s in &stops {
            if let Some(sym) = s.symbol.as_ref().filter(|x| !x.is_empty()) {
                by_symbol.insert(sym.clone(), s.clone());
                coords.insert(sym.clone(), (s.lat, s.lon));
            }
        }
        let now = self.now_ms();
        let mut st = self.state();
        let prev = st.stops.len();
        let n = stops.len();
        st.stops = Arc::new(stops);
        st.stops_by_symbol = Arc::new(by_symbol);
        st.stop_coords = Arc::new(coords);
        st.stops_loaded_at = now as f64 / 1000.0;
        if prev > 0 {
            logger::info(TAG, format!("stops reloaded: {n} (was {prev})"));
        }
        let MzkPollerState {
            stop_dirs,
            stops_by_symbol,
            ..
        } = &mut *st;
        if stop_dirs.reconcile(|sym| stops_by_symbol.get(sym).map(|s| StopCoord { lat: s.lat, lon: s.lon })) {
            logger::warn(TAG, "stop data changed, learned stop directions reset");
        }
        Ok(true)
    }

    /// `loadLines`: an empty list keeps the previous lines. Driven directly by tests.
    pub async fn load_lines(&self) -> Result<(), String> {
        let raw = self.api.fetch_lines().await?;
        if raw.is_empty() {
            return Ok(());
        }
        let lines = raw
            .iter()
            .map(|l| MzkLineInfo {
                id: format!("mzk:{}", js::number_to_string(l.id)),
                name: l.name.clone(),
                terminus: l.long_name.clone().unwrap_or_default(),
                operator: "MZK",
            })
            .collect();
        self.state().lines = Arc::new(lines);
        Ok(())
    }

    /// `loadStaticVehicles`: an empty list keeps the previous fleet. Driven directly by tests.
    pub async fn load_static_vehicles(&self) -> Result<(), String> {
        let raw = self.api.fetch_vehicles().await?;
        if raw.is_empty() {
            return Ok(());
        }
        let next: HashMap<String, Value> = raw
            .into_iter()
            .map(|v| (js::value_to_string(v.get("sideNumber")), v))
            .collect();
        self.state().static_vehicles = Arc::new(next);
        Ok(())
    }

    /// `noteCourse`: a re-noted course moves to the young end, the oldest is evicted past 20 000. Driven directly
    /// by tests.
    pub fn note_course(&self, id: i64, meta: CourseMeta) {
        self.state().note_course(id, meta);
    }

    /// Receivers of the loop's stop signal (the TS abort listeners on `stopCtl.signal`). Driven directly by tests.
    pub fn stop_listeners(&self) -> usize {
        self.state().stop_tx.as_ref().map_or(0, watch::Sender::receiver_count)
    }
}

impl<S: MzkSource + 'static> MzkPoller<S> {
    /// `start`: load stop directions, the static data and one poll, then the loop (every refresh interval until
    /// `stop`). A second call while started returns at once.
    pub async fn start(self: &Arc<Self>) {
        let rx = {
            let mut st = self.state();
            if st.started {
                return;
            }
            st.started = true;
            st.started_at = self.now_ms().div_euclid(1000) as f64;
            let (tx, rx) = watch::channel(false);
            st.stop_tx = Some(tx);
            rx
        };
        if let Some(file) = &self.stop_dirs_file {
            let dirs = blocking_io(|| load_mzk_stop_dirs(file));
            self.state().stop_dirs = dirs;
        }
        let me = Arc::clone(self);
        let stops = tokio::spawn(async move { me.load_stops().await.map(|_| ()) });
        let me = Arc::clone(self);
        let lines = tokio::spawn(async move { me.load_lines().await });
        let me = Arc::clone(self);
        let fleet = tokio::spawn(async move { me.load_static_vehicles().await });
        // Promise.all: settles at the first failure; the loads still running are detached and swap their data in
        match tokio::try_join!(joined(stops), joined(lines), joined(fleet)) {
            Ok(_) => {
                let msg = {
                    let st = self.state();
                    format!("Loaded {} stops and {} lines", st.stops.len(), st.lines.len())
                };
                logger::info(TAG, msg);
            }
            Err(e) => logger::warn(TAG, format!("Initial static load failed: {e}")),
        }
        if let Err(e) = self.poll_guarded().await {
            logger::warn(TAG, format!("Initial vehicles poll failed: {e}"));
        }
        let me = Arc::clone(self);
        let task = tokio::spawn(async move { me.run_loop(rx).await });
        self.state().loop_task = Some(task);
    }

    /// `stop`: write a pending stop-direction save, signal the loop and wait for it. A request in flight is not
    /// interrupted, like the TS.
    pub async fn stop(&self) {
        {
            let mut st = self.state();
            if !st.started {
                return;
            }
            st.started = false;
        }
        self.flush_stop_dirs();
        let task = {
            let mut st = self.state();
            if let Some(tx) = st.stop_tx.take() {
                tx.send_replace(true);
            }
            st.loop_task.take()
        };
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    async fn run_loop(self: Arc<Self>, mut stop: watch::Receiver<bool>) {
        while !aborted(&stop) {
            interruptible_sleep(self.refresh_interval_ms, &mut stop).await;
            if aborted(&stop) {
                break;
            }
            if let Err(e) = self.poll_guarded().await {
                logger::warn(TAG, format!("Poll loop iteration failed: {e}"));
            }
        }
    }

    /// `poll_once` in its own task, so a panic is caught like the TS catch (Err = the logged text).
    async fn poll_guarded(self: &Arc<Self>) -> Result<(), String> {
        let me = Arc::clone(self);
        joined(tokio::spawn(async move { me.poll_once().await })).await
    }

    /// `flushStopDirs`: write a pending trailing save now (shutdown). Driven directly by tests.
    pub fn flush_stop_dirs(&self) {
        let now = self.now_ms();
        let mut st = self.state();
        let Some(timer) = st.stop_dirs_timer.take() else {
            return;
        };
        timer.abort();
        self.save_stop_dirs(&mut st, now);
    }

    fn save_stop_dirs(&self, st: &mut MzkPollerState, now: i64) {
        st.stop_dirs_timer = None;
        st.stop_dirs_saved_at = now;
        if let Some(file) = &self.stop_dirs_file {
            blocking_io(|| save_mzk_stop_dirs(file, &st.stop_dirs));
        }
    }

    /// `persistStopDirs`: at once when the last save is a minute old, else one trailing save.
    fn persist_stop_dirs(self: &Arc<Self>, st: &mut MzkPollerState, now: i64) {
        let wait = 60_000 - (now - st.stop_dirs_saved_at);
        if wait <= 0 {
            self.save_stop_dirs(st, now);
        } else if st.stop_dirs_timer.is_none() {
            let me = Arc::downgrade(self);
            st.stop_dirs_timer = Some(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(wait.unsigned_abs())).await;
                if let Some(me) = me.upgrade() {
                    let now = me.now_ms();
                    let mut st = me.state();
                    me.save_stop_dirs(&mut st, now);
                }
            }));
        }
    }

    /// `learnFromRunning`: feed the direction learner, spot symbols missing from the stop list.
    fn learn_from_running(self: &Arc<Self>, st: &mut MzkPollerState, running: &[Arc<Value>], now: i64) {
        let mut unknown: IndexSet<String> = IndexSet::new();
        let mut learned = false;
        for v in running {
            // ponytail: a non-object stop point reads as symbol "" (the TS throws and skips this poll's learning)
            let stops: Vec<(&str, Option<StopCoord>)> = stop_points(v)
                .iter()
                .map(|p| {
                    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or_default();
                    let at = st
                        .stops_by_symbol
                        .get(sym)
                        .map(|s| StopCoord { lat: s.lat, lon: s.lon });
                    // "00" = depot, never a real stop
                    if at.is_none() && !sym.is_empty() && sym != "00" {
                        unknown.insert(sym.to_owned());
                    }
                    (sym, at)
                })
                .collect();
            if let Some(variant) = num(v, "variantLoid")
                && st.stop_dirs.learn(variant, &stops)
            {
                learned = true;
            }
        }
        if learned {
            self.persist_stop_dirs(st, now);
        }
        if !st.stops.is_empty() {
            self.maybe_reload_stops(st, unknown, now);
        }
    }

    /// `maybeReloadStops`, its synchronous part: reload when the list is a day old, or (at most every 10 min) when
    /// a running course names a symbol not tried yet. Never overlaps.
    fn maybe_reload_stops(self: &Arc<Self>, st: &mut MzkPollerState, unknown: IndexSet<String>, now: i64) {
        if st.stops_reload_in_flight {
            return;
        }
        let due = now as f64 / 1000.0 - st.stops_loaded_at >= *config::STOPS_RELOAD_SEC as f64;
        let fresh = unknown.iter().any(|s| !st.unknown_handled.contains(s));
        let stale = fresh && now - st.stops_reload_attempt_at >= 10 * 60_000;
        if !due && !stale {
            return;
        }
        st.stops_reload_in_flight = true;
        st.stops_reload_attempt_at = now;
        if stale {
            let first: Vec<&str> = unknown.iter().take(5).map(String::as_str).collect();
            logger::warn(
                TAG,
                format!(
                    "unknown stop symbols on running courses ({}), reloading stops",
                    first.join(",")
                ),
            );
        }
        st.unknown_handled = unknown.into_iter().collect();
        let me = Arc::clone(self);
        tokio::spawn(async move { me.reload_stops(due, now).await });
    }

    /// `maybeReloadStops` after its first await.
    async fn reload_stops(self: Arc<Self>, due: bool, now: i64) {
        let installed = match self.load_stops().await {
            Ok(true) => {
                if due {
                    let (a, b) = tokio::join!(self.load_lines(), self.load_static_vehicles());
                    if let Some(e) = a.err().or(b.err()) {
                        logger::warn(TAG, format!("lines/vehicles reload failed: {}", string_err(e)));
                    }
                }
                true
            }
            Ok(false) => false,
            Err(e) => {
                logger::warn(TAG, format!("stops reload failed: {}", string_err(e)));
                false
            }
        };
        let mut st = self.state();
        st.stops_reload_in_flight = false;
        if !installed {
            // failed or empty: keep the old list, forget what was tried; a due reload is retried in 30 min
            st.unknown_handled.clear();
            if due {
                st.stops_loaded_at = now as f64 / 1000.0 - *config::STOPS_RELOAD_SEC as f64 + 1800.0;
            }
        }
    }

    /// `pollOnce`: load what static data is missing, fetch the running fleet, rebuild the positions snapshot and
    /// feed the fleet tracker. Err = the running-vehicles fetch failed. Driven directly by tests.
    pub async fn poll_once(self: &Arc<Self>) -> Result<(), String> {
        let (need_stops, need_lines, need_fleet) = {
            let st = self.state();
            (st.stops.is_empty(), st.lines.is_empty(), st.static_vehicles.is_empty())
        };
        let (a, b, c) = tokio::join!(
            async {
                if need_stops {
                    self.load_stops().await.map(|_| ())
                } else {
                    Ok(())
                }
            },
            async { if need_lines { self.load_lines().await } else { Ok(()) } },
            async {
                if need_fleet {
                    self.load_static_vehicles().await
                } else {
                    Ok(())
                }
            },
        );
        for r in [a, b, c] {
            if let Err(e) = r {
                logger::warn(TAG, format!("Reload static metadata failed: {}", string_err(e)));
            }
        }

        let running: Vec<Arc<Value>> = self
            .api
            .fetch_running_vehicles()
            .await?
            .into_iter()
            .map(Arc::new)
            .collect();
        let now = self.now_ms();
        let now_secs = now.div_euclid(1000) as f64;
        let mut st = self.state();
        if let Err(p) = catch_unwind(AssertUnwindSafe(|| self.learn_from_running(&mut st, &running, now))) {
            logger::warn(TAG, format!("learning stop directions failed: {}", panic_msg(&*p)));
        }
        let old = Arc::clone(&st.positions);
        let shapes = st.shapes.clone();
        let mut new_positions: IndexMap<String, Arc<VehiclePos>> = IndexMap::new();
        let mut new_running: HashMap<String, Arc<Value>> = HashMap::new();
        let mut touched: HashSet<u64> = HashSet::new();

        for v in &running {
            let (Some(lon), Some(lat)) = (num(v, "longitude"), num(v, "latitude")) else {
                // ponytail: a non-numeric coordinate skips the record (the TS would coerce a numeric string)
                continue;
            };
            if lon == 0.0 || lat == 0.0 || !js::truthy(v.get("vehicleId")) {
                continue;
            }
            if !(48.8..=50.5).contains(&lat) || !(18.0..=20.5).contains(&lon) {
                continue;
            }
            let course = js::value_to_string(v.get("courseLoid"));
            if let Some(id) = num(v, "courseLoid").filter(|x| *x != 0.0) {
                st.note_course(
                    id as i64,
                    CourseMeta {
                        line_name: v.get("lineName").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        variant_id: num(v, "variantLoid"),
                        direction: headsign(v),
                    },
                );
            }
            let vid = js::value_to_string(v.get("vehicleId"));
            let exec_id = format!("mzk:{course}:{vid}");
            let mut pos = self.vehicle_pos(&st, v, &old, &exec_id, &vid, (lat, lon), now, now_secs);
            let prev_same = old.get(&exec_id).map(Arc::as_ref);
            let route = catch_unwind(AssertUnwindSafe(|| {
                attach_route_info(&mut pos, v, prev_same, now_secs, &mut touched, shapes.as_deref());
            }));
            if let Err(p) = route {
                pos.shape_key = None;
                pos.dist_m = None;
                if now - st.route_err_logged_at > 60_000 {
                    st.route_err_logged_at = now;
                    logger::error(
                        TAG,
                        format!("route info failed for {}: {}", pos.exec_id, panic_msg(&*p)),
                    );
                }
            }
            // diagnostics must never break a poll
            let _ = catch_unwind(AssertUnwindSafe(|| note_estimate_dip(&mut st.dip_logged_at, v, now)));

            let pos = Arc::new(pos);
            new_positions.insert(exec_id.clone(), Arc::clone(&pos));
            st.last_positions_by_vehicle.insert(vid, pos);
            new_running.insert(exec_id, Arc::clone(v));
            new_running.insert(course, Arc::clone(v));
        }

        st.positions = Arc::new(new_positions);
        st.running_vehicles = Arc::new(new_running);
        st.last_scan = now_secs;
        st.scan_count += 1;
        st.last_good_refresh = now_secs;
        let static_vehs = Arc::clone(&st.static_vehicles);
        let coords = Arc::clone(&st.stop_coords);
        drop(st);

        if let Some(fleet) = self
            .fleet
            .as_ref()
            .or_else(|| self.global_fleet.then(get_fleet_tracker))
        {
            let inputs: Vec<FleetRunningInput> = running.iter().map(|v| mzk_fleet_input(v)).collect();
            let fed = catch_unwind(AssertUnwindSafe(|| {
                fleet.update_from_running_vehicles(&inputs, Some(&static_vehs), Some(&coords));
            }));
            if let Err(p) = fed {
                logger::warn(TAG, format!("FleetTracker update failed: {}", panic_msg(&*p)));
            }
        }
        Ok(())
    }

    /// The `VehiclePos` literal of `pollOnce` with its next stop and bearing (before `attachRouteInfo`).
    #[allow(clippy::too_many_arguments)]
    fn vehicle_pos(
        &self,
        st: &MzkPollerState,
        v: &Value,
        old: &IndexMap<String, Arc<VehiclePos>>,
        exec_id: &str,
        vid: &str,
        (lat, lon): (f64, f64),
        now: i64,
        now_secs: f64,
    ) -> VehiclePos {
        let fleet = fleet_details(vid, st.static_vehicles.get(vid));
        // by exec id, else by vehicle across a course change
        let prev = old.get(exec_id).or_else(|| st.last_positions_by_vehicle.get(vid));
        let sp = stop_points(v);
        let sym_of = |p: &Value| p.get("symbol").and_then(Value::as_str).map(str::to_owned);
        let stop_of = |p: Option<&Value>| {
            p.and_then(|p| p.get("symbol"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .and_then(|s| st.stops_by_symbol.get(s))
        };
        let idx = mzk_stop_indices(v);
        // course not begun: OnTime's delaySec / plannedDeparture are a placeholder, not a delay
        let first = stop_of(sp.first());
        let not_started = is_mzk_not_started(&MzkLifecycleInput::from_json(v), first.map(|s| (s.lat, s.lon)));

        let (target, mut next_name) = match idx.next.and_then(|n| sp.get(n)).filter(|p| js::truthy(Some(p))) {
            Some(p) => (sym_of(p), p.get("name").and_then(Value::as_str).map(str::to_owned)),
            None => (v.get("nearestSymbol").and_then(Value::as_str).map(str::to_owned), None),
        };
        let mut next_at = None;
        if let Some(m) = target
            .as_deref()
            .filter(|t| !t.is_empty())
            .and_then(|t| st.stops_by_symbol.get(t))
        {
            if next_name.as_deref().is_none_or(str::is_empty) {
                next_name = Some(m.name.clone());
            }
            next_at = Some((m.lat, m.lon));
        }

        let angle = num(v, "angle");
        let mut brg: Option<f64> = None;
        // 1. the real displacement since the last poll; a standing bus keeps its heading
        if let Some(p) = prev {
            if meters_between(p.lat, p.lon, lat, lon) >= 8.0 {
                brg = bearing(p.lat, p.lon, lat, lon);
            } else if p.bearing.is_some() {
                brg = p.bearing;
            }
        }
        if brg.is_none() {
            // 2. OnTime's telemetry angle
            if let Some(a) = angle.filter(|a| a.is_finite() && *a != 0.0) {
                brg = Some(mzk_angle_to_compass_bearing(a));
            } else {
                // 3. standing at a terminus: towards the next stop, then along the stop points
                if let Some((nlat, nlon)) = next_at
                    && meters_between(lat, lon, nlat, nlon) >= 15.0
                {
                    brg = bearing(lat, lon, nlat, nlon);
                }
                if brg.is_none() && sp.len() >= 2 {
                    let o = num(v, "orderInCourse").filter(|o| *o >= 0.0).unwrap_or(0.0);
                    let at = |i: f64| {
                        if i.fract() == 0.0 {
                            sp.get(i as usize).filter(|p| js::truthy(Some(p)))
                        } else {
                            None
                        }
                    };
                    if let Some(cur) = at(o)
                        && let Some(nxt) = at(o + 1.0).or_else(|| at(1.0))
                        && let (Some(s1), Some(s2)) = (stop_of(Some(cur)), stop_of(Some(nxt)))
                    {
                        brg = bearing(s1.lat, s1.lon, s2.lat, s2.lon);
                    }
                }
                if brg.is_none() {
                    brg = angle.filter(|a| a.is_finite()).map(mzk_angle_to_compass_bearing);
                }
            }
        }

        VehiclePos {
            exec_id: exec_id.to_owned(),
            trip_id: js::value_to_string(v.get("courseLoid")),
            route_id: v.get("lineName").and_then(Value::as_str).unwrap_or_default().to_owned(),
            line: v.get("lineName").and_then(Value::as_str).unwrap_or_default().to_owned(),
            headsign: headsign(v),
            lat,
            lon,
            vehicle_type: 3,
            current_stop_sequence: idx
                .served
                .map(|s| s as i64)
                .or_else(|| num(v, "orderInCourse").map(|o| o as i64)),
            at_stop: js::truthy(v.get("onStopPoint")),
            delay: num(v, "delaySec")
                .filter(|d| !not_started && d.is_finite())
                .map(js::round),
            timestamp: num(v, "lastPingDate")
                .filter(|x| *x != 0.0)
                .map_or(now_secs, |x| (x / 1000.0).floor()),
            updated_at: now as f64 / 1000.0,
            bearing: brg.map(js::round1),
            next_stop_name: next_name,
            next_stop_lat: next_at.map(|a| a.0),
            next_stop_lon: next_at.map(|a| a.1),
            last_moved_at: now_secs,
            anchor_lat: lat,
            anchor_lon: lon,
            finished: false,
            not_started,
            operator: Some("MZK"),
            side_number: Some(vid.to_owned()),
            model: Some(fleet.model),
            features: Some(fleet.features),
            next_stop_seq: idx.next.map(|n| n as i64),
            ..VehiclePos::default()
        }
    }
}

/// `attachRouteInfo`: shape key, along-route distance (OnTime's reachedMeters remapped onto our polyline), fix
/// time and cruise speed.
fn attach_route_info(
    pos: &mut VehiclePos,
    v: &Value,
    prev: Option<&VehiclePos>,
    now_secs: f64,
    touched: &mut HashSet<u64>,
    shapes: Option<&dyn MzkShapeSink>,
) {
    // the raw ping time (MZK server clock): the client maps it onto its own clock
    let fix_at = num(v, "lastPingDate")
        .filter(|x| *x != 0.0)
        .map_or(now_secs, |x| x / 1000.0);
    pos.fix_at = Some(fix_at);
    let variant = num(v, "variantLoid").filter(|x| *x > 0.0);
    let key = variant.map(|x| format!("mzk:{}", js::number_to_string(x)));
    pos.shape_key.clone_from(&key);
    if let (Some(shapes), Some(variant), Some(key)) = (shapes, variant, key) {
        if touched.insert(variant.to_bits()) {
            shapes.touch_mzk(variant, ShapePrio::Background);
        }
        let sp = stop_points(v);
        // the variant's stops must line up with this course's stopPoints, else no shape
        if let Some(geom) = shapes.geometry(&key) {
            if geom.stops.len() != sp.len() {
                pos.shape_key = None;
            } else if let Some(reached) = num(v, "reachedMeters").filter(|x| x.is_finite()) {
                let dists: Vec<Option<f64>> = sp.iter().map(|p| num(p, "distance")).collect();
                if let Some(d) = mzk_remap_dist(reached, &dists, &geom.stops) {
                    pos.dist_m = Some(js::round1(d));
                    pos.dist_rev = Some(geom.rev.clone());
                    let times: Vec<Option<f64>> = sp
                        .iter()
                        .map(|p| num(p, "scheduledDeparture").filter(|x| *x != 0.0).map(|x| x / 1000.0))
                        .collect();
                    pos.sched_speed = sched_speed(&geom.stops, &times, d);
                }
            }
        }
    }
    let Some(prev) = prev else {
        return;
    };
    let prev_fix = prev.fix_at.unwrap_or(prev.updated_at);
    if fix_at - prev_fix < 0.5 {
        // the same ping as last poll: not a new fix
        pos.move_ds = prev.move_ds;
        pos.speed = prev.speed;
        pos.speed_at = prev.speed_at;
        return;
    }
    let ds = match (pos.dist_m, prev.dist_m) {
        (Some(d), Some(pd)) if prev.dist_rev == pos.dist_rev => d - pd,
        _ => meters_between(prev.lat, prev.lon, pos.lat, pos.lon),
    };
    let s = next_speed(
        prev.speed,
        prev.move_ds,
        ds,
        fix_at - prev_fix,
        0.0,
        prev.at_stop || pos.at_stop,
    );
    pos.move_ds = Some(ds);
    pos.speed = s.or(prev.speed);
    pos.speed_at = if s.is_some() { Some(fix_at) } else { prev.speed_at };
}

/// `noteEstimateDip`: OnTime estimates going backwards along a course, logged once per course per 10 min with
/// the raw per-stop diffs.
fn note_estimate_dip(logged: &mut HashMap<String, i64>, v: &Value, now: i64) {
    let sp = stop_points(v);
    let planned: Vec<Option<f64>> = sp.iter().map(|p| num(p, "plannedDeparture")).collect();
    if !has_planned_dip(&planned, num(v, "orderInCourse").unwrap_or(0.0)) {
        return;
    }
    let course = js::value_to_string(v.get("courseLoid"));
    if now - logged.get(&course).copied().unwrap_or(0) < 600_000 {
        return;
    }
    if logged.len() > 500 {
        logged.clear();
    }
    logged.insert(course, now);
    let diffs: Vec<Value> = sp
        .iter()
        .map(|p| match num(p, "plannedDeparture").filter(|x| *x != 0.0) {
            Some(pl) => js::num_value(js::round(
                (pl - num(p, "scheduledDeparture").unwrap_or(f64::NAN)) / 1000.0,
            )),
            None => Value::Null,
        })
        .collect();
    let s = |k: &str| js::value_to_string(v.get(k));
    logger::warn(
        TAG,
        format!(
            "non-monotone planned times: course {} line {} veh {} ord {} lastStopOrderNo {} onStop {} delaySec {} diffs(s) {}",
            s("courseLoid"),
            s("lineName"),
            s("vehicleId"),
            s("orderInCourse"),
            s("lastStopOrderNo"),
            s("onStopPoint"),
            s("delaySec"),
            Value::Array(diffs)
        ),
    );
}
