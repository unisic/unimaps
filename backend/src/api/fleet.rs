//! server/api/fleet/route.ts, GZM branch: the whole fleet list (built and hashed once per tracker update), its
//! filtered form, or one vehicle's card by `?sideNumber=`. Another zbiorkom city has no fleet tracker: 404.

use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, HeaderName, HeaderValue};
use hyper::{Response, StatusCode};
use jiff::Timestamp;
use serde::Serialize;
use serde_json::json;

use super::ApiRequest;
use super::stop_departures::json_no_store;
use crate::api_helpers::{bad_request, etag_matches, json_with_etag, not_found, query_param};
use crate::fleet_tracker::{FleetSummaryFilter, FleetTracker, blocking_io};
use crate::gzm::start_gzm;
use crate::gzm_fleet::{ListBody, fleet_list_body, get_gzm_fleet_tracker, is_gzm_side};
use crate::http::{Body, full, header_str};
use crate::js;
use crate::shared::fleet::{FleetVehicleDetail, VehicleStatus};

const X_SERVER_TIME: HeaderName = HeaderName::from_static("x-server-time");
const FILTER_PARAMS: [&str; 4] = ["status", "propulsion", "line", "q"];

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

/// GET /api/fleet?city=<zbiorkom slug>; None = a BB request (Node answers it).
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
        let status = match query_param(&req.query, "status").as_deref() {
            Some("active") => Some(VehicleStatus::Active),
            Some("depot") => Some(VehicleStatus::Depot),
            _ => None,
        };
        let propulsion = query_param(&req.query, "propulsion");
        let line = query_param(&req.query, "line");
        let q = query_param(&req.query, "q");
        // ponytail: a 64th UTF-16 unit that splits a pair drops the pair (the TS keeps a lone surrogate)
        let vehicles = tracker.get_fleet_summary(&FleetSummaryFilter {
            status,
            propulsion: propulsion.as_deref(),
            line: line.as_deref(),
            query: q.as_deref().map(|q| js::utf16_prefix(q, 64)),
        });
        let stats = tracker.get_stats();
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
