//! server/api/trip_execution/route.ts, zbiorkom branch: the live trip of a vehicle on the city's map, answered
//! from memory.

use std::sync::Arc;

use hyper::Response;
use serde_json::json;

use super::stop_departures::json_no_store;
use super::trip::index_ok;
use super::{ApiRequest, zb_live};
use crate::api_helpers::{bad_request, not_found, query_param, zb_enabled};
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::Body;
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;

/// ZB_EXEC_RE `/^[a-zA-Z]+:\d{1,4}_[A-Za-z0-9_.-]{1,36}$/`: `<slug>:<type>_<vehicle>` (GZM `<op>_<fleet>`).
fn zb_exec_ok(id: &str) -> bool {
    let Some((city, rest)) = id.split_once(':') else {
        return false;
    };
    let Some((kind, vehicle)) = rest.split_once('_') else {
        return false;
    };
    !city.is_empty()
        && city.bytes().all(|b| b.is_ascii_alphabetic())
        && (1..=4).contains(&kind.len())
        && kind.bytes().all(|b| b.is_ascii_digit())
        && (1..=36).contains(&vehicle.len())
        && vehicle
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// GET /api/trip_execution?exec_id=<zbiorkom vehicle id>[&index=N]; None = not a zbiorkom id (Node answers it).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    // a zbiorkom id is never empty: the TS 400 for a missing exec_id is Node's
    let exec_id = query_param(&req.query, "exec_id")?;
    let slug = zb_city_of(&exec_id)?;
    if !allow_request(&req.ip(), 1.0) {
        return Some(too_many_requests());
    }
    if !index_ok(&req.query) {
        return Some(bad_request("index must be an integer"));
    }
    if !zb_enabled(slug) {
        return Some(not_found("Not found"));
    }
    if !zb_exec_ok(&exec_id) {
        return Some(bad_request("Invalid exec_id"));
    }
    let trip = live(slug).trip_execution(&exec_id).unwrap_or_else(|| json!({}));
    Some(json_no_store(&trip))
}
