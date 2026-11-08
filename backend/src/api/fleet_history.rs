//! server/api/fleet/[sideNumber]/history/route.ts, GZM branch: a vehicle's past days, newest first.

use hyper::Response;

use super::ApiRequest;
use super::fleet::gzm_tracker;
use crate::api_helpers::{bad_request, json_with_etag, not_found};
use crate::fleet_tracker::{FleetTracker, blocking_io};
use crate::gzm_fleet::is_gzm_side;
use crate::http::Body;

/// GET /api/fleet/<side>/history?city=<zbiorkom slug>; None = a BB request (Node answers it).
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
    if !is_gzm_side(&req.param) {
        return Some(bad_request("Invalid sideNumber"));
    }
    Some(json_with_etag(&req.headers, &tracker().vehicle_history(&req.param)))
}
