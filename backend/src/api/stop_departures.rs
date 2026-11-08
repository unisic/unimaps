//! server/api/stop/[designator]/departures/route.ts, zbiorkom branch: a pole's board (with `all=1` the whole
//! stop's) from the city's local feed plus the live join, never an upstream call. A call from our own Node child
//! (push alerts reading a zbiorkom board) carries the per-start token and skips the rate limit.

use std::sync::Arc;

use hyper::Response;
use hyper::header::{HeaderValue, PRAGMA};
use serde::Serialize;

use super::{ApiRequest, is_internal, json_cached, zb_live};
use crate::api_helpers::{bad_request, is_valid_id, not_found, query_param, warming, zb_enabled};
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;

/// `Response.json(data, { headers: { "Cache-Control": "no-store, ...", Pragma: "no-cache" } })` of the live routes.
pub(super) fn json_no_store(data: &impl Serialize) -> Response<Body> {
    let mut res = json_cached(data, "no-store, no-cache, must-revalidate, max-age=0");
    res.headers_mut().insert(PRAGMA, HeaderValue::from_static("no-cache"));
    res
}

/// GET /api/stop/<zbiorkom designator>/departures[?all=1]; None = not a zbiorkom stop (Node answers it).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let slug = zb_city_of(&req.param)?;
    if !is_internal(&req.headers) && !allow_request(&req.ip(), 1.0) {
        return Some(too_many_requests());
    }
    if !is_valid_id(&req.param) {
        return Some(bad_request("Invalid stop designator"));
    }
    let all = match query_param(&req.query, "all").as_deref() {
        None => false,
        Some("1") => true,
        Some(_) => return Some(bad_request("Invalid all")),
    };
    if !zb_enabled(slug) {
        return Some(not_found("Not found"));
    }
    Some(match live(slug).departures(&req.param, all) {
        Lookup::Loading => warming(),
        Lookup::Unknown => not_found("Unknown stop"),
        Lookup::Found(board) => json_no_store(&board),
    })
}

#[cfg(test)]
mod tests {
    use hyper::StatusCode;
    use hyper::header::HeaderMap;

    use super::*;
    use crate::api::{INTERNAL_TOKEN, set_internal_token};
    use crate::gzm::HttpZb;

    fn req(ip: &str, token: Option<&str>) -> ApiRequest {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_str(ip).unwrap());
        if let Some(t) = token {
            headers.insert("x-kb-internal", HeaderValue::from_str(t).unwrap());
        }
        ApiRequest {
            param: "gzm:1".into(),
            query: String::new(),
            headers,
        }
    }

    fn status(req: &ApiRequest) -> StatusCode {
        let live = Arc::new(GzmLive::new("gzm", HttpZb).with_feed(Arc::new(|| None)));
        handle(req, |_| live).unwrap().status()
    }

    #[test]
    fn internal_token_skips_the_rate_limit() {
        set_internal_token("ab".repeat(32));
        let token = INTERNAL_TOKEN.get().unwrap().clone();
        let ip = "203.0.113.77";
        // drained right before each call: the bucket refills one token per 25 ms
        let limited = (0..3).any(|_| {
            while allow_request(ip, 1.0) {}
            status(&req(ip, None)) == StatusCode::TOO_MANY_REQUESTS
        });
        assert!(limited);
        while allow_request(ip, 1.0) {}
        assert_eq!(status(&req(ip, Some(&token))), StatusCode::SERVICE_UNAVAILABLE);
    }
}
