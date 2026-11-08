//! server/api/stop/[designator]/timetable/route.ts: a zbiorkom pole's whole-day timetable from the city's local
//! feed, or a BB stop's from upstream (KB timetable + MZK atomic schedules, merged per the shared stop view).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use hyper::Response;
use serde::Serialize;
use serde_json::{Map, Value};

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{
    bad_request, is_valid_date, is_valid_id, not_found, query_param, upstream_error, warming, zb_enabled,
};
use crate::departures_board_cache::BoardLeg;
use crate::fetch::string_err;
use crate::fleet_tracker::blocking_io;
use crate::gtfs_trips::gtfs_trip_meta;
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::js::{truthy, value_to_string};
use crate::kb_api::{KbSource, join_all, py_truthy};
use crate::logger;
use crate::mzk_api::MzkSource;
use crate::mzk_poller::{CourseMeta, MzkPoller};
use crate::mzk_timetable::order_cmp;
use crate::poller::js_number_of;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;
use crate::stop_board::mzk_symbols_of;
use crate::stop_merge::Operator;
use crate::time::today_local;

type Row = Map<String, Value>;

/// GET /api/stop/<zbiorkom designator>/timetable[?date=YYYY-MM-DD]; None = not a zbiorkom stop (`get_bb` in owned
/// mode, Node in proxy mode).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The rate-limit gate, the designator and `?date=` checks every branch makes first; Ok = the date (today when
/// absent or empty).
fn checked(req: &ApiRequest) -> Result<String, Response<Body>> {
    if !allow_request(&req.ip(), 1.0) {
        return Err(too_many_requests());
    }
    if !is_valid_id(&req.param) {
        return Err(bad_request("Invalid stop designator"));
    }
    let date = query_param(&req.query, "date")
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| today_local().to_string());
    if !is_valid_date(&date) {
        return Err(bad_request("date must be YYYY-MM-DD"));
    }
    Ok(date)
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let slug = zb_city_of(&req.param)?;
    let date = match checked(req) {
        Ok(date) => date,
        Err(res) => return Some(res),
    };
    if !zb_enabled(slug) {
        return Some(not_found("Not found"));
    }
    Some(match live(slug).timetable(&req.param, &date) {
        Lookup::Loading => warming(),
        Lookup::Unknown => not_found("Unknown stop"),
        Lookup::Found(tt) => json_cached(&tt, "public, max-age=900"),
    })
}

/// The legs that failed, in the order they failed (the TS `Set`).
#[derive(Default)]
struct Failed(Mutex<Vec<BoardLeg>>);

impl Failed {
    fn add(&self, leg: BoardLeg) {
        let mut f = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if !f.contains(&leg) {
            f.push(leg);
        }
    }

    fn take(self) -> Vec<BoardLeg> {
        self.0.into_inner().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Default, Serialize)]
struct Timetable {
    departures: Vec<Row>,
    #[serde(skip_serializing_if = "Option::is_none")]
    main_direction: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<Vec<BoardLeg>>,
}

/// GET /api/stop/<BB designator>/timetable[?date=YYYY-MM-DD]. A failed upstream leg is `warnings` + no-store, not
/// a 15-minute "no departures".
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    let date = match checked(req) {
        Ok(date) => date,
        Err(res) => return res,
    };
    if let Err(err) = bb.start_poller().await {
        return upstream_error("timetable", err);
    }
    // one shared, memoized merge (the list /api/stops serves); a changed input re-merges, a first read loads files
    let view = blocking_io(|| bb.merged_stops_view());
    let failed = Failed::default();
    let designator = req.param.as_str();
    let both = view
        .lookup(designator)
        .filter(|m| m.operator == Some(Operator::BOTH))
        .and_then(|m| Some((m.kb_designator.clone().filter(|d| !d.is_empty())?, mzk_symbols_of(m))));

    let mut tt = if let Some((kb_designator, symbols)) = both {
        let (kb, mzk) = tokio::join!(
            fetch_kb(bb, &kb_designator, &date, &failed),
            join_all(symbols.iter().map(|s| fetch_mzk(bb, s, &date, &failed)))
        );
        let mut mzk: Vec<Row> = mzk.into_iter().flatten().collect();
        mzk.sort_by(by_departure);
        if symbols.len() > 1 {
            // a course can call at two stops of the same hub: keep its earliest departure only
            let mut seen = HashSet::new();
            mzk.retain(|d| seen.insert(value_to_string(d.get("trip_id"))));
        }
        mzk.extend(kb.departures);
        mzk.sort_by(by_departure);
        Timetable {
            departures: mzk,
            main_direction: kb.main_direction,
            warnings: None,
        }
    } else if let Some(symbol) = designator.strip_prefix("mzk:") {
        Timetable {
            departures: fetch_mzk(bb, symbol, &date, &failed).await,
            ..Default::default()
        }
    } else {
        fetch_kb(bb, designator, &date, &failed).await
    };

    let failed = failed.take();
    // a partial view (one operator's stop list still missing) may answer a BOTH stop as one operator only
    let cache = if failed.is_empty() && !view.partial {
        "public, max-age=900"
    } else {
        "no-store"
    };
    tt.warnings = (!failed.is_empty()).then_some(failed);
    json_cached(&tt, cache)
}

/// `a.departure - b.departure`.
fn by_departure(a: &Row, b: &Row) -> std::cmp::Ordering {
    let key = |r: &Row| r.get("departure").map_or(f64::NAN, js_number_of);
    order_cmp(key(a), key(b))
}

/// `fetchKb`: the KB timetable, each departure labelled `operator: "KB"` plus line + headsign from the built GTFS
/// feed when upstream sends no line. A failure is `failed` + no departures.
async fn fetch_kb<T: BbKinds>(bb: &Bb<T>, kb_designator: &str, date: &str, failed: &Failed) -> Timetable {
    let res = match bb.api().fetch_timetable(kb_designator, date).await {
        // the first GTFS trip lookup reads trips.txt
        Ok(data) => blocking_io(|| kb_timetable(&data)),
        Err(err) => Err(string_err(err)),
    };
    res.unwrap_or_else(|err| {
        failed.add(BoardLeg::Kb);
        logger::warn(
            "kb-timetable",
            format_args!("Timetable fetch failed for {kb_designator}: {err}"),
        );
        Timetable::default()
    })
}

/// The TS mapping of a KB timetable answer; Err = the TypeError it throws on a malformed one.
/// ponytail: a non-object departure is read as a field-less object (the TS spread of a string copies its chars).
fn kb_timetable(data: &Value) -> Result<Timetable, String> {
    if !py_truthy(Some(data)) || !(data.is_object() || data.is_array()) {
        return Ok(Timetable::default());
    }
    let list = match data.get("departures") {
        Some(Value::Array(list)) => list.as_slice(),
        Some(v) if truthy(Some(v)) => {
            return Err("TypeError: (rec.departures || []).map is not a function".into());
        }
        _ => &[],
    };
    let mut departures = Vec::with_capacity(list.len());
    for d in list {
        if d.is_null() {
            return Err("TypeError: Cannot read properties of null (reading 'line')".into());
        }
        let mut row = d.as_object().cloned().unwrap_or_default();
        let meta = (!truthy(d.get("line")))
            .then(|| gtfs_trip_meta(&value_to_string(d.get("trip_id"))))
            .flatten();
        if let Some(meta) = meta {
            row.insert("line".into(), meta.line.into());
            if !meta.headsign.is_empty() {
                row.insert("direction".into(), meta.headsign.into());
            }
        }
        row.insert("operator".into(), "KB".into());
        departures.push(row);
    }
    Ok(Timetable {
        departures,
        main_direction: data.get("main_direction").cloned(),
        warnings: None,
    })
}

/// `fetchMzk`: one MZK symbol's atomic schedule, sorted by departure; every course is noted for trip resolution. A
/// failure is `failed` + no departures.
async fn fetch_mzk<T: BbKinds>(bb: &Bb<T>, symbol: &str, date: &str, failed: &Failed) -> Vec<Row> {
    let res = match bb.mzk_api().fetch_atomic_schedule(symbol, Some(date), true).await {
        Ok(sched) => mzk_timetable(&sched, bb.mzk_poller()),
        Err(err) => Err(string_err(err)),
    };
    match res {
        Ok(mut departures) => {
            departures.sort_by(by_departure);
            departures
        }
        Err(err) => {
            failed.add(BoardLeg::Mzk);
            logger::warn(
                "mzk-timetable",
                format_args!("Atomic schedule fetch failed for symbol {symbol}: {err}"),
            );
            Vec::new()
        }
    }
}

/// The TS walk over `lineSchedules`; Err = the TypeError it throws on a malformed answer (courses noted before it
/// stay noted, as in the TS).
fn mzk_timetable<S: MzkSource + 'static>(sched: &Value, poller: &MzkPoller<S>) -> Result<Vec<Row>, String> {
    let null_read = |key: &str| format!("TypeError: Cannot read properties of null (reading '{key}')");
    if sched.is_null() {
        return Err(null_read("lineSchedules"));
    }
    let lines: Vec<&Value> = match sched.get("lineSchedules") {
        Some(Value::Object(m)) => m.values().collect(),
        Some(Value::Array(a)) => a.iter().collect(),
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for line in lines {
        if line.is_null() {
            return Err(null_read("lineName"));
        }
        let line_name = line.get("lineName");
        let dest = line.get("destination");
        let deps: Vec<Value> = match line.get("departures") {
            Some(Value::Array(a)) => a.clone(),
            Some(Value::String(s)) => s.chars().map(|c| Value::String(c.into())).collect(),
            Some(v) if truthy(Some(v)) => return Err("TypeError: lineData.departures is not iterable".into()),
            _ => Vec::new(),
        };
        for dep in &deps {
            if dep.is_null() {
                return Err(null_read("courseId"));
            }
            let course = dep.get("courseId");
            let variant = dep.get("variantId");
            let trip_id = if truthy(variant) {
                format!("mzk:{}:{}", value_to_string(course), value_to_string(variant))
            } else {
                format!("mzk:{}", value_to_string(course))
            };
            let direction = [dep.get("optionalDirection"), dest]
                .into_iter()
                .find(|v| truthy(*v))
                .flatten()
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));
            let mut row = Row::new();
            row.insert("trip_id".into(), trip_id.into());
            if let Some(d) = dep.get("scheduledDepartureSec") {
                row.insert("departure".into(), d.clone());
            }
            if let Some(l) = line_name {
                row.insert("line".into(), l.clone());
            }
            row.insert("direction".into(), direction.clone());
            row.insert("operator".into(), "MZK".into());
            out.push(row);
            // ponytail: the TS Map also keys a non-numeric courseId; only a finite number can be resolved later
            if let Some(id) = course.and_then(Value::as_f64).filter(|x| x.is_finite()) {
                poller.note_course(
                    id as i64,
                    CourseMeta {
                        line_name: line_name.and_then(Value::as_str).unwrap_or_default().to_owned(),
                        variant_id: variant.and_then(Value::as_f64),
                        direction: direction.as_str().unwrap_or_default().to_owned(),
                    },
                );
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn rows(v: Value) -> Vec<Row> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn malformed_departures_sort_last_and_fail_the_leg_without_a_panic() {
        let mut deps =
            rows(json!([{ "departure": 30 }, {}, { "departure": "x" }, { "departure": null }, { "departure": 10 }]));
        deps.sort_by(by_departure);
        let order: Vec<Option<&Value>> = deps.iter().map(|r| r.get("departure")).collect();
        assert_eq!(
            order,
            [
                Some(&json!(null)),
                Some(&json!(10)),
                Some(&json!(30)),
                None,
                Some(&json!("x"))
            ]
        );

        assert!(kb_timetable(&json!({ "departures": { "a": 1 } })).is_err());
        assert!(kb_timetable(&json!({ "departures": [null] })).is_err());
        let tt = kb_timetable(
            &json!({ "departures": [{ "operator": "x", "line": "5", "trip_id": 1 }], "main_direction": null }),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&tt).unwrap(),
            r#"{"departures":[{"operator":"KB","line":"5","trip_id":1}],"main_direction":null}"#
        );
        assert_eq!(
            serde_json::to_string(&kb_timetable(&json!({})).unwrap()).unwrap(),
            r#"{"departures":[]}"#
        );
    }
}
