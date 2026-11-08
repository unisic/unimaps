//! test/poller-singleton.test.ts: the start retry, the routes' own bounded KbApi and the `/api/vehicles` payload
//! memo of src/poller_singleton.rs. Nothing here builds a client against a live upstream: the services are fakes,
//! and `bb()` is only read on a thread without a runtime, where its accessors start nothing.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::Value;
use unimaps::gzm::{NowFn, ZbResponse, ZbTransport};
use unimaps::kb_api::KbSource;
use unimaps::mzk_api::{MzkLine, MzkRunningVehicle, MzkSource, MzkStopPoint};
use unimaps::mzk_poller::MzkPoller;
use unimaps::osrm::{OsrmHttp, OsrmTransport};
use unimaps::poller::{LivePoller, LivePollerOptions};
use unimaps::poller_singleton::{Bb, BbKinds, bb, route_kb_api};
use unimaps::shape_store::{ShapeStore, ShapeStoreOptions};
use unimaps::types::{Stop, VehiclesResponse};
use unimaps::vehicle::VehiclePos;

const NOW_MS: i64 = 1_800_000_000_000;

/// A KB source whose stop list never loads; `starts` counts the poller's start attempts.
struct DownKb(Arc<AtomicU32>);

impl KbSource for DownKb {
    async fn fetch_revision(&self) -> String {
        "1".to_owned()
    }
    async fn fetch_stops(&self, _: Option<&str>) -> Result<Vec<Stop>, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("upstream down".to_owned())
    }
    async fn fetch_multiple_departures(&self, _: &[String]) -> Result<Value, String> {
        Err("upstream down".to_owned())
    }
    async fn fetch_trip_execution(&self, _: &str, _: i64) -> Result<Value, String> {
        Err("upstream down".to_owned())
    }
}

/// The TS `mzkPoller: { start: async () => undefined }`: the MZK start settles whatever the source answers.
struct QuietMzk;

impl MzkSource for QuietMzk {
    async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
        Ok(Vec::new())
    }
    async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
        Ok(Vec::new())
    }
    async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
        Ok(Vec::new())
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
    type Kb = DownKb;
    type Mzk = QuietMzk;
    type Osrm = NoOsrm;
}

/// The TS `t.mock.method(globalThis, "fetch", () => new Promise(() => {}))`.
struct Hang;

impl ZbTransport for Hang {
    async fn get(&self, _: &str, _: &[(&str, &str)], _: Duration, _: usize) -> Result<ZbResponse, String> {
        std::future::pending().await
    }
}

fn fake_bb(kb_starts: Arc<AtomicU32>, now: NowFn) -> Bb<Fakes> {
    let shapes = ShapeStore::new(ShapeStoreOptions {
        timers: false,
        ..ShapeStoreOptions::new(NoOsrm)
    });
    Bb::<Fakes>::from_parts(
        DownKb(Arc::new(AtomicU32::new(0))),
        LivePoller::new(DownKb(kb_starts), LivePollerOptions::default()),
        QuietMzk,
        MzkPoller::new(QuietMzk).with_stop_dirs_file(None),
        shapes,
    )
    .with_gtfs_dir(std::env::temp_dir().join(format!("unimaps-no-gtfs-{}", std::process::id())))
    .with_now(now)
}

fn fixed_clock(ms: &Arc<AtomicI64>) -> NowFn {
    let ms = Arc::clone(ms);
    Arc::new(move || ms.load(Ordering::SeqCst))
}

fn mzk_pos(id: &str, updated_at: f64) -> Arc<VehiclePos> {
    Arc::new(VehiclePos {
        exec_id: id.to_owned(),
        trip_id: id.to_owned(),
        route_id: "6".to_owned(),
        line: "6".to_owned(),
        lat: 49.8,
        lon: 19.0,
        updated_at,
        timestamp: updated_at,
        bearing: None,
        next_stop_lat: None,
        next_stop_lon: None,
        operator: Some("MZK"),
        ..VehiclePos::default()
    })
}

/// The TS `builds` counter: every payload built is a new Arc, a memo hit hands back one already seen.
fn builds(seen: &[Arc<VehiclesResponse>]) -> usize {
    seen.iter()
        .enumerate()
        .filter(|(i, a)| !seen[..*i].iter().any(|b| Arc::ptr_eq(a, b)))
        .count()
}

async fn flush() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

// startPoller

#[tokio::test(start_paused = true)]
async fn retries_a_failed_kb_start_in_the_background_even_though_mzk_started() {
    let kb_starts = Arc::new(AtomicU32::new(0));
    let base = tokio::time::Instant::now();
    let bb = fake_bb(
        Arc::clone(&kb_starts),
        Arc::new(move || NOW_MS + base.elapsed().as_millis() as i64),
    );
    assert_eq!(bb.start_poller().await, Ok(()));
    assert_eq!(kb_starts.load(Ordering::SeqCst), 1);
    flush().await;
    tokio::time::advance(Duration::from_millis(60_000)).await;
    flush().await;
    assert_eq!(
        kb_starts.load(Ordering::SeqCst),
        2,
        "a failed KB start must be retried, not left dead for the life of the process"
    );
    bb.mzk_poller().stop().await;
}

// getApi

#[test]
fn routes_get_their_own_bounded_kb_api_a_flood_sheds_instead_of_queueing_behind_the_poller() {
    // no runtime on this thread: `poller()` starts nothing, so the live services are only compared, never run
    let live = bb();
    assert!(
        !std::ptr::eq(Arc::as_ptr(live.api()), &live.poller().api),
        "passthrough traffic must not share the poller's limiter"
    );
    // the flood goes to the same construction over a hanging transport, never the live network
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| panic!("runtime: {e}"));
    let first = rt.block_on(async {
        let route_api = Arc::new(route_kb_api(Hang));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        for i in 0..2000 {
            let (api, tx) = (Arc::clone(&route_api), tx.clone());
            tokio::spawn(async move {
                let res = api.fetch_departures(&i.to_string()).await;
                let _ = tx.send(res.map_or_else(|e| e, |_| "ok".to_owned()));
            });
        }
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(msg)) => msg,
            _ => "timeout".to_owned(),
        }
    });
    assert!(first.contains("queue full"), "{first}");
}

// getCombinedVehicles

#[test]
fn drops_mzk_positions_once_the_mzk_feed_has_stopped_refreshing() {
    let clock = Arc::new(AtomicI64::new(NOW_MS));
    let bb = fake_bb(Arc::new(AtomicU32::new(0)), fixed_clock(&clock));
    let now = NOW_MS as f64 / 1000.0;
    {
        let mut st = bb.mzk_poller().state();
        st.positions = Arc::new(IndexMap::from([
            ("fresh".to_owned(), mzk_pos("fresh", now - 3.0)),
            ("old".to_owned(), mzk_pos("old", now - 600.0)),
        ]));
        st.last_good_refresh = now - 3.0;
        st.scan_count = 1;
        st.last_scan = now;
    }
    let res = bb.combined_vehicles(Some("mzk"));
    let ids: Vec<&Value> = res.vehicles.iter().filter_map(|v| v.get("id")).collect();
    assert_eq!(ids, ["fresh"]);
}

// getCombinedVehicles memo

#[test]
fn serves_the_same_payload_until_the_kb_snapshot_or_the_mzk_map_changes() {
    let clock = Arc::new(AtomicI64::new(NOW_MS));
    let bb = fake_bb(Arc::new(AtomicU32::new(0)), fixed_clock(&clock));
    let mut seen = Vec::new();
    let first = bb.combined_vehicles(None);
    seen.push(Arc::clone(&first));
    let again = bb.combined_vehicles(None);
    assert!(Arc::ptr_eq(&again, &first));
    seen.push(again);
    let anything = bb.combined_vehicles(Some("anything"));
    assert!(
        Arc::ptr_eq(&anything, &first),
        "an unknown filter shares the unfiltered entry"
    );
    seen.push(anything);
    assert_eq!(builds(&seen), 1);
    // the KB snapshot key moves with the 5 s bucket of the clock
    clock.fetch_add(5_000, Ordering::SeqCst);
    let changed = bb.combined_vehicles(None);
    assert!(!Arc::ptr_eq(&changed, &first));
    seen.push(changed);
    bb.mzk_poller().state().positions = Arc::new(IndexMap::new());
    seen.push(bb.combined_vehicles(None));
    assert_eq!(builds(&seen), 3);
}
