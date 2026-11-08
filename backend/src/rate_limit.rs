//! lib/rate-limit.ts: in-memory token buckets for the routes that reach an upstream or run a search, so the open
//! passthrough can't be turned into a flood against the upstream API. Per IP 600 burst + 40/s, a global backstop of
//! `KB_RATE_LIMIT_GLOBAL`/s (8 s of burst) against spoofed keys, and a process-wide search budget of 250 ms/s.

use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use hyper::header::{HeaderMap, HeaderValue, RETRY_AFTER};
use hyper::{Response, StatusCode};
use indexmap::IndexMap;

use crate::http::{Body, header_str, json};
use crate::{config, js};

const CAP: f64 = 600.0;
const REFILL_PER_SEC: f64 = 40.0;
/// headers are client-controlled: never key on arbitrary blobs
const MAX_KEY_LEN: usize = 64;
/// hard cap so spoofed keys can't grow the map unbounded
const MAX_BUCKETS: usize = 10_000;
/// a full-map idle sweep at most this often, not on every request of a flood
const SWEEP_EVERY_MS: f64 = 10_000.0;
const IDLE_MS: f64 = 60_000.0;
const SEARCH_MS_PER_SEC: f64 = 250.0;
const SEARCH_CAP_MS: f64 = 200.0;
/// the search's time also comes out of the client's own bucket: at 40 tokens/s one IP holds at most 100 ms/s
const SEARCH_MS_PER_TOKEN: f64 = 2.5;

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    last: f64,
}

impl Bucket {
    fn full(cap: f64, now: f64) -> Self {
        Bucket { tokens: cap, last: now }
    }

    /// a clock stepped back must not drain a bucket
    fn refill(&mut self, now: f64, cap: f64, per_sec: f64) {
        self.tokens = cap.min(self.tokens + (now - self.last).max(0.0) / 1000.0 * per_sec);
        self.last = now;
    }
}

struct State {
    /// insertion order = eviction order
    buckets: IndexMap<String, Bucket>,
    last_sweep: f64,
    global: Bucket,
    global_per_sec: f64,
    search: Bucket,
}

impl State {
    fn sweep_idle(&mut self, now: f64) {
        if now - self.last_sweep < SWEEP_EVERY_MS {
            return;
        }
        self.last_sweep = now;
        self.buckets.retain(|_, b| now - b.last <= IDLE_MS);
    }
}

/// The buckets on a caller's clock (ms); the free functions below run the process-wide one.
pub struct RateLimiter(Mutex<State>);

/// The key is the first 64 characters (header strings are Latin-1, so a character is a UTF-16 unit as in the TS).
fn key(ip: &str) -> &str {
    ip.char_indices().nth(MAX_KEY_LEN).map_or(ip, |(i, _)| &ip[..i])
}

impl RateLimiter {
    pub fn new(global_per_sec: f64, now: f64) -> Self {
        RateLimiter(Mutex::new(State {
            buckets: IndexMap::new(),
            last_sweep: f64::NEG_INFINITY,
            global: Bucket::full(global_per_sec * 8.0, now),
            global_per_sec,
            search: Bucket::full(SEARCH_CAP_MS, now),
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// true = allowed. `cost` = upstream fetches the request will make (a batch route charges one per id), so one
    /// token never buys a fan-out.
    pub fn allow_request(&self, ip: &str, cost: f64, now: f64) -> bool {
        let mut guard = self.state();
        let s = &mut *guard;
        let key = key(ip);
        if let Some(b) = s.buckets.get_mut(key) {
            b.refill(now, CAP, REFILL_PER_SEC);
        } else {
            if s.buckets.len() >= MAX_BUCKETS {
                s.sweep_idle(now);
                // ponytail: shift_remove is O(n) per new key, only while 10 000 IPs were active within a minute
                while s.buckets.len() >= MAX_BUCKETS {
                    s.buckets.shift_remove_index(0);
                }
            }
            s.buckets.insert(key.to_owned(), Bucket::full(CAP, now));
        }
        s.global.refill(now, s.global_per_sec * 8.0, s.global_per_sec);
        // opportunistic, so idle IPs don't pile up in a long-lived process; this key was touched now and stays
        if s.buckets.len() > 5000 {
            s.sweep_idle(now);
        }
        let b = s.buckets.get_mut(key).expect("touched above");
        if b.tokens < cost || s.global.tokens < cost {
            return false;
        }
        b.tokens -= cost;
        s.global.tokens -= cost;
        true
    }

    /// true = a search may run now: the process-wide budget is not overdrawn.
    pub fn allow_search(&self, now: f64) -> bool {
        let mut s = self.state();
        s.search.refill(now, SEARCH_CAP_MS, SEARCH_MS_PER_SEC);
        s.search.tokens > 0.0
    }

    /// Charge the time a search took to the process-wide budget and to `ip`'s bucket; a long search may overdraw
    /// either, later ones wait the debt out.
    pub fn charge_search(&self, ip: &str, ms: f64, now: f64) {
        let mut s = self.state();
        s.search.refill(now, SEARCH_CAP_MS, SEARCH_MS_PER_SEC);
        s.search.tokens -= ms;
        if let Some(b) = s.buckets.get_mut(key(ip)) {
            b.tokens -= ms / SEARCH_MS_PER_TOKEN;
        }
    }
}

static CLOCK: LazyLock<Instant> = LazyLock::new(Instant::now);
static LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter::new(*config::RATE_LIMIT_GLOBAL as f64, now_ms()));

fn now_ms() -> f64 {
    CLOCK.elapsed().as_secs_f64() * 1000.0
}

pub fn allow_request(ip: &str, cost: f64) -> bool {
    LIMITER.allow_request(ip, cost, now_ms())
}

pub fn allow_search() -> bool {
    LIMITER.allow_search(now_ms())
}

pub fn charge_search(ip: &str, ms: f64) {
    LIMITER.charge_search(ip, ms, now_ms())
}

/// Best-effort client IP: the LAST X-Forwarded-For entry (the proxy-set peer behind one trusted proxy; the front
/// sets it from the socket when absent), else X-Real-IP, else "local". A client that sends its own XFF forges every
/// entry, so per-IP keying is best-effort and the global bucket bounds total abuse.
pub fn client_ip(h: &HeaderMap) -> String {
    if let Some(xff) = header_str(h, "x-forwarded-for").filter(|v| !v.is_empty()) {
        let last = xff.rsplit(',').next().unwrap_or("").trim_matches(js::is_space);
        return if last.is_empty() { "local" } else { last }.to_owned();
    }
    header_str(h, "x-real-ip")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "local".to_owned())
}

/// 429 with a Retry-After hint.
pub fn too_many_requests() -> Response<Body> {
    let mut r = json(StatusCode::TOO_MANY_REQUESTS, r#"{"error":"Too many requests"}"#);
    r.headers_mut().insert(RETRY_AFTER, HeaderValue::from_static("5"));
    r
}
