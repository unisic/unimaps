//! server/api/stop/[designator]/timetable/route.ts, zbiorkom branch: a pole's whole-day timetable from the city's
//! local feed.

use std::sync::Arc;

use hyper::Response;

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{bad_request, is_valid_date, is_valid_id, not_found, query_param, warming, zb_enabled};
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;
use crate::time::today_local;

/// GET /api/stop/<zbiorkom designator>/timetable[?date=YYYY-MM-DD]; None = not a zbiorkom stop (Node answers it).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let slug = zb_city_of(&req.param)?;
    if !allow_request(&req.ip(), 1.0) {
        return Some(too_many_requests());
    }
    if !is_valid_id(&req.param) {
        return Some(bad_request("Invalid stop designator"));
    }
    let date = query_param(&req.query, "date")
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| today_local().to_string());
    if !is_valid_date(&date) {
        return Some(bad_request("date must be YYYY-MM-DD"));
    }
    if !zb_enabled(slug) {
        return Some(not_found("Not found"));
    }
    Some(match live(slug).timetable(&req.param, &date) {
        Lookup::Loading => warming(),
        Lookup::Unknown => not_found("Unknown stop"),
        Lookup::Found(tt) => json_cached(&tt, "public, max-age=900"),
    })
}
