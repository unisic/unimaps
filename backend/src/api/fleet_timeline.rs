//! server/api/fleet/timeline/route.ts, GZM branch: today's punctuality of the running fleet in 5-minute slots.

use hyper::Response;
use serde::Serialize;

use super::ApiRequest;
use super::fleet::gzm_tracker;
use crate::api_helpers::{json_with_etag, not_found};
use crate::fleet_tracker::{FleetTracker, blocking_io};
use crate::http::Body;
use crate::shared::fleet::{FleetTimelinePoint, TIMELINE_SLOT_SECS};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Timeline {
    slot_secs: i64,
    points: Vec<FleetTimelinePoint>,
}

/// GET /api/fleet/timeline?city=<zbiorkom slug>; None = a BB request (Node answers it).
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
    let body = Timeline {
        slot_secs: TIMELINE_SLOT_SECS,
        points: tracker().get_timeline(),
    };
    Some(json_with_etag(&req.headers, &body))
}
