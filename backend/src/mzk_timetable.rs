//! lib/mzk-timetable.ts: the file the router reads (`loadMzkTimetable`) and the day schedule of the fleet's
//! next-course prediction (`mzkDaySchedule`). The builder comes with the MZK poller.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use indexmap::IndexMap;
use serde::Deserialize;

use crate::shared::fleet::fold_text;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MzkTimetableTrip {
    /// `mzk:<course>:<variant>`
    pub id: String,
    pub line: String,
    pub headsign: String,
    pub day_type: String,
    /// (stop symbol, secs from the service day's midnight) in stop order
    pub calls: Vec<(String, f64)>,
}

#[derive(Deserialize)]
pub struct MzkTimetableFile {
    v: f64,
    /// Warsaw ISO date -> OnTime day type
    pub calendar: IndexMap<String, String>,
    /// symbol -> (name, lat, lon), in `Object.entries` order
    pub stops: IndexMap<String, (String, f64, f64)>,
    pub trips: Vec<MzkTimetableTrip>,
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
