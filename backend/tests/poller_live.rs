//! Port of test/poller-live.test.ts: LivePoller end to end against a fake KbSource (no network): the
//! departures-board truncation rule, the 404 cache, ghost filtering, heading, parsePosition's midnight wrap,
//! out-of-order responses, the arrival log bound and the stop-list reload backoff. The TS mock.timers Date is
//! the injected clock.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::sync::{Notify, oneshot};
use unimaps::kb_api::KbSource;
use unimaps::poller::{LivePoller, LivePollerOptions};
use unimaps::types::Stop;

/// 2026-10-22 08:00 UTC = 10:00 Europe/Warsaw
const T0: i64 = 1_792_656_000_000;
const LAT0: f64 = 49.8;
const LON0: f64 = 19.0;

fn p(east: f64, north: f64) -> [f64; 2] {
    let kx = 111_320.0 * (LAT0 * (std::f64::consts::PI / 180.0)).cos();
    [LAT0 + north / 111_320.0, LON0 + east / kx]
}

fn mk_stops(n: usize) -> Vec<Stop> {
    (0..n)
        .map(|i| Stop {
            url_id: format!("S{}", i + 1),
            internal_id: i as i64 + 1,
            name: format!("Stop {}", i + 1),
            lat: LAT0,
            lon: LON0 + i as f64 * 0.01,
            stop_id: format!("S{}", i + 1),
            ..Default::default()
        })
        .collect()
}

/// A trip execution reply; designators 901+ resolve to no stop, so GPS progress stays out of the way.
fn trip_resp(at: [f64; 2], extra: Value) -> Value {
    let times: Vec<Value> = ["10:00", "10:05", "10:10"]
        .iter()
        .enumerate()
        .map(|(i, t)| json!({ "stop_name": format!("T{i}"), "designator": 901 + i, "departure_time": t }))
        .collect();
    let mut o: Map<String, Value> = json!({
        "trip": { "times": times, "line": { "name": "1" }, "direction": "X" },
        "vehicle": { "lat": at[0], "lon": at[1] },
        "vehicle_trip_index": 0,
        "next_departure_index": 1,
        "at_stop": false,
        "estimates": [{ "arrival_abs": "10:06" }],
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    if let Value::Object(extra) = extra {
        o.extend(extra);
    }
    Value::Object(o)
}

type Fut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type ExecFn = Box<dyn Fn() -> Fut<Result<Value, String>> + Send + Sync>;
type DepsFn = Box<dyn Fn(&[String]) -> Value + Send + Sync>;

/// The TS `{ fetchRevision, fetchStops, ...api } as unknown as KbApi`; a method the test leaves out throws.
struct Fake {
    stops: Box<dyn Fn() -> Vec<Stop> + Send + Sync>,
    deps: Option<DepsFn>,
    exec: Option<ExecFn>,
}

impl Fake {
    fn new(stops: Vec<Stop>) -> Self {
        Self {
            stops: Box::new(move || stops.clone()),
            deps: None,
            exec: None,
        }
    }

    fn deps(mut self, f: impl Fn(&[String]) -> Value + Send + Sync + 'static) -> Self {
        self.deps = Some(Box::new(f));
        self
    }

    fn exec(mut self, f: impl Fn() -> Fut<Result<Value, String>> + Send + Sync + 'static) -> Self {
        self.exec = Some(Box::new(f));
        self
    }
}

fn ready(v: Result<Value, String>) -> Fut<Result<Value, String>> {
    Box::pin(async move { v })
}

impl KbSource for Fake {
    async fn fetch_revision(&self) -> String {
        "1".into()
    }

    async fn fetch_stops(&self, _revision: Option<&str>) -> Result<Vec<Stop>, String> {
        Ok((self.stops)())
    }

    async fn fetch_multiple_departures(&self, stop_url_ids: &[String]) -> Result<Value, String> {
        match &self.deps {
            Some(f) => Ok(f(stop_url_ids)),
            None => Err("TypeError: this.api.fetchMultipleDepartures is not a function".into()),
        }
    }

    async fn fetch_trip_execution(&self, _trip_execution_id: &str, _index: i64) -> Result<Value, String> {
        match &self.exec {
            Some(f) => f().await,
            None => Err("TypeError: this.api.fetchTripExecution is not a function".into()),
        }
    }
}

/// mock.timers' Date: `set_t(sec)` = `mock.timers.setTime(T0 + sec * 1000)`
#[derive(Clone)]
struct Clock(Arc<AtomicI64>);

impl Clock {
    fn new() -> Self {
        Self(Arc::new(AtomicI64::new(T0)))
    }

    fn set_t(&self, sec: i64) {
        self.0.store(T0 + sec * 1000, Ordering::SeqCst);
    }
}

async fn mk_poller(api: Fake, opts: LivePollerOptions, clock: &Clock) -> Arc<LivePoller<Fake>> {
    let c = clock.0.clone();
    let poller = LivePoller::new(api, opts).with_now(Arc::new(move || c.load(Ordering::SeqCst)));
    let _ = poller.load_stops().await;
    Arc::new(poller)
}

#[tokio::test]
async fn a_board_absent_from_the_reply_truncation_is_rescanned_an_empty_board_is_cached_as_empty() {
    let clock = Clock::new();
    let asked: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let a = asked.clone();
    let api = Fake::new(mk_stops(8))
        .deps(move |ids| {
            if let Ok(mut a) = a.lock() {
                a.push(ids.to_vec());
            }
            // upstream answers at most 6 boards, empty stops still get a board with empty rows
            let boards: Vec<Value> = ids
                .iter()
                .take(6)
                .map(|d| json!({ "designator": d, "rows": [] }))
                .collect();
            json!({ "departures": boards })
        })
        .exec(|| ready(Ok(json!({}))));
    let poller = mk_poller(
        api,
        LivePollerOptions {
            batch_size: Some(8),
            ..Default::default()
        },
        &clock,
    )
    .await;
    poller.full_scan().await;
    assert_eq!(
        *asked.lock().unwrap(),
        vec![vec!["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]]
    );
    poller.full_scan().await;
    assert_eq!(
        asked.lock().unwrap()[1],
        vec!["S7", "S8"],
        "only the truncated stops are due again"
    );
}

#[tokio::test]
async fn cache_404_a_cached_skip_never_re_stamps_the_trip_is_re_fetched_once_the_cache_expires_a_fetch_error_is_not_a_404()
 {
    const M404: u8 = 0;
    const OK: u8 = 1;
    const THROW: u8 = 2;
    let clock = Clock::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicU8::new(M404));
    let (c, m) = (calls.clone(), mode.clone());
    let api = Fake::new(mk_stops(1))
        .deps(|_| json!({ "departures": [{ "designator": "S1", "rows": [{ "trip_execution_id": "E1", "time": "< 1 min" }] }] }))
        .exec(move || {
            c.fetch_add(1, Ordering::SeqCst);
            ready(match m.load(Ordering::SeqCst) {
                THROW => Err("Error: socket hang up".into()),
                M404 => Ok(json!({})),
                _ => Ok(trip_resp(p(0.0, 0.0), json!({}))),
            })
        });
    let poller = mk_poller(
        api,
        LivePollerOptions {
            cache404: Some(240.0),
            ..Default::default()
        },
        &clock,
    )
    .await;
    let t0s = (T0 / 1000) as f64;
    poller.full_scan().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(poller.not_found("E1"), Some(t0s));

    mode.store(OK, Ordering::SeqCst);
    clock.set_t(180);
    poller.full_scan().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "still inside the 404 cache: skipped");
    assert_eq!(poller.not_found("E1"), Some(t0s), "the skip must not slide the TTL");

    clock.set_t(241);
    poller.full_scan().await;
    assert_eq!(calls.load(Ordering::SeqCst), 2, "cache expired: fetched again");
    let pos = poller.position("E1").expect("the late-dispatched bus is tracked");
    assert_eq!(poller.not_found("E1"), None);

    mode.store(THROW, Ordering::SeqCst);
    clock.set_t(251);
    poller.refresh_active().await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert!(
        poller.position("E1").is_some_and(|p| Arc::ptr_eq(&p, &pos)),
        "a failed fetch keeps the previous position"
    );
    assert_eq!(poller.not_found("E1"), None, "a failed fetch is not a 404");
}

/// A fake whose trip execution reply is built from the shared `at` at call time.
fn moving_fake(at: &Arc<Mutex<[f64; 2]>>, extra: Value) -> Fake {
    let at = at.clone();
    Fake::new(vec![]).exec(move || {
        let now = at.lock().map(|a| *a).unwrap_or_default();
        ready(Ok(trip_resp(now, extra.clone())))
    })
}

#[tokio::test]
async fn ghosts_a_feed_frozen_within_the_movement_epsilon_no_delay_is_hidden_and_pruned_a_creeping_bus_is_not() {
    let clock = Clock::new();
    let at = Arc::new(Mutex::new(p(0.0, 0.0)));
    let set_at = |v: [f64; 2]| *at.lock().unwrap() = v;
    let poller = mk_poller(
        moving_fake(&at, json!({ "estimates": [] })),
        LivePollerOptions::default(),
        &clock,
    )
    .await;
    poller.ingest_trip_execution("ghost", &trip_resp(p(0.0, 0.0), json!({ "estimates": [] })), None);
    assert_eq!(poller.position("ghost").and_then(|v| v.delay), None);
    for k in 1..=6 {
        clock.set_t(60 * k);
        // GPS jitter around a parked bus
        set_at(p(0.0, if k % 2 == 1 { 3.0 } else { -3.0 }));
        poller.refresh_active().await;
        if k == 4 {
            assert_eq!(poller.to_json().count, 1, "frozen 240 s: still shown");
        }
    }
    assert_eq!(
        poller.to_json().count,
        0,
        "frozen > 300 s with no delay estimate: hidden"
    );
    assert_eq!(poller.positions_len(), 0, "and pruned");

    clock.set_t(0);
    set_at(p(0.0, 0.0));
    poller.ingest_trip_execution("creep", &trip_resp(p(0.0, 0.0), json!({ "estimates": [] })), None);
    for k in 1..=8 {
        clock.set_t(60 * k);
        // 5 m per poll: each step under the epsilon, the sum is not
        set_at(p(5.0 * k as f64, 0.0));
        poller.refresh_active().await;
    }
    let v = poller.position("creep").expect("a slowly moving bus stays tracked");
    let t0s = T0 as f64 / 1000.0;
    assert!(
        v.last_moved_at > t0s + 300.0,
        "lastMovedAt advanced ({})",
        v.last_moved_at - t0s
    );
    assert_eq!(poller.to_json().count, 1);
}

#[tokio::test]
async fn heading_follows_movement_of_8_m_and_is_kept_while_almost_standing() {
    let clock = Clock::new();
    let at = Arc::new(Mutex::new(p(0.0, 0.0)));
    let poller = mk_poller(moving_fake(&at, json!({})), LivePollerOptions::default(), &clock).await;
    poller.ingest_trip_execution("E", &trip_resp(p(0.0, 0.0), json!({})), None);
    let step = async |sec: i64, to: [f64; 2]| {
        clock.set_t(sec);
        *at.lock().unwrap() = to;
        poller.refresh_active().await;
        poller.position("E").unwrap().bearing
    };
    assert_eq!(step(10, p(0.0, 3.0)).await, None, "3 m: no heading yet");
    let north = step(20, p(0.0, 23.0)).await;
    assert!(
        north.is_some_and(|n| !(1.0..=359.0).contains(&n)),
        "20 m north -> {north:?}"
    );
    assert_eq!(step(30, p(3.0, 23.0)).await, north, "3 m east: heading kept");
    let east = step(40, p(23.0, 23.0)).await;
    assert!(east.is_some_and(|e| (e - 90.0).abs() < 1.0), "20 m east -> {east:?}");
}

#[tokio::test]
async fn parse_position_delay_wraps_midnight_both_ways_time_diff_is_the_fallback() {
    let clock = Clock::new();
    let poller = mk_poller(Fake::new(vec![]), LivePollerOptions::default(), &clock).await;
    let times = |t1: &str, est: Option<Value>| {
        let mut first = json!({ "designator": 901, "departure_time": "23:50" });
        if let (Some(est), Some(o)) = (est, first.as_object_mut()) {
            o.insert("estimate".into(), est);
        }
        json!({
            "times": [first, { "designator": 902, "departure_time": t1 }],
            "line": { "name": "1" },
            "direction": "X",
        })
    };
    let late = poller.ingest_trip_execution(
        "a",
        &trip_resp(
            p(0.0, 0.0),
            json!({ "trip": times("23:58", None), "estimates": [{ "arrival_abs": "00:02" }] }),
        ),
        None,
    );
    assert_eq!(late.and_then(|v| v.delay_up), Some(Some(240.0)));
    let early = poller.ingest_trip_execution(
        "b",
        &trip_resp(
            p(0.0, 0.0),
            json!({ "trip": times("00:02", None), "estimates": [{ "arrival_abs": "23:58" }] }),
        ),
        None,
    );
    assert_eq!(early.and_then(|v| v.delay_up), Some(Some(-240.0)));
    let fb = poller.ingest_trip_execution(
        "c",
        &trip_resp(
            p(0.0, 0.0),
            json!({ "trip": times("00:02", Some(json!({ "time_diff": 90 }))), "estimates": [] }),
        ),
        None,
    );
    assert_eq!(fb.and_then(|v| v.delay_up), Some(Some(90.0)));
}

#[tokio::test]
async fn out_of_order_responses_a_reply_to_an_older_request_never_overwrites_a_newer_position() {
    let clock = Clock::new();
    let (release, reply) = oneshot::channel::<Value>();
    let reply = Arc::new(Mutex::new(Some(reply)));
    let asked = Arc::new(Notify::new());
    let n = asked.clone();
    let api = Fake::new(vec![]).exec(move || {
        let rx = reply.lock().ok().and_then(|mut r| r.take());
        n.notify_one();
        Box::pin(async move {
            match rx {
                Some(rx) => rx.await.map_err(|e| e.to_string()),
                None => Err("asked twice".into()),
            }
        })
    });
    let poller = mk_poller(api, LivePollerOptions::default(), &clock).await;
    poller.ingest_trip_execution("E", &trip_resp(p(0.0, 0.0), json!({})), None);
    clock.set_t(10);
    // poller asks upstream at t=10 ...
    let refresh = tokio::spawn({
        let poller = poller.clone();
        async move { poller.refresh_active().await }
    });
    asked.notified().await;
    clock.set_t(12);
    // ... a viewer's newer reply lands first
    poller.ingest_trip_execution("E", &trip_resp(p(0.0, 200.0), json!({})), None);
    // ... then the poller's older one
    let _ = release.send(trip_resp(p(0.0, 100.0), json!({})));
    refresh.await.unwrap();
    assert_eq!(poller.position("E").unwrap().lat, p(0.0, 200.0)[0]);
    // a viewer's reply to a request issued before the stored one is dropped as well
    let kept = poller.ingest_trip_execution("E", &trip_resp(p(0.0, 50.0), json!({})), Some(T0 + 11_000));
    assert_eq!(kept.map(|v| v.lat), Some(p(0.0, 200.0)[0]));
}

#[tokio::test]
async fn the_arrival_log_stays_bounded_by_the_trip_s_stop_count_on_a_garbage_vehicle_trip_index() {
    let clock = Clock::new();
    let poller = mk_poller(Fake::new(vec![]), LivePollerOptions::default(), &clock).await;
    poller.ingest_trip_execution("E", &trip_resp(p(0.0, 0.0), json!({ "vehicle_trip_index": 0 })), None);
    clock.set_t(10);
    poller.ingest_trip_execution("E", &trip_resp(p(0.0, 100.0), json!({ "vehicle_trip_index": 1 })), None);
    clock.set_t(20);
    let pos = poller.ingest_trip_execution(
        "E",
        &trip_resp(p(0.0, 200.0), json!({ "vehicle_trip_index": 100_000 })),
        None,
    );
    let arrivals = pos.and_then(|v| v.arrivals.clone()).expect("arrivals");
    assert!(arrivals.arrived.len() <= 3, "arrived.length {}", arrivals.arrived.len());
}

/// mock.timers with Date and setTimeout: the injected clock follows tokio's paused time.
#[tokio::test(start_paused = true)]
async fn an_empty_reload_backs_off_like_a_failed_one_instead_of_retrying_every_full_scan() {
    let stop_calls = Arc::new(AtomicUsize::new(0));
    let s = stop_calls.clone();
    let stops = mk_stops(1);
    let mut api = Fake::new(vec![]).deps(|_| json!({}));
    api.stops = Box::new(move || {
        if s.fetch_add(1, Ordering::SeqCst) == 0 {
            stops.clone()
        } else {
            vec![]
        }
    });
    let base = tokio::time::Instant::now();
    let poller = LivePoller::new(
        api,
        LivePollerOptions {
            scan_interval: Some(1.0),
            refresh_interval: Some(1.0),
            ..Default::default()
        },
    )
    .with_now(Arc::new(move || T0 + base.elapsed().as_millis() as i64));
    let _ = poller.load_stops().await;
    let poller = Arc::new(poller);
    poller.start().await.unwrap();
    let before = stop_calls.load(Ordering::SeqCst);
    // the daily reload is due
    poller.set_stops_loaded_at(0.0);
    for _ in 0..6 {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        tokio::task::yield_now().await;
    }
    poller.stop().await;
    assert_eq!(
        stop_calls.load(Ordering::SeqCst) - before,
        1,
        "one empty reload, then the 30 min backoff"
    );
    assert_eq!(poller.stops().len(), 1, "the previous list is kept");
}
