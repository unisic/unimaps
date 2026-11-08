//! server/api/connections/route.ts: a RAPTOR search over a zbiorkom city's own feed or the BB (KB + MZK) index.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use hyper::Response;
use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use serde::Serialize;

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{bad_request, internal_error, is_valid_date, query_param, warming};
use crate::fleet_tracker::blocking_io;
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::Body;
use crate::js;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, allow_search, charge_search, too_many_requests};
use crate::router::{ConnectionItinerary, LiveFn, Point, RouteQuery, SortBy, find_connections, get_index};
use crate::shape_patterns::raw_trip_id;
use crate::stop_board::mzk_symbols_of;

/// how far the rider walks between a query point and a stop, metres
const WALK_MIN_M: f64 = 200.0;
const WALK_MAX_M: f64 = 1500.0;
const MAX_AVOID: usize = 20;
/// GZM's feed is far larger (~22k trips a day): charge a search more so one client can't hold the search
const GZM_COST: f64 = 20.0;
/// The TS budget check, search and charge share one event-loop turn: a search arriving meanwhile sees the charge.
static SEARCH_TURN: Mutex<()> = Mutex::new(());

/// /^\d{1,n}$/ (JS \d is ASCII)
fn digits(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// INT_RE /^\d{1,4}$/
fn int_ok(s: &str) -> bool {
    digits(s, 4)
}

/// TIME_RE /^([01]\d|2[0-3]):[0-5]\d$/
fn time_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && matches!((b[0], b[1]), (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3'))
        && b[2] == b':'
        && matches!(b[3], b'0'..=b'5')
        && b[4].is_ascii_digit()
}

/// `-?\d{1,int}(?:\.\d{1,7})?` of GEO_RE
fn geo_num(s: &str, int: usize) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    match s.split_once('.') {
        Some((i, f)) => digits(i, int) && digits(f, 7),
        None => digits(s, int),
    }
}

/// A `geo:` param rounded to ~11 m (one memo entry per spot, and no finer trace of the rider); None when malformed.
fn parse_point(v: &str, walk_m: Option<f64>) -> Option<Point> {
    let (lat, lon) = v.strip_prefix("geo:")?.split_once(',')?;
    if !geo_num(lat, 2) || !geo_num(lon, 3) {
        return None;
    }
    let (lat, lon) = (js::number(lat), js::number(lon));
    if !(lat.abs() <= 90.0 && lon.abs() <= 180.0) {
        return None;
    }
    Some(Point {
        lat: js::round(lat * 1e4) / 1e4,
        lon: js::round(lon * 1e4) / 1e4,
        walk_m,
    })
}

/// LINE_RE /^[\p{L}\p{N} ._-]{1,16}$/u
fn line_ok(s: &str) -> bool {
    let gc = CodePointMapData::<GeneralCategory>::new();
    (1..=16).contains(&s.chars().count())
        && s.chars().all(|c| {
            matches!(c, ' ' | '.' | '_' | '-') || {
                let g = gc.get(c);
                GeneralCategoryGroup::Letter.contains(g) || GeneralCategoryGroup::Number.contains(g)
            }
        })
}

/// A comma list param, every item passing `ok`; None when malformed or too long.
fn list_param(v: Option<String>, ok: fn(&str) -> bool) -> Option<Vec<String>> {
    let Some(v) = v.filter(|v| !v.is_empty()) else {
        return Some(Vec::new());
    };
    let items: Vec<String> = v.split(',').map(str::to_owned).collect();
    (items.len() <= MAX_AVOID && items.iter().all(|i| ok(i))).then_some(items)
}

#[derive(Serialize)]
struct Answer<'a> {
    count: usize,
    connections: &'a [ConnectionItinerary],
}

/// GET /api/connections?city=<zbiorkom slug>&from=..&to=..; None = a BB request (`get_bb`, Node in proxy mode).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live`, called where the TS calls startZb (after every check).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let city = match req.zb_city() {
        Err(None) => return None,
        city => city,
    };
    let ip = req.ip();
    if !allow_request(&ip, GZM_COST) {
        return Some(too_many_requests());
    }
    let slug = match city {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    let p = match Params::parse(req) {
        Ok(p) => p,
        Err(res) => return Some(res),
    };
    let live = live(slug);
    Some(blocking_io(|| {
        budgeted(&ip, "gzm-connections", || {
            match live.connections(&p.query(), &p.avoid_types) {
                None => warming(),
                Some(c) => answer(&c),
            }
        })
    }))
}

/// GET /api/connections without a zbiorkom city: the search over the KB + MZK router index, today's running buses
/// boarded at their live times, each leg tagged with its operator and stored road shape.
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    let ip = req.ip();
    if !allow_request(&ip, 1.0) {
        return too_many_requests();
    }
    let p = match Params::parse(req) {
        Ok(p) => p,
        Err(res) => return res,
    };
    // the merged stop list needs both pollers' stops; a failed start still leaves name search working
    let _ = bb.start_poller().await;
    blocking_io(|| {
        budgeted(&ip, "connections", || {
            let view = (p.from_point.is_none() || p.to_point.is_none()).then(|| bb.merged_stops_view());
            let stop_ids = |key: &str| -> Vec<String> {
                let Some(m) = view.as_ref().and_then(|v| v.lookup(key)) else {
                    return Vec::new();
                };
                let kb = m.kb_id.iter().filter(|id| !id.is_empty()).cloned();
                kb.chain(mzk_symbols_of(m).into_iter().map(|s| format!("mzk:{s}")))
                    .collect()
            };
            let from_ids = if p.from_point.is_none() {
                stop_ids(&p.from)
            } else {
                Vec::new()
            };
            let to_ids = if p.to_point.is_none() {
                stop_ids(&p.to)
            } else {
                Vec::new()
            };
            let live = bb.bb_live_delay();
            let q = RouteQuery {
                from_ids: &from_ids,
                to_ids: &to_ids,
                live: live.as_ref().map(|f| f as &LiveFn),
                ..p.query()
            };
            let mut connections = find_connections(&q, get_index().as_deref());
            attach_leg_shapes(&mut connections, bb);
            answer(&connections)
        })
    })
}

/// The checked query of both branches, in the TS order of its 400s.
struct Params {
    from: String,
    to: String,
    from_point: Option<Point>,
    to_point: Option<Point>,
    after_secs: Option<i32>,
    arrive_by: bool,
    limit: Option<i32>,
    direct_only: bool,
    min_transfer_secs: Option<i32>,
    date: Option<String>,
    day_label: Option<String>,
    sort_by: SortBy,
    avoid_lines: Vec<String>,
    /// zbiorkom cities only (BB runs buses only)
    avoid_types: Vec<String>,
}

impl Params {
    fn parse(req: &ApiRequest) -> Result<Params, Response<Body>> {
        let param = |name: &str| query_param(&req.query, name);
        let from = param("from").unwrap_or_default();
        let to = param("to").unwrap_or_default();
        let time = param("time").unwrap_or_default();
        let date = param("date").unwrap_or_default();
        let day_label = param("dayLabel").filter(|d| !d.is_empty());
        let direct = param("direct").or_else(|| param("directOnly"));
        let min_transfer = param("minTransfer").unwrap_or_default();
        let sort_by = param("sortBy");
        let limit = param("limit").unwrap_or_default();
        let walk = param("walk").unwrap_or_default();
        let arrive_by = param("arriveBy");
        let avoid_lines = list_param(param("avoid"), line_ok);
        let avoid_types = list_param(param("avoidTypes"), |t| digits(t, 4));
        let Some(avoid_lines) = avoid_lines else {
            return Err(bad_request("Invalid 'avoid' parameter (comma-separated line names)"));
        };
        let Some(avoid_types) = avoid_types else {
            return Err(bad_request(
                "Invalid 'avoidTypes' parameter (comma-separated route types)",
            ));
        };

        let too_long = |s: &str| s.encode_utf16().count() > 100;
        if from.is_empty() || too_long(&from) {
            return Err(bad_request("Missing or invalid 'from' parameter"));
        }
        if to.is_empty() || too_long(&to) {
            return Err(bad_request("Missing or invalid 'to' parameter"));
        }
        let walk_m = (!walk.is_empty()).then(|| if int_ok(&walk) { js::number(&walk) } else { f64::NAN });
        if walk_m.is_some_and(|w| !(WALK_MIN_M..=WALK_MAX_M).contains(&w)) {
            return Err(bad_request("Invalid 'walk' parameter (metres, 200 to 1500)"));
        }
        let from_point = match from.starts_with("geo:") {
            true => match parse_point(&from, walk_m) {
                None => return Err(bad_request("Invalid 'from' location (expected geo:LAT,LON)")),
                p => p,
            },
            false => None,
        };
        let to_point = match to.starts_with("geo:") {
            true => match parse_point(&to, walk_m) {
                None => return Err(bad_request("Invalid 'to' location (expected geo:LAT,LON)")),
                p => p,
            },
            false => None,
        };
        let arrive_by = matches!(arrive_by.as_deref(), Some("true" | "1"));
        if arrive_by && time.is_empty() {
            return Err(bad_request("'arriveBy' needs a 'time'"));
        }
        let mut after_secs = None;
        if !time.is_empty() {
            if !time_ok(&time) {
                return Err(bad_request("Invalid 'time' parameter (expected HH:MM 24h format)"));
            }
            let n = |s: Option<&str>| s.and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
            after_secs = Some(n(time.get(..2)) * 3600 + n(time.get(3..)) * 60);
        }
        if !date.is_empty() && !is_valid_date(&date) {
            return Err(bad_request("Invalid 'date' parameter (expected YYYY-MM-DD)"));
        }
        if !min_transfer.is_empty() && !int_ok(&min_transfer) {
            return Err(bad_request("Invalid 'minTransfer' parameter (expected minutes)"));
        }
        if !limit.is_empty() && !int_ok(&limit) {
            return Err(bad_request("Invalid 'limit' parameter (expected an integer)"));
        }

        let int = |s: &str| (!s.is_empty()).then(|| s.parse::<i32>().unwrap_or(0));
        let sort_by = match sort_by.as_deref() {
            Some("duration") => SortBy::Duration,
            Some("arrival") => SortBy::Arrival,
            Some("transfers") => SortBy::Transfers,
            Some("walk") => SortBy::Walk,
            _ => SortBy::Departure,
        };
        Ok(Params {
            from_point,
            to_point,
            after_secs,
            arrive_by,
            limit: int(&limit),
            direct_only: matches!(direct.as_deref(), Some("true" | "1")),
            min_transfer_secs: int(&min_transfer).map(|m| m * 60),
            date: (!date.is_empty()).then_some(date),
            day_label,
            sort_by,
            avoid_lines,
            avoid_types,
            from,
            to,
        })
    }

    fn query(&self) -> RouteQuery<'_> {
        RouteQuery {
            from: &self.from,
            to: &self.to,
            from_point: self.from_point,
            to_point: self.to_point,
            after_secs: self.after_secs,
            arrive_by: self.arrive_by,
            limit: self.limit,
            direct_only: self.direct_only,
            min_transfer_secs: self.min_transfer_secs,
            date: self.date.as_deref(),
            day_label: self.day_label.as_deref(),
            sort_by: self.sort_by,
            avoid_lines: &self.avoid_lines,
            ..RouteQuery::default()
        }
    }
}

/// Runs a synchronous search inside the process-wide loop-time budget, charged what it took; 429 while overdrawn.
/// A panic is the route's catch: 500, logged under `tag`.
fn budgeted(ip: &str, tag: &str, search: impl FnOnce() -> Response<Body>) -> Response<Body> {
    // ponytail: a waiter parks a blocking thread until the running search ends (~230 ms on GZM), as the TS loop
    // holds every request for it; past max_blocking_threads + workers waiters, tasks stall for that long too
    let _turn = SEARCH_TURN.lock().unwrap_or_else(PoisonError::into_inner);
    if !allow_search() {
        return too_many_requests();
    }
    let t0 = Instant::now();
    let res = catch_unwind(AssertUnwindSafe(search)).unwrap_or_else(|panic| {
        let msg = panic.downcast_ref::<&str>().copied();
        let msg = msg.or_else(|| panic.downcast_ref::<String>().map(String::as_str));
        internal_error(tag, msg.unwrap_or("panic"))
    });
    charge_search(ip, t0.elapsed().as_secs_f64() * 1000.0);
    res
}

fn answer(connections: &[ConnectionItinerary]) -> Response<Body> {
    json_cached(
        &Answer {
            count: connections.len(),
            connections,
        },
        "public, max-age=60",
    )
}

/// attachLegShapes: every leg's operator, then the stored road-shape id of its trip pattern, so the client draws
/// legs from server geometry. Best effort: a store panic leaves the remaining ids off.
fn attach_leg_shapes<T: BbKinds>(connections: &mut [ConnectionItinerary], bb: &Bb<T>) {
    for leg in connections.iter_mut().flat_map(|c| c.legs.iter_mut()) {
        leg.operator = Some(if leg.trip_id.starts_with("mzk:") { "MZK" } else { "KB" });
    }
    let shapes = bb.shapes();
    let _ = catch_unwind(AssertUnwindSafe(|| {
        for leg in connections.iter_mut().flat_map(|c| c.legs.iter_mut()) {
            // MZK trip ids are mzk:<courseId>:<variantId>; the store keys a variant's shape mzk:<variantId>
            let key = match leg.operator {
                Some("MZK") => Some(format!("mzk:{}", leg.trip_id.rsplit_once(':').map_or("", |(_, v)| v))),
                _ => shapes.key_for_raw_trip(raw_trip_id(&leg.trip_id)),
            };
            if let Some(id) = key.and_then(|k| shapes.wire_id(&k)).filter(|id| !id.is_empty()) {
                leg.shape_id = Some(id);
            }
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        assert!(time_ok("00:00") && time_ok("23:59") && time_ok("19:05"));
        assert!(!time_ok("24:00") && !time_ok("7:50") && !time_ok("07:60") && !time_ok("07:5x"));
        assert!(line_ok("M1") && line_ok("Łódź 1.a_-") && line_ok("٣") && !line_ok("") && !line_ok("a+b"));
        assert!(line_ok("abcdefghijklmnop") && !line_ok("abcdefghijklmnopq"));
        assert_eq!(list_param(None, line_ok), Some(vec![]));
        assert_eq!(list_param(Some(String::new()), line_ok), Some(vec![]));
        assert_eq!(list_param(Some("1,,2".into()), line_ok), None);
        assert_eq!(list_param(Some(vec!["1"; 21].join(",")), line_ok), None);
        let p = parse_point("geo:50.12345678,19.1", None);
        assert!(p.is_none());
        let p = parse_point("geo:-50.123456,019.12347", Some(800.0)).map(|p| (p.lat, p.lon, p.walk_m));
        assert_eq!(p, Some((-50.1235, 19.1235, Some(800.0))));
        assert!(parse_point("geo:91,0", None).is_none() && parse_point("geo:1,2,3", None).is_none());
        assert!(parse_point("geo:-.5,1", None).is_none() && parse_point("geo:1.,1", None).is_none());
    }
}
