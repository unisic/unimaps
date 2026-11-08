//! lib/poller.ts, core half: the KB live poller's state, position parsing, motion carry-over, GPS progress, route
//! info and the `/api/vehicles` / GTFS-RT snapshots. The background loop (loadStops, start/stop, scans,
//! fetchPositions) lives further down this module.
// ponytail: wired in sub-stage 4b/4c
#![allow(dead_code)]

use std::any::Any;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::IndexMap;
use jiff::Timestamp;
use serde_json::Value;
use tokio::sync::watch;

use crate::config;
use crate::fetch::string_err;
use crate::geo::{bearing, meters_between};
use crate::gzm::NowFn;
use crate::js;
use crate::kb_api::{KbSource, as_record, join_all, parse_int_strict_str, py_truthy};
use crate::kb_progress::{DelaySrc, KbProgIn, ProgressGeom, step_arrivals, step_kb_progress, straight_geom};
use crate::logger;
use crate::route_info::{KbShapeSink, PrevFix, estimate_fix_at, kb_ahead_m, kb_dist_along, next_speed, sched_speed};
use crate::shape_patterns::{KbPattern, ResolvedStop, build_kb_pattern};
use crate::shape_store::ShapePrio;
use crate::time::agency_clock;
use crate::types::{Stop, UpstreamRecord, VehiclesResponse};
use crate::vehicle::VehiclePos;

pub use crate::gtfs_rt::{FeedVehicle, vehicle_positions_feed};
pub use crate::vehicle::vehicle_to_json;

const TAG: &str = "rt";
const EXEC_TRIP_TTL_SEC: f64 = 3.0 * 3600.0;
const EXEC_TRIP_MAX: usize = 20_000;
const PATTERN_MEMO_MAX: usize = 4000;
const ERR_LOG_EVERY_MS: i64 = 60_000;

fn in_service_area(lat: f64, lon: f64) -> bool {
    (48.8..=50.5).contains(&lat) && (18.0..=20.5).contains(&lon)
}

fn hm_secs(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let h = parse_int_strict_str(parts.next()?)?;
    let m = parse_int_strict_str(parts.next()?)?;
    Some(h * 3600.0 + m * 60.0)
}

/// `hhmmToSecs`: "HH:MM[:SS]" -> seconds since midnight (seconds ignored), None for anything else.
pub fn hhmm_to_secs(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::String(s)) if s.contains(':') => hm_secs(s),
        _ => None,
    }
}

/// `rowDepartureSecs`: a departures row's `static_time`, else `time`, when it is "HH:MM"; None = imminent.
pub fn row_departure_secs(row: &UpstreamRecord) -> Option<f64> {
    ["static_time", "time"].iter().find_map(|k| hhmm_to_secs(row.get(*k)))
}

/// JS `Number(v)` of a non-null JSON value.
pub(crate) fn js_number_of(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js::number(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Array(_) => js::number(&js::value_to_string(Some(v))),
        Value::Null => 0.0,
        Value::Object(_) => f64::NAN,
    }
}

/// `toInt`: Python `int(x or default)` with a fallback for anything not numeric.
fn to_int(v: Option<&Value>, def: f64) -> f64 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js::number(s),
        _ => f64::NAN,
    };
    if n.is_finite() { n.trunc() } else { def }
}

/// `isIdx`: the value when it is an integral JSON number.
fn idx(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.fract() == 0.0),
        _ => None,
    }
}

fn in_range(i: Option<f64>, n: usize) -> Option<f64> {
    i.filter(|&i| i >= 0.0 && i < n as f64)
}

fn target_idx(vti: Option<f64>, ndi: Option<f64>, n: usize) -> Option<f64> {
    in_range(ndi, n).or_else(|| in_range(vti, n))
}

/// `kbNextStopIndex`: next_departure_index, else vehicle_trip_index, one further while the bus sits in that
/// stop's zone; None when out of range.
pub fn kb_next_stop_index(vti: Option<&Value>, ndi: Option<&Value>, at_stop: bool, n: usize) -> Option<i64> {
    let vti = idx(vti);
    let target = target_idx(vti, idx(ndi), n)?;
    let i = if at_stop && vti == Some(target) {
        target + 1.0
    } else {
        target
    };
    in_range(Some(i), n).map(|i| i as i64)
}

/// `isFeedStale`: no live delay from upstream (the raw value when GPS replaced it) and not moved for `stale_sec`.
pub fn is_feed_stale(v: &VehiclePos, now_epoch: f64, stale_sec: f64) -> bool {
    let raw = v.delay_up.unwrap_or(v.delay);
    raw.is_none() && now_epoch - v.last_moved_at > stale_sec
}

/// The stop signal is set, or its sender is gone (nothing can stop the loop any more: treated as stopped).
pub(crate) fn aborted(rx: &watch::Receiver<bool>) -> bool {
    *rx.borrow() || rx.has_changed().is_err()
}

/// `interruptibleSleep`: sleeps `ms` (Node's setTimeout coercion: outside 1..=2^31-1 or NaN = 1 ms), returns early
/// once the stop signal turns true or its sender is dropped.
pub async fn interruptible_sleep(ms: f64, stop: &mut watch::Receiver<bool>) {
    if aborted(stop) {
        return;
    }
    let ms = if (1.0..=2_147_483_647.0).contains(&ms) { ms } else { 1.0 };
    tokio::select! {
        () = tokio::time::sleep(Duration::from_secs_f64(ms / 1000.0)) => {}
        _ = stop.wait_for(|&s| s) => {}
    }
}

pub(crate) fn panic_msg(p: &(dyn Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_default()
}

fn js_opt(v: Option<f64>) -> String {
    v.map_or_else(|| "null".to_owned(), js::number_to_string)
}

fn times_of(resp: &UpstreamRecord) -> &[Value] {
    match as_record(resp.get("trip")).get("times") {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

fn plan_of(times: &[Value]) -> Vec<Option<f64>> {
    times
        .iter()
        .map(|t| hhmm_to_secs(as_record(Some(t)).get("departure_time")))
        .collect()
}

/// Snapshot of poller liveness/feed state for GET /api/health (`PollerHealth`).
#[derive(Debug, Clone, PartialEq)]
pub struct PollerHealth {
    pub started_at: f64,
    pub stops: usize,
    pub scan_count: u64,
    pub last_scan: f64,
    pub last_refresh: f64,
    /// epoch secs of the last proven upstream contact
    pub last_good_refresh: f64,
    /// positions incl. hidden ghosts
    pub tracked: usize,
    /// what the map shows
    pub live: usize,
    pub loop_restarts: u64,
    pub last_loop_error: Option<String>,
    pub last_loop_error_at: f64,
    pub stops_loaded_at: f64,
    /// vehicles whose upstream stop index is detected stale (delay_src set)
    pub stale_index: usize,
    pub gps_polls: u64,
    pub gps_disagree: u64,
}

/// `LivePollerOptions`: None = the `config::LIVE_*` default.
#[derive(Default, Clone)]
pub struct LivePollerOptions {
    pub scan_interval: Option<f64>,
    pub refresh_interval: Option<f64>,
    pub horizon: Option<f64>,
    pub cache404: Option<f64>,
    pub stop_empty_cache: Option<f64>,
    pub stop_far_cache: Option<f64>,
    pub stop_far_threshold: Option<f64>,
    pub smart_scan_interval: Option<f64>,
    pub smart_scan_window: Option<f64>,
    pub batch_size: Option<usize>,
    pub shapes: Option<Arc<dyn KbShapeSink>>,
}

/// A tracked position plus the epoch ms its upstream request was issued (`reqAt`, dies with the position).
pub(crate) struct Tracked {
    pub pos: Arc<VehiclePos>,
    pub req_at: i64,
}

pub(crate) struct ExecTrip {
    pub trip: String,
    pub seen: f64,
}

/// One `patternMemo` entry plus its `straightMemo` geometry (None = not computed yet).
pub(crate) struct MemoEntry {
    pub pattern: Option<Arc<KbPattern>>,
    pub straight: Option<Option<Arc<ProgressGeom>>>,
}

/// The stop list with its two lookups, swapped as one value.
#[derive(Default)]
pub(crate) struct StopIndex {
    pub list: Arc<Vec<Stop>>,
    pub by_id: HashMap<i64, usize>,
    pub by_url_id: HashMap<String, usize>,
}

impl StopIndex {
    pub fn new(stops: Vec<Stop>) -> Self {
        let mut by_id = HashMap::with_capacity(stops.len());
        let mut by_url_id = HashMap::with_capacity(stops.len());
        for (i, s) in stops.iter().enumerate() {
            by_id.insert(s.internal_id, i);
            by_url_id.insert(s.url_id.clone(), i);
        }
        StopIndex {
            list: Arc::new(stops),
            by_id,
            by_url_id,
        }
    }

    /// `stopCoords` / `resolveStop`: an integral `designator` by internal id, else a string `place_id` by url id.
    pub fn find(&self, t: &UpstreamRecord) -> Option<&Stop> {
        let by_id = idx(t.get("designator")).and_then(|d| self.by_id.get(&(d as i64)));
        let i = by_id.or_else(|| match t.get("place_id") {
            Some(Value::String(p)) => self.by_url_id.get(p),
            _ => None,
        })?;
        self.list.get(*i)
    }
}

/// Every mutable `LivePoller` field (one lock, never held across an await).
#[derive(Default)]
pub(crate) struct State {
    pub stops: StopIndex,
    /// insertion-ordered like the TS Map: the snapshot order
    pub positions: IndexMap<String, Tracked>,
    pub last_scan: f64,
    pub last_refresh: f64,
    pub scan_count: u64,
    pub started_at: f64,
    pub loop_restarts: u64,
    pub last_loop_error: Option<String>,
    pub last_loop_error_at: f64,
    pub snapshot_version: u64,
    pub last_good_refresh: f64,
    pub json_cache: Option<(String, Arc<VehiclesResponse>)>,
    pub pb_cache: Option<(String, Arc<Vec<u8>>)>,
    /// exec id -> epoch secs of the observed 404
    pub not_found: HashMap<String, f64>,
    /// exec id -> static trip id from a departures board; FIFO-capped at EXEC_TRIP_MAX
    pub exec_trip: IndexMap<String, ExecTrip>,
    /// stop url id -> epoch secs before which it is not rescanned
    pub stop_rescan_at: HashMap<String, f64>,
    /// stop url id -> earliest scheduled departure (secs since midnight)
    pub stop_earliest: HashMap<String, f64>,
    pub shapes: Option<Arc<dyn KbShapeSink>>,
    pub pattern_memo: HashMap<String, MemoEntry>,
    pub route_err_logged_at: i64,
    pub progress_err_logged_at: i64,
    pub gps_polls: u64,
    pub gps_disagree: u64,
    pub started: bool,
    pub stop_tx: Option<watch::Sender<bool>>,
    pub run_task: Option<tokio::task::JoinHandle<()>>,
    pub stops_reload_in_flight: bool,
    pub stops_loaded_at: f64,
}

/// `carryMotion`: keep the movement anchor until the bus leaves the epsilon, heading from moves of >= 8 m.
fn carry_motion(pos: &mut VehiclePos, prev: &VehiclePos) {
    let moved = meters_between(pos.lat, pos.lon, prev.anchor_lat, prev.anchor_lon);
    if moved > *config::LIVE_STALE_MOVE_EPS_M as f64 {
        pos.anchor_lat = pos.lat;
        pos.anchor_lon = pos.lon;
        pos.last_moved_at = pos.updated_at;
    } else {
        pos.anchor_lat = prev.anchor_lat;
        pos.anchor_lon = prev.anchor_lon;
        pos.last_moved_at = prev.last_moved_at;
    }
    if meters_between(pos.lat, pos.lon, prev.lat, prev.lon) >= 8.0 {
        if let Some(b) = bearing(prev.lat, prev.lon, pos.lat, pos.lon) {
            pos.bearing = Some(b);
        }
    } else if prev.bearing.is_some() {
        pos.bearing = prev.bearing;
    }
}

fn is_stale(v: &VehiclePos, now_epoch: f64) -> bool {
    is_feed_stale(v, now_epoch, *config::LIVE_STALE_VEHICLE_SEC as f64)
}

fn is_live(v: &VehiclePos, now_epoch: f64) -> bool {
    !v.finished && !is_stale(v, now_epoch) && now_epoch - v.updated_at <= *config::LIVE_STALE_VEHICLE_SEC as f64
}

fn pattern_sig(times: &[Value], line: &str, dir: &str) -> String {
    let parts: Vec<String> = times
        .iter()
        .map(|t| {
            let r = as_record(Some(t));
            match (idx(r.get("designator")), r.get("place_id")) {
                (Some(d), _) => js::number_to_string(d),
                (None, Some(Value::String(p))) => format!("p{p}"),
                _ => "?".to_owned(),
            }
        })
        .collect();
    format!("{line}\u{1}{dir}\u{1}{}", parts.join(","))
}

impl State {
    /// `kbPatternFor`'s memo slot (cleared wholesale at PATTERN_MEMO_MAX and on every stop reload).
    fn pattern_slot(&mut self, times: &[Value], line: &str, dir: &str) -> &mut MemoEntry {
        let sig = pattern_sig(times, line, dir);
        if self.pattern_memo.len() >= PATTERN_MEMO_MAX && !self.pattern_memo.contains_key(&sig) {
            self.pattern_memo.clear();
        }
        let stops = &self.stops;
        match self.pattern_memo.entry(sig) {
            Entry::Occupied(e) => e.into_mut(),
            Entry::Vacant(e) => {
                let pattern = build_kb_pattern(times, line, dir, |t| {
                    stops.find(as_record(Some(t))).map(|s| ResolvedStop {
                        id: s.stop_id.clone(),
                        lat: s.lat,
                        lon: s.lon,
                    })
                });
                e.insert(MemoEntry {
                    pattern: pattern.map(Arc::new),
                    straight: None,
                })
            }
        }
    }

    /// `parsePosition` (exact port of _parse_position): None for a reply without a usable fix.
    fn parse_position(&self, eid: &str, resp: &UpstreamRecord, now_ms: i64) -> Option<VehiclePos> {
        let trip = as_record(resp.get("trip"));
        let vehicle = as_record(resp.get("vehicle"));
        let lat = vehicle.get("lat").filter(|v| !v.is_null()).map(js_number_of)?;
        let lon = vehicle.get("lon").filter(|v| !v.is_null()).map(js_number_of)?;
        if !lat.is_finite() || !lon.is_finite() || !in_service_area(lat, lon) {
            return None;
        }

        let line = as_record(trip.get("line"));
        let line_name = if py_truthy(line.get("name")) {
            js::value_to_string(line.get("name"))
        } else {
            String::new()
        };
        let times = times_of(resp);
        let n = times.len();
        let vti_raw = resp.get("vehicle_trip_index");
        let ndi_raw = resp.get("next_departure_index");
        let vti = idx(vti_raw);
        let at_stop = py_truthy(resp.get("at_stop"));

        let mut delay = None;
        let first_est = match resp.get("estimates") {
            Some(Value::Object(o)) => Some(o),
            Some(Value::Array(a)) => a.first().map(|e| as_record(Some(e))),
            _ => None,
        };
        if let Some(first) = first_est
            && let Some(t) = target_idx(vti, idx(ndi_raw), n)
        {
            let sched = hhmm_to_secs(as_record(times.get(t as usize)).get("departure_time"));
            if let (Some(arr), Some(sched)) = (hhmm_to_secs(first.get("arrival_abs")), sched) {
                let mut raw = arr - sched;
                if raw > 43200.0 {
                    raw -= 86400.0;
                } else if raw < -43200.0 {
                    raw += 86400.0;
                }
                delay = Some(raw.trunc());
            }
        }
        let vti_entry = in_range(vti, n).and_then(|i| match times.get(i as usize) {
            Some(Value::Object(o)) => Some(o),
            _ => None,
        });
        if delay.is_none()
            && let Some(entry) = vti_entry
            && let Some(Value::Number(td)) = as_record(entry.get("estimate")).get("time_diff")
        {
            delay = td.as_f64().map(f64::trunc);
        }

        let next_idx = kb_next_stop_index(vti_raw, ndi_raw, at_stop, n);
        let (mut next_name, mut next_lat, mut next_lon) = (None, None, None);
        if let Some(i) = next_idx
            && let Some(Value::Object(entry)) = times.get(i as usize)
            && let Some(s) = self.stops.find(entry)
        {
            next_name = Some(if py_truthy(entry.get("stop_name")) {
                js::value_to_string(entry.get("stop_name"))
            } else {
                String::new()
            });
            next_lat = Some(s.lat);
            next_lon = Some(s.lon);
        }

        let mut trip_id = String::new();
        if let Some(entry) = vti_entry {
            let cand = if py_truthy(entry.get("trip_id")) {
                entry.get("trip_id")
            } else if py_truthy(resp.get("trip_id")) {
                resp.get("trip_id")
            } else {
                None
            };
            trip_id = cand.map(|c| js::value_to_string(Some(c))).unwrap_or_default();
        }
        if trip_id.is_empty() {
            // str((resp["trip_id"] or eid.split(":")[1]) if ":" in eid else eid)
            trip_id = if eid.contains(':') {
                if py_truthy(resp.get("trip_id")) {
                    js::value_to_string(resp.get("trip_id"))
                } else {
                    eid.split(':').nth(1).unwrap_or_default().to_owned()
                }
            } else {
                eid.to_owned()
            };
        }

        let vehicle_type = if py_truthy(resp.get("vehicle_type")) {
            to_int(resp.get("vehicle_type"), 0.0)
        } else if py_truthy(trip.get("vehicle_type")) {
            to_int(trip.get("vehicle_type"), 0.0)
        } else {
            0.0
        };
        let now_epoch = now_ms as f64 / 1000.0;
        let timestamp = if py_truthy(resp.get("timestamp")) {
            to_int(resp.get("timestamp"), now_epoch.floor())
        } else {
            now_epoch.floor()
        };
        // course over once the bus sits at (or past) its last scheduled stop
        let finished = at_stop && n > 0 && vti.is_some_and(|v| v >= (n - 1) as f64);
        Some(VehiclePos {
            exec_id: eid.to_owned(),
            trip_id,
            route_id: if line_name.is_empty() {
                String::new()
            } else {
                format!("L_{line_name}")
            },
            line: line_name,
            headsign: if py_truthy(trip.get("direction")) {
                js::value_to_string(trip.get("direction"))
            } else {
                String::new()
            },
            lat,
            lon,
            vehicle_type: vehicle_type as i32,
            // ponytail: an integral index beyond i64 saturates (TS keeps the double); garbage upstream data only
            current_stop_sequence: vti.map(|v| v as i64),
            at_stop,
            delay,
            timestamp,
            updated_at: now_epoch,
            bearing: None,
            next_stop_name: next_name,
            next_stop_lat: next_lat,
            next_stop_lon: next_lon,
            last_moved_at: now_epoch,
            anchor_lat: lat,
            anchor_lon: lon,
            finished,
            next_stop_seq: next_idx,
            ..VehiclePos::default()
        })
    }

    /// `attachProgress`: GPS progress replaces an upstream delay frozen by a stalled stop index. Returns the GPS
    /// last-passed stop index (None = unplaced). A panic inside leaves upstream's value, like the TS catch.
    fn attach_progress(
        &mut self,
        pos: &mut VehiclePos,
        prev: Option<&VehiclePos>,
        resp: &UpstreamRecord,
        now_ms: i64,
    ) -> Option<i64> {
        pos.delay_up = Some(pos.delay);
        if !*config::GPS_DELAY {
            return None;
        }
        match catch_unwind(AssertUnwindSafe(|| self.progress_inner(pos, prev, resp, now_ms))) {
            Ok(r) => r,
            Err(p) => {
                pos.delay = pos.delay_up.flatten();
                pos.delay_src = None;
                pos.geo_last_seq = None;
                pos.geo_next_seq = None;
                if now_ms - self.progress_err_logged_at > ERR_LOG_EVERY_MS {
                    self.progress_err_logged_at = now_ms;
                    logger::error(
                        TAG,
                        format_args!("gps progress failed for {}: {}", pos.exec_id, panic_msg(&*p)),
                    );
                }
                None
            }
        }
    }

    fn progress_inner(
        &mut self,
        pos: &mut VehiclePos,
        prev: Option<&VehiclePos>,
        resp: &UpstreamRecord,
        now_ms: i64,
    ) -> Option<i64> {
        let times = times_of(resp);
        let slot = self.pattern_slot(times, &pos.line, &pos.headsign);
        let pattern = slot.pattern.clone()?;
        let geom = slot
            .straight
            .get_or_insert_with(|| straight_geom(&pattern.stop_pts).map(Arc::new))
            .clone()?;
        let plan = plan_of(times);
        let ts = Timestamp::from_millisecond(now_ms).unwrap_or(Timestamp::UNIX_EPOCH);
        let o = step_kb_progress(
            &KbProgIn {
                geom: &geom,
                plan: &plan,
                lat: pos.lat,
                lon: pos.lon,
                t_epoch: pos.updated_at,
                local_secs: f64::from(agency_clock(ts).1),
                vti: pos.current_stop_sequence,
                next_up: pos.next_stop_seq,
                delay_up: pos.delay,
            },
            prev.and_then(|p| p.prog.as_ref()),
        );
        if let Some(s) = o.state {
            pos.prog = Some(s);
        }
        let delay_up = pos.delay_up.flatten();
        if let Some(dev) = o.dev {
            self.gps_polls += 1;
            if !o.stale && delay_up.is_some_and(|up| (dev - up).abs() >= 120.0) {
                self.gps_disagree += 1;
            }
        }
        if o.stale && prev.is_none_or(|p| p.delay_src.is_none()) {
            logger::info(
                TAG,
                format_args!(
                    "stale stop index: {} line {} vti {} upstream {}s -> gps {}s (last stop {})",
                    pos.exec_id,
                    pos.line,
                    js_opt(pos.current_stop_sequence.map(|v| v as f64)),
                    js_opt(delay_up),
                    o.delay
                        .map_or_else(|| "?".to_owned(), |d| js::number_to_string(js::round(d))),
                    js_opt(o.last_idx.map(|v| v as f64)),
                ),
            );
        }
        match o.src {
            DelaySrc::Gps | DelaySrc::GpsHeld => {
                pos.delay = o.delay.map(js::round);
                pos.delay_src = Some(o.src);
            }
            DelaySrc::Unknown => {
                pos.delay = None;
                pos.delay_src = Some(DelaySrc::Unknown);
            }
            DelaySrc::Est => {}
        }
        if o.stale
            && let Some(last) = o.last_idx
            && last >= 0
        {
            pos.geo_last_seq = Some(last);
            pos.geo_next_seq = o.next_idx.map(|i| i as i64);
        }
        if o.finished {
            pos.finished = true;
        }
        o.last_idx
    }

    /// `attachArrivals`: the stop arrival log, bounded by the trip's stop count.
    fn attach_arrivals(pos: &mut VehiclePos, prev: Option<&VehiclePos>, gps_last: Option<i64>, resp: &UpstreamRecord) {
        let n = times_of(resp).len() as i64;
        let up = pos.current_stop_sequence.filter(|&c| c < n).unwrap_or(-1);
        let reached = up.max(gps_last.unwrap_or(-1));
        pos.arrivals = Some(step_arrivals(
            prev.and_then(|p| p.arrivals.as_ref()),
            reached,
            pos.updated_at,
            pos.fix_at.unwrap_or(pos.updated_at),
        ));
    }

    /// `attachRouteInfo`: shape key, fix time, along-route distance and cruise speed. A panic inside ships the
    /// vehicle without route info, like the TS catch.
    fn attach_route_info(
        &mut self,
        pos: &mut VehiclePos,
        prev: Option<&VehiclePos>,
        resp: &UpstreamRecord,
        prio: ShapePrio,
        refresh_interval: f64,
        now_ms: i64,
    ) {
        let res = catch_unwind(AssertUnwindSafe(|| {
            self.route_inner(pos, prev, resp, prio, refresh_interval)
        }));
        if let Err(p) = res {
            pos.shape_key = None;
            pos.dist_m = None;
            if now_ms - self.route_err_logged_at > ERR_LOG_EVERY_MS {
                self.route_err_logged_at = now_ms;
                logger::error(
                    TAG,
                    format_args!("route info failed for {}: {}", pos.exec_id, panic_msg(&*p)),
                );
            }
        }
    }

    fn route_inner(
        &mut self,
        pos: &mut VehiclePos,
        prev: Option<&VehiclePos>,
        resp: &UpstreamRecord,
        prio: ShapePrio,
        refresh_interval: f64,
    ) {
        let moved = prev.is_none_or(|p| (pos.lat - p.lat).abs() > 1e-7 || (pos.lon - p.lon).abs() > 1e-7);
        let fix_at = estimate_fix_at(
            prev.map(|p| PrevFix {
                fix_at: p.fix_at,
                updated_at: p.updated_at,
            }),
            pos.updated_at,
            moved,
            (3.0 * refresh_interval).max(30.0),
        );
        pos.fix_at = Some(fix_at);
        if let Some(shapes) = self.shapes.clone() {
            let times = times_of(resp);
            let pattern = self.pattern_slot(times, &pos.line, &pos.headsign).pattern.clone();
            pos.shape_key = pattern.as_ref().map(|p| p.key.clone());
            if let Some(p) = &pattern {
                shapes.touch_kb(p, prio);
            }
            let geom = pos
                .shape_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .and_then(|k| shapes.geometry(k));
            if let Some(g) = geom {
                let same_shape =
                    prev.is_some_and(|p| p.shape_key == pos.shape_key && p.dist_rev.as_ref() == Some(&g.rev));
                if moved || !same_shape {
                    let hint = prev.filter(|_| same_shape).and_then(|p| p.dist_m);
                    // continuity first; while upstream's index is stale the GPS indices keep the vti window honest
                    pos.dist_m = kb_dist_along(
                        &g,
                        pos.lat,
                        pos.lon,
                        pos.geo_last_seq.or(pos.current_stop_sequence),
                        pos.geo_next_seq.or(pos.next_stop_seq),
                        hint,
                        Some(kb_ahead_m(prev.map_or(0.0, |p| pos.updated_at - p.updated_at))),
                    );
                    pos.dist_rev = Some(g.rev.clone());
                } else if let Some(p) = prev {
                    pos.dist_m = p.dist_m;
                    pos.dist_rev = p.dist_rev.clone();
                }
                if let Some(d) = pos.dist_m
                    && g.stops.len() == times.len()
                {
                    pos.sched_speed = sched_speed(&g.stops, &plan_of(times), d);
                }
            }
        }
        let Some(p) = prev else { return };
        if !moved {
            pos.move_ds = p.move_ds;
            pos.speed = p.speed;
            pos.speed_at = p.speed_at;
            return;
        }
        let ds = match (pos.dist_m, p.dist_m) {
            (Some(d), Some(pd)) if p.shape_key == pos.shape_key && p.dist_rev == pos.dist_rev => d - pd,
            _ => meters_between(p.lat, p.lon, pos.lat, pos.lon),
        };
        let prev_fix = p.fix_at.unwrap_or(p.updated_at);
        let v = next_speed(
            p.speed,
            p.move_ds,
            ds,
            fix_at - prev_fix,
            p.updated_at - prev_fix,
            p.at_stop || pos.at_stop,
        );
        pos.move_ds = Some(ds);
        pos.speed = v.or(p.speed);
        pos.speed_at = if v.is_some() { Some(fix_at) } else { p.speed_at };
    }

    /// `pruneDead`: drop finished, frozen and long-unrefreshed vehicles.
    pub(crate) fn prune_dead(&mut self, now_epoch: f64) {
        let hard_max = *config::LIVE_STALE_VEHICLE_SEC as f64 * 3.0;
        let before = self.positions.len();
        self.positions.retain(|_, t| {
            let v = &t.pos;
            !(v.finished || is_stale(v, now_epoch) || now_epoch - v.updated_at > hard_max)
        });
        if self.positions.len() != before {
            self.snapshot_version += 1;
        }
    }

    /// `sweepExpired`: evict expired 404 markers and exec -> trip notes unseen for EXEC_TRIP_TTL_SEC.
    pub(crate) fn sweep_expired(&mut self, now_ms: i64, cache404: f64) {
        let now_ts = (now_ms as f64 / 1000.0).floor();
        let cut = now_ts - cache404;
        self.not_found.retain(|_, ts| *ts > cut);
        let trip_cut = now_ts - EXEC_TRIP_TTL_SEC;
        let positions = &self.positions;
        self.exec_trip
            .retain(|eid, e| e.seen > trip_cut || positions.contains_key(eid));
    }

    /// `noteExecTrip`: remember the static trip a board listed `eid` with; the oldest note goes past the cap.
    pub(crate) fn note_exec_trip(&mut self, eid: &str, trip: String, now_ts: f64) {
        if let Some(cur) = self.exec_trip.get_mut(eid) {
            cur.trip = trip;
            cur.seen = now_ts;
            return;
        }
        if self.exec_trip.len() >= EXEC_TRIP_MAX {
            // ponytail: O(n) shift of a 20k map per insert at the cap; reached only on a pathological day
            self.exec_trip.shift_remove_index(0);
        }
        self.exec_trip.insert(eid.to_owned(), ExecTrip { trip, seen: now_ts });
    }

    /// The common tail of fetchPositions and ingestTripExecution: parse, carry motion, GPS progress, route info
    /// (urgent), arrivals, static trip id, store with `req_ms`, clear the 404 mark. None = unparseable reply (the
    /// previous position stays). The caller checks `req_at` first and bumps `snapshot_version`.
    pub(crate) fn apply_position(
        &mut self,
        eid: &str,
        resp: &UpstreamRecord,
        req_ms: i64,
        now_ms: i64,
        refresh_interval: f64,
    ) -> Option<Arc<VehiclePos>> {
        let mut pos = self.parse_position(eid, resp, now_ms)?;
        let prev = self.positions.get(eid).map(|t| Arc::clone(&t.pos));
        let prev = prev.as_deref();
        if let Some(p) = prev {
            carry_motion(&mut pos, p);
        }
        let gps_last = self.attach_progress(&mut pos, prev, resp, now_ms);
        self.attach_route_info(&mut pos, prev, resp, ShapePrio::Urgent, refresh_interval, now_ms);
        Self::attach_arrivals(&mut pos, prev, gps_last, resp);
        pos.sched_trip_id = self.exec_trip.get(eid).map(|e| e.trip.clone());
        let pos = Arc::new(pos);
        self.positions.insert(
            eid.to_owned(),
            Tracked {
                pos: Arc::clone(&pos),
                req_at: req_ms,
            },
        );
        self.not_found.remove(eid);
        Some(pos)
    }

    /// `reqAt` of the stored position (0 when none, like `?? 0`).
    pub(crate) fn req_at(&self, eid: &str) -> i64 {
        self.positions.get(eid).map_or(0, |t| t.req_at)
    }

    fn live(&self, now_epoch: f64) -> impl Iterator<Item = &Arc<VehiclePos>> {
        self.positions
            .values()
            .map(|t| &t.pos)
            .filter(move |v| is_live(v, now_epoch))
    }

    fn snapshot_key(&self, now_epoch: f64) -> String {
        format!(
            "{}:{}",
            self.snapshot_version,
            js::number_to_string((now_epoch / 5.0).floor())
        )
    }

    /// The stop-list swap of `loadStops` (a non-empty list): lookups, pattern memo cleared, scan state of vanished
    /// stops dropped. Returns the previous stop count.
    pub(crate) fn install_stops(&mut self, stops: Vec<Stop>, now_ms: i64) -> usize {
        let prev = self.stops.list.len();
        self.stops = StopIndex::new(stops);
        self.pattern_memo.clear();
        let by_url = &self.stops.by_url_id;
        self.stop_rescan_at.retain(|k, _| by_url.contains_key(k));
        self.stop_earliest.retain(|k, _| by_url.contains_key(k));
        self.stops_loaded_at = now_ms as f64 / 1000.0;
        prev
    }
}

/// `LivePoller`: KB scraper state behind one lock. Construction starts nothing; `start()` (4b) runs the loop.
pub struct LivePoller<S> {
    pub api: S,
    pub scan_interval: f64,
    pub refresh_interval: f64,
    pub horizon: f64,
    pub cache404: f64,
    pub stop_empty_cache: f64,
    pub stop_far_cache: f64,
    pub stop_far_threshold: f64,
    pub smart_scan_interval: f64,
    pub smart_scan_window: f64,
    pub batch_size: usize,
    now: NowFn,
    state: Mutex<State>,
}

impl<S: KbSource> LivePoller<S> {
    pub fn new(api: S, opts: LivePollerOptions) -> Self {
        let now: NowFn = Arc::new(|| Timestamp::now().as_millisecond());
        let state = State {
            last_good_refresh: (now() as f64 / 1000.0).floor(),
            shapes: opts.shapes,
            ..State::default()
        };
        let secs = |o: Option<f64>, d: &std::sync::LazyLock<i64>| o.unwrap_or(**d as f64);
        LivePoller {
            api,
            scan_interval: secs(opts.scan_interval, &config::LIVE_FULL_SCAN_INTERVAL),
            refresh_interval: secs(opts.refresh_interval, &config::LIVE_REFRESH_INTERVAL),
            horizon: secs(opts.horizon, &config::LIVE_CANDIDATE_HORIZON_SEC),
            cache404: secs(opts.cache404, &config::LIVE_404_CACHE_SEC),
            stop_empty_cache: secs(opts.stop_empty_cache, &config::LIVE_STOP_EMPTY_CACHE_SEC),
            stop_far_cache: secs(opts.stop_far_cache, &config::LIVE_STOP_FAR_CACHE_SEC),
            stop_far_threshold: secs(opts.stop_far_threshold, &config::LIVE_STOP_FAR_THRESHOLD_SEC),
            smart_scan_interval: secs(opts.smart_scan_interval, &config::LIVE_SMART_SCAN_INTERVAL),
            smart_scan_window: secs(opts.smart_scan_window, &config::LIVE_SMART_SCAN_WINDOW_SEC),
            batch_size: opts
                .batch_size
                .unwrap_or(usize::try_from(*config::LIVE_BATCH_SIZE).unwrap_or(6)),
            now,
            state: Mutex::new(state),
        }
    }

    /// Injected clock (epoch ms) for tests; also re-stamps `last_good_refresh` like construction under that clock.
    pub fn with_now(mut self, now: NowFn) -> Self {
        let st = self.state.get_mut().unwrap_or_else(PoisonError::into_inner);
        st.last_good_refresh = (now() as f64 / 1000.0).floor();
        self.now = now;
        self
    }

    pub fn now_ms(&self) -> i64 {
        (self.now)()
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `poller.shapes = ...` (poller-singleton attaches the shape store after construction).
    pub fn set_shapes(&self, shapes: Option<Arc<dyn KbShapeSink>>) {
        self.state().shapes = shapes;
    }

    /// `kbPatternFor`: road-shape pattern for a trip's times, memoized per stop list.
    pub fn kb_pattern_for(&self, times: &[Value], line: &str, dir: &str) -> Option<Arc<KbPattern>> {
        self.state().pattern_slot(times, line, dir).pattern.clone()
    }

    /// `liveVehicles`: not finished, not frozen, refreshed within LIVE_STALE_VEHICLE_SEC; insertion order.
    pub fn live_vehicles(&self, now_epoch: f64) -> Vec<Arc<VehiclePos>> {
        self.state().live(now_epoch).cloned().collect()
    }

    pub fn live_count(&self) -> usize {
        let now_epoch = self.now_ms() as f64 / 1000.0;
        self.state().live(now_epoch).count()
    }

    /// `ingestTripExecution`: a viewer's trip_execution reply into the live positions. `req_ms` = when the caller
    /// asked upstream (None = now); a reply to an older request than the stored one returns the stored position.
    pub fn ingest_trip_execution(&self, eid: &str, resp: &Value, req_ms: Option<i64>) -> Option<Arc<VehiclePos>> {
        if !py_truthy(Some(resp)) {
            return None;
        }
        let now_ms = self.now_ms();
        let req_ms = req_ms.unwrap_or(now_ms);
        let mut st = self.state();
        if let Some(t) = st.positions.get(eid)
            && t.req_at > req_ms
        {
            return Some(Arc::clone(&t.pos));
        }
        let pos = st.apply_position(eid, as_record(Some(resp)), req_ms, now_ms, self.refresh_interval)?;
        st.last_good_refresh = (now_ms as f64 / 1000.0).floor();
        st.snapshot_version += 1;
        Some(pos)
    }

    /// `healthSnapshot` for GET /api/health.
    pub fn health_snapshot(&self) -> PollerHealth {
        let now_epoch = self.now_ms() as f64 / 1000.0;
        let st = self.state();
        PollerHealth {
            started_at: st.started_at,
            stops: st.stops.list.len(),
            scan_count: st.scan_count,
            last_scan: st.last_scan,
            last_refresh: st.last_refresh,
            last_good_refresh: st.last_good_refresh,
            tracked: st.positions.len(),
            live: st.live(now_epoch).count(),
            loop_restarts: st.loop_restarts,
            last_loop_error: st.last_loop_error.clone(),
            last_loop_error_at: st.last_loop_error_at,
            stops_loaded_at: st.stops_loaded_at,
            stale_index: st.positions.values().filter(|t| t.pos.delay_src.is_some()).count(),
            gps_polls: st.gps_polls,
            gps_disagree: st.gps_disagree,
        }
    }

    /// `snapshotKey`: positions version + 5 s time bucket.
    pub fn snapshot_key(&self, now_epoch: f64) -> String {
        self.state().snapshot_key(now_epoch)
    }

    /// `toJson`: the `/api/vehicles` body without route extras (memoized per snapshot key).
    pub fn to_json(&self) -> Arc<VehiclesResponse> {
        let now_epoch = self.now_ms() as f64 / 1000.0;
        let mut st = self.state();
        let key = st.snapshot_key(now_epoch);
        if let Some((k, v)) = &st.json_cache
            && *k == key
        {
            return Arc::clone(v);
        }
        let vehicles: Vec<_> = st.live(now_epoch).map(|v| vehicle_to_json(v)).collect();
        let value = Arc::new(VehiclesResponse {
            timestamp: js::JsNum(st.last_good_refresh),
            scan_count: st.scan_count,
            last_scan: js::JsNum(st.last_scan),
            count: vehicles.len(),
            vehicles,
        });
        st.json_cache = Some((key, Arc::clone(&value)));
        value
    }

    /// `toProtobuf`: GTFS-RT VehiclePositions of the live vehicles (memoized per snapshot key).
    pub fn to_protobuf(&self) -> Arc<Vec<u8>> {
        let now_epoch = self.now_ms() as f64 / 1000.0;
        let mut st = self.state();
        let key = st.snapshot_key(now_epoch);
        if let Some((k, v)) = &st.pb_cache
            && *k == key
        {
            return Arc::clone(v);
        }
        let feed: Vec<FeedVehicle> = st
            .live(now_epoch)
            .map(|v| FeedVehicle {
                exec_id: &v.exec_id,
                trip_id: &v.trip_id,
                route_id: &v.route_id,
                line: &v.line,
                lat: v.lat,
                lon: v.lon,
                bearing: v.bearing,
                timestamp: v.timestamp,
                current_stop_sequence: v.current_stop_sequence.map(|c| c as f64),
                at_stop: v.at_stop,
            })
            .collect();
        let value = Arc::new(vehicle_positions_feed(&feed, st.last_good_refresh));
        drop(feed);
        st.pb_cache = Some((key, Arc::clone(&value)));
        value
    }

    /// Driven directly by tests: the stored position (`positions.get`), identity via `Arc::ptr_eq`.
    pub fn position(&self, eid: &str) -> Option<Arc<VehiclePos>> {
        self.state().positions.get(eid).map(|t| Arc::clone(&t.pos))
    }

    /// Driven directly by tests: `positions.size` (hidden ghosts included).
    pub fn positions_len(&self) -> usize {
        self.state().positions.len()
    }

    /// Driven directly by tests: the 404 stamp of `eid` (`notFound.get`).
    pub fn not_found(&self, eid: &str) -> Option<f64> {
        self.state().not_found.get(eid).copied()
    }

    /// The current stop list (`poller.stops`).
    pub fn stops(&self) -> Arc<Vec<Stop>> {
        Arc::clone(&self.state().stops.list)
    }

    /// Driven directly by tests: `poller.stopsLoadedAt = x` (0 = the daily reload is due).
    pub fn set_stops_loaded_at(&self, secs: f64) {
        self.state().stops_loaded_at = secs;
    }
}

/// Clears `stops_reload_in_flight` when `load_stops` ends, also when its future is dropped mid-fetch (the TS
/// `finally`), so a cancelled caller cannot block every later reload.
struct ReloadFlag<'a>(&'a Mutex<State>);

impl Drop for ReloadFlag<'_> {
    fn drop(&mut self) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .stops_reload_in_flight = false;
    }
}

impl<S: KbSource> LivePoller<S> {
    fn now_s(&self) -> f64 {
        self.now_ms() as f64 / 1000.0
    }

    /// `loadStops`: fetch the stop list and swap it in atomically. Ok(false) = a reload already in flight or an
    /// empty list (the previous list stays); Err = the fetch failed (the previous list stays).
    pub async fn load_stops(&self) -> Result<bool, String> {
        {
            let mut st = self.state();
            if st.stops_reload_in_flight {
                return Ok(false);
            }
            st.stops_reload_in_flight = true;
        }
        let _flag = ReloadFlag(&self.state);
        let rev = self.api.fetch_revision().await;
        let stops = self.api.fetch_stops(Some(&rev)).await?;
        if stops.is_empty() {
            logger::error(TAG, "stops reload: upstream returned an empty list, keeping previous");
            return Ok(false);
        }
        let n = stops.len();
        let now_ms = self.now_ms();
        let prev = self.state().install_stops(stops, now_ms);
        if prev > 0 {
            logger::info(TAG, format!("stops reloaded: {n} (was {prev}), rev {rev}"));
        }
        Ok(true)
    }

    /// `stop`: signal the loop (sleeps return at once) and wait for it to end. An upstream request in flight is
    /// not interrupted, like the TS.
    pub async fn stop(&self) {
        let task = {
            let mut st = self.state();
            if let Some(tx) = st.stop_tx.take() {
                tx.send_replace(true);
            }
            st.started = false;
            st.run_task.take()
        };
        if let Some(task) = task {
            // the supervisor never panics; a JoinError here is a runtime shutdown
            let _ = task.await;
        }
    }

    /// `run`: full scan every scan_interval; between scans a position refresh every refresh_interval and a smart
    /// scan every smart_scan_interval; the daily stop reload backs off 30 min after a failed or empty one.
    // ponytail: the scans have no error path in Rust (fetch errors are handled inside), so the TS per-step catch
    // has nothing to catch; a panic (a bug) ends this run and supervise restarts it with its backoff.
    async fn run(&self, mut stop: watch::Receiver<bool>) {
        while !aborted(&stop) {
            let reload_sec = *config::STOPS_RELOAD_SEC as f64;
            let loaded_at = self.state().stops_loaded_at;
            if self.now_s() - loaded_at >= reload_sec {
                let ok = match self.load_stops().await {
                    Ok(ok) => ok,
                    Err(e) => {
                        logger::error(TAG, format!("stops reload failed: {}", string_err(e)));
                        false
                    }
                };
                if !ok {
                    let at = self.now_s() - reload_sec + 1800.0;
                    self.state().stops_loaded_at = at;
                }
            }
            self.full_scan().await;
            let last_scan = self.now_s();
            {
                let mut st = self.state();
                st.last_scan = last_scan;
                st.scan_count += 1;
            }
            let deadline = last_scan + self.scan_interval;
            let mut last_smart = last_scan;
            while self.now_s() < deadline && !aborted(&stop) {
                let wait = self.refresh_interval.min((deadline - self.now_s()).max(1.0));
                interruptible_sleep(wait * 1000.0, &mut stop).await;
                if aborted(&stop) {
                    break;
                }
                let now = self.now_s();
                self.refresh_active().await;
                if now - last_smart >= self.smart_scan_interval {
                    last_smart = now;
                    self.smart_scan().await;
                }
                let at = self.now_s();
                self.state().last_refresh = at;
            }
        }
    }

    /// The stops `due` selects, under one lock, against the current list.
    fn due_stops(&self, due: impl Fn(&State, &Stop) -> bool) -> (Arc<Vec<Stop>>, Vec<usize>) {
        let st = self.state();
        let list = Arc::clone(&st.stops.list);
        let idx = list
            .iter()
            .enumerate()
            .filter(|(_, s)| due(&st, s))
            .map(|(i, _)| i)
            .collect();
        (list, idx)
    }

    async fn fetch_batch(&self, ids: &[String]) -> Option<Value> {
        match self.api.fetch_multiple_departures(ids).await {
            Ok(v) => Some(v),
            Err(e) => {
                logger::error(TAG, format!("departures batch failed: {}", string_err(e)));
                None
            }
        }
    }

    /// `scanStopsBatched`: departures for `to_scan` in batches of batch_size, scan state stamped per stop; returns
    /// exec id -> earliest scheduled departure (secs since midnight) in discovery order.
    async fn scan_stops_batched(
        &self,
        to_scan: &[&Stop],
        now: f64,
        now_ts: f64,
        rescan_on_empty: f64,
    ) -> IndexMap<String, f64> {
        let mut stop_by_url: HashMap<&str, &Stop> = HashMap::new();
        for s in to_scan {
            stop_by_url.insert(&s.url_id, s);
        }
        let batches: Vec<Vec<String>> = to_scan
            .chunks(self.batch_size.max(1))
            .map(|b| b.iter().map(|s| s.url_id.clone()).collect())
            .collect();
        let results = join_all(batches.iter().map(|b| self.fetch_batch(b))).await;

        let mut per_trip: IndexMap<String, f64> = IndexMap::new();
        let mut guard = self.state();
        let st = &mut *guard;
        // any successful batch proves upstream contact, a dead upstream stops advancing the feed timestamp
        if results.iter().any(Option::is_some) {
            st.last_good_refresh = now_ts.floor();
        }
        let stamp_empty = |st: &mut State, s: &Stop| {
            st.stop_rescan_at.insert(s.url_id.clone(), now_ts + rescan_on_empty);
            st.stop_earliest.remove(&s.url_id);
        };
        for (batch, resp) in batches.iter().zip(&results) {
            // failed fetch: not a completed scan of these stops, stamp nothing
            let Some(resp) = resp else { continue };
            if !py_truthy(Some(resp)) {
                for uid in batch {
                    if let Some(s) = stop_by_url.get(uid.as_str()) {
                        stamp_empty(st, s);
                    }
                }
                continue;
            }
            let mut deps_by_desig: HashMap<String, &Value> = HashMap::new();
            if let Some(Value::Array(deps)) = as_record(Some(resp)).get("departures") {
                for dep in deps {
                    let Some(desig) = dep.as_object().and_then(|d| d.get("designator")) else {
                        continue;
                    };
                    if !desig.is_null() {
                        deps_by_desig.insert(js::value_to_string(Some(desig)), dep);
                    }
                }
            }
            for uid in batch {
                let Some(s) = stop_by_url.get(uid.as_str()) else {
                    continue;
                };
                let dep_a = deps_by_desig.get(s.stop_id.as_str()).copied();
                let dep = if py_truthy(dep_a) {
                    dep_a
                } else {
                    deps_by_desig.get(uid.as_str()).copied()
                };
                // A board absent from the reply is truncation (upstream caps the boards per request), NOT an
                // empty stop: an empty stop still gets a board with empty rows. Stamping the empty cache here
                // would hide the stop's buses for the cache window; the next scan retries it.
                let Some(dep) = dep else { continue };
                let rows = as_record(Some(dep)).get("rows");
                if !py_truthy(rows) {
                    stamp_empty(st, s);
                    continue;
                }
                let mut earliest: Option<f64> = None;
                if let Some(Value::Array(rows)) = rows {
                    for row in rows {
                        let Some(row) = row.as_object() else { continue };
                        let eid_raw = row.get("trip_execution_id");
                        if !py_truthy(eid_raw) {
                            continue;
                        }
                        let eid = js::value_to_string(eid_raw);
                        if py_truthy(row.get("trip_id")) {
                            st.note_exec_trip(&eid, js::value_to_string(row.get("trip_id")), now_ts.floor());
                        }
                        let dep_sec = row_departure_secs(row).unwrap_or(now);
                        if earliest.is_none_or(|e| dep_sec < e) {
                            earliest = Some(dep_sec);
                        }
                        match per_trip.get_mut(&eid) {
                            Some(cur) if dep_sec < *cur => *cur = dep_sec,
                            Some(_) => {}
                            None => {
                                per_trip.insert(eid, dep_sec);
                            }
                        }
                    }
                }
                match earliest {
                    Some(e) => {
                        st.stop_earliest.insert(s.url_id.clone(), e);
                        let at = if e > now + self.stop_far_threshold {
                            now_ts + self.stop_far_cache
                        } else {
                            now_ts
                        };
                        st.stop_rescan_at.insert(s.url_id.clone(), at);
                    }
                    None => stamp_empty(st, s),
                }
            }
        }
        per_trip
    }

    /// `fullScan`: scan every due stop for departures and fetch the candidates' positions. Driven directly by tests.
    pub async fn full_scan(&self) {
        let now_ms = self.now_ms();
        {
            let mut st = self.state();
            if st.stops.list.is_empty() {
                return;
            }
            st.sweep_expired(now_ms, self.cache404);
        }
        let now = local_secs(now_ms);
        let now_ts = now_ms as f64 / 1000.0;
        let horizon = self.horizon;
        let (list, idx) = self.due_stops(|st, s| {
            st.stop_rescan_at.get(&s.url_id).copied().unwrap_or(0.0) <= now_ts
                || st.stop_earliest.get(&s.url_id).copied().unwrap_or(999_999.0) <= now + horizon
        });
        let to_scan: Vec<&Stop> = idx.iter().filter_map(|&i| list.get(i)).collect();
        let n_batches = to_scan.len().div_ceil(self.batch_size.max(1));
        logger::info(
            TAG,
            format!(
                "full scan: {}/{} stops in {n_batches} batches (cached {}), now={}s",
                to_scan.len(),
                list.len(),
                list.len() - to_scan.len(),
                js::number_to_string(now)
            ),
        );
        if to_scan.is_empty() {
            let active = self.state().positions.len();
            logger::info(TAG, format!("all stops cached, {active} active"));
            return;
        }
        let per_trip = self
            .scan_stops_batched(&to_scan, now, now_ts, self.stop_empty_cache)
            .await;
        let candidates: Vec<String> = per_trip
            .iter()
            .filter(|&(_, &mnd)| mnd <= now + horizon)
            .map(|(eid, _)| eid.clone())
            .collect();
        let active = self.state().positions.len();
        logger::info(
            TAG,
            format!(
                "discovered {} trips, {} candidates ({active} active)",
                per_trip.len(),
                candidates.len()
            ),
        );
        self.fetch_positions(&candidates).await;
    }

    /// `smartScan`: rescan only the stops with departures within smart_scan_window, fetch new candidates.
    /// Driven directly by tests.
    pub async fn smart_scan(&self) {
        let now_ms = self.now_ms();
        let now = local_secs(now_ms);
        let now_ts = now_ms as f64 / 1000.0;
        let window = self.smart_scan_window;
        let (list, idx) = self.due_stops(|st, s| {
            st.stop_earliest.get(&s.url_id).copied().unwrap_or(999_999.0) <= now + window
                && st.stop_rescan_at.get(&s.url_id).copied().unwrap_or(0.0) <= now_ts
        });
        let to_scan: Vec<&Stop> = idx.iter().filter_map(|&i| list.get(i)).collect();
        if to_scan.is_empty() {
            return;
        }
        logger::info(
            TAG,
            format!(
                "smart scan: {} stops in {} batches (departures within {}s)",
                to_scan.len(),
                to_scan.len().div_ceil(self.batch_size.max(1)),
                js::number_to_string(window)
            ),
        );
        let per_trip = self
            .scan_stops_batched(&to_scan, now, now_ts, self.smart_scan_interval)
            .await;
        let candidates: Vec<String> = {
            let st = self.state();
            per_trip
                .iter()
                .filter(|&(eid, &mnd)| mnd <= now + self.horizon && !st.positions.contains_key(eid))
                .map(|(eid, _)| eid.clone())
                .collect()
        };
        if !candidates.is_empty() {
            self.fetch_positions(&candidates).await;
        }
    }

    /// `refreshActive`: re-fetch every tracked vehicle's position. Driven directly by tests.
    pub async fn refresh_active(&self) {
        let active: Vec<String> = self.state().positions.keys().cloned().collect();
        if active.is_empty() {
            return;
        }
        self.fetch_positions(&active).await;
    }

    async fn fetch_exec(&self, eid: &str, skip: bool) -> Option<Value> {
        if skip {
            return None;
        }
        match self.api.fetch_trip_execution(eid, 0).await {
            Ok(v) => Some(v),
            Err(e) => {
                // a fetch error is not a 404: keep the previous position, stamp no 404
                logger::error(TAG, format!("trip execution fetch failed for {eid}: {}", string_err(e)));
                None
            }
        }
    }

    /// `fetchPositions`: trip executions of `candidates` (exec ids; the TS pair's departure part is unused),
    /// honouring the 404 cache. A reply to a request older than the stored position's is dropped. Driven
    /// directly by tests.
    pub async fn fetch_positions(&self, candidates: &[String]) {
        let req_ms = self.now_ms();
        let now_ts = (req_ms as f64 / 1000.0).floor();
        let cache_cut = now_ts - self.cache404;
        // A fresh cached 404 skips the fetch and is NOT re-stamped below: re-stamping on every scan would slide
        // the TTL forever (scan interval < cache404) and permanently hide a bus that 404'd once.
        let skip: Vec<bool> = {
            let st = self.state();
            candidates
                .iter()
                .map(|eid| st.not_found.get(eid).is_some_and(|&nf| nf > cache_cut) && !st.positions.contains_key(eid))
                .collect()
        };
        let results = join_all(candidates.iter().zip(&skip).map(|(eid, &s)| self.fetch_exec(eid, s))).await;
        let fetch_ok = results.iter().filter(|r| r.is_some()).count();

        let now_ms = self.now_ms();
        let mut st = self.state();
        let mut changed = false;
        for (eid, resp) in candidates.iter().zip(&results) {
            let Some(resp) = resp else { continue };
            if st.req_at(eid) > req_ms {
                continue;
            }
            if !py_truthy(Some(resp)) {
                st.not_found.insert(eid.clone(), now_ts);
                if st.positions.shift_remove(eid).is_some() {
                    changed = true;
                }
                continue;
            }
            if st
                .apply_position(eid, as_record(Some(resp)), req_ms, now_ms, self.refresh_interval)
                .is_some()
            {
                changed = true;
            }
        }
        if changed {
            st.snapshot_version += 1;
        }
        // freshness = proven upstream contact: at least one fetch succeeded (a zero-candidate run proves nothing)
        if fetch_ok > 0 {
            st.last_good_refresh = now_ts;
        }
        st.prune_dead(self.now_ms() as f64 / 1000.0);
    }

    /// Driven directly by tests: `stopRescanAt.get(urlId)`.
    pub fn stop_rescan_at(&self, url_id: &str) -> Option<f64> {
        self.state().stop_rescan_at.get(url_id).copied()
    }

    /// Driven directly by tests: `stopsLoadedAt`.
    pub fn stops_loaded_at(&self) -> f64 {
        self.state().stops_loaded_at
    }
}

impl<S: KbSource + 'static> LivePoller<S> {
    /// `addCandidates`: the positions of the exec ids not tracked yet, fetched in a background task (a departures
    /// board saw them before the next scan). Outside a tokio runtime nothing is fetched.
    pub fn add_candidates(self: &Arc<Self>, eids: &[String]) {
        let needed: Vec<String> = {
            let st = self.state();
            eids.iter()
                .filter(|eid| !eid.is_empty() && !st.positions.contains_key(eid.as_str()))
                .cloned()
                .collect()
        };
        if needed.is_empty() || tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let me = Arc::clone(self);
        let fetch = tokio::spawn(async move { me.fetch_positions(&needed).await });
        tokio::spawn(async move {
            if let Err(e) = fetch.await
                && e.is_panic()
            {
                let msg = panic_msg(&*e.into_panic());
                logger::error(TAG, format!("addCandidates background fetch failed: {msg}"));
            }
        });
    }

    /// `start`: load the stops and spawn the supervised loop (no-op while running). Err = the stop fetch failed,
    /// or no stop list at all ("poller start failed: upstream returned an empty stop list").
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        if self.state().started {
            return Ok(());
        }
        self.load_stops().await?;
        let mut st = self.state();
        if st.stops.list.is_empty() {
            return Err("poller start failed: upstream returned an empty stop list".to_owned());
        }
        if st.started {
            return Ok(());
        }
        st.started = true;
        st.started_at = self.now_s();
        let (tx, rx) = watch::channel(false);
        st.stop_tx = Some(tx);
        let me = Arc::clone(self);
        st.run_task = Some(tokio::spawn(me.supervise(rx)));
        Ok(())
    }

    /// `supervise`: keeps `run` alive, restarting it after a panic (or a return while not stopped) with capped
    /// exponential backoff (1 s doubling to 5 min, reset after a run that lasted over 5 min).
    async fn supervise(self: Arc<Self>, mut stop: watch::Receiver<bool>) {
        let mut backoff: i64 = 1000;
        while !aborted(&stop) {
            let t0 = self.now_ms();
            let me = Arc::clone(&self);
            let rx = stop.clone();
            match tokio::spawn(async move { me.run(rx).await }).await {
                Ok(()) => {}
                Err(e) if e.is_panic() => {
                    let msg = panic_msg(&*e.into_panic());
                    let at = self.now_s();
                    {
                        let mut st = self.state();
                        st.last_loop_error = Some(msg.clone());
                        st.last_loop_error_at = at;
                    }
                    logger::error(TAG, format!("poller loop crashed: {msg}"));
                }
                // cancelled: the runtime is shutting down
                Err(_) => break,
            }
            if aborted(&stop) {
                break;
            }
            backoff = if self.now_ms() - t0 > 5 * 60_000 {
                1000
            } else {
                (backoff * 2).min(300_000)
            };
            let restarts = {
                let mut st = self.state();
                st.loop_restarts += 1;
                st.loop_restarts
            };
            logger::info(
                TAG,
                format!("restarting poller loop in {}s (restart #{restarts})", backoff / 1000),
            );
            interruptible_sleep(backoff as f64, &mut stop).await;
        }
    }
}

/// `nowSecs()` at `now_ms`: seconds since the agency's midnight.
fn local_secs(now_ms: i64) -> f64 {
    let ts = Timestamp::from_millisecond(now_ms).unwrap_or(Timestamp::UNIX_EPOCH);
    f64::from(agency_clock(ts).1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn interruptible_sleep_wakes_on_stop_and_on_a_dropped_sender() {
        let (tx, mut rx) = watch::channel(false);
        let t0 = tokio::time::Instant::now();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = tx.send(true);
        });
        interruptible_sleep(60_000.0, &mut rx).await;
        assert_eq!(t0.elapsed(), Duration::from_millis(50));
        let _ = stopper.await;
        // already stopped: no sleep at all
        interruptible_sleep(60_000.0, &mut rx).await;
        assert_eq!(t0.elapsed(), Duration::from_millis(50));

        let (tx, mut rx) = watch::channel(false);
        drop(tx);
        interruptible_sleep(60_000.0, &mut rx).await;
        assert_eq!(
            t0.elapsed(),
            Duration::from_millis(50),
            "a dropped sender counts as stopped"
        );

        let (_tx, mut rx) = watch::channel(false);
        interruptible_sleep(f64::NAN, &mut rx).await;
        assert_eq!(t0.elapsed(), Duration::from_millis(51), "NaN = 1 ms like setTimeout");
    }

    /// Departures panic on the first call; stop fetches hang while `hang` is set.
    struct Flaky {
        calls: std::sync::atomic::AtomicU32,
        hang: std::sync::atomic::AtomicBool,
    }

    impl KbSource for Flaky {
        async fn fetch_revision(&self) -> String {
            "1".to_owned()
        }
        async fn fetch_stops(&self, _: Option<&str>) -> Result<Vec<Stop>, String> {
            if self.hang.load(std::sync::atomic::Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            Ok(vec![Stop {
                url_id: "S1".into(),
                internal_id: 1,
                stop_id: "1".into(),
                ..Stop::default()
            }])
        }
        async fn fetch_multiple_departures(&self, _: &[String]) -> Result<Value, String> {
            if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                panic!("boom");
            }
            Ok(Value::Null)
        }
        async fn fetch_trip_execution(&self, _: &str, _: i64) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    fn flaky(hang: bool) -> Arc<LivePoller<Flaky>> {
        let base = tokio::time::Instant::now();
        let src = Flaky {
            calls: 0.into(),
            hang: hang.into(),
        };
        let now: NowFn = Arc::new(move || 1_780_000_000_000 + base.elapsed().as_millis() as i64);
        Arc::new(LivePoller::new(src, LivePollerOptions::default()).with_now(now))
    }

    #[tokio::test(start_paused = true)]
    async fn a_panicking_loop_is_restarted_with_backoff_and_counted() {
        let p = flaky(false);
        p.start().await.expect("one stop loaded");
        tokio::time::sleep(Duration::from_millis(1999)).await;
        let h = p.health_snapshot();
        assert_eq!((h.loop_restarts, h.scan_count), (1, 0), "still in the 2 s backoff");
        assert_eq!(h.last_loop_error.as_deref(), Some("boom"));
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert_eq!(p.health_snapshot().scan_count, 1, "the restarted loop scanned");
        p.stop().await;
        assert!(!p.state().started);
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_load_stops_future_releases_the_reload_flag() {
        let p = flaky(true);
        let dropped = tokio::time::timeout(Duration::from_secs(1), p.load_stops()).await;
        assert!(dropped.is_err(), "the hung fetch timed out");
        p.api.hang.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(p.load_stops().await, Ok(true));
        assert_eq!(p.stops().len(), 1);
    }
}
