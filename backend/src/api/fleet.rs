//! server/api/fleet/route.ts. GZM: the whole fleet list (built and hashed once per tracker update), its filtered
//! form, or one vehicle's card by `?sideNumber=`; another zbiorkom city has no fleet tracker: 404. BB (no `?city=`):
//! the MZK fleet list with `serverNow`, or one vehicle's card.

use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, HeaderName, HeaderValue};
use hyper::{Response, StatusCode};
use jiff::Timestamp;
use serde::Serialize;
use serde_json::json;

use super::ApiRequest;
use super::stop_departures::json_no_store;
use crate::api_helpers::{bad_request, etag_matches, json_with_etag, not_found, query_param, upstream_error};
use crate::fleet_tracker::{FleetSummaryFilter, FleetTracker, blocking_io};
use crate::gzm::start_gzm;
use crate::gzm_fleet::{ListBody, fleet_list_body, get_gzm_fleet_tracker, is_gzm_side};
use crate::http::{Body, full, header_str};
use crate::js::{self, JsNum};
use crate::poller_singleton::{Bb, BbKinds};
use crate::shared::fleet::{FleetStats, FleetSummaryItem, FleetVehicleDetail, VehicleStatus};

const X_SERVER_TIME: HeaderName = HeaderName::from_static("x-server-time");
const FILTER_PARAMS: [&str; 4] = ["status", "propulsion", "line", "q"];

/// summaryFilter(url): the query values a `FleetSummaryFilter` borrows.
struct Filter {
    status: Option<VehicleStatus>,
    propulsion: Option<String>,
    line: Option<String>,
    q: Option<String>,
}

impl Filter {
    fn parse(query: &str) -> Self {
        let status = match query_param(query, "status").as_deref() {
            Some("active") => Some(VehicleStatus::Active),
            Some("depot") => Some(VehicleStatus::Depot),
            _ => None,
        };
        Filter {
            status,
            propulsion: query_param(query, "propulsion"),
            line: query_param(query, "line"),
            q: query_param(query, "q"),
        }
    }

    fn get(&self) -> FleetSummaryFilter<'_> {
        FleetSummaryFilter {
            status: self.status,
            propulsion: self.propulsion.as_deref(),
            line: self.line.as_deref(),
            // ponytail: a 64th UTF-16 unit that splits a pair drops the pair (the TS keeps a lone surrogate)
            query: self.q.as_deref().map(|q| js::utf16_prefix(q, 64)),
        }
    }
}

/// The BB list: `{ stats, count, vehicles, serverNow }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BbList<'a> {
    stats: &'a FleetStats,
    count: usize,
    vehicles: &'a [FleetSummaryItem],
    server_now: JsNum,
}

/// `{ vehicle: detail }` of the card routes.
#[derive(Serialize)]
pub(super) struct VehicleBody<'a> {
    pub(super) vehicle: &'a FleetVehicleDetail,
}

/// 404 `{"error":"Vehicle not found"}` with the routes' NO_STORE headers.
pub(super) fn vehicle_not_found() -> Response<Body> {
    let mut res = json_no_store(&json!({ "error": "Vehicle not found" }));
    *res.status_mut() = StatusCode::NOT_FOUND;
    res
}

/// `void startGzm(); getGzmFleetTracker()`. The tracker's first use reads today's file, so the routes run on
/// `blocking_io`.
pub(super) fn gzm_tracker() -> &'static FleetTracker {
    start_gzm();
    get_gzm_fleet_tracker()
}

/// GET /api/fleet?city=<zbiorkom slug>; None = a BB request (`get_bb`).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    blocking_io(|| handle(req, gzm_tracker))
}

/// The route with the GZM tracker from `tracker` (called where the TS starts GZM; a test passes its own tracker).
pub fn handle<'t>(req: &ApiRequest, tracker: impl FnOnce() -> &'t FleetTracker) -> Option<Response<Body>> {
    let slug = match req.zb_city() {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    if slug != "gzm" {
        return Some(not_found("Not found"));
    }
    let tracker = tracker();
    if let Some(side) = query_param(&req.query, "sideNumber").filter(|s| !s.is_empty()) {
        if !is_gzm_side(&side) {
            return Some(bad_request("Invalid sideNumber"));
        }
        return Some(match tracker.get_vehicle_detail(&side) {
            Some(detail) => json_with_etag(&req.headers, &VehicleBody { vehicle: &detail }),
            None => vehicle_not_found(),
        });
    }

    if FILTER_PARAMS.iter().any(|k| query_param(&req.query, k).is_some()) {
        let (_, vehicles, stats) = tracker.list_snapshot(&Filter::parse(&req.query).get());
        let body = ListBody {
            stats: &stats,
            count: vehicles.len(),
            vehicles: &vehicles,
        };
        return Some(json_with_etag(&req.headers, &body));
    }

    let list = fleet_list_body(tracker);
    let hit = etag_matches(header_str(&req.headers, "if-none-match").as_deref(), &list.etag);
    let mut res = Response::new(full(if hit { String::new() } else { list.body.clone() }));
    if hit {
        *res.status_mut() = StatusCode::NOT_MODIFIED;
    }
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(v) = HeaderValue::from_str(&list.etag) {
        h.insert(ETAG, v);
    }
    h.insert(X_SERVER_TIME, HeaderValue::from(Timestamp::now().as_millisecond()));
    Some(res)
}

/// The BB branch (no `?city=`) over the MZK tracker from `tracker` (the dispatcher passes `get_fleet_tracker`).
pub async fn get_bb<T: BbKinds>(
    req: &ApiRequest,
    bb: &'static Bb<T>,
    tracker: impl FnOnce() -> &'static FleetTracker,
) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return upstream_error("fleet", err);
    }
    blocking_io(|| {
        let tracker = tracker();
        if let Some(side) = query_param(&req.query, "sideNumber").filter(|s| !s.is_empty()) {
            let detail = if side.encode_utf16().count() <= 16 {
                tracker.get_vehicle_detail(&side)
            } else {
                None
            };
            return match detail {
                Some(detail) => json_with_etag(&req.headers, &VehicleBody { vehicle: &detail }),
                None => vehicle_not_found(),
            };
        }
        let (_, vehicles, stats) = tracker.list_snapshot(&Filter::parse(&req.query).get());
        json_no_store(&BbList {
            stats: &stats,
            count: vehicles.len(),
            vehicles: &vehicles,
            server_now: JsNum(bb.now_ms() as f64 / 1000.0),
        })
    })
}
