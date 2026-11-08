//! Shared rig of test/stops-routes.test.ts (and test/mzk-not-started-routes.test.ts, test/trips-route.test.ts,
//! test/gtfs-connections-route.test.ts): the TS `api` / `mzkApi` fakes behind a started `Bb`, the KB / MZK stop literals and the departure row builders. The TS installs a
//! started singleton; here a `Bb` over fakes whose start loads the fixture data and touches no file.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use serde_json::{Value, json};
use unimaps::departures_board_cache::DEPARTURES_BOARD_CACHE;
use unimaps::kb_api::{KbSource, TripsBatch};
use unimaps::mzk_api::{
    MzkAtomicScheduleResponse, MzkLine, MzkRealtimeResponse, MzkRunningVehicle, MzkSource, MzkStopPoint,
};
use unimaps::mzk_poller::MzkPoller;
use unimaps::osrm::{OsrmHttp, OsrmTransport};
use unimaps::poller::{LivePoller, LivePollerOptions};
use unimaps::poller_singleton::{Bb, BbKinds};
use unimaps::shape_store::{ShapeStore, ShapeStoreOptions};
use unimaps::stop_merge::Operator;
use unimaps::types::Stop;

/// `support/tmp-output`: KB_OUTPUT_DIR (the merged view's GTFS bearings) -> a dir that is never created; every
/// other upstream at a closed port.
pub static ENV: LazyLock<()> = LazyLock::new(|| {
    let dir = std::env::temp_dir().join(format!("unimaps-stops-{}", std::process::id()));
    // SAFETY: forced first by every test of the binary, before anything in it reads the environment
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", dir);
        std::env::set_var("KB_GZM_GTFS_URL", "http://127.0.0.1:9/gtfs");
        std::env::set_var("KB_GZM_POSITIONS_URL", "http://127.0.0.1:9/positions");
        std::env::set_var("KB_ZB_API_URL", "http://127.0.0.1:9");
        std::env::set_var("KB_GZM_SDIP", "0");
        std::env::set_var("KB_GZM_SDIP_URL", "http://127.0.0.1:9/sdip");
        std::env::set_var("KB_GZM_NEWS_URL", "off");
        std::env::set_var("KB_OSRM_URL", "off");
        std::env::set_var("KB_GEOCODER_URL", "off");
        std::env::set_var("KB_LOG_LEVEL", "error");
    }
});
/// The board micro-cache is process-wide: one test at a time, each starting from an empty cache (`beforeEach`).
pub static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
pub struct FakeState {
    pub kb_stops: Vec<Stop>,
    pub kb_rows: HashMap<String, Vec<Value>>,
    pub kb_fail: bool,
    pub kb_calls: Vec<String>,
    pub mzk_rows: HashMap<String, Vec<Value>>,
    pub mzk_fail: bool,
    pub mzk_fail_syms: Vec<String>,
    pub sched_fail: bool,
    pub mzk_calls: Vec<String>,
    pub running: Vec<MzkRunningVehicle>,
    pub stop_points: Vec<MzkStopPoint>,
    pub lines: Vec<MzkLine>,
    /// trips-route `fake.cached` / `fake.fail`
    pub cached_trips: HashSet<String>,
    pub failing_trips: HashSet<String>,
}

/// The TS `api` / `mzkApi` fakes and what the pollers' start reads (KB and MZK stop lists, running courses).
#[derive(Clone, Default)]
pub struct Fake(Arc<Mutex<FakeState>>);

impl Fake {
    pub fn with<R>(&self, f: impl FnOnce(&mut FakeState) -> R) -> R {
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
    async fn fetch_timetable(&self, _: &str, _: &str) -> Result<Arc<Value>, String> {
        Ok(Arc::new(
            json!({ "departures": [{ "trip_id": "kbt1", "departure": 54000, "line": "120", "direction": "x" }] }),
        ))
    }
    fn has_cached_trip(&self, id: &str, _: i64) -> bool {
        self.with(|s| s.cached_trips.contains(id))
    }
    async fn fetch_trips_batch(&self, ids: &[String], _: i64) -> TripsBatch {
        self.with(|s| {
            let mut batch = TripsBatch {
                trips: Default::default(),
                failed: 0,
            };
            for id in ids {
                if s.failing_trips.contains(id) {
                    batch.failed += 1;
                } else {
                    let trip = json!({ "times": [], "line": { "name": "120" }, "direction": "x" });
                    batch.trips.insert(id.clone(), Arc::new(trip));
                }
            }
            batch
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
    async fn fetch_atomic_schedule(
        &self,
        symbol: &str,
        _: Option<&str>,
        _: bool,
    ) -> Result<Arc<MzkAtomicScheduleResponse>, String> {
        self.with(|s| {
            s.mzk_calls.push(format!("sched:{symbol}"));
            if s.sched_fail {
                return Err("OnTime unavailable".to_owned());
            }
            Ok(Arc::new(json!({ "lineSchedules": { "6": {
                "lineName": "6", "destination": "x",
                "departures": [{ "courseId": 1, "variantId": 1, "scheduledDepartureSec": 54060 }],
            } } })))
        })
    }
}

pub struct NoOsrm;

impl OsrmTransport for NoOsrm {
    async fn throttle(&self) {}
    async fn get(&self, _: &str) -> Result<OsrmHttp, String> {
        Err("no osrm".to_owned())
    }
}

pub struct Fakes;

impl BbKinds for Fakes {
    type Kb = Fake;
    type Mzk = Fake;
    type Osrm = NoOsrm;
}

/// A started singleton over `fake` (`startPromise` settled, as the TS installs it). `now_ms` None = system clock;
/// `mzk_stops` = the MZK poller's stop list as the TS sets it (the fake's `fetch_stops` stays empty then, and an
/// empty answer keeps that list).
pub async fn started(fake: &Fake, now_ms: Option<i64>, mzk_stops: Option<Vec<Stop>>) -> Bb<Fakes> {
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
        .with_gtfs_dir(std::env::temp_dir().join(format!("unimaps-stops-no-gtfs-{}", std::process::id())));
    if let Some(ms) = now_ms {
        bb = bb.with_now(Arc::new(move || ms));
    }
    bb.start_poller().await.expect("fake start");
    bb
}

pub async fn stop(bb: &Bb<Fakes>) {
    bb.mzk_poller().stop().await;
    bb.poller().stop().await;
}

pub fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

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

pub fn kb_stops() -> Vec<Stop> {
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

pub fn mzk_stops() -> Vec<Stop> {
    vec![
        mz("265", "Piastowska Lubertowicza", 49.827047, 19.036152),
        mz("343", "Warszawska Dworzec", 49.8309, 19.0435),
        mz("341", "Warszawska Dworzec", 49.8315, 19.0432),
        mz("264", "Piastowska Dworzec", 49.8289, 19.0428),
        mz("2366", "Czechowice-Dz. Dworzec", 49.914582, 19.006531), // 10 m
        mz("2367", "Czechowice-Dz. Dworzec", 49.914375, 19.006531), // 13 m
    ]
}

pub fn mzk_dep(course: i64, line: &str, sec: i64) -> Value {
    json!({
        "courseId": course, "scheduledDepartureSec": sec, "scheduledDeparture": sec * 1000, "realDeparture": 0,
        "vehicleId": "", "variantId": 1, "orderInCourse": 1, "passed": false, "lack": true, "onStopPoint": false,
        "lineName": line, "directionName": format!("dir {line}"),
    })
}

pub fn kb_row() -> Value {
    json!({ "trip_execution_id": "kb1", "line_name": "120", "static_time": "15:03", "time": "15:03" })
}

/// `beforeEach`: an empty board cache, the TS fakes over KB_STOPS / MZK_STOPS, a started singleton.
pub async fn stops_bb() -> (Fake, Bb<Fakes>, tokio::sync::MutexGuard<'static, ()>) {
    LazyLock::force(&ENV);
    let guard = SERIAL.lock().await;
    DEPARTURES_BOARD_CACHE.clear();
    let fake = Fake::default();
    fake.with(|s| s.kb_stops = kb_stops());
    let bb = started(&fake, None, Some(mzk_stops())).await;
    (fake, bb, guard)
}

/// `state.mzkPoller.stops = ...` (the poller swaps in a new array)
pub fn set_mzk_stops(bb: &Bb<Fakes>, stops: Vec<Stop>) {
    bb.mzk_poller().state().stops = Arc::new(stops);
}
