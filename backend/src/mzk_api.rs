//! The MZK Bielsko-Biała OnTime client (lib/mzk-api.ts, https://rozklady.bielsko.pl).

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::IndexMap;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

use crate::config;
use crate::fetch::string_err;
use crate::gzm::{HttpZb, NowFn, ZbTransport};
use crate::js;
use crate::kb_api::js_json_parse;
use crate::logger;

/// A getRunningVehicles.json record (lineName, courseLoid, vehicleId, delaySec, latitude, longitude, angle,
/// reachedMeters, variantLoid, lastPingDate, nearestSymbol, onStopPoint, orderInCourse, direction, lastStopOrderNo,
/// stopPoints [{symbol, name, orderNo, street, distance, scheduledDeparture ms, plannedDeparture ms}],
/// optionalDirection, ...), read field by field: `MzkLifecycleInput::from_json`, `mzk_stop_indices` and the fleet
/// tracker's input already take the raw JSON.
pub type MzkRunningVehicle = Value;
/// getRealtime.json: stopPointSymbol, stopPointId, stopPointName, responseDate, departures [{courseId,
/// scheduledDepartureSec, scheduledDeparture ms, realDeparture ms, vehicleId, variantId, orderInCourse, passed, lack,
/// onStopPoint, lineName, directionName}], error.
pub type MzkRealtimeResponse = Value;
/// getAtomicSchedule.json: dayTypeSymbol, lineSchedules (line -> {lineName, isGettingOutOnly, destination,
/// mainVariantId, departures [{scheduledDepartureSec, courseId, variantId, operator, transportType,
/// expectedVehicleType, orderInCourse, optionalDirection, courseStartSec, letter, visible}]}), scheduleDate, error.
/// Objects keep `Object.keys` order (`js_json_parse`).
pub type MzkAtomicScheduleResponse = Value;
/// A getCalendar.json day: date (epoch ms of the local midnight), dayType {dayTypeSymbol, description}.
pub type MzkCalendarDay = Value;
/// A getAllMessages.json message: loid, title, intro, stopSymbols, lineNames, startDate, endDate.
pub type MzkMessage = Value;

// ponytail: a getStops/getLines record of the wrong shape fails the whole list (the TS installs it untyped);
// OnTime has never sent one, and the poller then keeps its previous list
/// A getStops.json stop point.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct MzkStopPoint {
    pub id: f64,
    pub longitude: f64,
    pub latitude: f64,
    pub symbol: String,
    pub name: String,
    pub street: Option<String>,
    pub city: Option<String>,
    pub distance: Option<f64>,
    pub r#virtual: bool,
    pub on_request: bool,
    pub getting_out: bool,
}

/// A getLines.json line.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct MzkLine {
    pub id: f64,
    pub name: String,
    pub long_name: Option<String>,
    pub night_line: bool,
    pub line_type: String,
}

/// getRealtime of one stop changes every few seconds; concurrent viewers (and a station hub's several symbols) share a request.
pub const MZK_REALTIME_TTL_MS: i64 = 5_000;
/// A day's schedule of one stop never changes within the day (~165 KB each, so the cache is small and bounded).
pub const MZK_SCHEDULE_TTL_MS: i64 = 15 * 60_000;
const MZK_REALTIME_CACHE_MAX: usize = 256;
const MZK_SCHEDULE_CACHE_MAX: usize = 24;
const DEFAULT_BASE_URL: &str = "https://rozklady.bielsko.pl";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
// ponytail: the TS reads any body size; 8 MB is ~16x getRunningVehicles at rush hour
const MAX_BODY: usize = 8 << 20;

/// None while the request runs, then its outcome.
type Shared = watch::Receiver<Option<Result<Arc<Value>, String>>>;

struct Entry {
    /// epoch ms the request started (the TTL runs from it, as the TS stamps before `load()`)
    at: i64,
    rx: Shared,
}

#[derive(Clone, Copy)]
enum Cache {
    Realtime,
    Schedule,
}

#[derive(Default)]
struct State {
    realtime: IndexMap<String, Entry>,
    schedule: IndexMap<String, Entry>,
}

impl State {
    fn map(&mut self, cache: Cache) -> &mut IndexMap<String, Entry> {
        match cache {
            Cache::Realtime => &mut self.realtime,
            Cache::Schedule => &mut self.schedule,
        }
    }
}

/// What `MzkPoller` calls on its upstream client (the TS tests fake exactly these methods).
pub trait MzkSource: Send + Sync {
    fn fetch_running_vehicles(&self) -> impl Future<Output = Result<Vec<MzkRunningVehicle>, String>> + Send;
    fn fetch_vehicles(&self) -> impl Future<Output = Result<Vec<Value>, String>> + Send;
    fn fetch_stops(&self) -> impl Future<Output = Result<Vec<MzkStopPoint>, String>> + Send;
    fn fetch_lines(&self) -> impl Future<Output = Result<Vec<MzkLine>, String>> + Send;
}

/// The OnTime client: realtime and day schedules cached with in-flight sharing, everything else straight through.
pub struct MzkApi<T: ZbTransport = HttpZb> {
    pub base_url: String,
    timeout: Duration,
    transport: Arc<T>,
    now: NowFn,
    state: Arc<Mutex<State>>,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Err: "HTTP <status> from <url>" (a bare message = an `Error`), the transport's string, or "SyntaxError: ...".
async fn request_json<T: ZbTransport>(
    transport: &T,
    base_url: &str,
    timeout: Duration,
    path: &str,
) -> Result<Value, String> {
    let url = format!("{base_url}/{}", path.trim_start_matches('/'));
    let headers = [
        ("Accept", "application/json, text/plain, */*"),
        ("User-Agent", config::USER_AGENT.as_str()),
    ];
    // ponytail: a timeout reads "TimeoutError: ..." where the TS AbortController gives "AbortError: ..." (log text only)
    let res = match transport.get(&url, &headers, timeout, MAX_BODY).await {
        Ok(r) if r.ok() => js_json_parse(&r.body),
        Ok(r) => Err(format!("HTTP {} from {url}", r.status)),
        Err(e) => Err(e),
    };
    if let Err(e) = &res {
        logger::warn(
            "mzk-api",
            format!("Request failed for {url}: {}", string_err(e.clone())),
        );
    }
    res
}

impl<T: ZbTransport + Send + Sync + 'static> MzkApi<T> {
    /// rozklady.bielsko.pl, 10 s per request, the system clock. No task or IO at construction.
    pub fn new(transport: T) -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.into(),
            timeout: DEFAULT_TIMEOUT,
            transport: Arc::new(transport),
            now: Arc::new(|| jiff::Timestamp::now().as_millisecond()),
            state: Arc::default(),
        }
    }

    /// The TS `baseUrl` constructor argument (trailing slashes dropped).
    pub fn with_base_url(mut self, base_url: &str) -> Self {
        base_url.trim_end_matches('/').clone_into(&mut self.base_url);
        self
    }

    /// The TS `timeoutMs` constructor argument.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The cache TTL clock and "today" of `fetch_atomic_schedule` (epoch ms).
    pub fn with_now(mut self, now: NowFn) -> Self {
        self.now = now;
        self
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    async fn request_json(&self, path: &str) -> Result<Value, String> {
        request_json(&*self.transport, &self.base_url, self.timeout, path).await
    }

    /// TTL cache + in-flight sharing: the request starts with the entry in a task of its own (the TS `p: load()`),
    /// so an abandoned caller never aborts it; concurrent callers await its one outcome. A failure drops the entry
    /// before it reaches the callers, so the next caller retries. Bounded: expired entries first, then the oldest
    /// inserted.
    async fn cached(&self, cache: Cache, key: String, path: String) -> Result<Arc<Value>, String> {
        let (ttl, max) = match cache {
            Cache::Realtime => (MZK_REALTIME_TTL_MS, MZK_REALTIME_CACHE_MAX),
            Cache::Schedule => (MZK_SCHEDULE_TTL_MS, MZK_SCHEDULE_CACHE_MAX),
        };
        let now = (self.now)();
        let mut rx = {
            let mut st = self.state();
            let map = st.map(cache);
            match map.get(&key) {
                Some(hit) if now - hit.at < ttl => hit.rx.clone(),
                _ => {
                    let (tx, rx) = watch::channel(None);
                    // an existing key keeps its place, like Map.set
                    map.insert(
                        key.clone(),
                        Entry {
                            at: now,
                            rx: rx.clone(),
                        },
                    );
                    if map.len() > max {
                        map.retain(|_, e| now - e.at < ttl);
                        while map.len() > max {
                            map.shift_remove_index(0);
                        }
                    }
                    let (transport, state, mine) = (Arc::clone(&self.transport), Arc::clone(&self.state), rx.clone());
                    let (base_url, timeout, key) = (self.base_url.clone(), self.timeout, key.clone());
                    tokio::spawn(async move {
                        let res = request_json(&*transport, &base_url, timeout, &path).await.map(Arc::new);
                        if res.is_err() {
                            drop_entry(&state, cache, &key, &mine);
                        }
                        tx.send_replace(Some(res));
                    });
                    rx
                }
            }
        };
        let res = rx.wait_for(Option::is_some).await.ok().and_then(|v| v.clone());
        res.unwrap_or_else(|| {
            // the task ended without an outcome (a panic or the runtime shutting down): not cached either
            drop_entry(&self.state, cache, &key, &rx);
            Err("MZK request ended without an answer".into())
        })
    }

    /// All active running vehicles in real time.
    pub async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
        list(self.request_json("getRunningVehicles.json").await?, "vehicles")
    }

    /// Static vehicle attributes (fleet equipment, `MzkVehicleStatic` records keyed by `sideNumber`).
    pub async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
        list(self.request_json("getVehicles.json").await?, "vehicles")
    }

    /// All MZK stop points.
    pub async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
        typed(list(self.request_json("getStops.json").await?, "stopPoints")?)
    }

    /// All MZK lines.
    pub async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
        typed(list(self.request_json("getLines.json").await?, "lines")?)
    }

    /// Live departures of a stop symbol ("341", "2"), cached `MZK_REALTIME_TTL_MS`.
    pub async fn fetch_realtime(&self, symbol: &str) -> Result<Arc<MzkRealtimeResponse>, String> {
        let path = format!("getRealtime.json?stopPointSymbol={}", js::encode_uri_component(symbol));
        self.cached(Cache::Realtime, symbol.to_owned(), path).await
    }

    /// Service announcements.
    pub async fn fetch_messages(&self) -> Result<Vec<MzkMessage>, String> {
        list(self.request_json("getAllMessages.json").await?, "messages")
    }

    /// Real-time stoppings of a course (the JSON as sent).
    pub async fn fetch_real_course(&self, course_id: f64) -> Result<Value, String> {
        let path = format!("getRealCourse.json?courseId={}", js::number_to_string(course_id));
        self.request_json(&path).await
    }

    /// A stop's whole-day timetable. `date` "YYYY-MM-DD" (None or another shape = today in the agency zone), sent
    /// as noon UTC of that day in ms; `cache: false` (the timetable build reads every stop once) skips the cache.
    // ponytail: the TS also takes a ready epoch-ms date; no caller passes one
    pub async fn fetch_atomic_schedule(
        &self,
        symbol: &str,
        date: Option<&str>,
        cache: bool,
    ) -> Result<Arc<MzkAtomicScheduleResponse>, String> {
        let date_param = schedule_date_param(date, (self.now)());
        let path = format!(
            "getAtomicSchedule.json?symbol={}&date={date_param}",
            js::encode_uri_component(symbol)
        );
        if !cache {
            return self.request_json(&path).await.map(Arc::new);
        }
        self.cached(Cache::Schedule, format!("{symbol}|{date_param}"), path)
            .await
    }

    /// The operator calendar: the day type of each of the next ~90 days.
    pub async fn fetch_calendar(&self) -> Result<Vec<MzkCalendarDay>, String> {
        list(self.request_json("getCalendar.json").await?, "days")
    }

    /// Theoretical course details of a variant (geometry; `mzk_shape_from_course_details` reads it).
    pub async fn fetch_theoretical_course(&self, variant_id: f64) -> Result<Value, String> {
        let path = format!(
            "getTheoreticalCourseDetails.json?variantId={}",
            js::number_to_string(variant_id)
        );
        self.request_json(&path).await
    }
}

fn drop_entry(state: &Mutex<State>, cache: Cache, key: &str, rx: &Shared) {
    let mut st = lock(state);
    let map = st.map(cache);
    if map.get(key).is_some_and(|e| e.rx.same_channel(rx)) {
        map.shift_remove(key);
    }
}

impl<T: ZbTransport + Send + Sync + 'static> MzkSource for MzkApi<T> {
    fn fetch_running_vehicles(&self) -> impl Future<Output = Result<Vec<MzkRunningVehicle>, String>> + Send {
        MzkApi::fetch_running_vehicles(self)
    }

    fn fetch_vehicles(&self) -> impl Future<Output = Result<Vec<Value>, String>> + Send {
        MzkApi::fetch_vehicles(self)
    }

    fn fetch_stops(&self) -> impl Future<Output = Result<Vec<MzkStopPoint>, String>> + Send {
        MzkApi::fetch_stops(self)
    }

    fn fetch_lines(&self) -> impl Future<Output = Result<Vec<MzkLine>, String>> + Send {
        MzkApi::fetch_lines(self)
    }
}

/// `res?.<key> ?? []`; a non-array there is an error (the TS callers throw a TypeError on it).
fn list(res: Value, key: &str) -> Result<Vec<Value>, String> {
    match res {
        Value::Object(mut m) => match m.remove(key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(a)) => Ok(a),
            Some(_) => Err(format!("TypeError: {key} is not an array")),
        },
        _ => Ok(Vec::new()),
    }
}

fn typed<R: DeserializeOwned>(items: Vec<Value>) -> Result<Vec<R>, String> {
    serde_json::from_value(Value::Array(items)).map_err(|e| format!("TypeError: {e}"))
}

/// The `date` query value: `Date.UTC(y, m - 1, d, 12)` of a "YYYY-MM-DD" (out-of-range fields roll over as in JS),
/// else of the agency's date at `now_ms`.
fn schedule_date_param(date: Option<&str>, now_ms: i64) -> i64 {
    let (y, m, d) = match date.and_then(iso_parts) {
        Some(ymd) => ymd,
        None => {
            let day = jiff::Timestamp::from_millisecond(now_ms)
                .map(|ts| crate::time::agency_clock(ts).0)
                .unwrap_or_else(|_| crate::time::today_local());
            (i64::from(day.year()), i64::from(day.month()), i64::from(day.day()))
        }
    };
    date_utc_ms(y, m - 1, d, 12)
}

/// `/^\d{4}-\d{2}-\d{2}$/` split into numbers.
fn iso_parts(s: &str) -> Option<(i64, i64, i64)> {
    let b = s.as_bytes();
    let shape = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        });
    if !shape {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|p| p.parse::<i64>().ok());
    Some((num(0..4)?, num(5..7)?, num(8..10)?))
}

/// `Date.UTC(year, month0, day, hour)`: years 0..=99 are 1900 + year, month and day overflow roll over.
fn date_utc_ms(year: i64, month0: i64, day: i64, hour: i64) -> i64 {
    let year = if (0..=99).contains(&year) { 1900 + year } else { year };
    let y = year + month0.div_euclid(12);
    let m = month0.rem_euclid(12) + 1;
    (days_from_civil(y, m, 1) + day - 1) * 86_400_000 + hour * 3_600_000
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1..=12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_date_is_noon_utc_with_js_rollover() {
        let ms = |s: &str| {
            let ts: jiff::Timestamp = s.parse().unwrap();
            ts.as_millisecond()
        };
        assert_eq!(schedule_date_param(Some("2026-10-02"), 0), ms("2026-10-02T12:00:00Z"));
        assert_eq!(schedule_date_param(Some("2024-02-29"), 0), ms("2024-02-29T12:00:00Z"));
        assert_eq!(schedule_date_param(Some("2026-13-01"), 0), ms("2027-01-01T12:00:00Z"));
        assert_eq!(schedule_date_param(Some("2026-02-30"), 0), ms("2026-03-02T12:00:00Z"));
        assert_eq!(schedule_date_param(Some("2026-01-00"), 0), ms("2025-12-31T12:00:00Z"));
        assert_eq!(schedule_date_param(Some("0050-01-01"), 0), ms("1950-01-01T12:00:00Z"));
        // not the regex shape: today in Warsaw (23:30 UTC on Oct 2 is already Oct 3 there)
        let late = ms("2026-10-02T23:30:00Z");
        assert_eq!(schedule_date_param(Some("2026-10-2"), late), ms("2026-10-03T12:00:00Z"));
        assert_eq!(schedule_date_param(None, late), ms("2026-10-03T12:00:00Z"));
    }
}
