//! lib/kb-api.ts: the KiedyPrzyjedzie client (the KB upstream) and the Python-parity value helpers the BB layer reads
//! upstream records with. `KbApi` is generic over the crate's GET transport, `KbSource` is what `LivePoller` calls.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::task::Poll;
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::config;
use crate::gzm::{HttpZb, NowFn, ZbTransport};
use crate::js;
use crate::types::{Stop, Trip, TripStop, UpstreamRecord};

const RETRIES: u32 = 2;
const REVISION_TIMEOUT: Duration = Duration::from_secs(15);
const TRIP_TTL_MS: i64 = 4 * 3600 * 1000;
const TRIP_CACHE_MAX: usize = 5000;
const TIMETABLE_TTL_MS: i64 = 15 * 60 * 1000;
const TIMETABLE_CACHE_MAX: usize = 1000;
// ponytail: the TS reads KB bodies uncapped; one past 8 MB fails like a network error (retried, then thrown)
const MAX_BODY: usize = 8 << 20;

/// Python truthiness (`None` = undefined): null, false, 0, "", [] and {} are falsy, "0" is truthy.
pub fn py_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(m)) => !m.is_empty(),
    }
}

/// Python `int()`: a number truncates, a string must be a pure integer (trimmed, optional sign); the JS number.
pub fn parse_int_strict(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().map(f64::trunc),
        Value::String(s) => parse_int_strict_str(s),
        _ => None,
    }
}

/// [`parse_int_strict`] of a string.
pub fn parse_int_strict_str(s: &str) -> Option<f64> {
    let t = s.trim_matches(js::is_space);
    let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse().ok()
}

/// Python `float()` of a number or a string (`Number` of the trimmed text, finite only); None for anything else.
pub fn py_float(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim_matches(js::is_space);
            if t.is_empty() {
                return None;
            }
            Some(js::number(t)).filter(|n| n.is_finite())
        }
        _ => None,
    }
}

static EMPTY: LazyLock<UpstreamRecord> = LazyLock::new(Map::new);

/// The value as a plain object record, else an empty one.
pub fn as_record(v: Option<&Value>) -> &UpstreamRecord {
    v.and_then(Value::as_object).unwrap_or(&EMPTY)
}

/// True when the value is a plain (non-array) object.
pub fn is_record(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_object)
}

/// Standard base64 (with '=' padding) of the raw trip_execution_id.
pub fn b64_exec_id(trip_execution_id: &str) -> String {
    let mut s: String = js::to_base64url(trip_execution_id.as_bytes())
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    while !s.len().is_multiple_of(4) {
        s.push('=');
    }
    s
}

/// [`b64_exec_id`] with only '+' and '/' escaped, so it cannot rewrite the upstream path and every id that worked
/// before is byte-identical on the wire.
pub fn exec_id_path_segment(trip_execution_id: &str) -> String {
    b64_exec_id(trip_execution_id).replace('+', "%2B").replace('/', "%2F")
}

/// `JSON.parse` as the TS reads it: every object keyed in `Object.keys` order (array-index keys first, ascending)
/// and every number a double, so a re-served body comes out as `JSON.stringify` writes it.
/// Err = "SyntaxError: <serde_json's message>".
// ponytail: an overflowing literal (V8: Infinity) is null here, so it re-serves as JSON.stringify's null but
// reads as null, not Infinity; an integral double >= 2^64 and a fraction in [1e-6, 1e-5) keep serde_json's form
pub fn js_json_parse(text: &str) -> Result<Value, String> {
    let mut v: Value = crate::js::json_parse(text)
        .or_else(|e| {
            overflow_to_null(text)
                .and_then(|t| crate::js::json_parse(&t).ok())
                .ok_or(e)
        })
        .map_err(|e| format!("SyntaxError: {e}"))?;
    js_key_order(&mut v);
    Ok(v)
}

/// The text with every number literal outside a string that parses to an infinity replaced by `null`;
/// None when there is none.
fn overflow_to_null(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let (mut out, mut i, mut last) = (String::new(), 0, 0);
    while let Some(&c) = b.get(i) {
        match c {
            b'"' => {
                i += 1;
                while let Some(&c) = b.get(i).filter(|&&c| c != b'"') {
                    i += if c == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                while b
                    .get(i)
                    .is_some_and(|c| matches!(c, b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'))
                {
                    i += 1;
                }
                if text
                    .get(start..i)
                    .and_then(|s| s.parse::<f64>().ok())
                    .is_some_and(f64::is_infinite)
                {
                    out.push_str(text.get(last..start)?);
                    out.push_str("null");
                    last = i;
                }
            }
            _ => i += 1,
        }
    }
    (last > 0).then(|| out + text.get(last..).unwrap_or_default())
}

/// A number as V8 holds it after `JSON.parse`: an integral value goes back out as the integer `JSON.stringify`
/// prints (-0 = 0, past 2^53 the double's shortest digits).
fn js_number(n: &serde_json::Number) -> Option<Value> {
    const SAFE: f64 = 9_007_199_254_740_992.0;
    let x = n.as_f64().filter(|x| x.fract() == 0.0)?;
    if x.abs() < SAFE {
        return n.is_f64().then(|| (x as i64).into());
    }
    let s = js::number_to_string(x);
    s.parse::<i64>()
        .map(Value::from)
        .or_else(|_| s.parse::<u64>().map(Value::from))
        .ok()
}

fn js_key_order(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if let Some(js) = js_number(n) {
                *v = js;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(js_key_order),
        Value::Object(m) => {
            m.values_mut().for_each(js_key_order);
            if m.keys().any(|k| k.bytes().next().is_some_and(|b| b.is_ascii_digit())) {
                let mut im: IndexMap<String, Value> = std::mem::take(m).into_iter().collect();
                js::sort_object_keys(&mut im);
                *m = im.into_iter().collect();
            }
        }
        _ => {}
    }
}

/// `Promise.all` over futures that never reject: every output, in input order.
// ponytail: polls every unfinished future on each wake, O(n) per wake; fine for the few thousand a GTFS build joins
pub async fn join_all<F: Future>(futs: impl IntoIterator<Item = F>) -> Vec<F::Output> {
    let mut futs: Vec<Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut outs: Vec<Option<F::Output>> = futs.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (f, out) in futs.iter_mut().zip(outs.iter_mut()).filter(|(_, out)| out.is_none()) {
            match f.as_mut().poll(cx) {
                Poll::Ready(v) => *out = Some(v),
                Poll::Pending => pending = true,
            }
        }
        if pending { Poll::Pending } else { Poll::Ready(()) }
    })
    .await;
    outs.into_iter().flatten().collect()
}

fn nullish_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        v => js::value_to_string(v),
    }
}

/// `typeof v === "number" ? Math.trunc(v) : null`
fn trunc_num(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_f64).map(|x| x.trunc() as i64)
}

/// GET /stops?rev=... positional rows, deduped by internal id (the first row wins).
// ponytail: an id past +-2^63 saturates `internal_id` (the TS keeps an imprecise float); upstream ids are 5 digits
pub fn parse_stops(raw: Option<&Value>) -> Vec<Stop> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let Some(rows) = as_record(raw).get("stops").and_then(Value::as_array) else {
        return out;
    };
    for row in rows {
        let Some(row) = row.as_array().filter(|r| r.len() >= 5) else {
            continue;
        };
        let (Some(id), Some(lon), Some(lat)) =
            (parse_int_strict(row.get(1)), py_float(row.get(3)), py_float(row.get(4)))
        else {
            continue;
        };
        // a Set of numbers compares SameValueZero: -0 is 0
        if !seen.insert((id + 0.0).to_bits()) {
            continue;
        }
        out.push(Stop {
            url_id: js::value_to_string(row.first()),
            internal_id: id as i64,
            name: js::value_to_string(row.get(2)),
            lon: lon / 1_000_000.0,
            lat: lat / 1_000_000.0,
            only_disembarking: row.len() > 5 && py_truthy(row.get(5)),
            is_station: row.len() > 6 && py_truthy(row.get(6)),
            show_platforms: row.len() > 7 && py_truthy(row.get(7)),
            stop_id: js::number_to_string(id),
            ..Stop::default()
        });
    }
    out
}

/// One trip detail (GET /api/trip/<id>/<index>).
pub fn parse_trip(raw: Option<&Value>, trip_id: &str) -> Trip {
    let r = as_record(raw);
    let times = r
        .get("times")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|entry| {
                    let t = as_record(Some(entry));
                    TripStop {
                        stop_name: nullish_string(t.get("stop_name")),
                        designator: trunc_num(t.get("designator")),
                        place_id: t.get("place_id").and_then(Value::as_str).map(str::to_owned),
                        departure_time: nullish_string(t.get("departure_time")),
                        index: parse_int_strict(t.get("index")).unwrap_or(0.0) as i64,
                        platform: t
                            .get("platform")
                            .filter(|v| !v.is_null())
                            .map(|v| js::value_to_string(Some(v))),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let line = as_record(r.get("line"));
    Trip {
        trip_id: trip_id.to_owned(),
        times,
        direction: nullish_string(r.get("direction")),
        line_name: nullish_string(line.get("name")),
        line_type: line.get("type").and_then(Value::as_str).map(str::to_owned),
        show_name: line.get("show_name").is_none_or(|v| py_truthy(Some(v))),
        vehicle_type: trunc_num(r.get("vehicle_type")),
        current_station_id: trunc_num(r.get("current_station_id")),
    }
}

/// The first `data-stops-revision="<digits>"` of the homepage (`/data-stops-revision="(\d+)"/`).
fn scrape_revision(html: &str) -> Option<String> {
    html.split("data-stops-revision=\"").skip(1).find_map(|rest| {
        let end = rest.find(|c: char| !c.is_ascii_digit())?;
        (end > 0 && rest[end..].starts_with('"')).then(|| rest[..end].to_owned())
    })
}

/// The error of a source method a fake leaves out (the TS tests cast partial objects).
pub const NOT_PROVIDED: &str = "not provided by this source";

/// What `LivePoller`, the BB services and routes call on a KB upstream client. The first four are what the poller
/// needs (the TS tests fake exactly these); the rest default to `Err(NOT_PROVIDED)` so a fake overrides only what
/// its test uses. `fetchMany` is not here: it never touches the client, use [`join_all`].
pub trait KbSource: Send + Sync {
    fn fetch_revision(&self) -> impl Future<Output = String> + Send;
    fn fetch_stops(&self, revision: Option<&str>) -> impl Future<Output = Result<Vec<Stop>, String>> + Send;
    fn fetch_multiple_departures(&self, stop_url_ids: &[String]) -> impl Future<Output = Result<Value, String>> + Send;
    fn fetch_trip_execution(
        &self,
        trip_execution_id: &str,
        index: i64,
    ) -> impl Future<Output = Result<Value, String>> + Send;

    fn fetch_timetable(
        &self,
        _stop_url_id: &str,
        _date: &str,
    ) -> impl Future<Output = Result<Arc<Value>, String>> + Send {
        async { Err(NOT_PROVIDED.to_owned()) }
    }
    fn fetch_trip(&self, _trip_id: &str, _index: i64) -> impl Future<Output = Result<Option<Trip>, String>> + Send {
        async { Err(NOT_PROVIDED.to_owned()) }
    }
    fn fetch_trip_raw(&self, _trip_id: &str, _index: i64) -> impl Future<Output = Result<Arc<Value>, String>> + Send {
        async { Err(NOT_PROVIDED.to_owned()) }
    }
    fn has_cached_trip(&self, _trip_id: &str, _index: i64) -> bool {
        false
    }
    /// Default: every id failed.
    fn fetch_trips_batch(&self, trip_ids: &[String], _index: i64) -> impl Future<Output = TripsBatch> + Send {
        let failed = trip_ids.len();
        async move {
            TripsBatch {
                trips: IndexMap::new(),
                failed,
            }
        }
    }
    fn fetch_departures(&self, _stop_url_id: &str) -> impl Future<Output = Result<Value, String>> + Send {
        async { Err(NOT_PROVIDED.to_owned()) }
    }
    fn fetch_announcements(&self, _hash: Option<&str>) -> impl Future<Output = Result<Value, String>> + Send {
        async { Err(NOT_PROVIDED.to_owned()) }
    }
}

/// `fetchTripsBatch`'s answer: `trips` keyed in `Object.keys` order; `failed` = ids whose fetch threw (a 404 or an
/// empty body is no such trip, not a failure).
#[derive(Debug, Default)]
pub struct TripsBatch {
    pub trips: IndexMap<String, Arc<Value>>,
    pub failed: usize,
}

type Cache = IndexMap<String, (Arc<Value>, i64)>;

fn cache_get(cache: &Cache, key: &str, now: i64) -> Option<Arc<Value>> {
    cache
        .get(key)
        .filter(|(_, expires_at)| *expires_at > now)
        .map(|(data, _)| data.clone())
}

/// Insertion-ordered like a Map: full = the oldest entry goes first; a known key keeps its place.
fn cache_put(cache: &mut Cache, max: usize, key: String, data: Arc<Value>, expires_at: i64) {
    if cache.len() >= max {
        cache.shift_remove_index(0);
    }
    cache.insert(key, (data, expires_at));
}

#[derive(Default)]
struct State {
    /// last successfully scraped stops revision: a transient scrape failure falls back here, not to the default
    last_good_revision: Option<String>,
    trips: Cache,
    timetables: Cache,
}

/// Decrements the waiter count when a queued caller gets its slot or is dropped while waiting.
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The komunikacjabeskidzka.kiedyprzyjedzie.pl client: a global concurrency limit, retries with backoff, 404 = null.
pub struct KbApi<T: ZbTransport = HttpZb> {
    base: String,
    timeout: Duration,
    limit: Semaphore,
    /// callers waiting for a slot (`pLimit.pendingCount`)
    pending: AtomicUsize,
    /// new requests are refused once this many wait for a slot (a client-driven flood sheds, never queues unboundedly)
    max_pending: usize,
    transport: T,
    now: NowFn,
    state: Mutex<State>,
}

impl<T: ZbTransport> KbApi<T> {
    /// `KB_CONCURRENCY` slots, `KB_HTTP_TIMEOUT`, no pending cap, the system clock.
    pub fn new(transport: T) -> Self {
        Self {
            base: config::BASE_URL.clone(),
            timeout: Duration::from_secs(u64::try_from(*config::HTTP_TIMEOUT).unwrap_or(1)),
            limit: Semaphore::new(slots(usize::try_from(*config::DEFAULT_CONCURRENCY).unwrap_or(1))),
            pending: AtomicUsize::new(0),
            max_pending: usize::MAX,
            transport,
            now: Arc::new(|| jiff::Timestamp::now().as_millisecond()),
            state: Mutex::default(),
        }
    }

    /// The number of requests in flight at once (`opts.concurrency`; pLimit refuses 0, so 0 is 1 here).
    pub fn with_concurrency(mut self, n: usize) -> Self {
        self.limit = Semaphore::new(slots(n));
        self
    }

    /// Per-attempt timeout (`opts.timeout`, seconds in the TS).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// `opts.maxPending`
    pub fn with_max_pending(mut self, n: usize) -> Self {
        self.max_pending = n;
        self
    }

    /// The cache clock (epoch ms).
    pub fn with_now(mut self, now: NowFn) -> Self {
        self.now = now;
        self
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn headers() -> [(&'static str, &'static str); 2] {
        [
            ("User-Agent", config::USER_AGENT.as_str()),
            ("Accept", "application/json"),
        ]
    }

    async fn slot(&self) -> Result<SemaphorePermit<'_>, String> {
        if let Ok(permit) = self.limit.try_acquire() {
            return Ok(permit);
        }
        self.pending.fetch_add(1, Ordering::SeqCst);
        let _waiting = Waiting(&self.pending);
        self.limit.acquire().await.map_err(|e| e.to_string())
    }

    /// GET a JSON path: 404 or an empty body = null. A network error or non-2xx status is retried twice with
    /// 0.4 s x (attempt + 1) backoff inside the slot, then the last error is returned; a JSON error is not retried.
    // ponytail: pLimit also counts, for one microtask, calls a free slot is about to take, so one synchronous burst
    // past `max_pending` sheds up to `concurrency` calls earlier in the TS; no caller bursts that wide
    async fn get(&self, path: &str) -> Result<Value, String> {
        let url = format!("{}{path}", self.base);
        // checked once: a retry re-queues an admitted caller, so pending stays <= max_pending + concurrency
        if self.pending.load(Ordering::SeqCst) >= self.max_pending {
            return Err(format!("KB request queue full ({} pending)", self.max_pending));
        }
        let mut last_err = String::new();
        for attempt in 0..=RETRIES {
            let res = {
                let _slot = self.slot().await?;
                self.attempt_get(&url, attempt).await
            };
            match res {
                Ok(Some(text)) if !text.is_empty() => return js_json_parse(&text),
                Ok(_) => return Ok(Value::Null),
                Err(e) => last_err = e,
            }
        }
        Err(last_err)
    }

    /// One attempt; None = 404. The backoff sleep happens inside the slot (like the Python semaphore).
    async fn attempt_get(&self, url: &str, attempt: u32) -> Result<Option<String>, String> {
        let res = match self.transport.get(url, &Self::headers(), self.timeout, MAX_BODY).await {
            Ok(r) if r.status == 404 => return Ok(None),
            Ok(r) if r.ok() => return Ok(Some(r.body)),
            Ok(r) => format!("HTTP {} for {url}", r.status),
            Err(e) => e,
        };
        tokio::time::sleep(Duration::from_millis(400 * (u64::from(attempt) + 1))).await;
        Err(res)
    }

    /// Scrapes data-stops-revision from the homepage (15 s timeout, not retried, outside the limiter); a failure
    /// falls back to the last scraped revision, then to `KB_STOPS_REVISION`.
    // ponytail: the transport reads no body of a non-2xx answer, where the TS scrapes any status's page
    pub async fn fetch_revision(&self) -> String {
        let url = format!("{}/", self.base);
        if let Ok(res) = self
            .transport
            .get(&url, &Self::headers(), REVISION_TIMEOUT, MAX_BODY)
            .await
            && let Some(rev) = scrape_revision(&res.body)
        {
            self.state().last_good_revision = Some(rev.clone());
            return rev;
        }
        let last = self.state().last_good_revision.clone();
        last.unwrap_or_else(|| config::DEFAULT_STOPS_REVISION.clone())
    }

    /// The parsed stop list of a stops revision (None = scrape it first); a falsy body = no stops.
    pub async fn fetch_stops(&self, revision: Option<&str>) -> Result<Vec<Stop>, String> {
        let rev = match revision {
            Some(r) => r.to_owned(),
            None => self.fetch_revision().await,
        };
        let raw = self.get(&format!("/stops?rev={rev}")).await?;
        Ok(if py_truthy(Some(&raw)) {
            parse_stops(Some(&raw))
        } else {
            Vec::new()
        })
    }

    /// GET /api/timetables/<stopUrlId>?date=YYYY-MM-DD, a truthy answer cached 15 min (at most 1000 entries).
    pub async fn fetch_timetable(&self, stop_url_id: &str, date: &str) -> Result<Arc<Value>, String> {
        let key = format!("{stop_url_id}:{date}");
        let now = (self.now)();
        let hit = cache_get(&self.state().timetables, &key, now);
        if let Some(hit) = hit {
            return Ok(hit);
        }
        let data = Arc::new(self.get(&format!("/api/timetables/{stop_url_id}?date={date}")).await?);
        if py_truthy(Some(&data)) {
            let st = &mut self.state();
            cache_put(
                &mut st.timetables,
                TIMETABLE_CACHE_MAX,
                key,
                data.clone(),
                now + TIMETABLE_TTL_MS,
            );
        }
        Ok(data)
    }

    /// One parsed trip detail; None = 404 or a falsy body.
    pub async fn fetch_trip(&self, trip_id: &str, index: i64) -> Result<Option<Trip>, String> {
        let raw = self.fetch_trip_raw(trip_id, index).await?;
        Ok(py_truthy(Some(&raw)).then(|| parse_trip(Some(&raw), trip_id)))
    }

    /// GET /api/trip/<tripId>/<index>, a truthy answer cached 4 h (at most 5000 entries).
    pub async fn fetch_trip_raw(&self, trip_id: &str, index: i64) -> Result<Arc<Value>, String> {
        let key = format!("{trip_id}:{index}");
        let now = (self.now)();
        let hit = cache_get(&self.state().trips, &key, now);
        if let Some(hit) = hit {
            return Ok(hit);
        }
        let data = Arc::new(self.get(&format!("/api/trip/{trip_id}/{index}")).await?);
        if py_truthy(Some(&data)) {
            let st = &mut self.state();
            cache_put(&mut st.trips, TRIP_CACHE_MAX, key, data.clone(), now + TRIP_TTL_MS);
        }
        Ok(data)
    }

    /// True when `fetch_trip_raw` would answer from the cache without an upstream request.
    pub fn has_cached_trip(&self, trip_id: &str, index: i64) -> bool {
        cache_get(&self.state().trips, &format!("{trip_id}:{index}"), (self.now)()).is_some()
    }

    /// Resolves several trips (deduped) through the cache and the shared limiter at once.
    pub async fn fetch_trips_batch(&self, trip_ids: &[String], index: i64) -> TripsBatch {
        let mut seen = HashSet::new();
        let unique: Vec<&str> = trip_ids
            .iter()
            .map(String::as_str)
            .filter(|id| seen.insert(*id))
            .collect();
        let results = join_all(unique.iter().map(|tid| self.fetch_trip_raw(tid, index))).await;
        let mut batch = TripsBatch::default();
        for (tid, res) in unique.into_iter().zip(results) {
            match res {
                Ok(raw) if py_truthy(Some(&raw)) => {
                    batch.trips.insert(tid.to_owned(), raw);
                }
                Ok(_) => {}
                Err(_) => batch.failed += 1,
            }
        }
        js::sort_object_keys(&mut batch.trips);
        batch
    }

    /// GET /api/departures/<stopUrlId>
    pub async fn fetch_departures(&self, stop_url_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/departures/{stop_url_id}")).await
    }

    /// GET /api/departures?places=id1,id2,... (upstream answers at most 6 boards).
    pub async fn fetch_multiple_departures(&self, stop_url_ids: &[String]) -> Result<Value, String> {
        self.get(&format!("/api/departures?places={}", stop_url_ids.join(",")))
            .await
    }

    /// GET /api/announcements[?ah=<hash>] (an empty hash is no hash).
    pub async fn fetch_announcements(&self, hash: Option<&str>) -> Result<Value, String> {
        let params = hash.filter(|h| !h.is_empty()).map(|h| format!("?ah={h}"));
        self.get(&format!("/api/announcements{}", params.unwrap_or_default()))
            .await
    }

    /// GET /api/trip_execution/<base64(execId)>/<index>
    pub async fn fetch_trip_execution(&self, trip_execution_id: &str, index: i64) -> Result<Value, String> {
        self.get(&format!(
            "/api/trip_execution/{}/{index}",
            exec_id_path_segment(trip_execution_id)
        ))
        .await
    }

    /// Runs `f` over every item at once (the shared limiter paces the requests inside); a failure yields None
    /// instead of failing the batch.
    pub async fn fetch_many<I, R, F, Fut>(&self, f: F, items: &[I]) -> Vec<(I, Option<R>)>
    where
        I: Clone,
        F: Fn(I) -> Fut,
        Fut: Future<Output = Result<R, String>>,
    {
        let out = join_all(items.iter().map(|x| f(x.clone()))).await;
        items.iter().cloned().zip(out.into_iter().map(Result::ok)).collect()
    }
}

fn slots(n: usize) -> usize {
    n.clamp(1, Semaphore::MAX_PERMITS)
}

impl<T: ZbTransport + Send + Sync> KbSource for KbApi<T> {
    fn fetch_revision(&self) -> impl Future<Output = String> + Send {
        KbApi::fetch_revision(self)
    }

    fn fetch_stops(&self, revision: Option<&str>) -> impl Future<Output = Result<Vec<Stop>, String>> + Send {
        KbApi::fetch_stops(self, revision)
    }

    fn fetch_multiple_departures(&self, stop_url_ids: &[String]) -> impl Future<Output = Result<Value, String>> + Send {
        KbApi::fetch_multiple_departures(self, stop_url_ids)
    }

    fn fetch_trip_execution(
        &self,
        trip_execution_id: &str,
        index: i64,
    ) -> impl Future<Output = Result<Value, String>> + Send {
        KbApi::fetch_trip_execution(self, trip_execution_id, index)
    }

    fn fetch_timetable(
        &self,
        stop_url_id: &str,
        date: &str,
    ) -> impl Future<Output = Result<Arc<Value>, String>> + Send {
        KbApi::fetch_timetable(self, stop_url_id, date)
    }

    fn fetch_trip(&self, trip_id: &str, index: i64) -> impl Future<Output = Result<Option<Trip>, String>> + Send {
        KbApi::fetch_trip(self, trip_id, index)
    }

    fn fetch_trip_raw(&self, trip_id: &str, index: i64) -> impl Future<Output = Result<Arc<Value>, String>> + Send {
        KbApi::fetch_trip_raw(self, trip_id, index)
    }

    fn has_cached_trip(&self, trip_id: &str, index: i64) -> bool {
        KbApi::has_cached_trip(self, trip_id, index)
    }

    fn fetch_trips_batch(&self, trip_ids: &[String], index: i64) -> impl Future<Output = TripsBatch> + Send {
        KbApi::fetch_trips_batch(self, trip_ids, index)
    }

    fn fetch_departures(&self, stop_url_id: &str) -> impl Future<Output = Result<Value, String>> + Send {
        KbApi::fetch_departures(self, stop_url_id)
    }

    fn fetch_announcements(&self, hash: Option<&str>) -> impl Future<Output = Result<Value, String>> + Send {
        KbApi::fetch_announcements(self, hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gzm::ZbResponse;

    #[test]
    fn json_objects_take_js_key_order_at_every_depth() {
        let v = js_json_parse(r#"{"b":1,"10":2,"2":{"z":0,"1":0},"a":[{"x":0,"0":0}],"01":3}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"2":{"1":0,"z":0},"10":2,"b":1,"a":[{"0":0,"x":0}],"01":3}"#
        );
        assert!(js_json_parse("<html>").unwrap_err().starts_with("SyntaxError: "));
    }

    #[test]
    fn json_numbers_reserialize_as_json_stringify_writes_them() {
        let cases = [
            (r#"{"a":1.0}"#, r#"{"a":1}"#),
            (r#"{"a":-0}"#, r#"{"a":0}"#),
            (r#"{"a":-0.0}"#, r#"{"a":0}"#),
            (r#"{"a":1e2}"#, r#"{"a":100}"#),
            (r#"{"a":12345678901234567890}"#, r#"{"a":12345678901234567000}"#),
            (r#"{"a":-9007199254740993}"#, r#"{"a":-9007199254740992}"#),
            (
                r#"{"a":1e400,"b":["1e400",-1e400],"c":1.5}"#,
                r#"{"a":null,"b":["1e400",null],"c":1.5}"#,
            ),
            (r#"[1e-400,7,0.25]"#, r#"[0,7,0.25]"#),
        ];
        for (body, js) in cases {
            assert_eq!(
                serde_json::to_string(&js_json_parse(body).unwrap()).unwrap(),
                js,
                "{body}"
            );
        }
        let v = js_json_parse(r#"{"a":12345678901234567890}"#).unwrap();
        assert_eq!(v["a"].as_f64(), Some(12345678901234567890_f64));
        assert!(js_json_parse(r#"{"a":1e400"#).unwrap_err().starts_with("SyntaxError: "));
    }

    #[test]
    fn revision_scrape_takes_the_first_numeric_attribute() {
        let html = r#"<div data-stops-revision="x1"></div><div data-stops-revision="6829">"#;
        assert_eq!(scrape_revision(html).as_deref(), Some("6829"));
        assert_eq!(scrape_revision(r#"data-stops-revision="12"#), None);
        assert_eq!(scrape_revision(r#"data-stops-revision="""#), None);
    }

    #[tokio::test]
    async fn join_all_keeps_input_order() {
        let out = join_all((0..5u64).map(|i| async move {
            tokio::time::sleep(Duration::from_millis(5 - i)).await;
            i
        }))
        .await;
        assert_eq!(out, [0, 1, 2, 3, 4]);
    }

    /// Answers "1" once `gate` is notified.
    struct Gate(Arc<tokio::sync::Notify>);

    impl ZbTransport for Gate {
        async fn get(&self, _: &str, _: &[(&str, &str)], _: Duration, _: usize) -> Result<ZbResponse, String> {
            self.0.notified().await;
            Ok(ZbResponse {
                status: 200,
                body: "1".into(),
                ..ZbResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn a_full_queue_sheds_new_requests_and_waiters_are_counted_until_served() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let api = Arc::new(KbApi::new(Gate(gate.clone())).with_concurrency(1).with_max_pending(1));
        let running = tokio::spawn({
            let api = api.clone();
            async move { api.fetch_departures("A").await }
        });
        tokio::task::yield_now().await;
        let queued = tokio::spawn({
            let api = api.clone();
            async move { api.fetch_departures("B").await }
        });
        tokio::task::yield_now().await;
        assert_eq!(api.pending.load(Ordering::SeqCst), 1);
        assert_eq!(
            api.fetch_departures("C").await.unwrap_err(),
            "KB request queue full (1 pending)"
        );
        gate.notify_one();
        assert_eq!(running.await.unwrap(), Ok(Value::from(1)));
        gate.notify_one();
        assert_eq!(queued.await.unwrap(), Ok(Value::from(1)));
        assert_eq!(api.pending.load(Ordering::SeqCst), 0);
    }
}
