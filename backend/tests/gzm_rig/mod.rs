//! The rig of test/gzm-live.test.ts: the synthetic feed (test/support/gzm-fixture.ts), a fake zbiorkom / SDIP
//! transport (records every request, answers through a closure like the TS `fetchImpl`), an injected clock and a
//! swappable feed slot handed to `GzmLive` through its feed getter.
#![allow(dead_code)]

#[path = "../support/gzm_fixture.rs"]
mod fixture;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

pub use fixture::*;
use serde_json::{Value, json};
use unimaps::gzm::{FeedFn, GzmLive, NowFn, ZbResponse, ZbTransport};
use unimaps::gzm_feed::GzmFeed;

/// `loadGzmFeed()`: the default fixture parsed as GZM, once per test binary.
pub static FEED: LazyLock<Arc<GzmFeed>> = LazyLock::new(|| Arc::new(load_gzm_feed(&files(), "gzm")));

/// One request the fake transport saw.
#[derive(Debug, Clone)]
pub struct Req {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

impl Req {
    /// The header `name` (case-insensitive, like `new Headers(init.headers).get`).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

type Respond = dyn Fn(&Req) -> Result<ZbResponse, String> + Send + Sync;

/// The TS `fetchImpl`: every request is logged, then answered by `respond`.
#[derive(Clone)]
pub struct Fake {
    pub log: Arc<Mutex<Vec<Req>>>,
    respond: Arc<Respond>,
}

impl Fake {
    pub fn new(respond: impl Fn(&Req) -> Result<ZbResponse, String> + Send + Sync + 'static) -> Self {
        Self {
            log: Arc::default(),
            respond: Arc::new(respond),
        }
    }

    /// Answers `{ positions }` from the shared list, read at request time.
    pub fn positions(list: &Arc<Mutex<Vec<Value>>>) -> Self {
        let list = Arc::clone(list);
        Self::new(move |_| Ok(positions_body(&list.lock().unwrap())))
    }

    pub fn urls(&self) -> Vec<String> {
        self.log.lock().unwrap().iter().map(|r| r.url.clone()).collect()
    }
}

impl ZbTransport for Fake {
    fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        _timeout: Duration,
        _max_body: usize,
    ) -> impl Future<Output = Result<ZbResponse, String>> + Send {
        let req = Req {
            url: url.to_owned(),
            headers: headers.iter().map(|&(k, v)| (k.to_owned(), v.to_owned())).collect(),
        };
        let res = (self.respond)(&req);
        self.log.lock().unwrap().push(req);
        async move { res }
    }
}

/// `new Response(body)`: 200 with that text.
pub fn ok(body: impl Into<String>) -> ZbResponse {
    ZbResponse {
        status: 200,
        body: body.into(),
        ..ZbResponse::default()
    }
}

/// `new Response(JSON.stringify({ positions }))`
pub fn positions_body(list: &[Value]) -> ZbResponse {
    ok(json!({ "positions": list }).to_string())
}

/// The TS `clock.ms`.
pub fn now_fn(clock: &Arc<AtomicI64>) -> NowFn {
    let c = Arc::clone(clock);
    Arc::new(move || c.load(Ordering::SeqCst))
}

/// A feed getter over a slot the test swaps (`loaded = feed`).
pub fn feed_fn(slot: &Arc<Mutex<Option<Arc<GzmFeed>>>>) -> FeedFn {
    let s = Arc::clone(slot);
    Arc::new(move || s.lock().unwrap().clone())
}

/// The TS `rig(feedOf, slug)`: a GzmLive whose upstream answers the last `poll`'s list and whose clock is `clock`.
pub struct Rig {
    pub live: Arc<GzmLive<Fake>>,
    pub clock: Arc<AtomicI64>,
    pub positions: Arc<Mutex<Vec<Value>>>,
    pub feed: Arc<Mutex<Option<Arc<GzmFeed>>>>,
    pub up: Fake,
}

/// `rig()`: the default fixture feed, slug "gzm".
pub fn rig() -> Rig {
    rig_with(Some(Arc::clone(&FEED)), "gzm")
}

pub fn rig_with(feed: Option<Arc<GzmFeed>>, slug: &str) -> Rig {
    let clock = Arc::new(AtomicI64::new(at("08:03", 0) * 1000));
    let positions = Arc::default();
    let slot = Arc::new(Mutex::new(feed));
    let up = Fake::positions(&positions);
    let live = GzmLive::new(slug, up.clone())
        .with_now(now_fn(&clock))
        .with_feed(feed_fn(&slot))
        .with_url(Some("https://x.invalid/positions".into()));
    Rig {
        live: Arc::new(live),
        clock,
        positions,
        feed: slot,
        up,
    }
}

impl Rig {
    /// Sets the clock to `now_s` and the upstream list, polls once (must apply) and returns the parsed body.
    pub async fn poll(&self, now_s: i64, list: Vec<Value>) -> Value {
        self.clock.store(now_s * 1000, Ordering::SeqCst);
        *self.positions.lock().unwrap() = list;
        assert!(self.live.poll_once().await);
        body(&self.live)
    }
}

/// `JSON.parse(live.vehiclesBody())`
pub fn body<T: ZbTransport>(live: &GzmLive<T>) -> Value {
    serde_json::from_str(&live.vehicles_body()).unwrap()
}

/// The only vehicle of a body.
pub fn only(r: &Value) -> Value {
    let list = r["vehicles"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    list[0].clone()
}

/// Polls `ok` every 20 ms, panics after 3 s.
pub async fn until(mut ok: impl FnMut() -> bool) {
    let t0 = Instant::now();
    while !ok() {
        assert!(t0.elapsed() < Duration::from_secs(3), "timed out");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The TS `try { live.start() ... } finally { live.stop() }`: stops the loops even when an assertion panics.
pub struct Running<T: ZbTransport + Send + Sync + 'static>(pub Arc<GzmLive<T>>);

impl<T: ZbTransport + Send + Sync + 'static> Running<T> {
    pub fn start(live: &Arc<GzmLive<T>>) -> Self {
        live.start();
        Self(Arc::clone(live))
    }
}

impl<T: ZbTransport + Send + Sync + 'static> Drop for Running<T> {
    fn drop(&mut self) {
        self.0.stop();
    }
}
