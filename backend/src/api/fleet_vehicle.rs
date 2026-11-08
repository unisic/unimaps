//! server/api/fleet/[sideNumber]/route.ts: one GZM or MZK vehicle's card (GZM: an idle card for a vehicle on the map
//! the tracker never saw on a course), plus `tech` / `photos` from the bundled phototrans index.

use std::sync::Arc;

use hyper::Response;

use super::ApiRequest;
use super::fleet::{VehicleBody, vehicle_not_found};
use crate::api_helpers::{bad_request, json_with_etag, not_found, upstream_error};
use crate::fleet_tracker::{FleetTracker, blocking_io};
use crate::gzm::{GzmLive, ZbTransport, get_gzm, start_gzm};
use crate::gzm_fleet::{get_gzm_fleet_tracker, idle_detail_of, is_gzm_side};
use crate::http::Body;
use crate::phototrans::pt_vehicle;
use crate::poller_singleton::{Bb, BbKinds};
use crate::shared::fleet::FleetVehicleDetail;

/// GET /api/fleet/<side>?city=<zbiorkom slug>; None = a BB request (`get_bb`).
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
    Some(answer(req, "gzm", detail))
}

/// The BB branch (no `?city=`) over the MZK tracker from `tracker` (the dispatcher passes `get_fleet_tracker`).
pub async fn get_bb<T: BbKinds>(
    req: &ApiRequest,
    bb: &'static Bb<T>,
    tracker: impl FnOnce() -> &'static FleetTracker,
) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return upstream_error("fleet-detail", err);
    }
    let side = req.param.as_str();
    blocking_io(|| {
        let detail = if side.encode_utf16().count() <= 16 {
            tracker().get_vehicle_detail(side)
        } else {
            None
        };
        answer(req, "bb", detail)
    })
}

/// 404 without a card, else the card with the phototrans `tech` and `photos` of `city`.
fn answer(req: &ApiRequest, city: &str, detail: Option<FleetVehicleDetail>) -> Response<Body> {
    let Some(mut detail) = detail else {
        return vehicle_not_found();
    };
    if let Some(pt) = pt_vehicle(city, &req.param) {
        detail.tech = Some(pt.tech);
        detail.photos = Some(pt.photos);
    }
    json_with_etag(&req.headers, &VehicleBody { vehicle: &detail })
}
