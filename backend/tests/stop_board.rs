//! The cases of test/mzk-not-started-routes.test.ts and test/stops-routes.test.ts that read nothing but the board
//! (`stop_board`) or the MZK trip (`resolve_mzk_trip`): the departures route answers `board.rows` as `rows` and
//! `board.failed` as `warnings` (when non-empty), the trip_execution route `resolveMzkTrip(id) || {}`. The cases
//! that assert a status code or a header wait for the route handlers (sub-stage 4c). Every service is a fake: the
//! TS installs a started singleton, here a `Bb` over fakes whose start loads the fixture data and touches no file.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use serde_json::{Map, Value, json};
use unimaps::departures_board_cache::{Board, DEPARTURES_BOARD_CACHE};
use unimaps::kb_api::KbSource;
use unimaps::mzk_api::{MzkLine, MzkRealtimeResponse, MzkRunningVehicle, MzkSource, MzkStopPoint};
use unimaps::mzk_poller::MzkPoller;
use unimaps::mzk_trip::resolve_mzk_trip;
use unimaps::osrm::{OsrmHttp, OsrmTransport};
use unimaps::poller::{LivePoller, LivePollerOptions};
use unimaps::poller_singleton::{Bb, BbKinds};
use unimaps::shape_store::{ShapeStore, ShapeStoreOptions};
use unimaps::stop_board::stop_board;
use unimaps::stop_merge::Operator;
use unimaps::types::Stop;

/// `support/tmp-output`: KB_OUTPUT_DIR (the merged view's GTFS bearings) -> a dir that is never created.
static ENV: LazyLock<()> = LazyLock::new(|| {
    let dir = std::env::temp_dir().join(format!("unimaps-stop-board-{}", std::process::id()));
    // SAFETY: forced first by every test of this binary, before anything in it reads the environment
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", dir);
        std::env::set_var("KB_LOG_LEVEL", "error");
    }
});
/// The board micro-cache is process-wide: one test at a time, each starting from an empty cache (`beforeEach`).
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct FakeState {
    kb_stops: Vec<Stop>,
    kb_rows: HashMap<String, Vec<Value>>,
    kb_fail: bool,
    kb_calls: Vec<String>,
    mzk_rows: HashMap<String, Vec<Value>>,
    mzk_fail: bool,
    mzk_fail_syms: Vec<String>,
    mzk_calls: Vec<String>,
    running: Vec<MzkRunningVehicle>,
    stop_points: Vec<MzkStopPoint>,
    lines: Vec<MzkLine>,
}

/// The TS `api` / `mzkApi` fakes and what the pollers' start reads (KB and MZK stop lists, running courses).
#[derive(Clone, Default)]
struct Fake(Arc<Mutex<FakeState>>);

impl Fake {
    fn with<R>(&self, f: impl FnOnce(&mut FakeState) -> R) -> R {
        f(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl KbSource for Fake {
    async fn fetch_revision(&self) -> String {
        "1".to_owned()
    }
    async fn fetch_stops(&self, _: Option<&str>) -> Result<Vec<Stop>, String> {
        Ok(self.with(|s| s.kb_stops.clone()))
    }
    async fn fetch_multiple_departures(&self, _: &[String]) -> Result<Value, String> {
        Ok(json!({}))
    }
    async fn fetch_trip_execution(&self, _: &str, _: i64) -> Result<Value, String> {
        Ok(Value::Null)
    }
    async fn fetch_departures(&self, d: &str) -> Result<Value, String> {
        self.with(|s| {
            s.kb_calls.push(d.to_owned());
            if s.kb_fail {
                return Err("KB unavailable".to_owned());
            }
            Ok(json!({ "rows": s.kb_rows.get(d).cloned().unwrap_or_default() }))
        })
    }
}

impl MzkSource for Fake {
    async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
        Ok(self.with(|s| s.running.clone()))
    }
    async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
        Ok(self.with(|s| s.stop_points.clone()))
    }
    async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
        Ok(self.with(|s| s.lines.clone()))
    }
    async fn fetch_realtime(&self, symbol: &str) -> Result<Arc<MzkRealtimeResponse>, String> {
        self.with(|s| {
            s.mzk_calls.push(symbol.to_owned());
            if s.mzk_fail || s.mzk_fail_syms.iter().any(|f| f == symbol) {
                return Err("OnTime unavailable".to_owned());
            }
            let rows = s.mzk_rows.get(symbol).cloned().unwrap_or_default();
            Ok(Arc::new(json!({ "stopPointSymbol": symbol, "departures": rows })))
        })
    }
    async fn fetch_real_course(&self, _: f64) -> Result<Value, String> {
        Ok(json!({}))
    }
}

struct NoOsrm;

impl OsrmTransport for NoOsrm {
    async fn throttle(&self) {}
    async fn get(&self, _: &str) -> Result<OsrmHttp, String> {
        Err("no osrm".to_owned())
    }
}

struct Fakes;

impl BbKinds for Fakes {
    type Kb = Fake;
    type Mzk = Fake;
    type Osrm = NoOsrm;
}

/// A started singleton over `fake` (`startPromise` settled, as the TS installs it). `now_ms` None = system clock;
/// `mzk_stops` = the MZK poller's stop list as the TS sets it (the fake's `fetch_stops` stays empty then, and an
/// empty answer keeps that list).
async fn started(fake: &Fake, now_ms: Option<i64>, mzk_stops: Option<Vec<Stop>>) -> Bb<Fakes> {
    let shapes = ShapeStore::new(ShapeStoreOptions {
        timers: false,
        ..ShapeStoreOptions::new(NoOsrm)
    });
    let mut poller = LivePoller::new(fake.clone(), LivePollerOptions::default());
    let mut mzk = MzkPoller::new(fake.clone()).with_stop_dirs_file(None);
    if let Some(ms) = now_ms {
        poller = poller.with_now(Arc::new(move || ms));
        mzk = mzk.with_now(Arc::new(move || ms));
    }
    if let Some(stops) = mzk_stops {
        mzk.state().stops = Arc::new(stops);
    }
    let mut bb = Bb::<Fakes>::from_parts(fake.clone(), poller, fake.clone(), mzk, shapes)
        .with_gtfs_dir(std::env::temp_dir().join(format!("unimaps-stop-board-no-gtfs-{}", std::process::id())));
    if let Some(ms) = now_ms {
        bb = bb.with_now(Arc::new(move || ms));
    }
    bb.start_poller().await.expect("fake start");
    bb
}

async fn stop(bb: &Bb<Fakes>) {
    bb.mzk_poller().stop().await;
    bb.poller().stop().await;
}

fn failed(b: &Board) -> Value {
    serde_json::to_value(&b.failed).expect("legs serialize")
}

fn operators(b: &Board) -> Vec<String> {
    b.rows
        .iter()
        .map(|r| r.get("operator").and_then(Value::as_str).unwrap_or_default().to_owned())
        .collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

// --- test/mzk-not-started-routes.test.ts ---

fn ms(iso: &str) -> i64 {
    iso.parse::<jiff::Timestamp>().expect("iso instant").as_millisecond()
}

/// the fixture's capture time
fn now() -> i64 {
    ms("2026-10-02T22:54:42+02:00")
}

static FX: LazyLock<Value> = LazyLock::new(|| {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/mzk-running-vehicles.json"
    );
    serde_json::from_str(&std::fs::read_to_string(p).expect("fixture")).expect("fixture json")
});

fn veh(key: &str) -> &'static Value {
    &FX["vehicles"][key]
}

fn stop_point(v: &Value, idx: usize) -> &Value {
    &v["stopPoints"][idx]
}

/// getRealtime departure row of one course at one stop of its running record (real OnTime shape).
fn rt_row(v: &Value, idx: usize) -> Value {
    let midnight = ms("2026-10-02T00:00:00+02:00");
    let sp = stop_point(v, idx);
    let sched = sp["scheduledDeparture"].as_f64().expect("scheduledDeparture");
    json!({
        "courseId": v["courseLoid"],
        "scheduledDepartureSec": ((sched - midnight as f64) / 1000.0).round() as i64,
        "scheduledDeparture": sp["scheduledDeparture"],
        // OnTime's stop-level number == the running record's (verified on captured pairs)
        "realDeparture": sp["plannedDeparture"],
        "vehicleId": v["vehicleId"],
        "variantId": v["variantLoid"],
        "orderInCourse": idx,
        "passed": false,
        "lack": false,
        "onStopPoint": idx == 0 && v["orderInCourse"].as_f64() == Some(0.0),
        "lineName": v["lineName"],
        "directionName": v["direction"],
    })
}

async fn not_started_bb() -> (Bb<Fakes>, tokio::sync::MutexGuard<'static, ()>) {
    LazyLock::force(&ENV);
    let guard = SERIAL.lock().await;
    DEPARTURES_BOARD_CACHE.clear();
    let running: Vec<Value> = ["not_started_late", "not_started_early", "just_departed", "running"]
        .into_iter()
        .map(|k| veh(k).clone())
        .collect();
    let mut rt_by_symbol: HashMap<String, Vec<Value>> = HashMap::new();
    for v in &running {
        for (idx, sp) in v["stopPoints"].as_array().expect("stopPoints").iter().enumerate() {
            let sym = sp["symbol"].as_str().expect("symbol").to_owned();
            rt_by_symbol.entry(sym).or_default().push(rt_row(v, idx));
        }
    }
    let fake = Fake::default();
    fake.with(|s| {
        s.stop_points = serde_json::from_value(FX["stopPoints"].clone()).expect("stop points");
        s.lines = serde_json::from_value(
            json!([{ "id": 1, "name": "29", "longName": null, "nightLine": false, "lineType": "BUS" }]),
        )
        .expect("lines");
        s.running = running;
        s.mzk_rows = rt_by_symbol;
    });
    (started(&fake, Some(now()), None).await, guard)
}

async fn row_of(bb: &Bb<Fakes>, v: &Value, stop_idx: usize) -> Map<String, Value> {
    let symbol = stop_point(v, stop_idx)["symbol"].as_str().expect("symbol");
    let board = stop_board(bb, &format!("mzk:{symbol}")).await;
    let course = v["courseLoid"].to_string();
    let row = board.rows.iter().find(|r| {
        r.get("trip_execution_id")
            .map(|id| id.as_str().map_or_else(|| id.to_string(), str::to_owned))
            .is_some_and(|id| id.contains(&course))
    });
    row.cloned()
        .unwrap_or_else(|| panic!("no board row for {} at stop {stop_idx}", v["vehicleId"]))
}

async fn live_trip(bb: &Bb<Fakes>, v: &Value) -> Value {
    let id = format!(
        "mzk:{}:{}",
        v["courseLoid"],
        v["vehicleId"].as_str().expect("vehicleId")
    );
    let trip = resolve_mzk_trip(bb, &id, true).await.expect("resolve");
    Value::Object(trip.unwrap_or_default())
}

#[tokio::test]
async fn not_started_late_bus_no_estimate_earliest_possible_time_flagged_first_stop_and_a_later_stop() {
    let (bb, _serial) = not_started_bb().await;
    let r0 = row_of(&bb, veh("not_started_late"), 0).await;
    assert_eq!(r0.get("not_started"), Some(&json!(true)));
    assert_eq!(r0.get("is_estimated"), Some(&json!(false)));
    assert_eq!(r0.get("time_diff").and_then(Value::as_f64), Some(0.0));
    // scheduled 22:54:00, now 22:54:42: the bus cannot leave before "now"
    assert_eq!(r0.get("time"), Some(&json!("22:54")));
    let r5 = row_of(&bb, veh("not_started_late"), 5).await;
    assert_eq!(r5.get("not_started"), Some(&json!(true)));
    assert_eq!(r5.get("is_estimated"), Some(&json!(false)));
    let (time, static_time) = (
        r5["time"].as_str().unwrap_or_default(),
        r5["static_time"].as_str().unwrap_or_default(),
    );
    assert!(
        time >= static_time,
        "lower bound {time} must not precede the schedule {static_time}"
    );
    stop(&bb).await;
}

#[tokio::test]
async fn not_started_early_bus_the_schedule_never_ontime_s_60_s_floor() {
    let (bb, _serial) = not_started_bb().await;
    let row = row_of(&bb, veh("not_started_early"), 3).await;
    assert_eq!(row.get("not_started"), Some(&json!(true)));
    assert_eq!(row.get("time_diff").and_then(Value::as_f64), Some(0.0));
    assert_eq!(row.get("time"), row.get("static_time"));
    stop(&bb).await;
}

#[tokio::test]
async fn running_bus_keeps_its_estimate() {
    let (bb, _serial) = not_started_bb().await;
    let row = row_of(&bb, veh("running"), 5).await;
    assert_eq!(row.get("not_started"), None);
    assert_eq!(row.get("is_estimated"), Some(&json!(true)));
    stop(&bb).await;
}

#[tokio::test]
async fn live_trip_of_a_waiting_bus_carries_no_per_stop_estimate_and_the_flag() {
    let (bb, _serial) = not_started_bb().await;
    let j = live_trip(&bb, veh("not_started_late")).await;
    assert_eq!(j.get("not_started"), Some(&json!(true)));
    let times = j["trip"]["times"].as_array().cloned().unwrap_or_default();
    assert!(times.len() > 5);
    assert!(times.iter().all(|t| t.get("estimate").is_none()));
    assert_eq!(j.get("vehicle_trip_index").and_then(Value::as_f64), Some(0.0));
    stop(&bb).await;
}

#[tokio::test]
async fn live_trip_of_a_running_bus_keeps_estimates_and_has_no_flag() {
    let (bb, _serial) = not_started_bb().await;
    let j = live_trip(&bb, veh("running")).await;
    assert_eq!(j.get("not_started"), None);
    let times = j["trip"]["times"].as_array().cloned().unwrap_or_default();
    assert!(times.iter().all(|t| t["estimate"]["time_diff"].is_number()));
    stop(&bb).await;
}

#[tokio::test]
async fn a_running_course_is_not_served_as_live_once_the_feed_stopped_refreshing() {
    let (bb, _serial) = not_started_bb().await;
    let good = bb.mzk_poller().state().last_good_refresh;
    assert!(
        live_trip(&bb, veh("running")).await["trip"]["times"].is_array(),
        "fresh feed: live trip"
    );
    bb.mzk_poller().state().last_good_refresh = now() as f64 / 1000.0 - 120.0;
    assert_eq!(
        live_trip(&bb, veh("running")).await.get("trip"),
        None,
        "stale feed: no frozen live trip"
    );
    bb.mzk_poller().state().last_good_refresh = good;
    stop(&bb).await;
}

// --- test/stops-routes.test.ts ---

fn kb(internal_id: i64, url_id: &str, name: &str, lat: f64, lon: f64) -> Stop {
    Stop {
        url_id: url_id.to_owned(),
        internal_id,
        name: name.to_owned(),
        lat,
        lon,
        stop_id: internal_id.to_string(),
        ..Stop::default()
    }
}

fn mz(symbol: &str, name: &str, lat: f64, lon: f64) -> Stop {
    Stop {
        url_id: format!("mzk:{symbol}"),
        internal_id: symbol.parse::<i64>().unwrap_or_default() + 1000,
        name: name.to_owned(),
        lat,
        lon,
        stop_id: format!("mzk:{symbol}"),
        operator: Some(Operator::MZK),
        symbol: Some(symbol.to_owned()),
        ..Stop::default()
    }
}

fn kb_stops() -> Vec<Stop> {
    vec![
        kb(
            10302,
            "19146:39714",
            "BIELSKO-BIAŁA PIASTOWSKA LUBERTOWICZA",
            49.827047,
            19.036152,
        ),
        Stop {
            is_station: true,
            show_platforms: true,
            ..kb(10000, "184900", "BIELSKO-BIAŁA D.A.", 49.830227, 19.042746)
        },
        Stop {
            is_station: true,
            ..kb(23000, "19185", "CZECHOWICE-DZIEDZICE D.A.", 49.914492, 19.006531)
        },
    ]
}

fn mzk_stops() -> Vec<Stop> {
    vec![
        mz("265", "Piastowska Lubertowicza", 49.827047, 19.036152),
        mz("343", "Warszawska Dworzec", 49.8309, 19.0435),
        mz("341", "Warszawska Dworzec", 49.8315, 19.0432),
        mz("264", "Piastowska Dworzec", 49.8289, 19.0428),
        mz("2366", "Czechowice-Dz. Dworzec", 49.914582, 19.006531), // 10 m
        mz("2367", "Czechowice-Dz. Dworzec", 49.914375, 19.006531), // 13 m
    ]
}

fn mzk_dep(course: i64, line: &str, sec: i64) -> Value {
    json!({
        "courseId": course, "scheduledDepartureSec": sec, "scheduledDeparture": sec * 1000, "realDeparture": 0,
        "vehicleId": "", "variantId": 1, "orderInCourse": 1, "passed": false, "lack": true, "onStopPoint": false,
        "lineName": line, "directionName": format!("dir {line}"),
    })
}

fn kb_row() -> Value {
    json!({ "trip_execution_id": "kb1", "line_name": "120", "static_time": "15:03", "time": "15:03" })
}

async fn stops_bb() -> (Fake, Bb<Fakes>, tokio::sync::MutexGuard<'static, ()>) {
    LazyLock::force(&ENV);
    let guard = SERIAL.lock().await;
    DEPARTURES_BOARD_CACHE.clear();
    let fake = Fake::default();
    fake.with(|s| s.kb_stops = kb_stops());
    let bb = started(&fake, None, Some(mzk_stops())).await;
    (fake, bb, guard)
}

fn set_mzk_stops(bb: &Bb<Fakes>, stops: Vec<Stop>) {
    bb.mzk_poller().state().stops = Arc::new(stops);
}

#[tokio::test]
async fn both_stop_mzk_kb_rows_piastowska_lubertowicza() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows
            .insert("265".into(), vec![mzk_dep(1, "6", 54000), mzk_dep(2, "15", 54300)]);
        s.kb_rows.insert("19146:39714".into(), vec![kb_row()]);
    });
    let board = stop_board(&bb, "19146:39714").await;
    assert_eq!(sorted(operators(&board)), ["KB", "MZK", "MZK"]);
    assert_eq!(fake.with(|s| s.mzk_calls.clone()), ["265"]);
    stop(&bb).await;
}

#[tokio::test]
async fn regression_mzk_stops_that_load_after_the_first_departures_request_are_used_without_any_api_stops_call() {
    let (fake, bb, _serial) = stops_bb().await;
    set_mzk_stops(&bb, Vec::new()); // MZK upstream was down when the first request arrived
    fake.with(|s| {
        s.mzk_rows.insert("265".into(), vec![mzk_dep(1, "6", 54000)]);
        s.kb_rows.insert("19146:39714".into(), vec![kb_row()]);
    });
    let first = stop_board(&bb, "19146:39714").await;
    assert_eq!(operators(&first), ["KB"]);
    set_mzk_stops(&bb, mzk_stops()); // loaded in the background; nobody calls /api/stops
    let second = stop_board(&bb, "19146:39714").await;
    assert_eq!(sorted(operators(&second)), ["KB", "MZK"]);
    stop(&bb).await;
}

#[tokio::test]
async fn station_hub_fans_out_to_every_mzk_symbol_and_keeps_a_course_that_calls_at_two_of_them_only_once() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows
            .insert("2366".into(), vec![mzk_dep(11, "50", 54060), mzk_dep(12, "50", 54120)]);
        // course 12 calls at both
        s.mzk_rows
            .insert("2367".into(), vec![mzk_dep(12, "50", 54180), mzk_dep(13, "50", 54240)]);
    });
    let board = stop_board(&bb, "19185").await;
    assert_eq!(sorted(fake.with(|s| s.mzk_calls.clone())), ["2366", "2367"]);
    let mzk_rows: Vec<_> = board
        .rows
        .iter()
        .filter(|r| r.get("operator") == Some(&json!("MZK")))
        .collect();
    assert_eq!(mzk_rows.len(), 3);
    let ids: std::collections::HashSet<String> = mzk_rows
        .iter()
        .map(|r| r.get("trip_execution_id").map(Value::to_string).unwrap_or_default())
        .collect();
    assert_eq!(ids.len(), 3);
    stop(&bb).await;
}

#[tokio::test]
async fn a_hub_s_extra_mzk_symbol_has_no_stop_of_its_own_mzk_2367_opens_the_station_board() {
    let (fake, bb, _serial) = stops_bb().await;
    stop_board(&bb, "mzk:2367").await;
    assert_eq!(sorted(fake.with(|s| s.mzk_calls.clone())), ["2366", "2367"]);
    stop(&bb).await;
}

#[tokio::test]
async fn bielsko_biala_d_a_is_a_kb_station_its_board_never_asks_mzk() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows.insert("343".into(), vec![mzk_dep(10, "31", 54000)]);
        s.kb_rows.insert("184900".into(), vec![kb_row()]);
    });
    let board = stop_board(&bb, "184900").await;
    assert_eq!(fake.with(|s| s.mzk_calls.clone()), Vec::<String>::new());
    assert_eq!(operators(&board), ["KB"]);
    stop(&bb).await;
}

#[tokio::test]
async fn a_failed_mzk_fetch_is_reported_as_a_warning_instead_of_looking_like_no_mzk_departures() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_fail = true;
        s.kb_rows.insert("19146:39714".into(), vec![kb_row()]);
    });
    let res = stop_board(&bb, "19146:39714").await;
    assert_eq!(operators(&res), ["KB"]);
    assert_eq!(failed(&res), json!(["mzk"]));
    fake.with(|s| s.mzk_fail = false);
    // `warnings` is sent only when a leg failed
    assert!(stop_board(&bb, "19146:39714").await.failed.is_empty());
    stop(&bb).await;
}

#[tokio::test]
async fn opening_the_mzk_only_entry_of_a_street_stop_at_d_a_queries_just_that_symbol() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows.insert("341".into(), vec![mzk_dep(11, "8", 54060)]);
    });
    let board = stop_board(&bb, "mzk:341").await;
    assert_eq!(fake.with(|s| s.mzk_calls.clone()), ["341"]);
    assert_eq!(operators(&board), ["MZK"]);
    stop(&bb).await;
}

#[tokio::test]
async fn a_failed_kb_fetch_is_reported_too_the_both_panel_would_show_mzk_rows_only() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.kb_fail = true;
        s.mzk_rows.insert("265".into(), vec![mzk_dep(1, "6", 54000)]);
    });
    let res = stop_board(&bb, "19146:39714").await;
    assert_eq!(operators(&res), ["MZK"]);
    assert_eq!(failed(&res), json!(["kb"]));
    stop(&bb).await;
}
