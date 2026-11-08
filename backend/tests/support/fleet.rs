//! Shared rig of test/fleet-tracker.test.ts: the `stop()` builder, OnTime-shaped records turned into the tracker's
//! input the way the MZK poller reads them, an injectable clock (the TS `mock.timers` Date) and per-test temp dirs.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use serde_json::{Value, json};
use unimaps::fleet_tracker::{FleetRunningInput, FleetStopPoint, FleetTracker, FleetTrackerOptions};
use unimaps::gzm::NowFn;
use unimaps::js::truthy;
use unimaps::mzk_shape::mzk_stop_indices;
use unimaps::mzk_state::MzkLifecycleInput;
use unimaps::shared::fleet::FleetVehicleDetail;

/// 2026-10-04 12:00:00 Europe/Warsaw (CEST, UTC+2)
pub const NOON_OCT4_MS: i64 = 1_791_108_000_000;

/// TS `stop(symbol, name, orderNo, distance, schedMs)` (planned = scheduled)
pub fn stop(symbol: &str, name: &str, order_no: i64, distance: f64, sched_ms: i64) -> Value {
    stop_p(symbol, name, order_no, distance, sched_ms, sched_ms)
}

/// TS `stop(symbol, name, orderNo, distance, schedMs, plannedMs)`
pub fn stop_p(symbol: &str, name: &str, order_no: i64, distance: f64, sched_ms: i64, planned_ms: i64) -> Value {
    json!({
        "symbol": symbol,
        "name": name,
        "orderNo": order_no,
        "distance": distance,
        "scheduledDeparture": sched_ms,
        "plannedDeparture": planned_ms,
    })
}

/// `{ ...base, ...over }` of two object literals
pub fn with(base: &Value, over: Value) -> Value {
    let mut out = base.clone();
    if let (Some(o), Value::Object(over)) = (out.as_object_mut(), over) {
        o.extend(over);
    }
    out
}

/// What the tracker reads of a raw OnTime running-vehicle record: the TS `FleetRunningInput` of an MZK record
/// (`Boolean(onStopPoint)`, `isMzkNotStarted` fields, `mzkStopIndices`).
pub fn input(raw: &Value) -> FleetRunningInput {
    let s = |k: &str| raw.get(k).and_then(Value::as_str).map(str::to_owned);
    let n = |k: &str| raw.get(k).and_then(Value::as_f64);
    let idx = mzk_stop_indices(raw);
    let stop_points = raw
        .get("stopPoints")
        .and_then(Value::as_array)
        .map(|sp| {
            sp.iter()
                .map(|p| FleetStopPoint {
                    symbol: p.get("symbol").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    name: p.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    distance: p.get("distance").and_then(Value::as_f64).unwrap_or(f64::NAN),
                    scheduled_departure: p.get("scheduledDeparture").and_then(Value::as_f64).unwrap_or(0.0),
                    planned_departure: p.get("plannedDeparture").and_then(Value::as_f64).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default();
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
        on_stop_point: truthy(raw.get("onStopPoint")),
        stop_points,
        lifecycle: MzkLifecycleInput::from_json(raw),
        served_idx: idx.served,
        next_idx: idx.next,
        ..FleetRunningInput::default()
    }
}

/// `input` of every record
pub fn inputs(raw: &[Value]) -> Vec<FleetRunningInput> {
    raw.iter().map(input).collect()
}

/// TS `tracker.updateFromRunningVehicles(raw)` of an MZK poll
pub fn update(tracker: &FleetTracker, raw: &[Value]) {
    tracker.update_from_running_vehicles(&inputs(raw), None, None);
}

/// TS `tracker.getVehicleDetail(side)!`
pub fn detail(tracker: &FleetTracker, side: &str) -> FleetVehicleDetail {
    tracker
        .get_vehicle_detail(side)
        .unwrap_or_else(|| panic!("vehicle {side} missing"))
}

/// The TS `mock.timers` Date: epoch ms read by every tracker built with `opts`.
#[derive(Clone)]
pub struct Clock(Arc<AtomicI64>);

impl Clock {
    pub fn at(ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(ms)))
    }

    pub fn set(&self, ms: i64) {
        self.0.store(ms, Ordering::SeqCst);
    }

    pub fn now_fn(&self) -> NowFn {
        let c = self.0.clone();
        Arc::new(move || c.load(Ordering::SeqCst))
    }
}

/// TS defaults with `historyDir` and the mocked clock
pub fn opts(history_dir: Option<PathBuf>, clock: &Clock) -> FleetTrackerOptions {
    FleetTrackerOptions {
        history_dir,
        now: clock.now_fn(),
        ..FleetTrackerOptions::default()
    }
}

/// TS `memTracker()`: `new FleetTracker({ historyDir: null })` on the real clock
pub fn mem_tracker() -> FleetTracker {
    FleetTracker::new(FleetTrackerOptions {
        history_dir: None,
        ..FleetTrackerOptions::default()
    })
}

/// `memTracker()` created while `mock.timers` is enabled
pub fn mem_tracker_at(clock: &Clock) -> FleetTracker {
    FleetTracker::new(opts(None, clock))
}

/// TS `mkTmp()`: a fresh directory, removed on drop
pub struct TmpDir(PathBuf);

impl TmpDir {
    pub fn new() -> Self {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "unimaps-fleet-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
