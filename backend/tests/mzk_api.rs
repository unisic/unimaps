//! Port of test/mzk-api-cache.test.ts: getRealtime / getAtomicSchedule are cached per symbol (5 s / 15 min) with
//! in-flight de-duplication, so a station hub that fans out to several symbols and several viewers refreshing the
//! same stop cost one request.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use unimaps::gzm::{NowFn, ZbResponse, ZbTransport};
use unimaps::mzk_api::{MZK_REALTIME_TTL_MS, MZK_SCHEDULE_TTL_MS, MzkApi};

#[derive(Default)]
struct Upstream {
    calls: Mutex<Vec<String>>,
    fail_next: AtomicBool,
}

/// The TS `globalThis.fetch` stub: logs the url at call time, yields once (`await Promise.resolve()`), then answers
/// 500 "boom" when `fail_next` is set, else `{ departures: [], n: calls.length }`.
#[derive(Clone, Default)]
struct Fake(Arc<Upstream>);

impl Fake {
    fn calls(&self) -> Vec<String> {
        self.0.calls.lock().unwrap().clone()
    }

    fn fail_next(&self) {
        self.0.fail_next.store(true, Ordering::SeqCst);
    }
}

impl ZbTransport for Fake {
    fn get(
        &self,
        url: &str,
        _headers: &[(&str, &str)],
        _timeout: Duration,
        _max_body: usize,
    ) -> impl Future<Output = Result<ZbResponse, String>> + Send {
        let up = Arc::clone(&self.0);
        up.calls.lock().unwrap().push(url.to_owned());
        async move {
            tokio::task::yield_now().await;
            if up.fail_next.swap(false, Ordering::SeqCst) {
                return Ok(ZbResponse {
                    status: 500,
                    body: "boom".into(),
                    ..ZbResponse::default()
                });
            }
            let n = up.calls.lock().unwrap().len();
            Ok(ZbResponse {
                status: 200,
                body: json!({ "departures": [], "n": n }).to_string(),
                ..ZbResponse::default()
            })
        }
    }
}

/// `mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 })`
struct Rig {
    up: Fake,
    clock: Arc<AtomicI64>,
    api: MzkApi<Fake>,
}

fn rig() -> Rig {
    let up = Fake::default();
    let clock = Arc::new(AtomicI64::new(1_790_000_000_000));
    let c = Arc::clone(&clock);
    let now: NowFn = Arc::new(move || c.load(Ordering::SeqCst));
    let api = MzkApi::new(up.clone()).with_base_url("http://mzk.test").with_now(now);
    Rig { up, clock, api }
}

impl Rig {
    /// `mock.timers.tick(ms)`
    fn tick(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
}

// describe("MzkApi.fetchRealtime cache")

#[tokio::test]
async fn concurrent_callers_share_one_request_the_answer_is_reused_inside_the_ttl_and_refetched_after_it() {
    let r = rig();
    let (a, b) = tokio::join!(r.api.fetch_realtime("265"), r.api.fetch_realtime("265"));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(r.up.calls().len(), 1);
    assert!(Arc::ptr_eq(&a, &b));
    r.tick(MZK_REALTIME_TTL_MS - 1);
    assert!(Arc::ptr_eq(&r.api.fetch_realtime("265").await.unwrap(), &a));
    assert_eq!(r.up.calls().len(), 1);
    r.tick(2);
    let c = r.api.fetch_realtime("265").await.unwrap();
    assert_eq!(r.up.calls().len(), 2);
    assert!(!Arc::ptr_eq(&c, &a));
}

#[tokio::test]
async fn different_symbols_are_independent() {
    let r = rig();
    let _ = tokio::join!(
        r.api.fetch_realtime("1"),
        r.api.fetch_realtime("2"),
        r.api.fetch_realtime("1")
    );
    let calls = r.up.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].ends_with("stopPointSymbol=1"), "{}", calls[0]);
}

#[tokio::test]
async fn a_failed_request_is_never_cached_the_next_caller_retries() {
    let r = rig();
    r.up.fail_next();
    assert!(r.api.fetch_realtime("265").await.is_err());
    let ok = r.api.fetch_realtime("265").await.unwrap();
    assert_eq!(r.up.calls().len(), 2);
    assert_eq!(ok["departures"], json!([]));
}

// describe("MzkApi.fetchAtomicSchedule cache")

#[tokio::test]
async fn is_keyed_by_symbol_and_date_lives_15_minutes() {
    let r = rig();
    let get = |sym: &'static str, date: &'static str| r.api.fetch_atomic_schedule(sym, Some(date), true);
    get("265", "2026-10-02").await.unwrap();
    get("265", "2026-10-02").await.unwrap();
    assert_eq!(r.up.calls().len(), 1);
    get("265", "2026-10-03").await.unwrap(); // another day
    get("341", "2026-10-02").await.unwrap(); // another stop
    assert_eq!(r.up.calls().len(), 3);
    r.tick(MZK_SCHEDULE_TTL_MS + 1);
    get("265", "2026-10-02").await.unwrap();
    assert_eq!(r.up.calls().len(), 4);
}

#[tokio::test]
async fn stays_bounded_the_oldest_entries_are_evicted() {
    let r = rig();
    for i in 0..60 {
        r.api
            .fetch_atomic_schedule(&i.to_string(), Some("2026-10-02"), true)
            .await
            .unwrap();
    }
    assert_eq!(r.up.calls().len(), 60);
    // newest: still cached
    r.api
        .fetch_atomic_schedule("59", Some("2026-10-02"), true)
        .await
        .unwrap();
    assert_eq!(r.up.calls().len(), 60);
    // oldest: evicted, refetched
    r.api
        .fetch_atomic_schedule("0", Some("2026-10-02"), true)
        .await
        .unwrap();
    assert_eq!(r.up.calls().len(), 61);
}

/// Polls `fut` once (far enough to send its upstream request) and drops it: a client that disconnected mid-request.
async fn abandon<F: Future>(fut: F) {
    tokio::select! {
        biased;
        _ = fut => panic!("the fake upstream yields once, the first poll cannot finish"),
        () = std::future::ready(()) => {}
    }
}

// The TS `cached()` starts `load()` when it creates the entry, detached from any caller: an abandoned caller never
// aborts the request, its answer stays cached for the TTL.

#[tokio::test]
async fn an_abandoned_realtime_caller_still_caches_the_answer() {
    let r = rig();
    abandon(r.api.fetch_realtime("265")).await;
    r.tick(1_000);
    let res = r.api.fetch_realtime("265").await.unwrap();
    assert_eq!(r.up.calls().len(), 1);
    assert_eq!(res["n"], json!(1));
}

#[tokio::test]
async fn an_abandoned_schedule_caller_still_caches_the_answer() {
    let r = rig();
    abandon(r.api.fetch_atomic_schedule("265", Some("2026-10-02"), true)).await;
    r.tick(30_000);
    let res = r
        .api
        .fetch_atomic_schedule("265", Some("2026-10-02"), true)
        .await
        .unwrap();
    assert_eq!(r.up.calls().len(), 1);
    assert_eq!(res["n"], json!(1));
}
