//! lib/shared/departures.ts: the server half. The board's pre-sort (`preSortRows` = `resolveTiming(row, null)` +
//! `compareBoardItems`), the GZM row key and `hhmm`. The KB/MZK normalisers come with the BB departures route; the
//! vehicle-aware resolving, labels and `sortBoard` stay client-only.

use std::cmp::Ordering;
use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::js;

/// The fields of a wire row the order reads (`TimingRow`). `row_key` is required: every server row builder sets one
/// (`kbRowKey` / `mzkRowKey` / `gzmRowKey` are never empty), so `rowKey()`'s fallback cannot run on the server.
pub struct TimingRow<'a> {
    /// `line_name ?? symbol`
    pub line: Option<&'a str>,
    pub row_key: &'a str,
    pub plan_ts: Option<f64>,
    pub eta_ts: Option<f64>,
    pub at_stop: bool,
    pub canceled: bool,
    pub not_started: bool,
}

pub trait BoardRow {
    fn timing_row(&self) -> TimingRow<'_>;
}

/// The part of `resolveTiming(row, null)` the order reads.
struct Timing {
    eta_ts: Option<f64>,
    plan_ts: Option<f64>,
    at_stop: bool,
    canceled: bool,
}

fn resolve(r: &TimingRow) -> Timing {
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
fn minutes_until(t: &Timing, now_ts: f64) -> f64 {
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
    let l = js::compare_pl_numeric(ra.line.unwrap_or(""), rb.line.unwrap_or(""));
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
