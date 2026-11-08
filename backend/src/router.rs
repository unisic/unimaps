//! lib/router.ts: the static connection search. Range RAPTOR (Delling et al. 2012) over the KB GTFS feed plus the
//! MZK timetable, or over a zbiorkom city's own index (`build_router_index`); the line view (`line_timetable`) and
//! the boardable calls of a stop (`stop_events`) read the same index.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

use crate::gtfs_csv::{NO_DROP_OFF, NO_PICKUP, col, field, parse_csv_line, read_text, split_lines};
use crate::js::{self, JsNum};
use crate::shared::fleet::fold_text;

const WALK_MAX_M: f64 = 350.0;
/// poles closer than this are one stop (the KB and MZK pole of one shelter), no walk; twins of one operator stand >= 5 m apart
const SAME_STOP_M: f64 = 4.0;
const WALK_MPS: f64 = 1.1;
/// a search from a point starts at the nearest ACCESS_MAX_POLES poles within its walk radius, by default ACCESS_MAX_M
const ACCESS_MAX_M: f64 = 800.0;
const ACCESS_MAX_POLES: usize = 24;
/// slack on top of a walk between poles, so a walking transfer is never tighter than walk + 1.5 min
const WALK_MARGIN_SECS: i32 = 90;
const DEFAULT_CHANGE_SECS: i32 = 180;
// ponytail: 5 rides (4 transfers) cover the KB + MZK network; raise it if a pair ever needs more
const MAX_RIDES: usize = 5;
const DAY_CACHE: usize = 4;
const FIRST_WINDOW_SECS: i32 = 2 * 3600;
const INF: i32 = 0x3fff_ffff;
// ponytail: a line's 12 busiest stop patterns; the rest are depot runs and one-off short turns
const MAX_VARIANTS: usize = 12;
const PL_WEEKDAYS: [&str; 7] = [
    "Poniedziałek",
    "Wtorek",
    "Środa",
    "Czwartek",
    "Piątek",
    "Sobota",
    "Niedziela",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLegStop {
    pub stop_id: String,
    pub stop_name: String,
    pub arrival_time: String,
    pub departure_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<JsNum>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLeg {
    pub line: String,
    pub trip_id: String,
    pub headsign: String,
    pub from_stop_id: String,
    pub from_stop_name: String,
    pub to_stop_id: String,
    pub to_stop_name: String,
    pub departure_time: String,
    pub arrival_time: String,
    pub departure_secs: i32,
    pub arrival_secs: i32,
    pub duration_mins: i32,
    pub stops_count: i32,
    pub stops: Vec<ConnectionLegStop>,
    /// walk from the previous leg's last pole to this leg's first, minutes (0 = the same stop); absent on the first leg
    #[serde(skip_serializing_if = "Option::is_none")]
    pub walk_mins: Option<i32>,
    /// the trip's live delay (s) its times already include: the vehicle is running
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_sec: Option<i32>,
    /// set by a zbiorkom city's search ("GZM" = the seconds dialect)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator: Option<&'static str>,
    #[serde(rename = "shape_id", skip_serializing_if = "Option::is_none")]
    pub shape_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionItinerary {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub departure_time: String,
    pub arrival_time: String,
    pub departure_secs: i32,
    pub arrival_secs: i32,
    pub total_duration_mins: i32,
    pub transfers_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_wait_mins: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_stop_name: Option<String>,
    /// every minute on foot: the walk to the first stop plus the transfers
    pub walk_minutes: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_walk_mins: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress_walk_mins: Option<i32>,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_label: Option<String>,
    pub arrives_next_day: bool,
    pub legs: Vec<ConnectionLeg>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum SortBy {
    #[default]
    Departure,
    Duration,
    Arrival,
    Transfers,
    /// least walking first; a walking transfer also weighs three times its minutes in the search
    Walk,
}

/// A query point: every pole within `walk_m` (default 800 m) is reached on foot.
#[derive(Clone, Copy, Default)]
pub struct Point {
    pub lat: f64,
    pub lon: f64,
    pub walk_m: Option<f64>,
}

/// A running trip's delay (s) on its service date (trip id, Warsaw ISO date); None = timetable.
pub type LiveFn<'a> = dyn Fn(&str, &str) -> Option<i32> + 'a;

#[derive(Default)]
pub struct RouteQuery<'a> {
    pub from: &'a str,
    pub to: &'a str,
    /// router stop ids of the origin (KB stop id, `mzk:<symbol>`); `from` is the name fallback when none is known
    pub from_ids: &'a [String],
    pub to_ids: &'a [String],
    /// overrides from / from_ids
    pub from_point: Option<Point>,
    /// overrides to / to_ids; the walk from the last pole counts into the arrival
    pub to_point: Option<Point>,
    pub after_secs: Option<i32>,
    /// after_secs is the latest arrival: the latest-leaving journeys that arrive by then, that day only
    pub arrive_by: bool,
    pub limit: Option<i32>,
    pub direct_only: bool,
    pub min_transfer_secs: Option<i32>,
    pub max_transfer_secs: Option<i32>,
    /// None or "" = today
    pub date: Option<&'a str>,
    pub day_label: Option<&'a str>,
    pub sort_by: SortBy,
    /// rider-facing lines never ridden
    pub avoid_lines: &'a [String],
    /// route ids never ridden (a mode the rider avoids, resolved by the caller from its route types)
    pub avoid_routes: &'a [String],
    /// today's searches board running trips at their live times
    pub live: Option<&'a LiveFn<'a>>,
    /// following days searched when today's query finds nothing (default 3)
    pub fallback_days: Option<u32>,
}

pub struct StopEntry {
    pub id: String,
    pub name: String,
    pub name_key: String,
    pub clean_key: String,
    pub lat: f64,
    pub lon: f64,
}

/// One stop_times row while a feed loads; a loaded trip keeps its calls as columns (`call_columns`).
pub struct TripStopEntry {
    pub stop_id: String,
    pub seq: f64,
    pub arr: f64,
    pub dep: f64,
}

#[derive(Clone, Default)]
pub struct TripEntry {
    pub trip_id: String,
    pub service_id: String,
    pub route_id: String,
    pub line: String,
    pub headsign: String,
    /// per call in stop_sequence order; one slice for every trip with the same calls
    pub stop_ids: Arc<[String]>,
    pub seqs: Arc<[i32]>,
    /// per call, secs from the service day's midnight, non-decreasing; one slice when every call's arr equals its dep
    pub arr: Arc<[i32]>,
    pub dep: Arc<[i32]>,
    /// MZK only: the OnTime day types the course runs on (KB trips use service_id + calendar.txt)
    pub day_types: Option<HashSet<String>>,
    /// GZM only: the Warsaw dates the trip runs on (checked before day_types and calendar.txt; empty = never)
    pub dates: Option<Arc<HashSet<String>>>,
    /// GZM only: per call gtfs_csv pickup bits; NO_PICKUP / NO_DROP_OFF calls are not boarded / alighted
    pub flags: Option<Arc<[u8]>>,
    /// stop numbers (RouterIndex::stop_ids) in stop order, shared like stop_ids; trips with the same `pattern`
    /// share RAPTOR routes
    pub nums: Arc<[u32]>,
    pub pattern: u32,
}

pub struct RouterStopInput {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// name the poles are grouped and searched by, when it differs from `name` (GZM drops the post number)
    pub key: Option<String>,
}

pub struct RouterInput {
    /// in numbering order
    pub stops: Vec<RouterStopInput>,
    pub trips: IndexMap<String, TripEntry>,
    pub services: HashMap<String, [u8; 7]>,
    pub mzk_day_types: HashMap<String, String>,
}

struct Footpath {
    to: u32,
    secs: i32,
}

/// Trips of one service day with the same stop sequence, none overtaking another (RAPTOR needs FIFO).
struct Route {
    stops: Arc<[u32]>,
    /// indices into RouterIndex::trips
    trips: Vec<u32>,
    /// [trip * stops.len() + position], secs from the searched date's midnight
    arr: Vec<i32>,
    dep: Vec<i32>,
    /// the pattern's blocking pickup bits (part of the pattern key), None when every call is open
    flags: Option<Arc<[u8]>>,
    /// per trip, the live delay (s) already in arr / dep; None = timetable times
    delays: Option<Vec<Option<i32>>>,
}

impl Route {
    fn blocks(&self, p: usize, bit: u8) -> bool {
        self.flags.as_ref().is_some_and(|f| f[p] & bit != 0)
    }
}

struct DayTable {
    routes: Vec<Arc<Route>>,
    /// per stop number: (route, position)
    at: Vec<Arc<Vec<(u32, u32)>>>,
}

pub struct RouterIndex {
    pub stops: IndexMap<String, StopEntry>,
    pub poles_by_name: HashMap<String, IndexSet<String>>,
    pub poles_by_clean_key: IndexMap<String, IndexSet<String>>,
    /// stop number -> router stop id
    pub stop_ids: Vec<String>,
    pub stop_num: HashMap<String, u32>,
    /// walkable poles per stop number
    foot: Vec<Vec<Footpath>>,
    /// an MZK course whose calls differ between day types has one entry per variant (`<id>#<n>`)
    pub trips: IndexMap<String, TripEntry>,
    pub services: HashMap<String, [u8; 7]>,
    /// Warsaw ISO date -> MZK day type, for the dates the MZK timetable covers
    pub mzk_day_types: HashMap<String, String>,
    /// route tables of the last searched dates (bounded by DAY_CACHE)
    days: Mutex<IndexMap<String, Arc<DayTable>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

static CACHE: Mutex<Option<Arc<RouterIndex>>> = Mutex::new(None);

/// Drops the cached KB + MZK index (after a feed rebuild).
pub fn invalidate_router() {
    *lock(&CACHE) = None;
}

/// The KB + MZK index from `KB_GTFS_DIR` and `KB_MZK_TIMETABLE_FILE`, loaded on first use and cached while it holds
/// trips and stops. None while the feed is missing.
pub fn get_index() -> Option<Arc<RouterIndex>> {
    let mut cache = lock(&CACHE);
    if let Some(idx) = cache.as_ref() {
        return Some(idx.clone());
    }
    let idx = Arc::new(load_index_from(
        Path::new(crate::config::GTFS_DIR.as_str()),
        Path::new(crate::config::MZK_TIMETABLE_FILE.as_str()),
    )?);
    if !idx.trips.is_empty() && !idx.stops.is_empty() {
        *cache = Some(idx.clone());
    }
    Some(idx)
}

/// Text folded for resilient matching: lowercase, no diacritics (ł too), punctuation as spaces, single-character
/// words glued ("d a" -> "da"), whitespace collapsed.
pub fn clean_text(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let gc = CodePointMapData::<GeneralCategory>::new();
    let mut spaced: Vec<char> = Vec::with_capacity(s.len());
    for c in fold_text(s).chars() {
        let g = gc.get(c);
        if GeneralCategoryGroup::Letter.contains(g) || GeneralCategoryGroup::Number.contains(g) {
            spaced.push(c);
        } else if spaced.last() != Some(&' ') || spaced.is_empty() {
            spaced.push(' ');
        }
    }
    // /\b([a-z0-9])\s+([a-z0-9])\b/g -> "$1$2": \b and \w are ASCII, matches never overlap
    let c = spaced;
    let word = |i: usize| c.get(i).is_some_and(|ch| ch.is_ascii_alphanumeric() || *ch == '_');
    let small = |ch: char| ch.is_ascii_lowercase() || ch.is_ascii_digit();
    let mut glued = String::with_capacity(c.len());
    let mut i = 0;
    while i < c.len() {
        if small(c[i]) && (i == 0 || !word(i - 1)) {
            let mut j = i + 1;
            while j < c.len() && js::is_space(c[j]) {
                j += 1;
            }
            if j > i + 1 && j < c.len() && small(c[j]) && !word(j + 1) {
                glued.push(c[i]);
                glued.push(c[j]);
                i = j + 1;
                continue;
            }
        }
        glued.push(c[i]);
        i += 1;
    }
    glued
        .split(js::is_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_name(name: &str) -> String {
    name.trim_matches(js::is_space).to_lowercase()
}

fn parse_time_secs(hhmmss: &str) -> f64 {
    let mut parts = hhmmss.split(':').map(|p| {
        let v = js::number(p);
        if v.is_nan() { 0.0 } else { v }
    });
    let mut next = || parts.next().unwrap_or(0.0);
    next() * 3600.0 + next() * 60.0 + next()
}

fn format_hhmm(secs: i32) -> String {
    let w = secs.rem_euclid(86400);
    format!("{:02}:{:02}", w / 3600, w % 3600 / 60)
}

fn ymd(date: &str) -> Option<(i64, i64, i64)> {
    let b = date.as_bytes();
    let shape = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        });
    shape.then(|| {
        (
            date[..4].parse().unwrap(),
            date[5..7].parse().unwrap(),
            date[8..].parse().unwrap(),
        )
    })
}

/// `Date.UTC(y, m0, d)` in days since 1970-01-01: years 0-99 are 1900-1999, months and days overflow.
fn utc_days(y: i64, m0: i64, d: i64) -> i64 {
    let y = if (0..=99).contains(&y) { 1900 + y } else { y };
    let ym = y * 12 + m0;
    let (y, m) = (ym.div_euclid(12), ym.rem_euclid(12) + 1);
    // days_from_civil (H. Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468 + d - 1
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Weekday of a "YYYY-MM-DD" date, Monday = 0 (0 when the date is malformed).
pub fn weekday_monday0(date: &str) -> usize {
    ymd(date).map_or(0, |(y, m, d)| (utc_days(y, m - 1, d) + 3).rem_euclid(7) as usize)
}

/// A "YYYY-MM-DD" date moved by `days` (a malformed date comes back unchanged).
pub fn offset_date(date: &str, days: i32) -> String {
    let Some((y, m, d)) = ymd(date) else {
        return date.to_string();
    };
    let (y, m, d) = civil_from_days(utc_days(y, m - 1, d + i64::from(days)));
    format!("{y}-{m:02}-{d:02}")
}

fn approx_dist_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1) * 111_320.0;
    let d_lon = (lon2 - lon1) * 111_320.0 * (((lat1 + lat2) / 2.0) * (std::f64::consts::PI / 180.0)).cos();
    (d_lat * d_lat + d_lon * d_lon).sqrt()
}

/// Walk over a straight-line distance, whole minutes; poles of one shelter are 0.
fn foot_secs(d: f64) -> i32 {
    if d < SAME_STOP_M {
        0
    } else {
        60 * (d / WALK_MPS / 60.0).ceil().max(1.0) as i32
    }
}

/// JS truthiness of a coordinate.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

fn mins(secs: i32) -> i32 {
    js::round(f64::from(secs) / 60.0) as i32
}

/// Makes a trip's times non-decreasing: a drop of more than 12 h is a midnight wrap (+24 h), a smaller one is clamped.
fn monotonic(calls: &mut [TripStopEntry]) {
    let mut wrap = 0.0;
    let mut prev = f64::NEG_INFINITY;
    for s in calls {
        let mut arr = s.arr + wrap;
        if arr < prev - 43200.0 {
            wrap += 86400.0;
            arr += 86400.0;
        }
        s.arr = arr.max(prev);
        s.dep = (s.dep + wrap).max(s.arr);
        prev = s.dep;
    }
}

fn same_calls(a: &[TripStopEntry], b: &[TripStopEntry]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.stop_id == y.stop_id && x.dep == y.dep)
}

/// stop_ids / seqs by calls while one feed loads (GZM 2026-10-31: 3062 for 38799 trips)
pub type CallPool = HashMap<String, (Arc<[String]>, Arc<[i32]>)>;

/// Puts a trip's calls in as columns: sorted by seq, times non-decreasing (`monotonic`), stop_ids / seqs shared
/// through `pool`.
pub fn call_columns(trip: &mut TripEntry, mut calls: Vec<TripStopEntry>, pool: &mut CallPool) {
    // ponytail: total_cmp puts a NaN seq last where V8 leaves it anywhere; feeds carry integer sequences
    calls.sort_by(|a, b| a.seq.total_cmp(&b.seq));
    monotonic(&mut calls);
    let mut key = String::new();
    for c in &calls {
        key.push_str(&c.stop_id);
        key.push('\0');
        key.push_str(&c.seq.to_bits().to_string());
        key.push('\0');
    }
    let (stop_ids, seqs) = pool
        .entry(key)
        .or_insert_with(|| {
            (
                calls.iter().map(|c| c.stop_id.clone()).collect(),
                calls.iter().map(|c| js::to_int32(c.seq)).collect(),
            )
        })
        .clone();
    let dep: Arc<[i32]> = calls.iter().map(|c| js::to_int32(c.dep)).collect();
    trip.arr = if calls.iter().all(|c| c.arr == c.dep) {
        dep.clone()
    } else {
        calls.iter().map(|c| js::to_int32(c.arr)).collect()
    };
    trip.dep = dep;
    trip.stop_ids = stop_ids;
    trip.seqs = seqs;
}

/// `Number(f) || 0`
fn coord(f: &[String], i: Option<usize>) -> f64 {
    let v = field(f, i).map_or(f64::NAN, js::number);
    if v.is_nan() { 0.0 } else { v }
}

/// The KB GTFS feed in `dir` plus the MZK timetable in `mzk_file` (optional). None when a feed file is missing.
pub fn load_index_from(dir: &Path, mzk_file: &Path) -> Option<RouterIndex> {
    let stops_txt = read_text(&dir.join("stops.txt"))?;
    let trips_txt = read_text(&dir.join("trips.txt"))?;
    let times_txt = read_text(&dir.join("stop_times.txt"))?;

    let mut stops = Vec::new();
    let lines = split_lines(&stops_txt);
    let hdr = parse_csv_line(lines[0]);
    if let (Some(i_id), Some(i_name)) = (col(&hdr, "stop_id"), col(&hdr, "stop_name")) {
        let (i_lat, i_lon) = (col(&hdr, "stop_lat"), col(&hdr, "stop_lon"));
        for line in &lines[1..] {
            if line.is_empty() {
                continue;
            }
            let f = parse_csv_line(line);
            let (Some(id), Some(name)) = (field(&f, Some(i_id)), field(&f, Some(i_name))) else {
                continue;
            };
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let (lat, lon) = (coord(&f, i_lat), coord(&f, i_lon));
            stops.push(RouterStopInput {
                id: id.into(),
                name: name.into(),
                lat,
                lon,
                key: None,
            });
        }
    }

    // MZK stops join the same pole maps, so walking transfers to / from KB poles come for free
    let mzk = crate::mzk_timetable::load_mzk_timetable(mzk_file);
    if let Some(tt) = &mzk {
        for (sym, (name, lat, lon)) in &tt.stops {
            stops.push(RouterStopInput {
                id: format!("mzk:{sym}"),
                name: name.clone(),
                lat: *lat,
                lon: *lon,
                key: None,
            });
        }
    }

    // raw calls while loading: the MZK variants compare them (`same_calls`), then they become columns
    let mut trips: IndexMap<String, (TripEntry, Vec<TripStopEntry>)> = IndexMap::new();
    let lines = split_lines(&trips_txt);
    let hdr = parse_csv_line(lines[0]);
    if let Some(i_trip) = col(&hdr, "trip_id") {
        let i_service = col(&hdr, "service_id");
        let i_route = col(&hdr, "route_id");
        let i_headsign = col(&hdr, "trip_headsign");
        let i_short = col(&hdr, "trip_short_name");
        for line in &lines[1..] {
            if line.is_empty() {
                continue;
            }
            let f = parse_csv_line(line);
            let Some(trip_id) = field(&f, Some(i_trip)).filter(|t| !t.is_empty()) else {
                continue;
            };
            let route = i_route.map(|i| field(&f, Some(i)).unwrap_or(""));
            let short = field(&f, i_short).unwrap_or("");
            let route_line = route.map_or("", |r| r.strip_prefix("L_").unwrap_or(r));
            let line = [short, route_line].into_iter().find(|s| !s.is_empty()).unwrap_or("—");
            let entry = TripEntry {
                trip_id: trip_id.into(),
                service_id: field(&f, i_service).unwrap_or("").into(),
                route_id: route.unwrap_or("").into(),
                headsign: field(&f, i_headsign).unwrap_or("").into(),
                line: line.into(),
                ..TripEntry::default()
            };
            trips.insert(trip_id.into(), (entry, Vec::new()));
        }
    }

    let lines = split_lines(&times_txt);
    let hdr = parse_csv_line(lines[0]);
    if let (Some(i_trip), Some(i_stop), Some(i_dep)) =
        (col(&hdr, "trip_id"), col(&hdr, "stop_id"), col(&hdr, "departure_time"))
    {
        let (i_arr, i_seq) = (col(&hdr, "arrival_time"), col(&hdr, "stop_sequence"));
        for line in &lines[1..] {
            if line.is_empty() {
                continue;
            }
            let f = parse_csv_line(line);
            let Some((_, calls)) = field(&f, Some(i_trip)).and_then(|t| trips.get_mut(t)) else {
                continue;
            };
            let dep_str = field(&f, Some(i_dep)).unwrap_or("");
            let arr_str = match i_arr {
                Some(i) => field(&f, Some(i)).filter(|s| !s.is_empty()).unwrap_or(dep_str),
                None => dep_str,
            };
            let seq = match i_seq {
                Some(i) => field(&f, Some(i)).map_or(f64::NAN, js::number),
                None => calls.len() as f64,
            };
            calls.push(TripStopEntry {
                stop_id: field(&f, Some(i_stop)).unwrap_or("").into(),
                seq,
                arr: parse_time_secs(arr_str),
                dep: parse_time_secs(dep_str),
            });
        }
    }

    // one OnTime course id may run different calls on different day types: keep each variant
    if let Some(tt) = &mzk {
        for t in &tt.trips {
            let calls: Vec<TripStopEntry> = t
                .calls
                .iter()
                .enumerate()
                .map(|(seq, (sym, secs))| TripStopEntry {
                    stop_id: format!("mzk:{sym}"),
                    seq: seq as f64,
                    arr: *secs,
                    dep: *secs,
                })
                .collect();
            let mut key = t.id.clone();
            let mut v = 1;
            while trips.get(&key).is_some_and(|(_, known)| !same_calls(known, &calls)) {
                key = format!("{}#{v}", t.id);
                v += 1;
            }
            if let Some((known, _)) = trips.get_mut(&key) {
                if let Some(types) = &mut known.day_types {
                    types.insert(t.day_type.clone());
                }
                continue;
            }
            let entry = TripEntry {
                trip_id: t.id.clone(),
                service_id: format!("mzk:{}", t.day_type),
                route_id: format!("mzk:{}", t.line),
                headsign: t.headsign.clone(),
                line: t.line.clone(),
                day_types: Some(HashSet::from([t.day_type.clone()])),
                ..TripEntry::default()
            };
            trips.insert(key, (entry, calls));
        }
        crate::logger::info(
            "router",
            format!("MZK timetable: {} stops, {} courses", tt.stops.len(), tt.trips.len()),
        );
    }

    // calendar.txt is optional
    let mut services = HashMap::new();
    if let Some(cal) = read_text(&dir.join("calendar.txt")) {
        let lines = split_lines(&cal);
        let hdr = parse_csv_line(lines[0]);
        let days = [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        ]
        .map(|w| col(&hdr, w));
        if let Some(i_svc) = col(&hdr, "service_id") {
            for line in &lines[1..] {
                if line.is_empty() {
                    continue;
                }
                let f = parse_csv_line(line);
                let Some(id) = field(&f, Some(i_svc)).filter(|s| !s.is_empty()) else {
                    continue;
                };
                services.insert(id.to_string(), days.map(|i| u8::from(field(&f, i) == Some("1"))));
            }
        }
    }

    let mzk_day_types = mzk.map(|tt| tt.calendar.into_iter().collect()).unwrap_or_default();
    let mut pool = CallPool::new();
    let trips = trips
        .into_iter()
        .map(|(key, (mut trip, calls))| {
            call_columns(&mut trip, calls, &mut pool);
            (key, trip)
        })
        .collect();
    Some(build_router_index(RouterInput {
        stops,
        trips,
        services,
        mzk_day_types,
    }))
}

/// The calls a trip can't be boarded / alighted at (a first call's NO_DROP_OFF and a last call's NO_PICKUP block
/// nothing).
fn block_flags(trip: &TripEntry) -> Option<Arc<[u8]>> {
    let f = trip.flags.as_deref()?;
    let mut out: Option<Vec<u8>> = None;
    for (p, &x) in f.iter().enumerate() {
        let mut b = x & (NO_PICKUP | NO_DROP_OFF);
        if p == 0 {
            b &= !NO_DROP_OFF;
        }
        if p == f.len() - 1 {
            b &= !NO_PICKUP;
        }
        if b != 0 {
            out.get_or_insert_with(|| vec![0; f.len()])[p] = b;
        }
    }
    out.map(Into::into)
}

/// Pole maps, stop numbers, trip patterns and walking transfers over the given stops and trips (calls from
/// `call_columns`). Numbers every trip (`nums`, `pattern`).
pub fn build_router_index(input: RouterInput) -> RouterIndex {
    let mut stops: IndexMap<String, StopEntry> = IndexMap::new();
    let mut poles_by_name: HashMap<String, IndexSet<String>> = HashMap::new();
    let mut poles_by_clean_key: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for s in input.stops {
        let key = s.key.as_deref().unwrap_or(&s.name);
        let name_key = normalize_name(key);
        let clean_key = clean_text(key);
        poles_by_name.entry(name_key.clone()).or_default().insert(s.id.clone());
        poles_by_clean_key
            .entry(clean_key.clone())
            .or_default()
            .insert(s.id.clone());
        stops.insert(
            s.id.clone(),
            StopEntry {
                id: s.id,
                name: s.name,
                name_key,
                clean_key,
                lat: s.lat,
                lon: s.lon,
            },
        );
    }

    let mut trips = input.trips;
    let mut stop_ids: Vec<String> = stops.keys().cloned().collect();
    let mut stop_num: HashMap<String, u32> = stop_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), i as u32))
        .collect();
    // trips with the same calls share one stop_ids slice, so one nums; equal patterns are one id
    let mut nums_of: HashMap<*const String, Arc<[u32]>> = HashMap::new();
    let mut patterns: HashMap<String, u32> = HashMap::new();
    for trip in trips.values_mut() {
        let nums = nums_of
            .entry(trip.stop_ids.as_ptr())
            .or_insert_with(|| {
                trip.stop_ids
                    .iter()
                    .map(|id| {
                        *stop_num.entry(id.clone()).or_insert_with(|| {
                            stop_ids.push(id.clone());
                            stop_ids.len() as u32 - 1
                        })
                    })
                    .collect()
            })
            .clone();
        let mut key = nums.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        if let Some(blocks) = block_flags(trip) {
            key.push('|');
            key.extend(blocks.iter().map(u8::to_string));
        }
        let next = patterns.len() as u32;
        trip.pattern = *patterns.entry(key).or_insert(next);
        trip.nums = nums;
    }

    // walking transfers: poles bucketed on a grid of WALK_MAX_M cells, each pole's list in stop-number order
    let mut foot: Vec<Vec<Footpath>> = stop_ids.iter().map(|_| Vec::new()).collect();
    let located: Vec<(usize, f64, f64)> = stop_ids
        .iter()
        .enumerate()
        .filter_map(|(i, id)| {
            stops
                .get(id)
                .filter(|s| truthy(s.lat) && truthy(s.lon))
                .map(|s| (i, s.lat, s.lon))
        })
        .collect();
    let cell_lat = WALK_MAX_M / 111_320.0;
    // a degree of longitude is shortest at the highest latitude, so cells sized there hold every pair
    let max_lat = located.iter().fold(0.0, |m: f64, p| m.max(p.1.abs()));
    let cell_lon = cell_lat / (max_lat * (std::f64::consts::PI / 180.0)).cos();
    let cell_of = |lat: f64, lon: f64| ((lat / cell_lat).floor() as i64, (lon / cell_lon).floor() as i64);
    let mut cells: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (a, p) in located.iter().enumerate() {
        cells.entry(cell_of(p.1, p.2)).or_default().push(a);
    }
    for (a, &(pi, plat, plon)) in located.iter().enumerate() {
        let (y, x) = cell_of(plat, plon);
        let mut near: Vec<usize> = Vec::new();
        for dy in -1..=1 {
            for dx in -1..=1 {
                if let Some(c) = cells.get(&(y + dy, x + dx)) {
                    near.extend(c.iter().filter(|&&b| b > a));
                }
            }
        }
        near.sort_unstable();
        for b in near {
            let (qi, qlat, qlon) = located[b];
            let d = approx_dist_meters(plat, plon, qlat, qlon);
            if d > WALK_MAX_M {
                continue;
            }
            let secs = foot_secs(d);
            foot[pi].push(Footpath { to: qi as u32, secs });
            foot[qi].push(Footpath { to: pi as u32, secs });
        }
    }

    RouterIndex {
        stops,
        poles_by_name,
        poles_by_clean_key,
        stop_ids,
        stop_num,
        foot,
        trips,
        services: input.services,
        mzk_day_types: input.mzk_day_types,
        days: Mutex::new(IndexMap::new()),
    }
}

impl RouterIndex {
    fn trip(&self, i: u32) -> &TripEntry {
        &self.trips[i as usize]
    }

    /// The poles a stop query names: a stop id's poles, else the name matched ever more loosely.
    pub fn resolve_poles(&self, input: &str) -> IndexSet<String> {
        let trimmed = input.trim_matches(js::is_space);
        if trimmed.is_empty() {
            return IndexSet::new();
        }
        if let Some(by_id) = self.stops.get(trimmed) {
            return self
                .poles_by_clean_key
                .get(&by_id.clean_key)
                .or_else(|| self.poles_by_name.get(&by_id.name_key))
                .cloned()
                .unwrap_or_else(|| IndexSet::from([trimmed.to_string()]));
        }
        if let Some(poles) = self
            .poles_by_name
            .get(&normalize_name(trimmed))
            .filter(|p| !p.is_empty())
        {
            return poles.clone();
        }
        let clean = clean_text(trimmed);
        // only punctuation: "" would match every key below
        if clean.is_empty() {
            return IndexSet::new();
        }
        if let Some(poles) = self.poles_by_clean_key.get(&clean).filter(|p| !p.is_empty()) {
            return poles.clone();
        }
        let followed = |s: &str, prefix: &str| s.strip_prefix(prefix).is_some_and(|r| r.starts_with(' '));
        // "KĘTY, D.A. UL. SIENKIEWICZA" -> "kety da"
        if let Some((_, poles)) = self.poles_by_clean_key.iter().find(|(k, _)| followed(&clean, k)) {
            return poles.clone();
        }
        // hub suffixes: "Kęty" -> "Kęty D.A.", "Kęty Centrum"
        for suffix in [" d.a.", " da", " centrum", " dworzec"] {
            if let Some(poles) = self.poles_by_clean_key.get(&clean_text(&format!("{clean}{suffix}"))) {
                return poles.clone();
            }
        }
        let mut combined = IndexSet::new();
        for (k, poles) in &self.poles_by_clean_key {
            if *k == clean || followed(k, &clean) {
                combined.extend(poles.iter().cloned());
            }
        }
        // a 1-2 letter fragment would match half the network as a substring
        if !combined.is_empty() || clean.encode_utf16().count() < 3 {
            return combined;
        }
        for (k, poles) in &self.poles_by_clean_key {
            if k.contains(&clean) {
                combined.extend(poles.iter().cloned());
            }
        }
        combined
    }

    /// Union of the poles of the given stop ids; falls back to resolving `input` by name when none is known.
    pub fn resolve_query_poles(&self, ids: &[String], input: &str) -> IndexSet<String> {
        let mut poles = IndexSet::new();
        for id in ids {
            if self.stops.contains_key(id) {
                poles.extend(self.resolve_poles(id));
            }
        }
        if poles.is_empty() {
            self.resolve_poles(input)
        } else {
            poles
        }
    }

    /// The walking transfers of a pole as (stop number, secs), in stop-number order.
    pub fn foot_of(&self, stop: u32) -> impl Iterator<Item = (u32, i32)> + '_ {
        self.foot[stop as usize].iter().map(|f| (f.to, f.secs))
    }
}

/// A pole a search starts (or ends) at and the walk between it and the query point (0 for a stop).
#[derive(Clone, Copy)]
struct Origin {
    stop: u32,
    walk: i32,
}

/// The nearest ACCESS_MAX_POLES poles within the walk radius of a point, each with its walk. O(poles) per query.
fn access_poles(idx: &RouterIndex, at: Point) -> Vec<Origin> {
    let max_m = at.walk_m.unwrap_or(ACCESS_MAX_M);
    let mut near: Vec<(u32, f64)> = idx
        .stop_ids
        .iter()
        .enumerate()
        .filter_map(|(stop, id)| {
            let s = idx.stops.get(id).filter(|s| truthy(s.lat) && truthy(s.lon))?;
            let d = approx_dist_meters(at.lat, at.lon, s.lat, s.lon);
            (d <= max_m).then_some((stop as u32, d))
        })
        .collect();
    near.sort_by(|a, b| a.1.total_cmp(&b.1));
    near.truncate(ACCESS_MAX_POLES);
    near.into_iter()
        .map(|(stop, d)| Origin {
            stop,
            walk: foot_secs(d),
        })
        .collect()
}

/// The poles of a stop query, no walk.
fn stop_origins(idx: &RouterIndex, ids: &[String], input: &str) -> Vec<Origin> {
    idx.resolve_query_poles(ids, input)
        .iter()
        .filter_map(|id| idx.stop_num.get(id).map(|&stop| Origin { stop, walk: 0 }))
        .collect()
}

/// `date` is the trip's service day (Warsaw ISO), `wd` its weekday (Monday = 0).
fn is_trip_active_on_day(trip: &TripEntry, wd: usize, date: &str, idx: &RouterIndex) -> bool {
    if let Some(dates) = &trip.dates {
        return dates.contains(date);
    }
    if let Some(types) = &trip.day_types {
        return idx.mzk_day_types.get(date).is_some_and(|t| types.contains(t));
    }
    if idx.services.len() <= 1 {
        return true;
    }
    idx.services.get(&trip.service_id).is_none_or(|days| days[wd] == 1)
}

fn build_leg_stops(trip: &TripEntry, start: usize, end: usize, idx: &RouterIndex, base: i32) -> Vec<ConnectionLegStop> {
    let dep0 = trip.dep[start];
    let after = |t: i32| if t < dep0 { t + 86400 } else { t } - dep0;
    (start..=end)
        .map(|s| {
            let stop_id = &trip.stop_ids[s];
            let e = idx.stops.get(stop_id);
            let off_arr = if s == start { 0 } else { after(trip.arr[s]) };
            ConnectionLegStop {
                stop_id: stop_id.clone(),
                stop_name: e
                    .map(|e| e.name.as_str())
                    .filter(|n| !n.is_empty())
                    .unwrap_or(stop_id)
                    .to_string(),
                arrival_time: format_hhmm(base + off_arr),
                departure_time: format_hhmm(base + after(trip.dep[s])),
                lat: e.map(|e| JsNum(e.lat)),
                lon: e.map(|e| JsNum(e.lon)),
            }
        })
        .collect()
}

/// A trip on a searched day: (index into RouterIndex::trips, its offset from the day: -24 h, 0 or +24 h).
type Instance = (u32, i32);

fn overtakes(idx: &RouterIndex, a: Instance, b: Instance) -> bool {
    let (x, y) = (idx.trip(a.0), idx.trip(b.0));
    (0..x.dep.len()).any(|p| x.dep[p] + a.1 < y.dep[p] + b.1 || x.arr[p] + a.1 < y.arr[p] + b.1)
}

/// The FIFO routes of every trip instance that can matter on `date`: the day's own trips, the previous day's
/// trips still running after midnight (-24 h) and the next day's trips (+24 h).
// ponytail: one lock for the cache, held while a missing day builds (15-45 ms); per-date slots if searches queue on it
fn day_table(idx: &RouterIndex, date: &str) -> Arc<DayTable> {
    let mut days = lock(&idx.days);
    if let Some(hit) = days.get(date) {
        return hit.clone();
    }
    let mut groups: IndexMap<u32, Vec<Instance>> = IndexMap::new();
    for o in -1..=1 {
        let d = offset_date(date, o);
        let wd = weekday_monday0(&d);
        for (i, trip) in idx.trips.values().enumerate() {
            let n = trip.arr.len();
            if n < 2 || (o < 0 && trip.arr[n - 1] < 86400) || !is_trip_active_on_day(trip, wd, &d, idx) {
                continue;
            }
            groups.entry(trip.pattern).or_default().push((i as u32, o * 86400));
        }
    }
    let mut routes = Vec::new();
    let mut at: Vec<Vec<(u32, u32)>> = vec![Vec::new(); idx.stop_ids.len()];
    for g in groups.values_mut() {
        g.sort_by_key(|&(t, off)| idx.trip(t).dep[0] + off);
        let mut split: Vec<Vec<Instance>> = Vec::new();
        for &inst in g.iter() {
            match split.iter_mut().find(|s| !overtakes(idx, inst, s[s.len() - 1])) {
                Some(s) => s.push(inst),
                None => split.push(vec![inst]),
            }
        }
        for s in split {
            let first = idx.trip(s[0].0);
            let len = first.nums.len();
            let (mut arr, mut dep) = (Vec::with_capacity(s.len() * len), Vec::with_capacity(s.len() * len));
            for &(t, off) in &s {
                let trip = idx.trip(t);
                arr.extend(trip.arr.iter().map(|a| a + off));
                dep.extend(trip.dep.iter().map(|d| d + off));
            }
            let r = routes.len() as u32;
            for (p, &st) in first.nums.iter().enumerate() {
                at[st as usize].push((r, p as u32));
            }
            routes.push(Arc::new(Route {
                stops: first.nums.clone(),
                trips: s.iter().map(|x| x.0).collect(),
                arr,
                dep,
                flags: block_flags(first),
                delays: None,
            }));
        }
    }
    let table = Arc::new(DayTable {
        routes,
        at: at.into_iter().map(Arc::new).collect(),
    });
    if days.len() >= DAY_CACHE {
        days.shift_remove_index(0);
    }
    days.insert(date.to_string(), table.clone());
    table
}

pub struct StopEvent<'a> {
    pub trip: &'a TripEntry,
    /// call index in trip
    pub pos: usize,
    /// secs from `date`'s midnight, like every router time
    pub arr: i32,
    pub dep: i32,
    /// the trip's own service day (the previous day's trips run on at -24 h, the next day's at +24 h)
    pub service_date: String,
}

/// Boardable calls at the given poles that depart in [from, to) secs of `date`, earliest first. A trip's last call
/// and NO_PICKUP calls are no departures. Secs assume 24 h days, so the window edges slip an hour on a DST day.
pub fn stop_events<'a, S: AsRef<str>>(
    idx: &'a RouterIndex,
    pole_ids: impl IntoIterator<Item = S>,
    date: &str,
    from: i32,
    to: i32,
    limit: Option<usize>,
) -> Vec<StopEvent<'a>> {
    let table = day_table(idx, date);
    let mut out = Vec::new();
    for id in pole_ids {
        let Some(&n) = idx.stop_num.get(id.as_ref()) else {
            continue;
        };
        for &(r, p) in table.at[n as usize].iter() {
            let route = &table.routes[r as usize];
            let (p, len) = (p as usize, route.stops.len());
            if p == len - 1 || route.blocks(p, NO_PICKUP) {
                continue;
            }
            for (t, &ti) in route.trips.iter().enumerate() {
                let dep = route.dep[t * len + p];
                if dep < from || dep >= to {
                    continue;
                }
                let trip = idx.trip(ti);
                let days = js::round(f64::from(dep - trip.dep[p]) / 86400.0) as i32;
                out.push(StopEvent {
                    trip,
                    pos: p,
                    arr: route.arr[t * len + p],
                    dep,
                    service_date: offset_date(date, days),
                });
            }
        }
    }
    out.sort_by_key(|e| e.dep);
    if let Some(limit) = limit {
        out.truncate(limit);
    }
    out
}

#[derive(Serialize)]
pub struct LineStop {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<JsNum>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineVariant {
    /// the busiest pattern's first trip (router id), for the route handler's shape lookup
    pub trip_id: String,
    pub headsign: String,
    pub stops: Vec<LineStop>,
    /// per trip, by first departure: the departure at each stop in minutes from the date's midnight (past 1440
    /// after midnight)
    pub times: Vec<Vec<i32>>,
}

/// The line view: each stop pattern `line` of `operator` ("KB" | "MZK" | "GZM") runs on `date` (most trips first)
/// with every trip's times. None without an index.
pub fn line_timetable(line: &str, operator: &str, date: &str, idx: Option<&RouterIndex>) -> Option<Vec<LineVariant>> {
    let idx = idx?;
    let wd = weekday_monday0(date);
    // "GZM" = a zbiorkom city's own index (every trip in it, whatever its slug prefix)
    let keep = |id: &str| match operator {
        "GZM" => true,
        "MZK" => id.starts_with("mzk:"),
        _ => !(id.starts_with("mzk:") || id.starts_with("gzm:")),
    };
    let mut groups: IndexMap<&[u32], Vec<&TripEntry>> = IndexMap::new();
    for trip in idx.trips.values() {
        if trip.line != line || trip.stop_ids.len() < 2 || !keep(&trip.trip_id) {
            continue;
        }
        if is_trip_active_on_day(trip, wd, date, idx) {
            groups.entry(&trip.nums).or_default().push(trip);
        }
    }
    let mut groups: Vec<Vec<&TripEntry>> = groups.into_values().collect();
    groups.sort_by_key(|g| Reverse(g.len()));
    groups.truncate(MAX_VARIANTS);
    Some(
        groups
            .into_iter()
            .map(|mut trips| {
                trips.sort_by_key(|t| t.dep[0]);
                let first = trips[0];
                LineVariant {
                    trip_id: first.trip_id.clone(),
                    headsign: first.headsign.clone(),
                    stops: first
                        .stop_ids
                        .iter()
                        .map(|id| {
                            let e = idx.stops.get(id);
                            LineStop {
                                id: id.clone(),
                                name: e
                                    .map(|e| e.name.as_str())
                                    .filter(|n| !n.is_empty())
                                    .unwrap_or(id)
                                    .to_string(),
                                lat: e.map(|e| JsNum(e.lat)),
                                lon: e.map(|e| JsNum(e.lon)),
                            }
                        })
                        .collect(),
                    times: trips.iter().map(|t| t.dep.iter().map(|&d| mins(d)).collect()).collect(),
                }
            })
            .collect(),
    )
}

/// The day table without the trips of avoided lines / routes, and with running trips at their live times. A late
/// trip stays in its route while the route stays FIFO; one that would overtake (or be overtaken by) its neighbour
/// moves into a one-trip route of its own (boarding binary-searches a route's departures).
// ponytail: O(trip instances of the day) per search (GZM 2026-10-31, 970 running: +~40 ms on ~230 ms); cache per
// live snapshot if searches pile up
fn adjust_table(
    idx: &RouterIndex,
    table: &Arc<DayTable>,
    date: &str,
    q: &RouteQuery,
    live: Option<&LiveFn<'_>>,
) -> Arc<DayTable> {
    let lines: HashSet<&str> = q.avoid_lines.iter().map(String::as_str).collect();
    let route_ids: HashSet<&str> = q.avoid_routes.iter().map(String::as_str).collect();
    if lines.is_empty() && route_ids.is_empty() && live.is_none() {
        return table.clone();
    }
    let dates = [offset_date(date, -1), date.to_string(), offset_date(date, 1)];
    let mut routes = table.routes.clone();
    // copy on write: Arc::make_mut clones a stop's list the first time a one-trip route joins it
    let mut at = table.at.clone();
    for (r, route) in table.routes.iter().enumerate() {
        let len = route.stops.len();
        let mut keep: Option<Vec<usize>> = None;
        let mut shift: Vec<Option<i32>> = vec![None; route.trips.len()];
        for (t, &ti) in route.trips.iter().enumerate() {
            let trip = idx.trip(ti);
            if lines.contains(trip.line.as_str()) || route_ids.contains(trip.route_id.as_str()) {
                keep.get_or_insert_with(|| (0..t).collect());
                continue;
            }
            let off = route.dep[t * len] - trip.dep[0];
            let delay = live.and_then(|f| f(&trip.trip_id, &dates[(1 + off / 86400) as usize]));
            if delay.is_some() {
                keep.get_or_insert_with(|| (0..t).collect());
                shift[t] = delay;
            }
            if let Some(k) = &mut keep {
                k.push(t);
            }
        }
        let Some(keep) = keep else { continue };
        // b runs no earlier than a at every call (timetable trips are FIFO among themselves)
        let fifo = |a: usize, b: usize| {
            let (da, db) = (shift[a].unwrap_or(0), shift[b].unwrap_or(0));
            (0..len).all(|p| {
                route.dep[b * len + p] + db >= route.dep[a * len + p] + da
                    && route.arr[b * len + p] + db >= route.arr[a * len + p] + da
            })
        };
        let mut stay: Vec<usize> = Vec::new();
        let mut solo: Vec<usize> = Vec::new();
        'next: for &t in &keep {
            while let Some(&top) = stay.last() {
                if fifo(top, t) {
                    break;
                }
                if shift[t].is_some() {
                    solo.push(t);
                    continue 'next;
                }
                solo.push(top);
                stay.pop();
            }
            stay.push(t);
        }
        let build = |ts: &[usize]| {
            let (mut arr, mut dep) = (Vec::with_capacity(ts.len() * len), Vec::with_capacity(ts.len() * len));
            for &t in ts {
                let s = shift[t].unwrap_or(0);
                arr.extend(route.arr[t * len..(t + 1) * len].iter().map(|a| a + s));
                dep.extend(route.dep[t * len..(t + 1) * len].iter().map(|d| d + s));
            }
            Arc::new(Route {
                stops: route.stops.clone(),
                trips: ts.iter().map(|&t| route.trips[t]).collect(),
                arr,
                dep,
                flags: route.flags.clone(),
                delays: ts
                    .iter()
                    .any(|&t| shift[t].is_some())
                    .then(|| ts.iter().map(|&t| shift[t]).collect()),
            })
        };
        routes[r] = build(&stay);
        for &t in &solo {
            let nr = routes.len() as u32;
            routes.push(build(&[t]));
            for (p, &st) in route.stops.iter().enumerate() {
                Arc::make_mut(&mut at[st as usize]).push((nr, p as u32));
            }
        }
    }
    Arc::new(DayTable { routes, at })
}

#[derive(Clone, Copy)]
struct Ride {
    route: u32,
    trip: u32,
    board: u32,
    alight: u32,
    /// walk from the previous ride's alighting pole to `board` (0 = same pole or stop); on the first ride, the walk
    /// from the query point
    walk_secs: i32,
}

/// Range RAPTOR state; per round k (journeys with exactly k rides) the arrays hold [k * n + stop].
struct Raptor<'a> {
    idx: &'a RouterIndex,
    table: &'a DayTable,
    origins: &'a [Origin],
    egress: &'a [i32],
    rides: usize,
    change: i32,
    walk_x: i32,
    n: usize,
    /// arrival by ride, ready-to-board after a transfer, and parents
    arr: Vec<i32>,
    rdy: Vec<i32>,
    p_route: Vec<u32>,
    p_trip: Vec<u32>,
    p_board: Vec<u32>,
    p_alight: Vec<u32>,
    p_from: Vec<u32>,
    /// best arrival at the destination per round (a target pole's arrival plus its egress walk), never past the cap
    tgt: Vec<i32>,
    tgt_stop: Vec<u32>,
    q_pos: Vec<i32>,
    is_marked: Vec<bool>,
    is_arrived: Vec<bool>,
    /// running minima the rounds compare against: min_arr[k][s] = min arr[1..k][s], min_rdy[k][s] = min rdy[0..k][s]
    min_arr: Vec<i32>,
    min_rdy: Vec<i32>,
    found: Vec<Vec<Ride>>,
}

impl Raptor<'_> {
    fn set_arr(&mut self, k: usize, s: usize, a: i32) {
        self.arr[k * self.n + s] = a;
        for j in k..=self.rides {
            let m = &mut self.min_arr[j * self.n + s];
            *m = (*m).min(a);
        }
    }

    fn set_rdy(&mut self, k: usize, s: usize, v: i32) {
        self.rdy[k * self.n + s] = v;
        for j in k..=self.rides {
            let m = &mut self.min_rdy[j * self.n + s];
            *m = (*m).min(v);
        }
    }

    fn mark(&mut self, s: usize, marked: &mut Vec<usize>) {
        if !self.is_marked[s] {
            self.is_marked[s] = true;
            marked.push(s);
        }
    }

    fn walk_secs(&self, from: usize, to: usize) -> i32 {
        self.idx.foot[from]
            .iter()
            .find(|f| f.to as usize == to)
            .map_or(0, |f| f.secs)
    }

    fn reconstruct(&self, k: usize, s: usize) -> Vec<Ride> {
        let n = self.n;
        let mut out = Vec::new();
        let (mut round, mut stop) = (k, s);
        loop {
            let i = round * n + stop;
            let mut ride = Ride {
                route: self.p_route[i],
                trip: self.p_trip[i],
                board: self.p_board[i],
                alight: self.p_alight[i],
                walk_secs: 0,
            };
            let route = &self.table.routes[ride.route as usize];
            let b = route.stops[ride.board as usize] as usize;
            let d = route.dep[ride.trip as usize * route.stops.len() + ride.board as usize];
            // the fewest rides that still made this boarding; labels only ever drop, so one always exists
            let mut j = 0;
            while j < round - 1 && self.rdy[j * n + b] > d {
                j += 1;
            }
            if j == 0 {
                // only origins carry a round-0 label
                ride.walk_secs = self.origins.iter().find(|o| o.stop as usize == b).map_or(0, |o| o.walk);
                out.push(ride);
                break;
            }
            let q = self.p_from[j * n + b] as usize;
            ride.walk_secs = if q == b { 0 } else { self.walk_secs(q, b) };
            out.push(ride);
            stop = q;
            round = j;
        }
        out.reverse();
        out
    }

    fn relax(&mut self, k: usize, q: usize, from: usize, v: i32, marked: &mut Vec<usize>) {
        if v >= self.tgt[k] || v >= self.min_rdy[k * self.n + q] {
            return;
        }
        self.set_rdy(k, q, v);
        self.p_from[k * self.n + q] = from as u32;
        self.mark(q, marked);
    }

    fn run(&mut self, tau: i32, collect: bool) {
        let (idx, table, n) = (self.idx, self.table, self.n);
        let mut marked: Vec<usize> = Vec::new();
        for o in self.origins {
            // runs go latest tau first, so this only ever lowers the label
            self.set_rdy(0, o.stop as usize, tau + o.walk);
            self.mark(o.stop as usize, &mut marked);
        }
        let mut improved = vec![false; self.rides + 1];
        let mut k = 1;
        while k <= self.rides && !marked.is_empty() {
            if self.tgt[k - 1] < self.tgt[k] {
                self.tgt[k] = self.tgt[k - 1];
            }
            let mut queue: Vec<usize> = Vec::new();
            for &s in &marked {
                self.is_marked[s] = false;
                for &(r, p) in table.at[s].iter() {
                    let (r, p) = (r as usize, p as i32);
                    if self.q_pos[r] < 0 {
                        self.q_pos[r] = p;
                        queue.push(r);
                    } else if p < self.q_pos[r] {
                        self.q_pos[r] = p;
                    }
                }
            }
            marked.clear();

            let mut arrived: Vec<usize> = Vec::new();
            for &r in &queue {
                let route = &table.routes[r];
                let (len, nt) = (route.stops.len(), route.trips.len());
                let mut t: Option<usize> = None;
                let mut bp = 0;
                for p in self.q_pos[r] as usize..len {
                    let s = route.stops[p] as usize;
                    if let Some(t) = t.filter(|_| !route.blocks(p, NO_DROP_OFF)) {
                        let a = route.arr[t * len + p];
                        if a < self.tgt[k] && a < self.min_arr[k * n + s] {
                            self.set_arr(k, s, a);
                            let i = k * n + s;
                            self.p_route[i] = r as u32;
                            self.p_trip[i] = t as u32;
                            self.p_board[i] = bp as u32;
                            self.p_alight[i] = p as u32;
                            if !self.is_arrived[s] {
                                self.is_arrived[s] = true;
                                arrived.push(s);
                            }
                            let e = self.egress[s];
                            if e >= 0 && a + e < self.tgt[k] {
                                self.tgt[k] = a + e;
                                self.tgt_stop[k] = s as u32;
                                improved[k] = true;
                            }
                        }
                    }
                    if p == len - 1 {
                        break;
                    }
                    if route.blocks(p, NO_PICKUP) {
                        continue;
                    }
                    let b = self.min_rdy[(k - 1) * n + s];
                    if b >= INF || t.is_some_and(|t| b > route.dep[t * len + p]) {
                        continue;
                    }
                    // earliest trip leaving p at or after b: FIFO keeps departures at p sorted by trip
                    let up_to = t.unwrap_or(nt);
                    let (mut lo, mut hi) = (0, up_to);
                    while lo < hi {
                        let mid = (lo + hi) / 2;
                        if route.dep[mid * len + p] < b {
                            lo = mid + 1
                        } else {
                            hi = mid
                        }
                    }
                    if lo < up_to {
                        t = Some(lo);
                        bp = p;
                    }
                }
                self.q_pos[r] = -1;
            }

            for &s in &arrived {
                self.is_arrived[s] = false;
                let a = self.arr[k * n + s];
                self.relax(k, s, s, a + self.change, &mut marked);
                for f in &idx.foot[s] {
                    let v = a + self.change.max(f.secs * self.walk_x + WALK_MARGIN_SECS);
                    self.relax(k, f.to as usize, s, v, &mut marked);
                }
            }
            k += 1;
        }
        for s in marked {
            self.is_marked[s] = false;
        }
        if collect {
            for (k, _) in improved.iter().enumerate().filter(|(_, i)| **i) {
                let rides = self.reconstruct(k, self.tgt_stop[k] as usize);
                self.found.push(rides);
            }
        }
    }
}

/// Range RAPTOR: every Pareto-optimal (departure, arrival, rides) journey from `origins` to a target pole that leaves
/// in [after, end). Departures are processed latest first with labels kept between them, so each one only reports
/// journeys that beat everything leaving later; `end` itself is a silent first run, so the window's last departures
/// are judged against the ones right after it. A departure is the time the rider leaves: a bus's departure at an
/// origin minus the walk to that origin.
#[allow(clippy::too_many_arguments)]
fn range_search(
    idx: &RouterIndex,
    table: &DayTable,
    origins: &[Origin],
    egress: &[i32],
    (after, end): (i32, i32),
    rides: usize,
    change: i32,
    probe: bool,
    cap: i32,
    walk_x: i32,
) -> Option<Vec<Vec<Ride>>> {
    let n = idx.stop_ids.len();
    let size = (rides + 1) * n;
    let mut st = Raptor {
        idx,
        table,
        origins,
        egress,
        rides,
        change,
        walk_x,
        n,
        arr: vec![INF; size],
        rdy: vec![INF; size],
        p_route: vec![0; size],
        p_trip: vec![0; size],
        p_board: vec![0; size],
        p_alight: vec![0; size],
        p_from: vec![0; size],
        tgt: vec![cap; rides + 1],
        tgt_stop: vec![0; rides + 1],
        q_pos: vec![-1; table.routes.len()],
        is_marked: vec![false; n],
        is_arrived: vec![false; n],
        min_arr: vec![INF; size],
        min_rdy: vec![INF; size],
        found: Vec::new(),
    };

    let mut departures: Vec<i32> = Vec::new();
    for o in origins {
        for &(r, p) in table.at[o.stop as usize].iter() {
            let route = &table.routes[r as usize];
            let (p, len) = (p as usize, route.stops.len());
            if p == len - 1 || route.blocks(p, NO_PICKUP) {
                continue;
            }
            for t in 0..route.trips.len() {
                let d = route.dep[t * len + p] - o.walk;
                if d >= after && d < end {
                    departures.push(d);
                }
            }
        }
    }
    departures.sort_unstable_by(|a, b| b.cmp(a));
    departures.dedup();
    if probe {
        // a journey leaving at any tau >= after can also leave at after (waiting at the origin), so a target the
        // earliest-arrival run from `after` misses is out of every window's reach: no need to scan 24 h for nothing
        st.run(after, false);
        if !st.tgt[1..].iter().any(|&t| t < cap) {
            return None;
        }
        for a in [&mut st.arr, &mut st.rdy, &mut st.min_arr, &mut st.min_rdy] {
            a.fill(INF);
        }
        st.tgt.fill(cap);
    }
    st.run(end, false);
    for tau in departures {
        st.run(tau, true);
    }
    Some(st.found)
}

fn to_itinerary(
    rides: &[Ride],
    egress: &[i32],
    idx: &RouterIndex,
    table: &DayTable,
    date: &str,
    day_label: Option<&str>,
    is_today: bool,
) -> ConnectionItinerary {
    let stop_name = |id: &str| {
        idx.stops
            .get(id)
            .map(|s| s.name.as_str())
            .filter(|n| !n.is_empty())
            .unwrap_or(id)
            .to_string()
    };
    let legs: Vec<ConnectionLeg> = rides
        .iter()
        .enumerate()
        .map(|(i, ride)| {
            let route = &table.routes[ride.route as usize];
            let t = ride.trip as usize;
            let trip = idx.trip(route.trips[t]);
            let len = route.stops.len();
            let (board, alight) = (ride.board as usize, ride.alight as usize);
            // timetable times on the wire (the client adds the bus's current delay); the search ran on the live ones
            let delay = route.delays.as_ref().and_then(|d| d[t]);
            let dep = route.dep[t * len + board] - delay.unwrap_or(0);
            let arr = route.arr[t * len + alight] - delay.unwrap_or(0);
            let (from_id, to_id) = (&trip.stop_ids[board], &trip.stop_ids[alight]);
            ConnectionLeg {
                line: trip.line.clone(),
                trip_id: trip.trip_id.clone(),
                headsign: trip.headsign.clone(),
                from_stop_id: from_id.clone(),
                from_stop_name: stop_name(from_id),
                to_stop_id: to_id.clone(),
                to_stop_name: stop_name(to_id),
                departure_time: format_hhmm(dep),
                arrival_time: format_hhmm(arr),
                departure_secs: dep,
                arrival_secs: arr,
                duration_mins: mins(arr - dep).max(1),
                stops_count: (alight - board) as i32,
                stops: build_leg_stops(trip, board, alight, idx, dep),
                walk_mins: (i > 0).then(|| mins(ride.walk_secs)),
                delay_sec: delay,
                operator: None,
                shape_id: None,
            }
        })
        .collect();

    let mut wait_secs = 0;
    let mut walk_minutes = 0;
    let mut transfers: Vec<String> = Vec::new();
    for pair in legs.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        wait_secs += b.departure_secs + b.delay_sec.unwrap_or(0) - a.arrival_secs - a.delay_sec.unwrap_or(0);
        let walk = b.walk_mins.unwrap_or(0);
        walk_minutes += walk;
        transfers.push(if walk == 0 {
            a.to_stop_name.clone()
        } else if a.to_stop_name == b.from_stop_name {
            format!("{} (pieszo {walk} min)", a.to_stop_name)
        } else {
            format!("{} → {} (pieszo {walk} min)", a.to_stop_name, b.from_stop_name)
        });
    }

    let (first, last) = (&legs[0], &legs[legs.len() - 1]);
    // from a point the journey starts when the rider leaves, the walk before the first bus; to a point it ends after the walk
    let access = rides[0].walk_secs;
    let dep_secs = first.departure_secs - access;
    let end = &rides[rides.len() - 1];
    let end_route = &table.routes[end.route as usize];
    let egress_secs = egress[end_route.stops[end.alight as usize] as usize].max(0);
    let arr_secs = last.arrival_secs + egress_secs;
    // secs stay relative to the searched date; a journey leaving after midnight belongs to the next day
    let day_off = dep_secs.div_euclid(86400);
    let dep_date = if day_off == 0 {
        date.to_string()
    } else {
        offset_date(date, day_off)
    };
    let day_label = match day_off {
        0 => day_label.map(str::to_string),
        1 if is_today => Some("Jutro".into()),
        _ => Some(PL_WEEKDAYS[weekday_monday0(&dep_date)].into()),
    };
    ConnectionItinerary {
        kind: if legs.len() == 1 { "direct" } else { "transfer" },
        departure_time: format_hhmm(dep_secs),
        arrival_time: format_hhmm(arr_secs),
        departure_secs: dep_secs,
        arrival_secs: arr_secs,
        total_duration_mins: mins(arr_secs - dep_secs).max(1),
        transfers_count: legs.len() as i32 - 1,
        transfer_wait_mins: (legs.len() > 1).then(|| mins(wait_secs)),
        transfer_stop_name: (!transfers.is_empty()).then(|| transfers.join(" / ")),
        walk_minutes: walk_minutes + mins(access) + mins(egress_secs),
        access_walk_mins: (access > 0).then(|| mins(access)),
        egress_walk_mins: (egress_secs > 0).then(|| mins(egress_secs)),
        date: dep_date,
        day_label,
        arrives_next_day: arr_secs.div_euclid(86400) > day_off,
        legs,
    }
}

struct Day<'a> {
    date: &'a str,
    label: Option<&'a str>,
    is_today: bool,
}

/// The Pareto set of one service day from `after`, over a window doubled until it holds `limit` journeys (24 h max).
/// Arrive-by: the window of departures ends at `after` and grows back, every arrival capped at it.
// ponytail: arrive-by stays on the day's table, a 05:00 arrival misses the previous day's after-midnight trips
fn search_day(
    q: &RouteQuery,
    idx: &RouterIndex,
    (origins, egress): (&[Origin], &[i32]),
    after: i32,
    day: Day,
    limit: usize,
) -> Vec<ConnectionItinerary> {
    // live times only on today's table: a fallback day's trips have not started
    let table = adjust_table(
        idx,
        &day_table(idx, day.date),
        day.date,
        q,
        q.live.filter(|_| day.is_today),
    );
    let rides = if q.direct_only { 1 } else { MAX_RIDES };
    let walk_x = if q.sort_by == SortBy::Walk { 3 } else { 1 };
    let change = q.min_transfer_secs.unwrap_or(DEFAULT_CHANGE_SECS);
    let back = q.arrive_by;
    let mut w = FIRST_WINDOW_SECS;
    loop {
        let span = w.min(86400);
        let start = if back { (after - span).max(0) } else { after };
        // a probe that misses the target: forward, nothing later reaches it either; arrive-by, an earlier start still may
        let runs = if back {
            range_search(
                idx,
                &table,
                origins,
                egress,
                (start, after),
                rides,
                change,
                true,
                after + 1,
                walk_x,
            )
        } else {
            let probe = w == FIRST_WINDOW_SECS;
            range_search(
                idx,
                &table,
                origins,
                egress,
                (after, after + span),
                rides,
                change,
                probe,
                INF,
                walk_x,
            )
        };
        if runs.is_none() && !back {
            return Vec::new();
        }
        let found: Vec<ConnectionItinerary> = runs
            .unwrap_or_default()
            .iter()
            .map(|r| to_itinerary(r, egress, idx, &table, day.date, day.label, day.is_today))
            .filter(|it| {
                it.legs.windows(2).all(|p| {
                    let wait = p[1].departure_secs + p[1].delay_sec.unwrap_or(0)
                        - p[0].arrival_secs
                        - p[0].delay_sec.unwrap_or(0);
                    q.max_transfer_secs.is_none_or(|m| wait <= m)
                })
            })
            .collect();
        if found.len() >= limit || span >= 86400 || (back && start == 0) {
            return found;
        }
        w *= 2;
    }
}

/// The Pareto-optimal connections (direct or with up to MAX_RIDES - 1 transfers, walking between nearby poles and
/// between operators) between two stops or points, leaving after or arriving by a time; `today` / `now_secs` are
/// the agency's clock.
pub fn find_connections_at(q: &RouteQuery, idx: &RouterIndex, today: &str, now_secs: i32) -> Vec<ConnectionItinerary> {
    let origins = match q.from_point {
        Some(p) => access_poles(idx, p),
        None => stop_origins(idx, q.from_ids, q.from),
    };
    let targets = match q.to_point {
        Some(p) => access_poles(idx, p),
        None => stop_origins(idx, q.to_ids, q.to),
    };
    if origins.is_empty() || targets.is_empty() {
        return Vec::new();
    }

    let date = q.date.filter(|d| !d.is_empty());
    let query_date = date.unwrap_or(today);
    let is_today = date.is_none_or(|d| d == today);
    // a future date without an explicit time starts at 00:00
    let after = q.after_secs.unwrap_or(if is_today { now_secs } else { 0 });
    let limit = q.limit.map_or(5, |l| l.clamp(1, 20)) as usize;

    // per pole: the walk from it to the destination, -1 = not a target
    let mut egress = vec![-1; idx.stop_ids.len()];
    for t in &targets {
        egress[t.stop as usize] = t.walk;
    }
    let ends = (origins.as_slice(), egress.as_slice());
    let today_day = Day {
        date: query_date,
        label: q.day_label,
        is_today,
    };
    let mut found = search_day(q, idx, ends, after, today_day, limit);

    // nothing within 24 h of today's query (a line that does not run tomorrow either): try the following days
    let mut offset = 1;
    while offset <= q.fallback_days.unwrap_or(3) && found.is_empty() && is_today && !q.arrive_by {
        let next = offset_date(query_date, offset as i32);
        let label = if offset == 1 {
            "Jutro"
        } else {
            PL_WEEKDAYS[weekday_monday0(&next)]
        };
        found = search_day(
            q,
            idx,
            ends,
            0,
            Day {
                date: &next,
                label: Some(label),
                is_today: false,
            },
            limit,
        );
        offset += 1;
    }
    // arrive-by keeps the latest-leaving journeys
    if q.arrive_by {
        found.sort_by_key(|it| Reverse(it.departure_secs));
        found.truncate(limit);
    }

    let by_departure = |it: &ConnectionItinerary| (it.departure_secs, it.arrival_secs, it.transfers_count);
    match q.sort_by {
        SortBy::Duration => found.sort_by_key(|it| (it.total_duration_mins, by_departure(it))),
        SortBy::Transfers => found.sort_by_key(|it| (it.transfers_count, by_departure(it))),
        SortBy::Walk => found.sort_by_key(|it| (it.walk_minutes, by_departure(it))),
        SortBy::Arrival => found.sort_by_key(|it| (it.arrival_secs, Reverse(it.departure_secs), it.transfers_count)),
        SortBy::Departure => found.sort_by_key(by_departure),
    }
    found.truncate(limit);
    found
}

/// `find_connections_at` on the agency's clock now; no index = no connections.
pub fn find_connections(q: &RouteQuery, idx: Option<&RouterIndex>) -> Vec<ConnectionItinerary> {
    idx.map_or_else(Vec::new, |idx| {
        find_connections_at(q, idx, &crate::time::today_local().to_string(), crate::time::now_secs())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_matches_the_js_regexes() {
        for (s, want) in [
            ("", ""),
            ("a b c", "ab c"),
            ("1 2 3 4", "12 34"),
            ("KĘTY, D.A.", "kety da"),
            ("Bielsko-Biała Dworzec", "bielsko biala dworzec"),
            ("  _x_ y  ", "xy"),
            ("ß a b", "ß ab"),
            ("ab c d", "ab cd"),
            ("Łódź—Kaliska", "lodz kaliska"),
            ("…", ""),
        ] {
            assert_eq!(clean_text(s), want, "{s:?}");
        }
    }

    #[test]
    fn dates_follow_date_utc() {
        assert_eq!(offset_date("2026-09-30", 1), "2026-10-01");
        assert_eq!(offset_date("2026-01-01", -1), "2025-12-31");
        assert_eq!(offset_date("2024-02-28", 1), "2024-02-29");
        assert_eq!(offset_date("0050-02-30", 0), "1950-03-02");
        assert_eq!(offset_date("2026-13-01", 0), "2027-01-01");
        assert_eq!(offset_date("2026-00-00", 0), "2025-11-30");
        assert_eq!(offset_date("9999-12-31", 3), "10000-01-03");
        assert_eq!(offset_date("2026-9-30", 1), "2026-9-30");
        assert_eq!(weekday_monday0("2026-09-30"), 2);
        assert_eq!(weekday_monday0("1970-01-01"), 3);
        assert_eq!(weekday_monday0("bad"), 0);
    }

    #[test]
    fn times_parse_and_print_like_js() {
        assert_eq!(parse_time_secs("25:10:00"), 90600.0);
        assert_eq!(parse_time_secs("x:5"), 300.0);
        assert_eq!(parse_time_secs(""), 0.0);
        assert_eq!(format_hhmm(90600), "01:10");
        assert_eq!(format_hhmm(-60), "23:59");
        assert_eq!(foot_secs(3.9), 0);
        assert_eq!(foot_secs(4.0), 60);
        assert_eq!(foot_secs(67.0), 120);
    }
}
