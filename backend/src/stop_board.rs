//! lib/stop-board.ts: one stop's merged KB + MZK departures board behind the 4 s micro-cache (the departures route
//! and the push alerts), the whole-stop pole group and its board.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Map, Value};

use crate::departures_board_cache::{Board, BoardLeg, DEPARTURES_BOARD_CACHE};
use crate::fetch::string_err;
use crate::geo::nearest_within;
use crate::js::{self, JsNum, num_value, number_to_string, truthy, value_to_string};
use crate::kb_api::{KbSource, join_all};
use crate::logger;
use crate::mzk_api::MzkSource;
use crate::mzk_fleet::fleet_details;
use crate::mzk_poller::{CourseMeta, MzkPoller};
use crate::mzk_state::{MzkLifecycleInput, MzkRowTimingInput, is_mzk_not_started, mzk_row_timing};
use crate::poller::js_number_of;
use crate::poller_singleton::{Bb, BbKinds};
use crate::shared::departures::{enrich_kb_row, kb_anchor_ts, mzk_wire_fields, pre_sort_rows};
use crate::stop_merge::{Operator, WireStop};

type Row = Map<String, Value>;

/// whole-stop board: the same-name poles this close (the widest BB pair, KOZY CENTRUM, is 435 m apart)
const GROUP_M: f64 = 500.0;
const GROUP_MAX: usize = 6;
/// a BB pole's label: the compass way its buses leave (the map's stop arrow); BB names carry no post number
const COMPASS: [&str; 8] = [
    "płn.",
    "płn.-wsch.",
    "wsch.",
    "płd.-wsch.",
    "płd.",
    "płd.-zach.",
    "zach.",
    "płn.-zach.",
];

/// `stopBoard`: the board of `designator` through the micro-cache, keyed by the merged-stop identity (a late MZK
/// list changes who is asked, so a KB-only board is not reused). The caller has awaited `start_poller`.
pub async fn stop_board<T: BbKinds>(bb: &Bb<T>, designator: &str) -> Arc<Board> {
    let key = {
        let view = bb.merged_stops_view();
        let m = view.lookup(designator);
        let op = m.and_then(|m| m.operator).map_or(String::new(), |o| format!("{o:?}"));
        let symbols = m.map(mzk_symbols_of).unwrap_or_default();
        format!("{designator}|{op}|{}", symbols.join(","))
    };
    DEPARTURES_BOARD_CACHE
        .get(&key, || async { Ok(Arc::new(build_board(bb, designator).await)) })
        .await
        .unwrap_or_default()
}

/// `stopGroup`: the merged stops sharing `designator`'s name within 500 m, nearest first (itself included), at most
/// 6; empty when unknown.
pub fn stop_group<T: BbKinds>(bb: &Bb<T>, designator: &str) -> Vec<WireStop> {
    let view = bb.merged_stops_view();
    let Some(me) = view.lookup(designator) else {
        return Vec::new();
    };
    // ponytail: an O(stops) name scan per call (the TS memoizes a by-name map per view); memo per view if it shows
    let same = view.stops.iter().filter(|s| s.name == me.name);
    nearest_within((me.lat.0, me.lon.0), same, |s| (s.lat.0, s.lon.0), GROUP_M, GROUP_MAX)
        .into_iter()
        .cloned()
        .collect()
}

/// `groupBoard`: every pole's board (each through the micro-cache) as one, each row tagged with its `pole`. The
/// caller has awaited `start_poller`.
pub async fn group_board<T: BbKinds>(bb: &Bb<T>, group: &[WireStop]) -> Board {
    let boards = join_all(group.iter().map(|p| stop_board(bb, &p.designator))).await;
    let mut out = Board::default();
    let mut rows = Vec::new();
    for (b, p) in boards.iter().zip(group) {
        let pole = pole_of(p.dirs.as_deref());
        for r in &b.rows {
            let mut r = r.clone();
            match &pole {
                Some(v) => {
                    r.insert("pole".into(), v.clone());
                }
                None => {
                    r.shift_remove("pole");
                }
            }
            rows.push(r);
        }
        for leg in &b.failed {
            if !out.failed.contains(leg) {
                out.failed.push(*leg);
            }
        }
        out.failed_legs += b.failed_legs;
        out.legs += b.legs;
    }
    out.rows = pre_sort(rows, now_ts(bb));
    out
}

/// A pole's `pole` value: `COMPASS[Math.round(dir / 45) % 8]` with exactly one bearing, else null. None = the TS
/// index read undefined (a negative or NaN bearing) and the spread drops the key.
fn pole_of(dirs: Option<&[JsNum]>) -> Option<Value> {
    let [dir] = dirs.unwrap_or_default() else {
        return Some(Value::Null);
    };
    let i = js::round(dir.0 / 45.0) % 8.0;
    (i >= 0.0)
        .then(|| COMPASS.get(i as usize))
        .flatten()
        .map(|s| Value::from(*s))
}

/// `${pad2(Math.floor(sec / 3600) % 24)}:${pad2(Math.floor((sec % 3600) / 60))}`: JS `%` keeps the dividend's sign
/// and `padStart` never cuts, so a negative or NaN input prints as the TS does.
pub(crate) fn hh_mm_of_secs(sec: f64) -> String {
    let pad2 = |x: f64| format!("{:0>2}", number_to_string(x));
    format!(
        "{}:{}",
        pad2((sec / 3600.0).floor() % 24.0),
        pad2(((sec % 3600.0) / 60.0).floor())
    )
}

/// `mzkSymbols ?? (mzkSymbol ? [mzkSymbol] : [])`
fn mzk_symbols_of(m: &WireStop) -> Vec<String> {
    match (&m.mzk_symbols, &m.mzk_symbol) {
        (Some(all), _) => all.clone(),
        (None, Some(s)) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn now_ts<T: BbKinds>(bb: &Bb<T>) -> f64 {
    bb.now_ms() as f64 / 1000.0
}

/// `preSortRows` over wire rows.
fn pre_sort(rows: Vec<Row>, now_ts: f64) -> Vec<Row> {
    pre_sort_rows(rows.into_iter().map(Value::Object).collect(), now_ts)
        .into_iter()
        .filter_map(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .collect()
}

/// The failed legs in failure order and the failed fetch count (a hub asks several MZK symbols).
#[derive(Default)]
struct Failed {
    legs: Vec<BoardLeg>,
    count: usize,
}

fn fail(failed: &Mutex<Failed>, leg: BoardLeg) {
    let mut f = failed.lock().unwrap_or_else(PoisonError::into_inner);
    if !f.legs.contains(&leg) {
        f.legs.push(leg);
    }
    f.count += 1;
}

async fn build_board<T: BbKinds>(bb: &Bb<T>, designator: &str) -> Board {
    let mzk = Arc::clone(bb.mzk_poller());
    // one shared, memoized merge (the list the client got from /api/stops): never an ad hoc re-merge
    let view = bb.merged_stops_view();
    let merged = view.lookup(designator);
    let failed = Mutex::new(Failed::default());

    let both = merged
        .filter(|m| m.operator == Some(Operator::BOTH))
        .and_then(|m| Some((m, m.kb_designator.as_deref().filter(|d| !d.is_empty())?)));
    let (rows, legs) = if let Some((m, kb_desig)) = both {
        let symbols = mzk_symbols_of(m);
        let (kb_rows, mzk_res) = tokio::join!(
            fetch_kb(bb, kb_desig, &failed),
            join_all(symbols.iter().map(|s| fetch_mzk(bb, &mzk, s, &failed)))
        );
        // a course can call at two stops of the same hub: keep its earliest departure only
        let mut seen = HashSet::new();
        let mut rows: Vec<Row> = pre_sort(mzk_res.into_iter().flatten().collect(), now_ts(bb))
            .into_iter()
            .filter(|r| symbols.len() <= 1 || seen.insert(value_to_string(r.get("trip_execution_id"))))
            .collect();
        rows.extend(kb_rows);
        (rows, 1 + symbols.len())
    } else if let Some(symbol) = designator.strip_prefix("mzk:") {
        (fetch_mzk(bb, &mzk, symbol, &failed).await, 1)
    } else {
        (fetch_kb(bb, designator, &failed).await, 1)
    };
    let f = failed.into_inner().unwrap_or_else(PoisonError::into_inner);
    Board {
        rows: pre_sort(rows, now_ts(bb)),
        failed: f.legs,
        failed_legs: f.count,
        legs,
    }
}

async fn fetch_kb<T: BbKinds>(bb: &Bb<T>, kb_desig: &str, failed: &Mutex<Failed>) -> Vec<Row> {
    let res = match bb.api().fetch_departures(kb_desig).await {
        Ok(data) => kb_rows(&data, now_ts(bb)),
        Err(e) => Err(string_err(e)),
    };
    match res {
        Ok(rows) => {
            // ponytail: a truthy candidate id that is not a string is never fetched (the TS passes it on)
            let eids: Vec<String> = rows
                .iter()
                .filter_map(|r| r.get("trip_execution_id")?.as_str().filter(|s| !s.is_empty()))
                .map(str::to_owned)
                .collect();
            if !eids.is_empty() {
                bb.poller().add_candidates(&eids);
            }
            rows
        }
        Err(err) => {
            fail(failed, BoardLeg::Kb);
            logger::warn(
                "kb-departures",
                format!("Departures fetch failed for {kb_desig}: {err}"),
            );
            Vec::new()
        }
    }
}

/// KB's rows enriched (KB's "N min" strings are relative to the moment upstream built the board). An object with
/// a `rows` array is always pyTruthy.
fn kb_rows(data: &Value, now_ts: f64) -> Result<Vec<Row>, String> {
    let Some(Value::Array(rows)) = data.get("rows") else {
        return Ok(Vec::new());
    };
    let anchor = kb_anchor_ts(data.get("timestamp"), now_ts);
    let empty = Map::new();
    rows.iter()
        .map(|r| match r {
            Value::Null => Err("TypeError: Cannot read properties of null (reading 'at_stop')".to_owned()),
            // ponytail: a primitive row is read as an empty object (the TS spreads it into nothing too)
            Value::Object(r) => Ok(enrich_kb_row(r, data.get("directions"), anchor)),
            _ => Ok(enrich_kb_row(&empty, data.get("directions"), anchor)),
        })
        .collect()
}

async fn fetch_mzk<T: BbKinds>(bb: &Bb<T>, mzk: &MzkPoller<T::Mzk>, symbol: &str, failed: &Mutex<Failed>) -> Vec<Row> {
    let res = match bb.mzk_api().fetch_realtime(symbol).await {
        Ok(rt) => mzk_rows(bb, mzk, &rt),
        Err(e) => Err(string_err(e)),
    };
    res.unwrap_or_else(|err| {
        fail(failed, BoardLeg::Mzk);
        logger::warn(
            "mzk-departures",
            format!("Realtime fetch failed for symbol {symbol}: {err}"),
        );
        Vec::new()
    })
}

fn num(v: Option<&Value>) -> f64 {
    v.map_or(f64::NAN, js_number_of)
}

/// Math.max(0, x) keeps a NaN.
fn max0(x: f64) -> f64 {
    if x.is_nan() { x } else { x.max(0.0) }
}

fn copy(row: &mut Row, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        row.insert(key.into(), v.clone());
    }
}

/// One OnTime realtime board as wire rows; every row notes its course for trip resolution.
// ponytail: a primitive departure is read as an object without fields (OnTime sends objects)
fn mzk_rows<T: BbKinds>(bb: &Bb<T>, mzk: &MzkPoller<T::Mzk>, rt: &Value) -> Result<Vec<Row>, String> {
    if rt.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'departures')".to_owned());
    }
    let deps: &[Value] = match rt.get("departures") {
        Some(Value::Array(a)) => a,
        d if !truthy(d) => &[],
        _ => return Err("TypeError: (rt.departures || []).map is not a function".to_owned()),
    };
    let (running, stops, statics) = {
        let st = mzk.state();
        (
            st.running_vehicles.clone(),
            st.stops_by_symbol.clone(),
            st.static_vehicles.clone(),
        )
    };
    let mut out = Vec::with_capacity(deps.len());
    for d in deps {
        if d.is_null() {
            return Err("TypeError: Cannot read properties of null (reading 'vehicleId')".to_owned());
        }
        let vid = d.get("vehicleId");
        let fleet = truthy(vid).then(|| {
            let stat = vid.and_then(Value::as_str).and_then(|s| statics.get(s));
            fleet_details(&value_to_string(vid), stat)
        });
        let sched_sec = num(d.get("scheduledDepartureSec"));
        let sched_ms = num(d.get("scheduledDeparture"));

        // the course has not begun (the bus waits at its first stop): OnTime's realDeparture is a placeholder,
        // the row shows the earliest possible time instead and no delay
        let course = value_to_string(d.get("courseId"));
        let running = running.get(&course);
        let first_sp = running
            .and_then(|r| r.get("stopPoints"))
            .and_then(|sp| sp.get(0))
            .filter(|sp| truthy(Some(sp)));
        let first_stop = first_sp
            .and_then(|sp| sp.get("symbol"))
            .and_then(Value::as_str)
            .and_then(|s| stops.get(s));
        let not_started = match (running, first_sp) {
            (Some(r), Some(_)) => {
                is_mzk_not_started(&MzkLifecycleInput::from_json(r), first_stop.map(|s| (s.lat, s.lon)))
            }
            _ => false,
        };
        let first_sched = first_sp
            .and_then(|sp| sp.get("scheduledDeparture"))
            .and_then(Value::as_f64);
        let now_ms = bb.now_ms() as f64;
        let timing = mzk_row_timing(&MzkRowTimingInput {
            scheduled_departure_sec: sched_sec,
            scheduled_departure: sched_ms,
            real_departure: d.get("realDeparture").and_then(Value::as_f64),
            lack: truthy(d.get("lack")),
            not_started,
            first_scheduled_ms: first_sched,
            now_ms,
        });

        if let Some(id) = d.get("courseId").and_then(Value::as_f64).filter(|x| x.is_finite()) {
            let text = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            mzk.note_course(
                id as i64,
                CourseMeta {
                    line_name: text("lineName"),
                    variant_id: d.get("variantId").and_then(Value::as_f64),
                    direction: text("directionName"),
                },
            );
        }

        let mut row = Row::new();
        let vid_text = if truthy(vid) {
            value_to_string(vid)
        } else {
            String::new()
        };
        row.insert("trip_execution_id".into(), format!("mzk:{course}:{vid_text}").into());
        let trip_id = if truthy(d.get("variantId")) {
            format!("mzk:{course}:{}", value_to_string(d.get("variantId")))
        } else {
            format!("mzk:{course}")
        };
        row.insert("trip_id".into(), trip_id.into());
        row.insert("static_time".into(), hh_mm_of_secs(sched_sec).into());
        row.insert("time".into(), timing.time.into());
        row.insert("time_diff".into(), num_value(timing.time_diff));
        row.insert("is_estimated".into(), timing.is_estimated.into());
        if not_started {
            row.insert("not_started".into(), true.into());
        }
        copy(&mut row, "direction", d.get("directionName"));
        copy(&mut row, "line_name", d.get("lineName"));
        row.insert("operator".into(), "MZK".into());
        copy(&mut row, "symbol", vid);
        copy(&mut row, "side_number", vid);
        if let Some(f) = &fleet {
            row.insert("model".into(), f.model.clone().into());
            if let Ok(features) = serde_json::to_value(&f.features) {
                row.insert("features".into(), features);
            }
        }
        // absolute instants (epoch s): the client sorts and counts down on these, never on "HH:MM"
        row.extend(mzk_wire_fields(d));
        if not_started {
            // no measured ETA/delay: the earliest possible instant is the schedule pushed back by the overstay
            let first_ms = first_sp
                .and_then(|sp| sp.get("scheduledDeparture"))
                .filter(|v| !v.is_null())
                .map_or(sched_ms, js_number_of);
            let eta = sched_ms / 1000.0 + max0((now_ms - first_ms) / 1000.0);
            row.insert("eta_ts".into(), num_value(eta));
            row.insert("delay_sec".into(), Value::Null);
            row.insert("at_stop".into(), false.into());
            row.insert("is_estimated".into(), false.into());
        }
        out.push(row);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The routes run these on hyper's multi-threaded runtime: the futures must stay `Send`.
    #[allow(dead_code)]
    fn services_are_send<T: BbKinds>(bb: &'static Bb<T>, group: &'static [WireStop]) {
        fn send<F: Send>(_: F) {}
        send(stop_board(bb, "x"));
        send(group_board(bb, group));
        send(crate::mzk_trip::resolve_mzk_trip(bb, "mzk:1", true));
        send(crate::announcements::fetch_announcements(bb, "bb"));
    }

    #[test]
    fn hh_mm_follows_js_remainder_and_pad() {
        assert_eq!(hh_mm_of_secs(0.0), "00:00");
        assert_eq!(hh_mm_of_secs(25.0 * 3600.0 + 7.0 * 60.0 + 59.0), "01:07");
        assert_eq!(hh_mm_of_secs(-300.0), "-1:-5");
        assert_eq!(hh_mm_of_secs(f64::NAN), "NaN:NaN");
    }

    #[test]
    fn pole_is_null_undefined_or_a_compass_point() {
        assert_eq!(pole_of(None), Some(Value::Null));
        assert_eq!(pole_of(Some(&[JsNum(10.0), JsNum(200.0)])), Some(Value::Null));
        assert_eq!(pole_of(Some(&[JsNum(359.0)])), Some("płn.".into()));
        assert_eq!(pole_of(Some(&[JsNum(100.0)])), Some("wsch.".into()));
        assert_eq!(pole_of(Some(&[JsNum(-10.0)])), Some("płn.".into()), "-0 indexes 0");
        assert_eq!(pole_of(Some(&[JsNum(-30.0)])), None, "COMPASS[-1] is undefined");
        assert_eq!(pole_of(Some(&[JsNum(f64::NAN)])), None);
    }
}
