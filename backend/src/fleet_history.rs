//! The past days of a fleet tracker (lib/fleet-history.ts), kept compact in memory: per day one string table and
//! per vehicle one packed row of FIELDS ints per course (by scheduled start). Feeds the vehicle history
//! (/api/fleet/<side>/history) and, for MZK, the successor index of the next-course prediction: which course a
//! vehicle ran right after a given course on past days of the same kind.
//!
//! Filled from the day files at start (one file per step, read and parsed outside the owner's lock) and by the
//! tracker at every rollover with the day that just ended.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use jiff::Span;
use jiff::civil::{Date, Weekday};
use serde::Deserialize;
use serde_json::Value;

use crate::js;
use crate::logger;
use crate::mzk_timetable::{MzkDayCourse, MzkDaySchedule};
use crate::shared::fleet::{
    CourseStatus, FleetHistoryCourse, FleetHistoryDay, PredictionConfidence, PredictionSeen, PredictionSource,
    VehicleCourseRecord, fold_text,
};

const START: usize = 0;
const END: usize = 1;
const LINE: usize = 2;
const DIR: usize = 3;
const FIRST: usize = 4;
const FIRST_SYM: usize = 5;
const LAST: usize = 6;
const BRIG: usize = 7;
const DELAY: usize = 8;
const STATUS: usize = 9;
const DRIVEN: usize = 10;
const AT: usize = 11;
const FIELDS: usize = 12;

/// A course followed by one that starts later than this after its end is the vehicle's last before a break.
pub const MAX_GAP_SEC: i64 = 45 * 60;
/// The next course may start this much before the scheduled end of the previous one (a late arrival).
const OVERLAP_SEC: i64 = 5 * 60;
/// The shortest turnaround the timetable rule assumes after the expected arrival.
const MIN_TURN_SEC: f64 = 60.0;
const END_KEY: &str = "END";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayKind {
    Wd,
    Sat,
    Sun,
}

impl DayKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DayKind::Wd => "wd",
            DayKind::Sat => "sat",
            DayKind::Sun => "sun",
        }
    }

    /// genitive plural for `history_reason`
    fn gen_plural(self) -> &'static str {
        match self {
            DayKind::Wd => "dni roboczych",
            DayKind::Sat => "sobót",
            DayKind::Sun => "niedziel",
        }
    }
}

/// `Date.parse("<date>T00:00:00Z")` of a "YYYY-MM-DD" string as a civil date: V8 takes any day 1-31 and rolls it
/// over into the next month.
fn js_date(date: &str) -> Option<Date> {
    let (y, rest) = date.split_once('-')?;
    let (m, d) = rest.split_once('-')?;
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    if !(digits(y, 4) && digits(m, 2) && digits(d, 2)) {
        return None;
    }
    let (y, m, d): (i16, i8, i8) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    if !(1..=31).contains(&d) {
        return None;
    }
    Date::new(y, m, 1).ok()?.checked_add(Span::new().days(d - 1)).ok()
}

// ponytail: weekday only, a public holiday counts as its weekday; the successor must exist in today's
// timetable, which drops most of what that gets wrong. Upgrade: the MZK calendar's day type per date.
pub fn day_kind(date: &str) -> DayKind {
    match js_date(date).map(|d| d.weekday()) {
        Some(Weekday::Sunday) => DayKind::Sun,
        Some(Weekday::Saturday) => DayKind::Sat,
        _ => DayKind::Wd,
    }
}

/// A course the same on every day of its day type: the tracker's records and the MZK timetable share it.
pub fn course_key(line: &str, first_sym: Option<&str>, start: f64) -> String {
    format!("{line}|{}|{}", first_sym.unwrap_or(""), js::number_to_string(start))
}

/// `date` minus `days`; "" for a date V8 cannot parse (where the TS would throw), so nothing is cut off.
pub(crate) fn minus_days(date: &str, days: i64) -> String {
    js_date(date)
        .and_then(|d| d.checked_sub(Span::new().try_days(days).ok()?).ok())
        .map(|d| d.to_string())
        .unwrap_or_default()
}

struct PackedDay {
    date: String,
    kind: DayKind,
    str: Vec<String>,
    by_side: IndexMap<String, Vec<[i32; FIELDS]>>,
}

impl PackedDay {
    fn s(&self, i: i32) -> &str {
        usize::try_from(i)
            .ok()
            .and_then(|i| self.str.get(i))
            .map_or("", String::as_str)
    }

    fn key_at(&self, c: &[i32; FIELDS]) -> String {
        let first_sym = (c[FIRST_SYM] >= 0).then(|| self.s(c[FIRST_SYM]));
        course_key(self.s(c[LINE]), first_sym, f64::from(c[START]))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Successor {
    pub key: String,
    /// observations of this successor
    pub count: i64,
    /// observations of the course, every successor and the end of a run included
    pub total: i64,
}

/// Maps each course read from a day file (the tracker re-judges old "cancelled" ones).
pub type Normalize = fn(VehicleCourseRecord) -> VehicleCourseRecord;

/// The vehicles of one day file, in `Object.entries` order.
pub type DayEntries = Vec<(String, Vec<VehicleCourseRecord>)>;

pub struct FleetHistory {
    /// newest first
    days: Vec<PackedDay>,
    succ: HashMap<String, IndexMap<String, i64>>,
    succ_dirty: bool,
    loaded: bool,
    today: String,
    cutoff: String,
    keep_days: i64,
    successors: bool,
}

impl FleetHistory {
    /// keep_days = past days held; successors = build the successor index (MZK)
    pub fn new(keep_days: i64, successors: bool) -> Self {
        Self {
            days: Vec::new(),
            succ: HashMap::new(),
            succ_dirty: true,
            loaded: false,
            today: String::new(),
            cutoff: String::new(),
            keep_days,
            successors,
        }
    }

    /// Whether the day files have been read: until then the history is partial and no successor is known.
    pub fn complete(&self) -> bool {
        self.loaded
    }

    /// Days before `today` and within keep_days stay.
    pub fn set_today(&mut self, today: &str) {
        self.today = today.to_owned();
        self.cutoff = minus_days(today, self.keep_days);
        let before = self.days.len();
        let cutoff = &self.cutoff;
        self.days.retain(|d| d.date >= *cutoff && d.date.as_str() < today);
        if self.days.len() != before {
            self.succ_dirty = true;
        }
    }

    /// Adds a finished day (no-op for a date already held or out of range). Only finished and broken-off courses
    /// count.
    pub fn add_day<'a>(
        &mut self,
        date: &str,
        vehicles: impl IntoIterator<Item = (&'a str, &'a [VehicleCourseRecord])>,
    ) {
        if *date < *self.cutoff || *date >= *self.today || self.days.iter().any(|d| d.date == date) {
            return;
        }
        let mut str: Vec<String> = Vec::new();
        let mut ids: HashMap<&'a str, i32> = HashMap::new();
        let mut id = |s: Option<&'a str>| -> i32 {
            let Some(s) = s.filter(|s| !s.is_empty()) else {
                return -1;
            };
            *ids.entry(s).or_insert_with(|| {
                str.push(s.to_owned());
                (str.len() - 1) as i32
            })
        };
        let mut by_side = IndexMap::new();
        for (side, courses) in vehicles {
            let mut list: Vec<&VehicleCourseRecord> = courses
                .iter()
                .filter(|c| {
                    matches!(c.status, CourseStatus::Completed | CourseStatus::Cancelled)
                        // files written before 2026-10-04 carry invented "synth-*" courses: never real
                        && !c.id.starts_with("synth-")
                })
                .collect();
            list.sort_by_key(|c| c.start_secs);
            if list.is_empty() {
                continue;
            }
            let rows: Vec<[i32; FIELDS]> = list
                .into_iter()
                .map(|c| {
                    let mut r = [0; FIELDS];
                    r[START] = c.start_secs as i32;
                    r[END] = c.end_secs as i32;
                    r[LINE] = id(Some(&c.line_name));
                    r[DIR] = id(Some(&c.direction));
                    r[FIRST] = id(Some(&c.first_stop_name));
                    r[FIRST_SYM] = id(c.first_stop_symbol.as_deref());
                    r[LAST] = id(Some(&c.last_stop_name));
                    r[BRIG] = id(c.brigade.as_deref());
                    r[DELAY] = c.delay_sec as i32;
                    r[STATUS] = i32::from(c.status == CourseStatus::Cancelled);
                    r[DRIVEN] = js::to_int32(js::round(c.driven_meters.map_or(0.0, |m| m.0)));
                    r[AT] = id(c.cancelled_at_stop_name.as_deref());
                    r
                })
                .collect();
            by_side.insert(side.to_owned(), rows);
        }
        if by_side.is_empty() {
            return;
        }
        self.days.push(PackedDay {
            date: date.to_owned(),
            kind: day_kind(date),
            str,
            by_side,
        });
        self.days.sort_by(|x, y| y.date.cmp(&x.date));
        self.succ_dirty = true;
    }

    /// Reads the day files in `dir`, newest first, blocking (no runtime: the tracker's constructor), then marks
    /// the history complete.
    pub fn load_sync(&mut self, dir: &Path, normalize: Normalize) {
        for date in day_dates(dir, &self.cutoff, &self.today) {
            if let Some(entries) = read_day(dir, &date, normalize) {
                self.add_day(&date, entry_refs(&entries));
            }
        }
        self.loaded = true;
    }

    /// A vehicle's past days, newest first, its courses by scheduled start.
    pub fn vehicle_days(&self, side: &str) -> Vec<FleetHistoryDay> {
        let mut out = Vec::new();
        for d in &self.days {
            let Some(rows) = d.by_side.get(side) else {
                continue;
            };
            let courses = rows
                .iter()
                .map(|a| FleetHistoryCourse {
                    line_name: d.s(a[LINE]).to_owned(),
                    direction: d.s(a[DIR]).to_owned(),
                    first_stop_name: d.s(a[FIRST]).to_owned(),
                    last_stop_name: d.s(a[LAST]).to_owned(),
                    start_secs: a[START].into(),
                    end_secs: a[END].into(),
                    brigade: (a[BRIG] >= 0).then(|| d.s(a[BRIG]).to_owned()),
                    delay_sec: a[DELAY].into(),
                    status: if a[STATUS] == 1 {
                        CourseStatus::Cancelled
                    } else {
                        CourseStatus::Completed
                    },
                    driven_meters: a[DRIVEN].into(),
                    cancelled_at_stop_name: (a[AT] >= 0).then(|| d.s(a[AT]).to_owned()),
                })
                .collect();
            out.push(FleetHistoryDay {
                date: d.date.clone(),
                courses,
            });
        }
        out
    }

    /// The course most often run right after `key` on past days of `kind`; None before the files are read.
    pub fn successor(&mut self, kind: DayKind, key: &str) -> Option<Successor> {
        if !self.successors || !self.loaded {
            return None;
        }
        if self.succ_dirty {
            self.rebuild();
        }
        let m = self.succ.get(&format!("{}|{key}", kind.as_str()))?;
        let mut total = 0;
        let mut best: Option<(&String, i64)> = None;
        for (k, &n) in m {
            total += n;
            if k != END_KEY && best.is_none_or(|(_, c)| n > c) {
                best = Some((k, n));
            }
        }
        best.map(|(k, count)| Successor {
            key: k.clone(),
            count,
            total,
        })
    }

    /// O(courses held): MZK 28 days ~ 80 000 courses, tens of ms, once per day and after the load.
    fn rebuild(&mut self) {
        self.succ.clear();
        self.succ_dirty = false;
        for d in &self.days {
            for rows in d.by_side.values() {
                let mut it = rows.iter().peekable();
                while let Some(a) = it.next() {
                    let end = i64::from(a[END]);
                    let next = match it.peek() {
                        Some(n)
                            if i64::from(n[START]) - end <= MAX_GAP_SEC && i64::from(n[START]) >= end - OVERLAP_SEC =>
                        {
                            d.key_at(n)
                        }
                        _ => END_KEY.to_owned(),
                    };
                    let k = format!("{}|{}", d.kind.as_str(), d.key_at(a));
                    *self.succ.entry(k).or_default().entry(next).or_insert(0) += 1;
                }
            }
        }
    }
}

/// `entries` as the item list `add_day` takes.
pub fn entry_refs(entries: &DayEntries) -> impl Iterator<Item = (&str, &[VehicleCourseRecord])> {
    entries
        .iter()
        .map(|(side, courses)| (side.as_str(), courses.as_slice()))
}

/// One day file's vehicles (the TS load loop body): every `todayCourses` array of an entry whose key does not
/// start with "_", each course normalized; a course that is not a record is dropped. The error reads like the
/// TS `${err}` (`<class>: <message>`).
// ponytail: a syntax error keeps serde_json's message after "SyntaxError: ", not V8's wording.
pub fn parse_day(text: &str, normalize: Normalize) -> Result<DayEntries, String> {
    let parsed = crate::js::json_parse(text).map_err(|e| format!("SyntaxError: {e}"))?;
    let mut data: IndexMap<String, Value> = match parsed {
        Value::Object(m) => m.into_iter().collect(),
        Value::Array(a) => a.into_iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        Value::Null => return Err("TypeError: Cannot convert undefined or null to object".to_owned()),
        _ => IndexMap::new(),
    };
    js::sort_object_keys(&mut data);
    let mut out = Vec::new();
    for (side, mut raw) in data {
        if side.starts_with('_') {
            continue;
        }
        let Some(Value::Array(list)) = raw.get_mut("todayCourses").map(Value::take) else {
            continue;
        };
        let courses = list
            .into_iter()
            .filter_map(|c| VehicleCourseRecord::deserialize(past_course(c)).ok())
            .map(normalize)
            .collect();
        out.push((side, courses));
    }
    Ok(out)
}

/// A saved course with the record fields the history never needs filled in when missing or null, so it counts
/// whenever its status and start/end are fine, as in the TS (`id(undefined)` = none, `delaySec || 0`).
// ponytail: a field of the wrong type still drops the course where the TS coerces it, and a re-judged "cancelled"
// course without stopsCount reads 0 where the TS compares undefined; every tracker writes complete, typed records.
fn past_course(mut c: Value) -> Value {
    if let Value::Object(o) = &mut c {
        let blank = [
            "id",
            "lineName",
            "direction",
            "firstStopName",
            "lastStopName",
            "startTime",
            "endTime",
        ];
        for (k, v) in blank
            .map(|k| (k, Value::from("")))
            .into_iter()
            .chain(["delaySec", "stopsCount"].map(|k| (k, Value::from(0))))
        {
            if o.get(k).is_none_or(Value::is_null) {
                o.insert(k.to_owned(), v);
            }
        }
    }
    c
}

/// The date of a day file's name (`/^fleet-history-(\d{4}-\d{2}-\d{2})\.json$/`).
pub(crate) fn file_day(name: &str) -> Option<&str> {
    let date = name.strip_prefix("fleet-history-")?.strip_suffix(".json")?;
    let ok = date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    ok.then_some(date)
}

/// The dates of `dir`'s day files within [cutoff, today), newest first (blocking IO); none when unreadable.
fn day_dates(dir: &Path, cutoff: &str, today: &str) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dates: Vec<String> = rd
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            let date = file_day(&name)?;
            (date >= cutoff && date < today).then(|| date.to_owned())
        })
        .collect();
    dates.sort_by(|a, b| b.cmp(a));
    dates
}

/// Reads and parses one day file (blocking IO), failing with the TS `${err}` text.
// ponytail: a read failure keeps the io::Error text after "Error: ", not Node's "ENOENT: ..., open '<path>'".
fn day_file(dir: &Path, date: &str, normalize: Normalize) -> Result<DayEntries, String> {
    let text =
        std::fs::read_to_string(dir.join(format!("fleet-history-{date}.json"))).map_err(|e| format!("Error: {e}"))?;
    parse_day(&text, normalize)
}

/// One day file's entries; None (logged) when unreadable or malformed.
fn read_day(dir: &Path, date: &str, normalize: Normalize) -> Option<DayEntries> {
    day_file(dir, date, normalize)
        .map_err(|e| logger::warn("fleet-history", format_args!("skipping {date}: {e}")))
        .ok()
}

/// Reads the day files in `dir`, newest first, one per step: each is read and parsed on a blocking thread and then
/// added through `with`, which runs its argument on the history under the owner's lock and answers false once the
/// owner is gone (the load then stops). Marks the history complete at the end, like the TS `finally`.
pub async fn load_async<F>(dir: PathBuf, normalize: Normalize, mut with: F)
where
    F: FnMut(&mut dyn FnMut(&mut FleetHistory)) -> bool,
{
    let mut range = None;
    if !with(&mut |h| range = Some((h.cutoff.clone(), h.today.clone()))) {
        return;
    }
    let Some((cutoff, today)) = range else {
        return;
    };
    let d = dir.clone();
    let dates = tokio::task::spawn_blocking(move || day_dates(&d, &cutoff, &today))
        .await
        .unwrap_or_default();
    for date in dates {
        let (d, day) = (dir.clone(), date.clone());
        let entries = tokio::task::spawn_blocking(move || read_day(&d, &day, normalize))
            .await
            .ok()
            .flatten();
        if let Some(entries) = entries
            && !with(&mut |h| h.add_day(&date, entry_refs(&entries)))
        {
            return;
        }
    }
    with(&mut |h| h.loaded = true);
}

/// Where a course ends: the start of a next-course search.
#[derive(Debug, Clone, PartialEq)]
pub struct CourseEnd {
    pub line: String,
    pub first_sym: Option<String>,
    pub start: f64,
    pub end: f64,
    pub last_name: String,
    /// expected arrival at the terminus, agency seconds
    pub arrival: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChainStep {
    pub course: MzkDayCourse,
    /// `History` or `Timetable`
    pub source: PredictionSource,
    pub confidence: PredictionConfidence,
    pub seen: Option<PredictionSeen>,
}

/// The next course after `at`: the history successor when today's timetable runs it, else the first timetable
/// course from a same-name stop at least MIN_TURN_SEC after the arrival and within MAX_GAP_SEC of the scheduled
/// end, the same line first.
pub fn next_course(
    at: &CourseEnd,
    sched: &MzkDaySchedule,
    successor: &mut impl FnMut(&str) -> Option<Successor>,
) -> Option<ChainStep> {
    if let Some(h) = successor(&course_key(&at.line, at.first_sym.as_deref(), at.start))
        && let Some(hc) = sched.by_key.get(&h.key)
        && hc.start > at.start
    {
        let share = h.count as f64 / h.total as f64;
        let confidence = if h.count >= 2 && share >= 0.75 {
            PredictionConfidence::High
        } else if share >= 0.4 {
            PredictionConfidence::Medium
        } else {
            PredictionConfidence::Low
        };
        return Some(ChainStep {
            course: hc.clone(),
            source: PredictionSource::History,
            confidence,
            seen: Some(PredictionSeen {
                days: h.count,
                of: h.total,
            }),
        });
    }
    let mut other: Option<&MzkDayCourse> = None;
    for c in sched.from_stop.get(&fold_text(&at.last_name)).into_iter().flatten() {
        if c.start < at.arrival + MIN_TURN_SEC {
            continue;
        }
        if c.start > at.end + MAX_GAP_SEC as f64 {
            break;
        }
        if c.line == at.line {
            return Some(ChainStep {
                course: c.clone(),
                source: PredictionSource::Timetable,
                confidence: PredictionConfidence::Medium,
                seen: None,
            });
        }
        other.get_or_insert(c);
    }
    other.map(|c| ChainStep {
        course: c.clone(),
        source: PredictionSource::Timetable,
        confidence: PredictionConfidence::Low,
        seen: None,
    })
}

/// Up to `max` (TS default 5) courses in a row from `at`, stopping at a course into the depot.
pub fn course_chain(
    at: CourseEnd,
    sched: &MzkDaySchedule,
    mut successor: impl FnMut(&str) -> Option<Successor>,
    max: usize,
) -> Vec<ChainStep> {
    let mut out: Vec<ChainStep> = Vec::new();
    let mut from = at;
    while out.len() < max {
        let Some(step) = next_course(&from, sched, &mut successor) else {
            break;
        };
        let c = &step.course;
        let depot = fold_text(&c.last_name).contains("zajezdnia");
        from = CourseEnd {
            line: c.line.clone(),
            first_sym: Some(c.first_sym.clone()),
            start: c.start,
            end: c.end,
            last_name: c.last_name.clone(),
            arrival: c.end,
        };
        out.push(step);
        if depot {
            break;
        }
    }
    out
}

/// "Po tym kursie pojazd jechał dalej tym kursem w 5 z 6 poprzednich dni roboczych."
pub fn history_reason(seen: PredictionSeen, kind: DayKind) -> String {
    format!(
        "Po tym kursie pojazd jechał dalej tym kursem w {} z {} poprzednich {}.",
        seen.days,
        seen.of,
        kind.gen_plural()
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn course(start: i64) -> Value {
        serde_json::json!({
            "id": format!("c{start}"), "lineName": "10", "direction": "Centrum", "firstStopName": "A",
            "lastStopName": "B", "startTime": "", "endTime": "", "startSecs": start, "endSecs": start + 600,
            "delaySec": 0, "stopsCount": 2, "status": "completed"
        })
    }

    #[test]
    fn a_bad_day_file_reads_as_the_ts_error_string() {
        let err = |text: &str| parse_day(text, |c| c).map(|_| ()).unwrap_err().to_string();
        assert_eq!(err("null"), "TypeError: Cannot convert undefined or null to object");
        assert!(err("{").starts_with("SyntaxError: "));
        let missing = day_file(Path::new("/nonexistent-unimaps"), "2026-11-05", |c| c).map(|_| ());
        assert!(missing.unwrap_err().starts_with("Error: "));
    }

    #[tokio::test]
    async fn async_load_adds_each_readable_day_then_completes() {
        let dir = std::env::temp_dir().join(format!("unimaps-fleet-history-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let day = serde_json::json!({ "_v": 1, "7": { "todayCourses": [course(3600), null, 5] } });
        std::fs::write(dir.join("fleet-history-2026-11-06.json"), day.to_string()).unwrap();
        std::fs::write(dir.join("fleet-history-2026-11-05.json"), "{").unwrap();
        std::fs::write(dir.join("fleet-history-2026-11-07.json"), day.to_string()).unwrap();

        let h = Arc::new(Mutex::new(FleetHistory::new(28, true)));
        h.lock().unwrap().set_today("2026-11-07");
        load_async(
            dir.clone(),
            |c| c,
            |f| {
                f(&mut h.lock().unwrap());
                true
            },
        )
        .await;
        assert!(h.lock().unwrap().complete());
        let days = h.lock().unwrap().vehicle_days("7");
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].date, "2026-11-06");
        assert_eq!(days[0].courses.len(), 1);

        let mut calls = 0;
        load_async(
            dir.clone(),
            |c| c,
            |_| {
                calls += 1;
                false
            },
        )
        .await;
        assert_eq!(calls, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
