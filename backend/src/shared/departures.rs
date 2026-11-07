//! lib/shared/departures.ts: the server half. The KB/MZK row normalisers (`enrichKbRow`, `mzkWireFields`), the board's
//! pre-sort (`preSortRows` = `resolveTiming(row, null)` + `compareBoardItems`), the GZM row key and `hhmm`. The
//! vehicle-aware resolving, labels and `sortBoard` stay client-only.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::{Map, Value};

use crate::js::{self, num_value, value_to_string};

/// KB prints whole minutes by floor: "N min" is read as N min + 29 s, so the countdown shows the printed N.
pub const KB_REL_BIAS_SEC: f64 = 29.0;

/// The fields of a wire row the order reads (`TimingRow`).
pub struct TimingRow<'a> {
    /// `String(line_name ?? symbol ?? "")`
    pub line: Cow<'a, str>,
    /// `rowKey(row)`: every server row builder sets `row_key` (`kbRowKey` / `mzkRowKey` / `gzmRowKey`)
    pub row_key: Cow<'a, str>,
    pub plan_ts: Option<f64>,
    pub eta_ts: Option<f64>,
    pub at_stop: bool,
    pub canceled: bool,
    pub not_started: bool,
}

pub trait BoardRow {
    fn timing_row(&self) -> TimingRow<'_>;
}

fn js_str<'a>(v: Option<&'a Value>) -> Cow<'a, str> {
    match v {
        Some(Value::String(s)) => Cow::Borrowed(s),
        v => Cow::Owned(value_to_string(v)),
    }
}

fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

fn is_true(v: Option<&Value>) -> bool {
    v == Some(&Value::Bool(true))
}

/// A wire row as JSON (the KB/MZK rows keep every upstream field).
impl BoardRow for Value {
    fn timing_row(&self) -> TimingRow<'_> {
        let line = [self.get("line_name"), self.get("symbol")]
            .into_iter()
            .find(|v| !nullish(*v))
            .map_or(Cow::Borrowed(""), js_str);
        let key = self.get("row_key");
        let row_key = if js::truthy(key) {
            js_str(key)
        } else {
            let exec = self.get("trip_execution_id");
            let base = if js::truthy(exec) {
                value_to_string(exec)
            } else if nullish(self.get("trip_id")) {
                String::new()
            } else {
                value_to_string(self.get("trip_id"))
            };
            let or_empty = |k: &str| {
                let v = self.get(k);
                if nullish(v) { String::new() } else { value_to_string(v) }
            };
            Cow::Owned(format!("{base}#{}#{}", or_empty("trip_index"), or_empty("static_time")))
        };
        TimingRow {
            line,
            row_key,
            plan_ts: self.get("plan_ts").and_then(Value::as_f64),
            eta_ts: self.get("eta_ts").and_then(Value::as_f64),
            at_stop: is_true(self.get("at_stop")),
            canceled: is_true(self.get("canceled")),
            not_started: is_true(self.get("not_started")),
        }
    }
}

/// The part of `resolveTiming(row, null)` the order and the alerts read.
pub(crate) struct Timing {
    pub(crate) eta_ts: Option<f64>,
    plan_ts: Option<f64>,
    at_stop: bool,
    pub(crate) canceled: bool,
}

pub(crate) fn resolve(r: &TimingRow) -> Timing {
    let finite = |v: Option<f64>| v.filter(|x| x.is_finite());
    let plan_ts = finite(r.plan_ts);
    Timing {
        eta_ts: finite(r.eta_ts).or(plan_ts),
        plan_ts,
        // a course that has not begun: earliest possible time, never "at the stop"
        at_stop: r.at_stop && (r.canceled || !r.not_started),
        canceled: r.canceled,
    }
}

/// Whole minutes until departure as the countdown prints them (>= 0); infinity when unknown.
pub(crate) fn minutes_until(t: &Timing, now_ts: f64) -> f64 {
    match (t.at_stop, t.eta_ts) {
        (true, _) => 0.0,
        (false, None) => f64::INFINITY,
        (false, Some(eta)) => js::round((eta - now_ts) / 60.0).max(0.0),
    }
}

/// `compareBoardItems`: canceled last, then the printed minute (unknown last), a bus at the stop first, line in
/// natural order, plan (unknown last), row key in UTF-16 order (JS `<` on strings).
fn compare(a: (&TimingRow, &Timing), b: (&TimingRow, &Timing), now_ts: f64) -> Ordering {
    let ((ra, ta), (rb, tb)) = (a, b);
    if ta.canceled != tb.canceled {
        return if ta.canceled { Ordering::Greater } else { Ordering::Less };
    }
    let (ma, mb) = (minutes_until(ta, now_ts), minutes_until(tb, now_ts));
    if ma != mb {
        return if ma < mb { Ordering::Less } else { Ordering::Greater };
    }
    if ta.at_stop != tb.at_stop {
        return if ta.at_stop { Ordering::Less } else { Ordering::Greater };
    }
    let l = js::compare_pl_numeric(&ra.line, &rb.line);
    if l != Ordering::Equal {
        return l;
    }
    match (ta.plan_ts, tb.plan_ts) {
        (Some(pa), Some(pb)) if pa != pb => return pa.total_cmp(&pb),
        (None, Some(_)) => return Ordering::Greater,
        (Some(_), None) => return Ordering::Less,
        _ => {}
    }
    ra.row_key.encode_utf16().cmp(rb.row_key.encode_utf16())
}

/// Server-side pre-sort (no live vehicles known there): the order a client without vehicle data computes.
pub fn pre_sort_rows<R: BoardRow>(rows: Vec<R>, now_ts: f64) -> Vec<R> {
    let mut items: Vec<(Timing, R)> = rows.into_iter().map(|r| (resolve(&r.timing_row()), r)).collect();
    items.sort_by(|(ta, a), (tb, b)| compare((&a.timing_row(), ta), (&b.timing_row(), tb), now_ts));
    items.into_iter().map(|(_, r)| r).collect()
}

/// KB's relative strings to whole minutes: "5 min" 5, "< 1 min" 0, "5 Min." 5, anything else None.
pub fn parse_rel_minutes(s: Option<&Value>) -> Option<f64> {
    let t = s?.as_str()?.trim_matches(js::is_space);
    let min_at = |rest: &str| {
        rest.trim_start_matches(js::is_space)
            .get(..3)
            .is_some_and(|m| m.eq_ignore_ascii_case("min"))
    };
    if let Some(rest) = t.strip_prefix('<') {
        let rest = rest.trim_start_matches(js::is_space);
        return rest.strip_prefix('1').filter(|r| min_at(r)).map(|_| 0.0);
    }
    let digits = t.len() - t.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    // `^(\d{1,3})\s*min`: a longer digit run cannot backtrack into a match
    if !(1..=3).contains(&digits) || !min_at(&t[digits..]) {
        return None;
    }
    t[..digits].parse().ok()
}

/// Warsaw wall clock at `ts` (epoch s): (minutes east of UTC, minute of day). `new Date(ts * 1000)` truncates.
fn warsaw_wall(ts: f64) -> (f64, f64) {
    let ms = (ts * 1000.0).trunc() as i64;
    let t = Timestamp::from_millisecond(ms).unwrap_or(Timestamp::UNIX_EPOCH);
    let wall_min = (ms + i64::from(WARSAW.to_offset(t).seconds()) * 1000).div_euclid(60_000);
    (
        (wall_min as f64) - (ts / 60.0).floor(),
        wall_min.rem_euclid(1440) as f64,
    )
}

/// `parseClockNear`: a wall-clock "HH:MM" (Europe/Warsaw) to the epoch second of its nearest occurrence in
/// [anchor - 2 h, anchor + 22 h), DST-exact. Anything else None.
pub fn parse_clock_near(s: Option<&Value>, anchor_ts: f64) -> Option<f64> {
    let s = s?.as_str()?;
    // `^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$`
    let t = s.trim_start_matches(js::is_space);
    let hl = t.len() - t.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let two = |r: &str| r.len() >= 2 && r.as_bytes()[..2].iter().all(u8::is_ascii_digit);
    let rest = t[hl..].strip_prefix(':').filter(|r| (1..=2).contains(&hl) && two(r))?;
    let (h, mi): (f64, f64) = (t[..hl].parse().ok()?, rest[..2].parse().ok()?);
    let mut tail = &rest[2..];
    if let Some(r) = tail.strip_prefix(':') {
        tail = if two(r) { &r[2..] } else { return None };
    }
    if !tail.chars().all(js::is_space) || h > 23.0 || mi > 59.0 {
        return None;
    }
    let (a_off, a_mod) = warsaw_wall(anchor_ts);
    let delta = (((h * 60.0 + mi - a_mod + 120.0) % 1440.0) + 1440.0) % 1440.0 - 120.0;
    let guess = (anchor_ts / 60.0).floor() * 60.0 + delta * 60.0;
    Some(guess - (warsaw_wall(guess).0 - a_off) * 60.0)
}

/// Absolute timing of one row: `TimingFields & RowFlags`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RowTiming {
    pub plan_ts: Option<f64>,
    pub eta_ts: Option<f64>,
    pub delay_sec: Option<f64>,
    pub at_stop: bool,
    pub canceled: bool,
}

/// `kbTiming`: a KB row against `anchor_ts`, the moment upstream computed its relative strings. See the TS for the
/// derivation of the plan from a relative static_time.
pub fn kb_timing(row: &Map<String, Value>, anchor_ts: f64) -> RowTiming {
    let at_stop = is_true(row.get("at_stop"));
    let time = row.get("time");
    let eta_ts = if at_stop {
        Some(anchor_ts)
    } else if let Some(n) = parse_rel_minutes(time) {
        Some(anchor_ts + n * 60.0 + KB_REL_BIAS_SEC)
    } else {
        parse_clock_near(time, anchor_ts)
    };
    let st = row.get("static_time");
    let plan_ts = parse_clock_near(st, anchor_ts).or_else(|| {
        parse_rel_minutes(st)
            .filter(|n| *n >= 1.0)
            .map(|n| ((anchor_ts + n * 60.0) / 60.0).ceil() * 60.0)
    });
    let td = row.get("time_diff").and_then(Value::as_f64);
    RowTiming {
        plan_ts,
        eta_ts,
        delay_sec: td
            .filter(|_| is_true(row.get("is_estimated")))
            .map(|td| js::round(td * 60.0)),
        at_stop,
        canceled: is_true(row.get("canceled")),
    }
}

/// `mzkTiming` of a raw OnTime getRealtime departure. `lack` or no realDeparture = scheduled only (eta None);
/// `passed` and `onStopPoint` are deliberately ignored (see the TS).
pub fn mzk_timing(d: &Value) -> RowTiming {
    let plan_ms = d.get("scheduledDeparture").and_then(Value::as_f64);
    let real_ms = d.get("realDeparture").and_then(Value::as_f64);
    let plan_ts = plan_ms.filter(|p| *p > 0.0).map(|p| p / 1000.0);
    let eta_ts = real_ms
        .filter(|r| !js::truthy(d.get("lack")) && *r > 0.0)
        .map(|r| r / 1000.0);
    RowTiming {
        plan_ts,
        eta_ts,
        delay_sec: plan_ts.zip(eta_ts).map(|(p, e)| js::round(e - p)),
        at_stop: false,
        canceled: false,
    }
}

/// `pickDirection`: the row's own non-empty `direction`, else the board's `directions[String(direction_id)]` (an own
/// property, a non-empty string).
pub fn pick_direction(row: &Map<String, Value>, directions: Option<&Value>) -> Option<String> {
    if let Some(Value::String(d)) = row.get("direction")
        && !d.is_empty()
    {
        return Some(d.clone());
    }
    let id = row.get("direction_id").filter(|v| !v.is_null())?;
    let key = value_to_string(Some(id));
    let v = match directions? {
        Value::Object(m) => m.get(&key),
        Value::Array(a) => key
            .parse::<usize>()
            .ok()
            .filter(|i| i.to_string() == key)
            .and_then(|i| a.get(i)),
        _ => None,
    };
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// `mzkRowKey`: stable across refetches (no vehicle id: it appears once a bus is assigned).
pub fn mzk_row_key(course_id: Option<&Value>, order_in_course: Option<&Value>) -> String {
    let order = if nullish(order_in_course) {
        String::new()
    } else {
        value_to_string(order_in_course)
    };
    format!("mzk:{}#{order}", value_to_string(course_id))
}

/// `kbRowKey`: `${exec ?? ""}#${index ?? ""}`.
pub fn kb_row_key(trip_execution_id: Option<&Value>, trip_index: Option<&Value>) -> String {
    let s = |v: Option<&Value>| if nullish(v) { String::new() } else { value_to_string(v) };
    format!("{}#{}", s(trip_execution_id), s(trip_index))
}

/// `kbAnchorTs`: the board's own `timestamp` when it is within 120 s of our receive time (clock-skew guard).
pub fn kb_anchor_ts(board_timestamp: Option<&Value>, local_ts: f64) -> f64 {
    board_timestamp
        .and_then(Value::as_f64)
        .filter(|b| (b - local_ts).abs() < 120.0)
        .unwrap_or(local_ts)
}

fn opt_num(x: Option<f64>) -> Value {
    x.map_or(Value::Null, num_value)
}

/// `enrichKbRow`: one KB board row to its wire row. Every upstream field stays; the added ones overwrite in place or
/// append, in the TS spread's order, and an unknown direction drops the key (`undefined` in JSON).
pub fn enrich_kb_row(row: &Map<String, Value>, directions: Option<&Value>, anchor_ts: f64) -> Map<String, Value> {
    let t = kb_timing(row, anchor_ts);
    let mut out = row.clone();
    out.insert("operator".into(), "KB".into());
    match pick_direction(row, directions) {
        Some(d) => out.insert("direction".into(), d.into()),
        None => out.shift_remove("direction"),
    };
    out.insert("plan_ts".into(), opt_num(t.plan_ts));
    out.insert("eta_ts".into(), opt_num(t.eta_ts));
    out.insert("delay_sec".into(), opt_num(t.delay_sec));
    out.insert("at_stop".into(), t.at_stop.into());
    out.insert("canceled".into(), t.canceled.into());
    let key = kb_row_key(row.get("trip_execution_id"), row.get("trip_index"));
    out.insert("row_key".into(), key.into());
    out
}

/// `mzkWireFields`: the fields the route adds to an MZK row (`trip_index` absent when orderInCourse is nullish).
pub fn mzk_wire_fields(d: &Value) -> Map<String, Value> {
    let t = mzk_timing(d);
    let order = d.get("orderInCourse");
    let mut out = Map::new();
    out.insert("plan_ts".into(), opt_num(t.plan_ts));
    out.insert("eta_ts".into(), opt_num(t.eta_ts));
    out.insert("delay_sec".into(), opt_num(t.delay_sec));
    out.insert("at_stop".into(), t.at_stop.into());
    out.insert("canceled".into(), t.canceled.into());
    if let Some(o) = order.filter(|o| !o.is_null()) {
        out.insert("trip_index".into(), o.clone());
    }
    out.insert("row_key".into(), mzk_row_key(d.get("courseId"), order).into());
    out
}

/// GZM: the static GTFS trip id (raw, without "gzm:") + the stop_sequence of this visit.
pub fn gzm_row_key(trip_id: &str, stop_sequence: i64) -> String {
    format!("gzm:{trip_id}#{stop_sequence}")
}

static WARSAW: LazyLock<TimeZone> = LazyLock::new(|| TimeZone::get("Europe/Warsaw").expect("bundled tzdb"));

/// "HH:MM" of an epoch instant on the Warsaw wall clock (24 h). `new Date(s * 1000)` truncates to the millisecond.
pub fn hhmm(epoch_sec: f64) -> String {
    let t = Timestamp::from_millisecond((epoch_sec * 1000.0).trunc() as i64).unwrap_or(Timestamp::UNIX_EPOCH);
    let dt = WARSAW.to_datetime(t);
    format!("{:02}:{:02}", dt.hour(), dt.minute())
}
