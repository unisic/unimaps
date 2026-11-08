//! Port of test/mzk-poller-stops.test.ts (MzkPoller stop-list lifecycle and run loop) and the mzk-poller case of
//! test/mzk-timetable.test.ts. The TS `FakeApi` is a method-level `MzkSource` fake; the TS `DIRS_FILE` (redirected by
//! support/tmp-output, unlinked before every case) is a fresh temp dir per test.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use unimaps::js::JsNum;
use unimaps::mzk_api::{MzkLine, MzkRunningVehicle, MzkSource, MzkStopPoint};
use unimaps::mzk_poller::{CourseMeta, MzkPoller, mzk_angle_to_compass_bearing};

/// `sp(symbol, lat, lon, id = Number(symbol))`
fn sp(symbol: &str, lat: f64, lon: f64) -> MzkStopPoint {
    MzkStopPoint {
        id: symbol.parse().unwrap_or(f64::NAN),
        longitude: lon,
        latitude: lat,
        symbol: symbol.into(),
        name: format!("Stop {symbol}"),
        ..MzkStopPoint::default()
    }
}

#[derive(Default)]
struct Api {
    stops_calls: usize,
    stops_reply: Vec<MzkStopPoint>,
    stops_fail: bool,
    running: Vec<MzkRunningVehicle>,
    lines_reply: Vec<MzkLine>,
    vehicles_reply: Vec<Value>,
    vehicles_fail: bool,
    vehicles_calls: usize,
    vehicles_delay_ms: u64,
}

/// The TS `FakeApi`; the test keeps a clone to change the replies between polls.
#[derive(Clone, Default)]
struct FakeApi(Arc<Mutex<Api>>);

impl FakeApi {
    fn set(&self) -> MutexGuard<'_, Api> {
        self.0.lock().unwrap()
    }

    fn stops_calls(&self) -> usize {
        self.set().stops_calls
    }
}

impl MzkSource for FakeApi {
    async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
        Ok(self.set().running.clone())
    }

    async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
        let delay = {
            let mut a = self.set();
            a.vehicles_calls += 1;
            a.vehicles_delay_ms
        };
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        let a = self.set();
        if a.vehicles_fail {
            return Err("Error: timeout".into());
        }
        Ok(a.vehicles_reply.clone())
    }

    async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
        let mut a = self.set();
        a.stops_calls += 1;
        if a.stops_fail {
            return Err("Error: boom".into());
        }
        Ok(a.stops_reply.clone())
    }

    async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
        Ok(self.set().lines_reply.clone())
    }
}

/// `veh(variant, symbols)`
fn veh(variant: i64, symbols: &[&str]) -> Value {
    let stop_points: Vec<Value> = symbols
        .iter()
        .enumerate()
        .map(|(i, s)| {
            json!({ "symbol": s, "name": s, "orderNo": i, "street": null, "distance": i * 100,
                    "scheduledDeparture": 0, "plannedDeparture": 0 })
        })
        .collect();
    json!({
        "lineName": "1", "courseLoid": variant * 10, "vehicleId": "100", "variantLoid": variant, "latitude": 49.8,
        "longitude": 19.0, "angle": 0, "delaySec": 0, "orderInCourse": 0, "reachedMeters": 0, "stopPoints": stop_points,
    })
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(20)).await;
}

/// A fresh dir for `DIRS_FILE`, removed on drop.
struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Self {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!(
            "kb-mzk-poller-{}-{}-{nanos}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn file(&self) -> PathBuf {
        self.0.join("mzk-stop-dirs.v1.json")
    }

    fn saved(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.file()).unwrap()).unwrap()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `new MzkPoller(api)` writing its stop directions to the test's `DIRS_FILE`.
fn poller(api: &FakeApi, tmp: &Tmp) -> Arc<MzkPoller<FakeApi>> {
    Arc::new(MzkPoller::new(api.clone()).with_stop_dirs_file(Some(tmp.file())))
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

/// `p.stopDirs.dirs().get(symbol)` as raw bits, so `deepStrictEqual`'s -0 vs 0 holds too.
fn dir_bits(p: &MzkPoller<FakeApi>, symbol: &str) -> Option<Vec<u64>> {
    let dirs = p.state().stop_dirs.dirs();
    dirs.get(symbol).map(|v| v.iter().map(|JsNum(n)| n.to_bits()).collect())
}

fn bits(v: &[f64]) -> Option<Vec<u64>> {
    Some(v.iter().map(|n| n.to_bits()).collect())
}

fn ab_c() -> Vec<MzkStopPoint> {
    vec![sp("A", 49.80, 19.0), sp("B", 49.81, 19.0), sp("C", 49.82, 19.0)]
}

fn one_two() -> Vec<MzkStopPoint> {
    vec![sp("1", 49.80, 19.0), sp("2", 49.81, 19.0)]
}

// describe("MzkPoller stop-list lifecycle (patched)")

#[tokio::test]
async fn an_empty_upstream_list_never_wipes_a_good_one() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = one_two();
    let p = poller(&api, &tmp);
    assert_eq!(p.load_stops().await, Ok(true));
    assert_eq!(p.state().stops.len(), 2);
    api.set().stops_reply = Vec::new();
    assert_eq!(p.load_stops().await, Ok(false));
    assert_eq!(p.state().stops.len(), 2);
    assert_eq!(p.state().stops_by_symbol.len(), 2);
}

#[tokio::test]
async fn a_reload_swaps_stops_and_stops_by_symbol_together_and_stamps_stops_loaded_at() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = vec![sp("1", 49.80, 19.0)];
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    let before = Arc::clone(&p.state().stops_by_symbol);
    api.set().stops_reply = vec![sp("1", 49.80, 19.0), sp("265", 49.827, 19.036)];
    p.load_stops().await.unwrap();
    let st = p.state();
    assert!(!Arc::ptr_eq(&st.stops_by_symbol, &before)); // new Map, not mutated in place
    assert_eq!(st.stops_by_symbol.get("265").map(|s| s.name.as_str()), Some("Stop 265"));
    assert!(st.stops_loaded_at > 0.0);
}

#[tokio::test]
async fn a_running_course_that_references_an_unknown_symbol_triggers_one_reload_throttled_to_10_min() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = one_two();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    let calls0 = api.stops_calls();
    {
        let mut a = api.set();
        // upstream re-versioned: new stop
        a.stops_reply = vec![sp("1", 49.80, 19.0), sp("2", 49.81, 19.0), sp("265", 49.82, 19.0)];
        a.running = vec![veh(1, &["1", "265", "2"]), veh(2, &["00", "1", "2"])]; // "00" (depot) must not count
    }
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1);
    assert!(p.state().stops_by_symbol.contains_key("265"));
    p.poll_once().await.unwrap(); // still unknown? no, but even if it were, the 10-min throttle holds
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1);
}

#[tokio::test]
async fn depot_only_unknown_symbol_00_never_triggers_a_reload() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = one_two();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    let calls0 = api.stops_calls();
    api.set().running = vec![veh(5, &["00", "1", "2"])];
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0);
}

#[tokio::test]
async fn a_day_old_list_is_reloaded_a_failed_reload_keeps_the_list_and_backs_off_30_min() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = one_two();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    p.state().stops_loaded_at = now_secs() - 90_000.0; // > 86 400 s
    {
        let mut a = api.set();
        a.stops_fail = true;
        a.running = vec![veh(7, &["1", "2"])];
    }
    let calls0 = api.stops_calls();
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1);
    assert_eq!(p.state().stops.len(), 2); // kept
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1); // backed off
}

#[tokio::test]
async fn a_day_old_reload_that_gets_an_empty_list_backs_off_30_min_too_not_a_get_stops_every_5_s_poll() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = one_two();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    p.state().stops_loaded_at = now_secs() - 90_000.0;
    {
        let mut a = api.set();
        a.stops_reply = Vec::new();
        a.running = vec![veh(7, &["1", "2"])];
    }
    let calls0 = api.stops_calls();
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1);
    assert_eq!(p.state().stops.len(), 2);
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1);
}

#[tokio::test]
async fn a_course_seen_before_the_stop_list_loaded_still_teaches_directions_once_it_does() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    let p = poller(&api, &tmp);
    api.set().running = vec![veh(9, &["A", "B", "C"])];
    p.poll_once().await.unwrap(); // getStops returned nothing: every stop of variant 9 is unknown
    assert_eq!(p.state().stop_dirs.size(), 0);
    api.set().stops_reply = ab_c();
    p.poll_once().await.unwrap();
    assert_eq!(dir_bits(&p, "B"), bits(&[0.0]));
    p.flush_stop_dirs();
}

#[tokio::test]
async fn a_failed_get_vehicles_is_retried_even_though_stops_and_lines_loaded() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    {
        let mut a = api.set();
        a.stops_reply = vec![sp("1", 49.80, 19.0)];
        a.lines_reply = vec![MzkLine {
            id: 1.0,
            name: "1".into(),
            long_name: Some("x".into()),
            ..MzkLine::default()
        }];
        a.vehicles_fail = true;
    }
    let p = poller(&api, &tmp);
    p.poll_once().await.unwrap();
    assert_eq!(p.state().lines.len(), 1);
    assert_eq!(p.state().static_vehicles.len(), 0);
    {
        let mut a = api.set();
        a.vehicles_fail = false;
        a.vehicles_reply = vec![json!({ "sideNumber": "100" })];
    }
    p.poll_once().await.unwrap();
    assert!(p.state().static_vehicles.contains_key("100"));
}

#[test]
fn course_meta_map_is_capped_the_oldest_course_goes_a_re_noted_still_running_one_stays() {
    let p = MzkPoller::new(FakeApi::default()).with_stop_dirs_file(None);
    let meta = CourseMeta {
        line_name: "1".into(),
        variant_id: None,
        direction: String::new(),
    };
    p.note_course(1, meta.clone());
    p.note_course(2, meta.clone());
    for id in 3..=25_000 {
        if id % 1000 == 0 {
            p.note_course(1, meta.clone()); // course 1 keeps running, the poller re-notes it
        }
        p.note_course(id, meta.clone());
    }
    let st = p.state();
    assert_eq!(st.course_meta.len(), 20_000);
    assert!(st.course_meta.contains_key(&1));
    assert!(!st.course_meta.contains_key(&2));
}

#[tokio::test]
async fn learns_stop_directions_from_running_courses_and_persists_them() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = ab_c();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    api.set().running = vec![veh(9, &["A", "B", "C"])];
    p.poll_once().await.unwrap();
    assert_eq!(dir_bits(&p, "B"), bits(&[0.0]));
    assert!(tmp.file().exists());
    let saved = tmp.saved();
    assert_eq!(saved["v"], json!(2));
    assert_eq!(saved["variants"], json!([9]));
}

#[tokio::test]
async fn a_symbol_that_stays_unknown_after_a_reload_does_not_trigger_another_one_a_new_unknown_symbol_does_after_the_throttle()
 {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = one_two();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    let calls0 = api.stops_calls();
    api.set().running = vec![veh(1, &["1", "TECH", "2"])]; // TECH is never in getStops
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1); // first sighting: one reload, TECH stays unknown
    p.state().stops_reload_attempt_at = 0; // pretend the 10 min throttle passed
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1); // same unknown symbol: handled, no reload loop
    api.set().running = vec![veh(1, &["1", "TECH", "NEW", "2"])];
    p.state().stops_reload_attempt_at = 0;
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 2); // a genuinely new unknown symbol retriggers
}

#[tokio::test]
async fn a_failed_reload_forgets_what_it_tried_so_the_unknown_symbol_is_retried_after_the_throttle() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = one_two();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    let calls0 = api.stops_calls();
    {
        let mut a = api.set();
        a.stops_fail = true;
        a.running = vec![veh(1, &["1", "NEW", "2"])];
    }
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 1);
    p.state().stops_reload_attempt_at = 0;
    {
        let mut a = api.set();
        a.stops_fail = false;
        a.stops_reply = vec![sp("1", 49.80, 19.0), sp("2", 49.81, 19.0), sp("NEW", 49.82, 19.0)];
    }
    p.poll_once().await.unwrap();
    settle().await;
    assert_eq!(api.stops_calls(), calls0 + 2);
    assert!(p.state().stops_by_symbol.contains_key("NEW"));
}

#[tokio::test]
async fn a_reload_in_which_a_learned_stop_moved_resets_the_learned_directions() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = ab_c();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    api.set().running = vec![veh(9, &["A", "B", "C"])];
    p.poll_once().await.unwrap();
    assert!(p.state().stop_dirs.dirs().contains_key("B"));
    // B re-surveyed 165 m north
    api.set().stops_reply = vec![sp("A", 49.80, 19.0), sp("B", 49.8115, 19.0), sp("C", 49.82, 19.0)];
    p.load_stops().await.unwrap();
    assert_eq!(p.state().stop_dirs.size(), 0);
}

#[tokio::test]
async fn a_second_learned_variant_within_a_minute_is_saved_by_the_trailing_flush() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    api.set().stops_reply = ab_c();
    let p = poller(&api, &tmp);
    p.load_stops().await.unwrap();
    api.set().running = vec![veh(9, &["A", "B", "C"])];
    p.poll_once().await.unwrap();
    assert_eq!(tmp.saved()["variants"], json!([9]));
    api.set().running = vec![veh(9, &["A", "B", "C"]), veh(10, &["C", "B", "A"])];
    p.poll_once().await.unwrap();
    assert_eq!(tmp.saved()["variants"], json!([9])); // debounced
    p.flush_stop_dirs();
    // `.sort()` with no comparator: by String(n)
    let mut variants = tmp.saved()["variants"].as_array().cloned().unwrap_or_default();
    variants.sort_by_key(Value::to_string);
    assert_eq!(Value::Array(variants), json!([10, 9]));
}

// describe("MzkPoller run loop")

#[tokio::test]
async fn does_not_pile_up_abort_listeners_on_the_loop_signal() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    let p = Arc::new(
        MzkPoller::new(api)
            .with_refresh_interval_ms(1.0)
            .with_stop_dirs_file(Some(tmp.file())),
    );
    p.start().await;
    settle().await; // ~20 loop iterations at 1 ms
    let listeners = p.stop_listeners();
    p.stop().await;
    assert!(listeners <= 1, "abort listeners: {listeners}");
}

#[tokio::test(start_paused = true)]
async fn start_polls_right_after_the_first_failed_static_load_while_a_slow_one_runs_on() {
    let (api, tmp) = (FakeApi::default(), Tmp::new());
    {
        let mut a = api.set();
        a.stops_fail = true;
        a.vehicles_delay_ms = 8000;
        a.vehicles_reply = vec![json!({ "sideNumber": "100" })];
    }
    let p = poller(&api, &tmp);
    p.start().await;
    // Promise.all rejects on getStops at once, so pollOnce still sees an empty fleet and asks again
    assert_eq!(api.set().vehicles_calls, 2);
    assert_eq!(api.stops_calls(), 2);
    p.stop().await;
}

// test/mzk-timetable.test.ts, describe("mzk-timetable and schedule logic")

#[test]
fn converts_ontime_cartesian_angles_to_standard_navigation_compass_bearings() {
    // North: Cartesian 90 deg -> Compass 0 deg
    assert_eq!(mzk_angle_to_compass_bearing(90.0), 0.0);
    // East: Cartesian 0 deg -> Compass 90 deg
    assert_eq!(mzk_angle_to_compass_bearing(0.0), 90.0);
    // South: Cartesian -90 deg -> Compass 180 deg
    assert_eq!(mzk_angle_to_compass_bearing(-90.0), 180.0);
    // West: Cartesian 180 deg or -180 deg -> Compass 270 deg
    assert_eq!(mzk_angle_to_compass_bearing(180.0), 270.0);
    assert_eq!(mzk_angle_to_compass_bearing(-180.0), 270.0);
    // North-West: Cartesian 127 deg -> Compass 323 deg
    assert_eq!(mzk_angle_to_compass_bearing(127.0), 323.0);
    // North-East: Cartesian 45 deg -> Compass 45 deg
    assert_eq!(mzk_angle_to_compass_bearing(45.0), 45.0);
    // South-East: Cartesian -45 deg -> Compass 135 deg
    assert_eq!(mzk_angle_to_compass_bearing(-45.0), 135.0);
    // South-West: Cartesian -135 deg -> Compass 225 deg
    assert_eq!(mzk_angle_to_compass_bearing(-135.0), 225.0);
}
