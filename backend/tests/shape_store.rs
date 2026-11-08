//! Port of test/shape-store.test.ts: queue/worker behaviour with a fake OSRM + fake clock (no network, no timers),
//! and persistence in a throwaway temp dir.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use tokio::sync::oneshot;
use unimaps::osrm::{OsrmHttp, OsrmTransport};
use unimaps::shape_patterns::KbPattern;
use unimaps::shape_store::{
    ALGO_VERSION, BoxFut, ShapeEntry, ShapePrio, ShapeSrc, ShapeStatus, ShapeStore, ShapeStoreOptions,
    pick_refresh_candidate,
};
use unimaps::shared::polyline::{LatLng, decode_polyline, encode_polyline, seg_meters};

const LAT0: f64 = 49.8;
const LON0: f64 = 19.0;

#[allow(non_snake_case)]
fn P(east: f64, north: f64) -> LatLng {
    let kx = 111_320.0 * (LAT0 * (std::f64::consts::PI / 180.0)).cos();
    [LAT0 + north / 111_320.0, LON0 + east / kx]
}

fn pattern(key: &str, n: usize) -> KbPattern {
    let pts: Vec<LatLng> = (0..n).map(|i| P(i as f64 * 300.0, 0.0)).collect();
    KbPattern {
        key: key.into(),
        stop_pts: pts.iter().copied().map(Some).collect(),
        waypoints: pts,
        wp_sig: "sig1".into(),
        line: "1".into(),
        dir: "X".into(),
    }
}

const KEY: &str = "kb:0123456789ab";

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Ok,
    Down,
    NoRoute,
    /// the TS test swaps in a fetchImpl that answers 403
    Forbidden,
}

type Gate = Arc<Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>>;

struct Fake {
    mode: Arc<Mutex<Mode>>,
    now: Arc<AtomicI64>,
    req_at: Arc<Mutex<Vec<i64>>>,
    /// when set, the next request reports itself and waits for the release
    gate: Gate,
}

fn http(status: u16, body: Option<Value>) -> OsrmHttp {
    OsrmHttp {
        status,
        body,
        retry_after: None,
    }
}

impl OsrmTransport for Fake {
    async fn throttle(&self) {}

    async fn get(&self, url: &str) -> Result<OsrmHttp, String> {
        self.req_at.lock().unwrap().push(self.now.load(Ordering::SeqCst));
        let gate = self.gate.lock().unwrap().take();
        if let Some((entered, release)) = gate {
            let _ = entered.send(());
            let _ = release.await;
        }
        let mode = *self.mode.lock().unwrap();
        match mode {
            Mode::Down => return Ok(http(503, None)),
            Mode::NoRoute => return Ok(http(400, Some(json!({ "code": "NoRoute" })))),
            Mode::Forbidden => return Ok(http(403, None)),
            Mode::Ok => {}
        }
        let u = url::Url::parse(url).unwrap();
        let p = u.path();
        let coords: Vec<LatLng> = p[p.rfind('/').unwrap() + 1..]
            .split(';')
            .map(|c| {
                let (lon, lat) = c.split_once(',').unwrap();
                [lat.parse().unwrap(), lon.parse().unwrap()]
            })
            .collect();
        // a "road" that bulges 20 m north between stops
        let mut geom: Vec<LatLng> = Vec::new();
        for (i, c) in coords.iter().enumerate() {
            geom.push(*c);
            if let Some(n) = coords.get(i + 1) {
                geom.push([(c[0] + n[0]) / 2.0 + 20.0 / 111_320.0, (c[1] + n[1]) / 2.0]);
            }
        }
        let legs: Vec<Value> = coords
            .windows(2)
            .map(|w| json!({ "distance": seg_meters(w[0][0], w[0][1], w[1][0], w[1][1]) + 2.0 }))
            .collect();
        Ok(http(
            200,
            Some(json!({ "code": "Ok", "routes": [{ "geometry": encode_polyline(&geom, 6), "legs": legs }] })),
        ))
    }
}

struct H {
    store: Arc<ShapeStore<Fake>>,
    mode: Arc<Mutex<Mode>>,
    req_at: Arc<Mutex<Vec<i64>>>,
    now: Arc<AtomicI64>,
    gate: Gate,
}

impl H {
    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }

    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn set_mode(&self, m: Mode) {
        *self.mode.lock().unwrap() = m;
    }

    fn entry(&self, key: &str) -> ShapeEntry {
        self.store.get_entry(key).unwrap()
    }

    fn health(&self, field: &str) -> Value {
        self.store.health()[field].clone()
    }
}

fn harness(extra: impl FnOnce(&mut ShapeStoreOptions<Fake>)) -> H {
    let now = Arc::new(AtomicI64::new(1_800_000_000_000));
    let mode = Arc::new(Mutex::new(Mode::Ok));
    let req_at = Arc::new(Mutex::new(Vec::new()));
    let gate: Gate = Arc::new(Mutex::new(None));
    let fake = Fake {
        mode: mode.clone(),
        now: now.clone(),
        req_at: req_at.clone(),
        gate: gate.clone(),
    };
    let (clock, slept) = (now.clone(), now.clone());
    let mut o = ShapeStoreOptions {
        osrm_base: Some("https://osrm.test/route/v1/driving".into()),
        min_interval_ms: 1000,
        max_age_days: 14.0,
        file: None,
        timers: false,
        now: Arc::new(move || clock.load(Ordering::SeqCst)),
        sleep: Arc::new(move |ms| {
            slept.fetch_add(ms, Ordering::SeqCst);
            Box::pin(async {}) as BoxFut<()>
        }),
        ..ShapeStoreOptions::new(fake)
    };
    extra(&mut o);
    let store = ShapeStore::new(o);
    store.start();
    H {
        store,
        mode,
        req_at,
        now,
        gate,
    }
}

fn plain(_: &mut ShapeStoreOptions<Fake>) {}

/* ---------------- ShapeStore: KB routing ---------------- */

#[tokio::test]
async fn new_pattern_straight_entry_at_once_not_served_routed_by_the_worker() {
    let h = harness(plain);
    let p = pattern(KEY, 4);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    assert_eq!(h.store.get_entry(&p.key).map(|e| e.src), Some(ShapeSrc::Straight));
    assert_eq!(h.store.wire_id(&p.key), None);
    assert_eq!(h.store.status(Some(&p.key)), ShapeStatus::Pending);
    assert_eq!(
        h.store.lookup(std::slice::from_ref(&p.key)).missing,
        vec![p.key.clone()]
    );

    assert!(h.store.run_next(None).await);
    let e = h.entry(&p.key);
    assert_eq!(e.src, ShapeSrc::Osrm);
    assert_eq!(h.store.status(Some(&p.key)), ShapeStatus::Road);
    let id = h.store.wire_id(&p.key).unwrap();
    assert_eq!(id, format!("{}.{}", p.key, e.rev));
    let look = h.store.lookup(std::slice::from_ref(&id));
    assert!(look.exact);
    let shape = &look.shapes[&id];
    assert_eq!(shape.id, id);
    assert_eq!(shape.stops.len(), 4);
    // stops are monotone along the road
    let s: Vec<f64> = shape.stops.iter().map(|x| x.unwrap().0).collect();
    assert!(s[0] < s[1] && s[1] < s[2] && s[2] < s[3]);
    assert!(decode_polyline(&shape.poly, 6).len() > 4);
    assert!(!h.store.run_next(None).await);
}

/// lib/shape-store.ts kick(): `pumping[kind] = false` sits in the worker's own `finally`, so a key queued
/// after its last empty runNext starts a fresh worker instead of waiting for the next enqueue.
#[tokio::test]
async fn a_key_queued_as_the_worker_winds_down_is_still_routed() {
    let h = harness(|o| o.timers = true);
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    *h.gate.lock().unwrap() = Some((entered_tx, release_rx));
    h.store.touch_kb(&pattern(KEY, 4), ShapePrio::Urgent);
    entered_rx.await.unwrap();
    // FIFO on the current-thread runtime: the worker finishes its job and its last empty run_next,
    // then this task queues the next key before anything else the worker's exit woke up runs
    release_tx.send(()).unwrap();
    let store = h.store.clone();
    let late = tokio::spawn(async move { store.touch_kb(&pattern("kb:fedcba987654", 4), ShapePrio::Urgent) });
    late.await.unwrap();
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(h.entry(KEY).src, ShapeSrc::Osrm);
    assert_eq!(h.entry("kb:fedcba987654").src, ShapeSrc::Osrm);
    assert_eq!(h.store.status(Some("kb:fedcba987654")), ShapeStatus::Road);
}

#[tokio::test]
async fn an_outdated_rev_gets_current_content_but_is_not_immutable() {
    let h = harness(plain);
    let p = pattern(KEY, 4);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    h.store.run_next(None).await;
    let old = format!("{}.ffffff", p.key);
    let look = h.store.lookup(std::slice::from_ref(&old));
    assert!(!look.exact);
    assert_eq!(Some(look.shapes[&old].id.clone()), h.store.wire_id(&p.key));
}

#[tokio::test]
async fn osrm_down_nothing_committed_breaker_pauses_job_kept() {
    let h = harness(plain);
    let p = pattern(KEY, 4);
    h.set_mode(Mode::Down);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    h.store.run_next(None).await;
    assert_eq!(h.entry(&p.key).src, ShapeSrc::Straight);
    assert_eq!(h.health("osrm_state"), json!("paused"));
    assert_eq!(h.health("queued"), json!(1));
    // still paused -> nothing runnable
    assert!(!h.store.run_next(None).await);
    h.advance(61_000);
    h.set_mode(Mode::Ok);
    assert!(h.store.run_next(None).await);
    assert_eq!(h.entry(&p.key).src, ShapeSrc::Osrm);
}

#[tokio::test]
async fn never_downgrades_a_stored_road_shape() {
    let h = harness(plain);
    let p = pattern(KEY, 4);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    h.store.run_next(None).await;
    let rev = h.entry(&p.key).rev;
    // stops moved -> rebuild queued; this time every leg is unroutable
    h.set_mode(Mode::NoRoute);
    h.store.touch_kb(
        &KbPattern {
            wp_sig: "sig2".into(),
            ..p.clone()
        },
        ShapePrio::Urgent,
    );
    h.store.run_next(None).await;
    let e = h.entry(&p.key);
    assert_eq!(e.src, ShapeSrc::Osrm);
    assert_eq!(e.rev, rev);
}

#[tokio::test]
async fn a_rebuild_under_a_new_algo_that_would_downgrade_backs_off_instead_of_re_routing_every_tick() {
    let h = harness(plain);
    let p = pattern(KEY, 4);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    h.store.run_next(None).await;
    // stored by the previous pipeline
    assert!(h.store.edit_entry(&p.key, |e| e.algo = ALGO_VERSION - 1.0));
    h.set_mode(Mode::NoRoute);
    h.store.refresh_tick();
    assert!(h.store.run_next(None).await);
    let e = h.entry(&p.key);
    assert_eq!(e.src, ShapeSrc::Osrm); // kept
    assert_eq!(pick_refresh_candidate([(&p.key, &e)], h.now(), 14.0, None), None);
    h.advance(e.retry_at as i64 - h.now());
    assert_eq!(
        pick_refresh_candidate([(&p.key, &e)], h.now(), 14.0, None),
        Some(p.key.clone())
    );
}

#[tokio::test]
async fn all_legs_unroutable_straight_marked_unroutable_status_none() {
    let h = harness(plain);
    let p = pattern(KEY, 4);
    h.set_mode(Mode::NoRoute);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    h.store.run_next(None).await;
    let e = h.entry(&p.key);
    assert_eq!(e.src, ShapeSrc::Straight);
    assert_eq!(e.unroutable, Some(true));
    assert_eq!(h.store.status(Some(&p.key)), ShapeStatus::None);
}

#[tokio::test]
async fn throttles_every_request_minimum_interval_apart() {
    let h = harness(plain);
    h.store.touch_kb(&pattern("kb:aaaaaaaaaaaa", 30), ShapePrio::Urgent); // 3 chunks
    h.store.touch_kb(&pattern("kb:bbbbbbbbbbbb", 4), ShapePrio::Background);
    while h.store.run_next(None).await {}
    let req_at = h.req_at.lock().unwrap().clone();
    assert_eq!(req_at.len(), 8); // 4 chunks, each with and without the stop directions
    for w in req_at.windows(2) {
        assert!(w[1] - w[0] >= 1000, "{w:?}");
    }
}

#[tokio::test]
async fn osrm_403_blocked_for_a_day_trips_report_none_then_it_retries() {
    let h = harness(plain);
    let p = pattern(KEY, 4);
    h.set_mode(Mode::Ok);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    // swap in a refusing OSRM
    h.set_mode(Mode::Forbidden);
    h.store.run_next(None).await;
    assert_eq!(h.health("osrm_state"), json!("blocked"));
    assert_eq!(h.store.status(Some(&p.key)), ShapeStatus::None);
    h.advance(25 * 3_600_000);
    assert_eq!(h.health("osrm_state"), json!("ok"));
    assert_eq!(h.store.status(Some(&p.key)), ShapeStatus::Pending);
}

#[tokio::test]
async fn routing_disabled_straight_only_status_none_nothing_queued() {
    let h = harness(|o| o.osrm_base = None);
    let p = pattern(KEY, 4);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    assert_eq!(h.store.status(Some(&p.key)), ShapeStatus::None);
    assert!(!h.store.run_next(None).await);
}

/* ---------------- ShapeStore: MZK ---------------- */

fn course() -> Value {
    let node = |[latitude, longitude]: LatLng| json!({ "latitude": latitude, "longitude": longitude });
    let stops = [P(0.0, 0.0), P(500.0, 0.0), P(1000.0, 0.0)].map(node);
    let seg1 = [P(0.0, 0.0), P(250.0, 30.0), P(500.0, 0.0)].map(node);
    let seg2 = [P(500.0, 0.0), P(1000.0, 0.0)].map(node);
    json!({ "stopPoints": stops, "segments": [{ "nodes": seg1 }, { "nodes": seg2 }] })
}

/// An MZK fetcher counting its calls; `fail` set = it throws "boom". It yields once, as the TS async fetcher does.
fn mzk_fetch(calls: &Arc<AtomicUsize>, fail: &Arc<AtomicBool>) -> unimaps::shape_store::MzkFetchFn {
    let (calls, fail) = (calls.clone(), fail.clone());
    Arc::new(move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        let fail = fail.load(Ordering::SeqCst);
        Box::pin(async move {
            tokio::task::yield_now().await;
            if fail { Err("boom".to_owned()) } else { Ok(course()) }
        })
    })
}

#[tokio::test]
async fn fetches_a_variant_in_the_background_and_serves_it_as_road() {
    let (calls, fail) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
    let f = mzk_fetch(&calls, &fail);
    let h = harness(|o| o.mzk_fetch = Some(f));
    h.store.touch_mzk(13954.0, ShapePrio::Background);
    assert_eq!(h.store.status(Some("mzk:13954")), ShapeStatus::Pending);
    h.store.run_next(None).await;
    let e = h.entry("mzk:13954");
    assert_eq!(e.src, ShapeSrc::Mzk);
    assert_eq!(e.stops.len(), 3);
    assert_eq!(e.stops[0], Some(0.0));
    assert!((e.stops[2].unwrap() - e.len).abs() < 0.5);
    assert!(h.store.wire_id("mzk:13954").is_some_and(|id| !id.is_empty()));
    let pts = h.store.get_mzk_shape(13954).await;
    assert!(pts.is_some_and(|p| p.len() >= 4));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn negative_caches_failures_and_dedupes_concurrent_on_demand_fetches() {
    let (calls, fail) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(true)));
    let f = mzk_fetch(&calls, &fail);
    let h = harness(|o| o.mzk_fetch = Some(f));
    let (a, b) = tokio::join!(h.store.get_mzk_shape(7), h.store.get_mzk_shape(7));
    assert_eq!(a, None);
    assert_eq!(b, None);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    h.store.get_mzk_shape(7).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_stale_variant_whose_refresh_fails_is_not_re_fetched_on_every_poll() {
    let (calls, fail) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
    let f = mzk_fetch(&calls, &fail);
    let h = harness(|o| o.mzk_fetch = Some(f));
    h.store.touch_mzk(13954.0, ShapePrio::Background);
    h.store.run_next(None).await;
    fail.store(true, Ordering::SeqCst);
    h.advance(8 * 86_400_000);
    for _ in 0..10 {
        h.store.touch_mzk(13954.0, ShapePrio::Background);
        h.store.run_next(None).await;
        h.advance(5_000);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // old shape still served
    assert_eq!(h.store.get_entry("mzk:13954").map(|e| e.src), Some(ShapeSrc::Mzk));
}

/* ---------------- pickRefreshCandidate ---------------- */

fn base(src: ShapeSrc) -> ShapeEntry {
    ShapeEntry {
        src,
        poly: String::new(),
        len: 0.0,
        stops: Vec::new(),
        rev: "000000".into(),
        built_at: 0.0,
        seen_at: 0.0,
        fails: 0.0,
        retry_at: 0.0,
        algo: ALGO_VERSION,
        unroutable: None,
        wp_sig: None,
        wp: None,
        sp: None,
        line: None,
        dir: None,
    }
}

const DAY: f64 = 86_400_000.0;
const NOW: f64 = 100.0 * DAY;

fn pick(entries: &[(String, ShapeEntry)]) -> Option<String> {
    pick_refresh_candidate(entries.iter().map(|(k, e)| (k, e)), NOW as i64, 14.0, None)
}

#[test]
fn oldest_due_entry_first_unseen_and_fresh_ones_skipped() {
    let osrm = |built_at: f64, seen_at: f64| ShapeEntry {
        built_at,
        seen_at,
        ..base(ShapeSrc::Osrm)
    };
    let entries: Vec<(String, ShapeEntry)> = vec![
        ("kb:fresh000000".into(), osrm(NOW - DAY, NOW)),
        ("kb:old00000000".into(), osrm(NOW - 20.0 * DAY, NOW)),
        ("kb:older000000".into(), osrm(NOW - 30.0 * DAY, NOW)),
        ("kb:unseen00000".into(), osrm(0.0, NOW - 30.0 * DAY)),
        (
            "mzk:1".into(),
            ShapeEntry {
                seen_at: NOW,
                ..base(ShapeSrc::Mzk)
            },
        ),
    ];
    assert_eq!(pick(&entries), Some("kb:older000000".into()));
    assert_eq!(pick(&entries[..1]), None);
}

#[test]
fn straight_retries_honour_retry_at_old_algo_is_always_due() {
    let straight = |retry_at: f64| ShapeEntry {
        retry_at,
        seen_at: NOW,
        ..base(ShapeSrc::Straight)
    };
    assert_eq!(pick(&[("kb:s".into(), straight(NOW + 1.0))]), None);
    assert_eq!(pick(&[("kb:s".into(), straight(NOW - 1.0))]), Some("kb:s".into()));
    let old_algo = ShapeEntry {
        algo: 0.0,
        built_at: NOW,
        seen_at: NOW,
        ..base(ShapeSrc::Osrm)
    };
    assert_eq!(pick(&[("kb:a".into(), old_algo)]), Some("kb:a".into()));
}

/* ---------------- ShapeStore: persistence ---------------- */

/// A fresh temp dir, removed on drop (the TS `fs.mkdtempSync(.../kb-shapes-)` + `fs.rmSync`).
struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Self {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!(
            "kb-shapes-{}-{}-{nanos}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn file(&self) -> PathBuf {
        self.0.join("route-shapes.v1.json")
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn with_file(file: &Path) -> impl FnOnce(&mut ShapeStoreOptions<Fake>) {
    let file = file.to_owned();
    move |o| o.file = Some(file)
}

fn foreign_lock() -> String {
    json!({ "pid": std::process::id() + 1, "host": "elsewhere" }).to_string()
}

/// `fs.utimesSync(lock, old, old)` with old = 10 min ago.
fn age_10_min(p: &Path) {
    let old = SystemTime::now() - Duration::from_secs(600);
    let f = std::fs::File::options().write(true).open(p).unwrap();
    f.set_times(std::fs::FileTimes::new().set_accessed(old).set_modified(old))
        .unwrap();
}

#[tokio::test]
async fn flush_plus_reload_round_trips_a_corrupt_main_file_falls_back_to_bak() {
    let dir = Tmp::new();
    let file = dir.file();
    let h = harness(with_file(&file));
    let p = pattern(KEY, 4);
    h.store.touch_kb(&p, ShapePrio::Urgent);
    h.store.run_next(None).await;
    h.store.flush(true);
    let rev = h.entry(&p.key).rev;
    // second save creates the .bak
    h.store.touch_kb(&pattern("kb:cccccccccccc", 4), ShapePrio::Background);
    h.store.flush(true);
    h.store.stop();
    assert!(file.exists() && with_suffix(&file, ".bak").exists());
    assert!(!with_suffix(&file, ".lock").exists());

    let again = harness(with_file(&file));
    assert_eq!(again.store.get_entry(&p.key).map(|e| e.rev), Some(rev.clone()));
    again.store.stop();

    std::fs::write(&file, "{not json").unwrap();
    let from_bak = harness(with_file(&file));
    assert_eq!(from_bak.store.get_entry(&p.key).map(|e| e.rev), Some(rev));
    assert!(
        std::fs::read_dir(&dir.0)
            .unwrap()
            .any(|f| f.unwrap().file_name().to_string_lossy().contains(".corrupt-"))
    );
    from_bak.store.stop();
}

#[test]
fn never_overwrites_a_store_written_by_a_newer_format() {
    let dir = Tmp::new();
    let file = dir.file();
    let newer = json!({ "format": "kb-map/route-shapes", "version": 99, "shapes": {} }).to_string();
    std::fs::write(&file, &newer).unwrap();
    let h = harness(with_file(&file));
    h.store.touch_kb(&pattern(KEY, 4), ShapePrio::Urgent);
    h.store.flush(true);
    h.store.stop();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer);
}

#[test]
fn an_owner_whose_lock_was_taken_over_drops_to_read_only() {
    let dir = Tmp::new();
    let file = dir.file();
    let lock = with_suffix(&file, ".lock");
    let h = harness(with_file(&file));
    assert_eq!(h.health("read_only"), json!(false));
    std::fs::write(&lock, foreign_lock()).unwrap();
    h.store.heartbeat();
    assert_eq!(h.health("read_only"), json!(true));
    h.store.stop();
    assert!(lock.exists()); // the new owner's lock survives
}

#[test]
fn a_stale_lock_no_heartbeat_for_5_min_is_taken_over() {
    let dir = Tmp::new();
    let file = dir.file();
    let lock = with_suffix(&file, ".lock");
    std::fs::write(&lock, foreign_lock()).unwrap();
    age_10_min(&lock);
    let h = harness(with_file(&file));
    assert_eq!(h.health("read_only"), json!(false));
    let owner: Value = serde_json::from_str(&std::fs::read_to_string(&lock).unwrap()).unwrap();
    assert_eq!(owner["pid"], json!(std::process::id()));
    h.store.stop();
}

#[test]
fn an_empty_lock_left_by_a_crash_is_held_while_fresh_taken_over_once_stale() {
    let dir = Tmp::new();
    let file = dir.file();
    let lock = with_suffix(&file, ".lock");
    std::fs::write(&lock, "").unwrap();
    let fresh = harness(with_file(&file));
    assert_eq!(fresh.health("read_only"), json!(true)); // a peer may be mid-write
    fresh.store.stop();
    age_10_min(&lock);
    let h = harness(with_file(&file));
    assert_eq!(h.health("read_only"), json!(false));
    h.store.stop();
}

#[test]
fn a_live_lock_held_by_another_process_makes_the_store_read_only() {
    let dir = Tmp::new();
    let file = dir.file();
    let lock = with_suffix(&file, ".lock");
    std::fs::write(&lock, foreign_lock()).unwrap();
    let h = harness(with_file(&file));
    assert_eq!(h.health("read_only"), json!(true));
    h.store.touch_kb(&pattern(KEY, 4), ShapePrio::Urgent);
    assert_eq!(h.health("queued"), json!(0));
    h.store.flush(true);
    assert!(!file.exists());
    h.store.stop();
    assert!(lock.exists()); // not ours to remove
}
