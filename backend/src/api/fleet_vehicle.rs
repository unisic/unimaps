//! server/api/fleet/[sideNumber]/route.ts, GZM branch: one vehicle's card, an idle card for a vehicle on the map the
//! tracker never saw on a course, plus `tech` / `photos` from the bundled phototrans index.

use std::sync::Arc;

use hyper::Response;

use super::ApiRequest;
use super::fleet::{VehicleBody, vehicle_not_found};
use crate::api_helpers::{bad_request, json_with_etag, not_found};
use crate::fleet_tracker::{FleetTracker, blocking_io};
use crate::gzm::{GzmLive, ZbTransport, get_gzm, start_gzm};
use crate::gzm_fleet::{get_gzm_fleet_tracker, idle_detail_of, is_gzm_side};
use crate::http::Body;
use crate::phototrans::pt_vehicle;

/// GET /api/fleet/<side>?city=<zbiorkom slug>; None = a BB request (Node answers it).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    blocking_io(|| {
        handle(req, || {
            start_gzm();
            (get_gzm_fleet_tracker(), get_gzm())
        })
    })
}

/// The route with the GZM tracker and live layer from `gzm` (called where the TS starts GZM; a test passes its own).
pub fn handle<'t, T: ZbTransport>(
    req: &ApiRequest,
    gzm: impl FnOnce() -> (&'t FleetTracker, Arc<GzmLive<T>>),
) -> Option<Response<Body>> {
    let slug = match req.zb_city() {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    if slug != "gzm" {
        return Some(not_found("Not found"));
    }
    let side = req.param.as_str();
    if !is_gzm_side(side) {
        return Some(bad_request("Invalid sideNumber"));
    }
    let (tracker, live) = gzm();
    let detail = tracker
        .get_vehicle_detail(side)
        .or_else(|| live.live_vehicle(side).map(|v| idle_detail_of(tracker, side, &v)));
    let Some(mut detail) = detail else {
        return Some(vehicle_not_found());
    };
    if let Some(pt) = pt_vehicle("gzm", side) {
        detail.tech = Some(pt.tech);
        detail.photos = Some(pt.photos);
    }
    Some(json_with_etag(&req.headers, &VehicleBody { vehicle: &detail }))
}
