//! server/api/fleet/timeline/route.ts: today's punctuality of the running GZM or MZK fleet in 5-minute slots.

use hyper::Response;
use serde::Serialize;

use super::ApiRequest;
use super::fleet::gzm_tracker;
use crate::api_helpers::{json_with_etag, not_found, upstream_error};
use crate::fleet_tracker::{FleetTracker, blocking_io};
use crate::http::Body;
use crate::poller_singleton::{Bb, BbKinds};
use crate::shared::fleet::{FleetTimelinePoint, TIMELINE_SLOT_SECS};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Timeline {
    slot_secs: i64,
    points: Vec<FleetTimelinePoint>,
}

/// GET /api/fleet/timeline?city=<zbiorkom slug>; None = a BB request (`get_bb` in owned mode,
/// Node in proxy mode).
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
    Some(answer(req, tracker()))
}

/// The BB branch (no `?city=`) over the MZK tracker from `tracker` (the dispatcher passes `get_fleet_tracker`).
pub async fn get_bb<T: BbKinds>(
    req: &ApiRequest,
    bb: &'static Bb<T>,
    tracker: impl FnOnce() -> &'static FleetTracker,
) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return upstream_error("fleet-timeline", err);
    }
    blocking_io(|| answer(req, tracker()))
}

fn answer(req: &ApiRequest, tracker: &FleetTracker) -> Response<Body> {
    let body = Timeline {
        slot_secs: TIMELINE_SLOT_SECS,
        points: tracker.get_timeline(),
    };
    json_with_etag(&req.headers, &body)
}
