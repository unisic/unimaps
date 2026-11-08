//! lib/mzk-timetable.ts: the builder (`buildMzkTimetable`, run by gtfs_refresh), the file the router reads
//! (`loadMzkTimetable`) and the day schedule of the fleet's next-course prediction (`mzkDaySchedule`).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use indexmap::IndexMap;
use jiff::Timestamp;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::gzm::NowFn;
use crate::js::{self, JsNum};
use crate::kb_api::join_all;
use crate::mzk_api::{MzkAtomicScheduleResponse, MzkSource};
use crate::poller::js_number_of;
use crate::shared::fleet::fold_text;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MzkTimetableTrip {
    /// `mzk:<course>:<variant>`
    pub id: String,
    pub line: String,
    pub headsign: String,
    pub day_type: String,
    /// (stop symbol, secs from the service day's midnight) in stop order
    #[serde(serialize_with = "ser_calls")]
    pub calls: Vec<(String, f64)>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MzkTimetableFile {
    #[serde(serialize_with = "ser_num")]
    v: f64,
    /// epoch ms of the build; not read back (0 after a load)
    #[serde(skip_deserializing, serialize_with = "ser_num")]
    pub built_at: f64,
    /// Warsaw ISO date -> OnTime day type
    pub calendar: IndexMap<String, String>,
    /// symbol -> (name, lat, lon), in `Object.entries` order
    #[serde(serialize_with = "ser_stops")]
    pub stops: IndexMap<String, (String, f64, f64)>,
    pub trips: Vec<MzkTimetableTrip>,
}

fn ser_num<S: Serializer>(x: &f64, s: S) -> Result<S::Ok, S::Error> {
    JsNum(*x).serialize(s)
}

fn ser_calls<S: Serializer>(calls: &[(String, f64)], s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(calls.iter().map(|(sym, sec)| (sym, JsNum(*sec))))
}

fn ser_stops<S: Serializer>(stops: &IndexMap<String, (String, f64, f64)>, s: S) -> Result<S::Ok, S::Error> {
    s.collect_map(
        stops
            .iter()
            .map(|(k, (name, lat, lon))| (k, (name, JsNum(*lat), JsNum(*lon)))),
    )
}

/// None when the file is missing (quietly) or not a v1 timetable (with a warning). A malformed trip or stop rejects
/// the whole file here, where the TS took it and misbehaved later.
pub fn load_mzk_timetable(file: &Path) -> Option<MzkTimetableFile> {
    let raw = std::fs::read(file).ok()?;
    let parsed = serde_json::from_slice::<MzkTimetableFile>(&raw)
        .map_err(|e| e.to_string())
        .and_then(|tt| {
            if tt.v == 1.0 {
                Ok(tt)
            } else {
                Err("Error: not a v1 timetable".into())
            }
        });
    match parsed {
        Ok(mut tt) => {
            crate::js::sort_object_keys(&mut tt.stops);
            Some(tt)
        }
        Err(e) => {
            crate::logger::warn("mzk-tt", format!("ignoring {}: {e}", file.display()));
            None
        }
    }
}

// ponytail: dates past this window get KB-only results; widen it (more day types, same requests per type) if users
// plan further ahead
const WINDOW_DAYS: usize = 8;
const CONCURRENCY: usize = 4;
/// More failed stop schedules than this share of all stops = a broken build, keep the old file.
const MAX_FAILED_SHARE: f64 = 0.05;

/// One course being assembled from the per-stop schedules of one day type.
pub struct CourseAcc {
    /// `String(variantId)`
    variant: String,
    line: String,
    headsign: String,
    start_sec: Option<f64>,
    /// (symbol, departure secs, order in course)
    calls: Vec<(String, f64, f64)>,
}

/// Courses keyed by `String(courseId)` (the TS `Map<number>`: two numbers are the same key exactly when their
/// `String()` is), in first-seen order.
pub type CourseAccumulator = IndexMap<String, CourseAcc>;

/// Course order of one sampled course: (stop symbol, departure secs).
pub type VariantSample = Vec<(String, f64)>;

/// Samples keyed by `String(variantId)` (the TS `Map<number>`), see [`variant_key`].
pub type VariantSamples = HashMap<String, VariantSample>;

/// `a.order - b.order` as a total order: -0 equals 0. ponytail: a NaN order (V8 leaves its place unspecified) sorts
/// last.
fn order_cmp(a: f64, b: f64) -> Ordering {
    let key = |x: f64| {
        if x == 0.0 {
            0.0
        } else if x.is_nan() {
            f64::NAN
        } else {
            x
        }
    };
    key(a).total_cmp(&key(b))
}

fn truthy(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| js::truthy(Some(v)))
}

/// `addStopSchedule`: folds one stop's day schedule into the courses of `day_type`. Some(false) = answered for
/// another day type (ignored); None = a payload the TS throws a TypeError on (the build counts that stop as failed;
/// courses folded before the bad record stay, as in the TS).
pub fn add_stop_schedule(
    acc: &mut CourseAccumulator,
    symbol: &str,
    res: &MzkAtomicScheduleResponse,
    day_type: &str,
) -> Option<bool> {
    if res.is_null() {
        return None;
    }
    if let Some(t) = res.get("dayTypeSymbol")
        && js::truthy(Some(t))
        && t.as_str() != Some(day_type)
    {
        return Some(false);
    }
    let schedules: Vec<&Value> = match res.get("lineSchedules") {
        Some(Value::Object(m)) => m.values().collect(),
        Some(Value::Array(a)) => a.iter().collect(),
        _ => Vec::new(),
    };
    for ls in schedules {
        let departures = match ls {
            Value::Null => return None,
            Value::Object(o) => o.get("departures"),
            _ => None,
        };
        let departures = match departures {
            None | Some(Value::Null | Value::String(_)) => continue,
            Some(Value::Array(a)) => a,
            Some(_) => return None,
        };
        for d in departures {
            if d.is_null() {
                return None;
            }
            let (Some(course), Some(sec)) = (
                d.get("courseId").and_then(Value::as_f64),
                d.get("scheduledDepartureSec").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let c = acc.entry(js::number_to_string(course)).or_insert_with(|| {
                // ponytail: a non-string lineName or headsign is stringified (the TS writes the raw value, which
                // load_mzk_timetable then rejects)
                CourseAcc {
                    variant: js::value_to_string(d.get("variantId")),
                    line: js::value_to_string(ls.get("lineName")),
                    headsign: truthy(d.get("optionalDirection"))
                        .or_else(|| truthy(ls.get("destination")))
                        .map_or_else(String::new, |v| js::value_to_string(Some(v))),
                    start_sec: None,
                    calls: Vec::new(),
                }
            });
            if c.start_sec.is_none() {
                c.start_sec = d.get("courseStartSec").and_then(Value::as_f64);
            }
            let order = match d.get("orderInCourse") {
                None | Some(Value::Null) => c.calls.len() as f64,
                Some(v) => js_number_of(v),
            };
            c.calls.push((symbol.to_owned(), sec, order));
        }
    }
    Some(true)
}

/// `finishCourses`: the accumulated courses as trips, calls in course order, times made monotonic across midnight
/// (a drop of more than 12 h from the previous call, or the course start, is a midnight crossing). Courses with
/// fewer than 2 calls are dropped.
pub fn finish_courses(acc: CourseAccumulator, day_type: &str) -> Vec<MzkTimetableTrip> {
    let mut trips = Vec::new();
    for (course, mut c) in acc {
        if c.calls.len() < 2 {
            continue;
        }
        c.calls.sort_by(|a, b| order_cmp(a.2, b.2));
        let Some(mut prev) = c.start_sec.or(c.calls.first().map(|x| x.1)) else {
            continue;
        };
        let mut wrap = 0.0;
        let calls = c
            .calls
            .into_iter()
            .map(|(sym, sec, _)| {
                let mut sec = sec + wrap;
                if sec < prev - 43200.0 {
                    wrap += 86400.0;
                    sec += 86400.0;
                }
                prev = sec;
                (sym, sec)
            })
            .collect();
        trips.push(MzkTimetableTrip {
            id: format!("mzk:{course}:{}", c.variant),
            line: c.line,
            headsign: c.headsign,
            day_type: day_type.to_owned(),
            calls,
        });
    }
    trips
}

/// `variantOf` as a [`VariantSamples`] key: `String(Number(<id after the last ':'>))`.
pub fn variant_key(trip_id: &str) -> String {
    let tail = trip_id.rfind(':').map_or(trip_id, |i| &trip_id[i + 1..]);
    js::number_to_string(js::number(tail))
}

/// `appendTermini`: appends the stops a trip lacks after its last call (the terminus), copied from the sample
/// course of its variant with the sample's own run times. Returns how many trips were extended.
// ponytail: run times from one sample per variant, about ±1 min off in the peak; getRealCourse per course if that
// matters
pub fn append_termini(trips: &mut [MzkTimetableTrip], samples: &VariantSamples) -> usize {
    let mut n = 0;
    for t in trips {
        let Some(sample) = samples.get(&variant_key(&t.id)) else {
            continue;
        };
        let Some((last_sym, last_sec)) = t.calls.last().cloned() else {
            continue;
        };
        let Some(i) = sample.iter().rposition(|(sym, _)| *sym == last_sym) else {
            continue;
        };
        let (Some(at_i), Some(rest)) = (sample.get(i), sample.get(i + 1..)) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        for (sym, sec) in rest {
            t.calls.push((sym.clone(), last_sec + sec - at_i.1));
        }
        n += 1;
    }
    n
}

/// `parseSample`: a getRealCourse answer as (symbol, departure secs) in course order; None below 2 usable stops.
fn parse_sample(raw: &Value) -> Option<VariantSample> {
    let stoppings = raw.get("realCourse")?.get("stoppings")?.as_array()?;
    let mut rows: Vec<(&str, f64, f64)> = stoppings
        .iter()
        .filter_map(|s| {
            let sym = s.get("stopPointSymbol")?.as_str()?;
            let sec = s.get("scheduledDepartureSec")?.as_f64()?;
            Some((sym, sec, s.get("orderInCourse").map_or(f64::NAN, js_number_of)))
        })
        .collect();
    rows.sort_by(|a, b| order_cmp(a.2, b.2));
    (rows.len() >= 2).then(|| rows.into_iter().map(|(sym, sec, _)| (sym.to_owned(), sec)).collect())
}

/// `buildMzkTimetable`: fetches and assembles the timetable for the day types of the next [`WINDOW_DAYS`] calendar
/// days from `today` (Warsaw "YYYY-MM-DD"), 4 requests at a time. Err (so the caller keeps the previous file) when
/// the calendar or stop list is empty, a day type yields no course, more than 5 % of the stop schedules failed, or a
/// calendar/stop fetch failed (the source's error as is). Peak memory: the courses of all day types (~2 500 courses,
/// a few MB); each stop schedule is folded and dropped as it arrives.
pub async fn build_mzk_timetable<M: MzkSource>(api: &M, today: &str, now: &NowFn) -> Result<MzkTimetableFile, String> {
    // ponytail: only a numeric `date` (epoch ms, the documented shape); the TS also feeds a string to `new Date`
    let mut days: Vec<(String, String)> = api
        .fetch_calendar()
        .await?
        .iter()
        .filter_map(|d| {
            let ms = d.get("date")?.as_f64()?;
            let ts = Timestamp::from_millisecond(ms.trunc() as i64).ok()?;
            let iso = crate::time::agency_clock(ts).0.to_string();
            let ty = d
                .get("dayType")?
                .get("dayTypeSymbol")?
                .as_str()
                .filter(|t| !t.is_empty())?;
            (iso.as_str() >= today).then(|| (iso, ty.to_owned()))
        })
        .collect();
    days.sort_by(|a, b| a.0.cmp(&b.0));
    days.truncate(WINDOW_DAYS);
    let mut calendar = IndexMap::new();
    let mut rep_date: IndexMap<String, String> = IndexMap::new();
    for (iso, ty) in days {
        rep_date.entry(ty.clone()).or_insert_with(|| iso.clone());
        calendar.insert(iso, ty);
    }
    if rep_date.is_empty() {
        return Err("MZK calendar has no day from today on".into());
    }

    let points: Vec<_> = api
        .fetch_stops()
        .await?
        .into_iter()
        .filter(|s| !s.symbol.is_empty())
        .collect();
    if points.is_empty() {
        return Err("MZK stop list is empty".into());
    }
    let mut stops = IndexMap::new();
    for s in &points {
        stops.insert(s.symbol.clone(), (s.name.clone(), s.latitude, s.longitude));
    }
    js::sort_object_keys(&mut stops);

    let limit = &Semaphore::new(CONCURRENCY);
    let mut trips: Vec<MzkTimetableTrip> = Vec::new();
    for (day_type, iso) in &rep_date {
        let acc = &Mutex::new(CourseAccumulator::new());
        // ponytail: join_all re-polls every pending future per wake, O(n) over ~1 000 stops; FuturesUnordered if it shows
        let outcomes = join_all(points.iter().map(|s| async move {
            let _permit = limit.acquire().await.ok()?;
            let res = api.fetch_atomic_schedule(&s.symbol, Some(iso), false).await.ok()?;
            let mut acc = acc.lock().unwrap_or_else(PoisonError::into_inner);
            add_stop_schedule(&mut acc, &s.symbol, &res, day_type)
        }))
        .await;
        let failed = outcomes.iter().filter(|o| o.is_none()).count();
        let other_day = outcomes.iter().filter(|o| **o == Some(false)).count();
        if failed as f64 > points.len() as f64 * MAX_FAILED_SHARE {
            return Err(format!(
                "MZK {day_type}: {failed}/{} stop schedules failed",
                points.len()
            ));
        }
        let acc = std::mem::take(&mut *acc.lock().unwrap_or_else(PoisonError::into_inner));
        let day_trips = finish_courses(acc, day_type);
        if day_trips.is_empty() {
            return Err(format!("MZK {day_type} ({iso}) has no course"));
        }
        crate::logger::info(
            "mzk-tt",
            format!(
                "{day_type} ({iso}): {} courses, {failed} failed, {other_day} other-day stops",
                day_trips.len()
            ),
        );
        trips.extend(day_trips);
    }

    let mut first_of_variant: IndexMap<String, f64> = IndexMap::new();
    for t in &trips {
        first_of_variant
            .entry(variant_key(&t.id))
            .or_insert_with(|| t.id.split(':').nth(1).map_or(f64::NAN, js::number));
    }
    let samples: VariantSamples = join_all(first_of_variant.iter().map(|(variant, &course)| async move {
        let _permit = limit.acquire().await.ok()?;
        // a missing sample only leaves that variant's trips without their terminus
        let raw = api.fetch_real_course(course).await.ok()?;
        Some((variant.clone(), parse_sample(&raw)?))
    }))
    .await
    .into_iter()
    .flatten()
    .collect();
    let extended = append_termini(&mut trips, &samples);
    for t in &mut trips {
        t.calls.retain(|(sym, _)| stops.contains_key(sym));
    }
    crate::logger::info(
        "mzk-tt",
        format!(
            "built {} courses, {}/{} variant samples, {extended} termini added",
            trips.len(),
            samples.len(),
            first_of_variant.len()
        ),
    );
    trips.retain(|t| t.calls.len() >= 2);
    Ok(MzkTimetableFile {
        v: 1.0,
        built_at: now() as f64,
        calendar,
        stops,
        trips,
    })
}

/// `saveMzkTimetable`: `JSON.stringify` of the file, written to `<file>.<pid>.tmp` and renamed over `file` (mkdir -p
/// first), so a reader never sees a half-written file. Sync: call through `blocking_io` from async code.
pub fn save_mzk_timetable(tt: &MzkTimetableFile, file: &Path) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec(tt).map_err(std::io::Error::other)?)?;
    std::fs::rename(&tmp, file)
}

/// `mzkTimetableDate`: the Warsaw date of the file's mtime ("YYYY-MM-DD"), None without the file. No parse.
pub fn mzk_timetable_date(file: &Path) -> Option<String> {
    let mtime = std::fs::metadata(file).ok()?.modified().ok()?;
    let ts = Timestamp::try_from(mtime).ok()?;
    Some(crate::time::agency_clock(ts).0.to_string())
}

/// One MZK course of a day as the next-course prediction reads it (lib/fleet-history.ts).
#[derive(Debug, Clone, PartialEq)]
pub struct MzkDayCourse {
    pub line: String,
    pub headsign: String,
    pub first_sym: String,
    pub first_name: String,
    /// scheduled first departure, agency seconds
    pub start: f64,
    pub last_name: String,
    /// scheduled terminus time, agency seconds (may exceed 86 400)
    pub end: f64,
}

#[derive(Debug, Default, PartialEq)]
pub struct MzkDaySchedule {
    /// by course key `<line>|<first stop symbol>|<String(start)>`
    pub by_key: HashMap<String, MzkDayCourse>,
    /// by folded first-stop name, each list by start
    pub from_stop: HashMap<String, Vec<MzkDayCourse>>,
}

struct DayMemo {
    file: PathBuf,
    date: String,
    mtime: Option<SystemTime>,
    checked_at: Instant,
    sched: Option<Arc<MzkDaySchedule>>,
}

static DAY_MEMO: LazyLock<Mutex<Option<DayMemo>>> = LazyLock::new(|| Mutex::new(None));
const RECHECK: Duration = Duration::from_secs(10 * 60);

/// [`mzk_day_schedule_in`] over `KB_MZK_TIMETABLE_FILE`.
pub fn mzk_day_schedule(date: &str) -> Option<Arc<MzkDaySchedule>> {
    mzk_day_schedule_in(date, Path::new(&*crate::config::MZK_TIMETABLE_FILE))
}

/// The courses of `date` from the timetable file, memoized for one date; the file's mtime is rechecked at most every
/// 10 min (the nightly rebuild replaces it). None without the file or without the date in its calendar. ~2 500
/// courses, < 1 MB held.
/// ponytail: blocking like the TS (a stat at most every 10 min, a reload parses 2.3 MB, ~30 ms, once a day), under
/// one global lock; a caller on an async worker stalls it that long.
pub fn mzk_day_schedule_in(date: &str, file: &Path) -> Option<Arc<MzkDaySchedule>> {
    let now = Instant::now();
    let mut memo = DAY_MEMO.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(m) = memo.as_ref()
        && m.file == file
        && m.date == date
        && now.duration_since(m.checked_at) < RECHECK
    {
        return m.sched.clone();
    }
    let mtime = std::fs::metadata(file).and_then(|m| m.modified()).ok();
    if let Some(m) = memo.as_mut()
        && m.file == file
        && m.date == date
        && m.mtime == mtime
    {
        m.checked_at = now;
        return m.sched.clone();
    }
    let tt = mtime.and_then(|_| load_mzk_timetable(file));
    let sched = tt
        .as_ref()
        .and_then(|tt| Some(Arc::new(day_schedule(tt, tt.calendar.get(date)?))));
    *memo = Some(DayMemo {
        file: file.to_path_buf(),
        date: date.to_owned(),
        mtime,
        checked_at: now,
        sched: sched.clone(),
    });
    sched
}

fn day_schedule(tt: &MzkTimetableFile, day_type: &str) -> MzkDaySchedule {
    let mut sched = MzkDaySchedule::default();
    for t in &tt.trips {
        let (Some((first_sym, start)), Some((last_sym, end))) = (t.calls.first(), t.calls.last()) else {
            continue;
        };
        if t.day_type != day_type || t.calls.len() < 2 {
            continue;
        }
        // ponytail: a course starting after midnight of its service day is skipped (MZK runs none past ~00:30);
        // the tracker keys courses by wall-clock seconds, so it would need the previous date's schedule.
        if *start >= 86_400.0 {
            continue;
        }
        let name = |sym: &str| tt.stops.get(sym).map(|s| s.0.clone()).unwrap_or_default();
        let c = MzkDayCourse {
            line: t.line.clone(),
            headsign: t.headsign.clone(),
            first_sym: first_sym.clone(),
            first_name: name(first_sym),
            start: *start,
            last_name: name(last_sym),
            end: *end,
        };
        let key = format!("{}|{first_sym}|{}", c.line, crate::js::number_to_string(*start));
        sched
            .from_stop
            .entry(fold_text(&c.first_name))
            .or_default()
            .push(c.clone());
        sched.by_key.insert(key, c);
    }
    for list in sched.from_stop.values_mut() {
        list.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    }
    sched
}
