//! server/api/trip/[tripId]/route.ts, zbiorkom branch: a static trip of the city's feed; opening it requests the
//! road match of its shape.

use std::sync::Arc;

use hyper::Response;
use serde_json::json;

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{bad_request, is_valid_id, not_found, query_param, warming, zb_enabled};
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::js;
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;

/// `?index=` absent, or a string lib/kb-api.ts parseIntStrict accepts (`/^[+-]?\d+$/` after trim).
pub(super) fn index_ok(query: &str) -> bool {
    query_param(query, "index").is_none_or(|raw| {
        let t = raw.trim_matches(js::is_space);
        let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
    })
}

/// GET /api/trip/<zbiorkom trip id>[?index=N]; None = not a zbiorkom trip (Node answers it).
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
        return Some(bad_request("Invalid trip id"));
    }
    if !index_ok(&req.query) {
        return Some(bad_request("index must be an integer"));
    }
    if !zb_enabled(slug) {
        return Some(not_found("Not found"));
    }
    const CACHE: &str = "public, max-age=300";
    Some(match live(slug).trip(&req.param, true) {
        Lookup::Loading => warming(),
        // not in the day's feed (a stale id from yesterday's)
        Lookup::Unknown => json_cached(&json!({}), CACHE),
        Lookup::Found(trip) => json_cached(&trip, CACHE),
    })
}
