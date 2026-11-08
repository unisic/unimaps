//! test/mzk-not-started-routes.test.ts: "course not begun" on REAL OnTime records
//! (test/fixtures/mzk-running-vehicles.json, captured 2026-10-02 22:54:42) through the real handlers of
//! /api/stop/[designator]/departures, /api/trip_execution and /api/trip/[tripId], over a started `Bb` of fakes
//! (support/stops_fake.rs) whose clocks read the capture time. No network, no file.

#[allow(dead_code)]
#[path = "support/stops_fake.rs"]
mod rig;

use std::collections::HashMap;
use std::sync::LazyLock;

use http_body_util::BodyExt;
use hyper::Response;
use hyper::header::HeaderMap;
use rig::{ENV, Fake, Fakes, SERIAL, started, stop};
use serde_json::{Map, Value, json};
use unimaps::api::{ApiRequest, stop_departures, trip, trip_execution};
use unimaps::departures_board_cache::DEPARTURES_BOARD_CACHE;
use unimaps::http::Body;
use unimaps::poller_singleton::Bb;

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

/// `before`: the MZK poller polled once over the fixture, the singleton leaked for the handlers' `&'static`.
async fn setup() -> (&'static Bb<Fakes>, tokio::sync::MutexGuard<'static, ()>) {
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
    let bb = started(&fake, Some(now()), None).await;
    (Box::leak(Box::new(bb)), guard)
}

/// `new Request(url)`: no x-forwarded-for, so every request shares one bucket as in the TS
fn req(param: String, query: String) -> ApiRequest {
    ApiRequest {
        param,
        query,
        headers: HeaderMap::new(),
        ..Default::default()
    }
}

async fn json_of(res: Response<Body>) -> Value {
    let bytes = res.into_body().collect().await.expect("body").to_bytes();
    serde_json::from_slice(&bytes).expect("json body")
}

async fn row_of(bb: &'static Bb<Fakes>, v: &Value, stop_idx: usize) -> Map<String, Value> {
    let symbol = stop_point(v, stop_idx)["symbol"].as_str().expect("symbol");
    let res = stop_departures::get_bb(&req(format!("mzk:{symbol}"), String::new()), bb).await;
    let rows = json_of(res).await["rows"].as_array().cloned().unwrap_or_default();
    let course = v["courseLoid"].to_string();
    let row = rows.into_iter().find(|r| {
        r.get("trip_execution_id")
            .map(|id| id.as_str().map_or_else(|| id.to_string(), str::to_owned))
            .is_some_and(|id| id.contains(&course))
    });
    match row {
        Some(Value::Object(row)) => row,
        _ => panic!("no board row for {} at stop {stop_idx}", v["vehicleId"]),
    }
}

async fn live_trip(bb: &'static Bb<Fakes>, v: &Value) -> Value {
    let vehicle = v["vehicleId"].as_str().expect("vehicleId");
    // encodeURIComponent of `mzk:<digits>:<digits>`
    let id = format!("mzk%3A{}%3A{vehicle}", v["courseLoid"]);
    let res = trip_execution::get_bb(&req(String::new(), format!("?exec_id={id}")), bb).await;
    json_of(res).await
}

// --- departures route ---

#[tokio::test]
async fn not_started_late_bus_no_estimate_earliest_possible_time_flagged_first_stop_and_a_later_stop() {
    let (bb, _serial) = setup().await;
    let r0 = row_of(bb, veh("not_started_late"), 0).await;
    assert_eq!(r0.get("not_started"), Some(&json!(true)));
    assert_eq!(r0.get("is_estimated"), Some(&json!(false)));
    assert_eq!(r0.get("time_diff").and_then(Value::as_f64), Some(0.0));
    // scheduled 22:54:00, now 22:54:42: the bus cannot leave before "now"
    assert_eq!(r0.get("time"), Some(&json!("22:54")));
    let r5 = row_of(bb, veh("not_started_late"), 5).await;
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
    stop(bb).await;
}

#[tokio::test]
async fn not_started_early_bus_the_schedule_never_ontime_s_60_s_floor() {
    let (bb, _serial) = setup().await;
    let row = row_of(bb, veh("not_started_early"), 3).await;
    assert_eq!(row.get("not_started"), Some(&json!(true)));
    assert_eq!(row.get("time_diff").and_then(Value::as_f64), Some(0.0));
    assert_eq!(row.get("time"), row.get("static_time"));
    stop(bb).await;
}

#[tokio::test]
async fn running_bus_keeps_its_estimate() {
    let (bb, _serial) = setup().await;
    let row = row_of(bb, veh("running"), 5).await;
    assert_eq!(row.get("not_started"), None);
    assert_eq!(row.get("is_estimated"), Some(&json!(true)));
    stop(bb).await;
}

// --- trip_execution + static trip routes ---

#[tokio::test]
async fn live_trip_of_a_waiting_bus_carries_no_per_stop_estimate_and_the_flag() {
    let (bb, _serial) = setup().await;
    let j = live_trip(bb, veh("not_started_late")).await;
    assert_eq!(j.get("not_started"), Some(&json!(true)));
    let times = j["trip"]["times"].as_array().cloned().unwrap_or_default();
    assert!(times.len() > 5);
    assert!(times.iter().all(|t| t.get("estimate").is_none()));
    assert_eq!(j.get("vehicle_trip_index").and_then(Value::as_f64), Some(0.0));
    stop(bb).await;
}

#[tokio::test]
async fn live_trip_of_a_running_bus_keeps_estimates_and_has_no_flag() {
    let (bb, _serial) = setup().await;
    let j = live_trip(bb, veh("running")).await;
    assert_eq!(j.get("not_started"), None);
    let times = j["trip"]["times"].as_array().cloned().unwrap_or_default();
    assert!(times.iter().all(|t| t["estimate"]["time_diff"].is_number()));
    stop(bb).await;
}

#[tokio::test]
async fn static_publicly_cached_trip_never_embeds_live_estimates() {
    let (bb, _serial) = setup().await;
    for v in [veh("running"), veh("not_started_late")] {
        let trip_id = format!("mzk:{}:{}", v["courseLoid"], v["variantLoid"]);
        let res = trip::get_bb(&req(trip_id, String::new()), bb).await;
        let cache = res
            .headers()
            .get("cache-control")
            .and_then(|h| h.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        assert!(cache.contains("public"), "{cache}");
        let j = json_of(res).await;
        let times = j["times"].as_array().cloned().unwrap_or_default();
        assert!(times.len() > 5);
        assert!(times.iter().all(|t| t.get("estimate").is_none()), "{}", v["vehicleId"]);
    }
    stop(bb).await;
}

// --- frozen OnTime feed ---

#[tokio::test]
async fn a_running_course_is_not_served_as_live_once_the_feed_stopped_refreshing() {
    let (bb, _serial) = setup().await;
    let good = bb.mzk_poller().state().last_good_refresh;
    assert!(
        live_trip(bb, veh("running")).await["trip"]["times"].is_array(),
        "fresh feed: live trip"
    );
    bb.mzk_poller().state().last_good_refresh = now() as f64 / 1000.0 - 120.0;
    assert_eq!(
        live_trip(bb, veh("running")).await.get("trip"),
        None,
        "stale feed: no frozen live trip"
    );
    bb.mzk_poller().state().last_good_refresh = good;
    stop(bb).await;
}
