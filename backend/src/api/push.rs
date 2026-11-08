//! server/api/push/route.ts: GET the VAPID public key a browser subscribes with, POST `{subscription, alert}` (the
//! server also fires that "Powiadom mnie" alert as a web push), DELETE `{subscription, key}`. 404 while push is off.

use bytes::Bytes;
use hyper::header::{HeaderValue, RETRY_AFTER};
use hyper::{Method, Response, StatusCode};
use jiff::Timestamp;
use serde_json::json;

use super::{ApiRequest, json_cached};
use crate::api_helpers::{bad_request, internal_error, not_found, read_json_body};
use crate::config::PUSH_ENABLED;
use crate::fleet_tracker::blocking_io;
use crate::http::{Body, full, json};
use crate::push_alerts::{alert_input, get_push_alerts};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::web_push::{parse_push_sub, vapid};

/// readJsonBody's default cap.
pub(super) const MAX_BODY: usize = 4096;

/// The route, by the handler's method (the front lets only GET, POST and DELETE through).
pub fn handle(req: &ApiRequest) -> Response<Body> {
    if !*PUSH_ENABLED {
        return not_found("Not found");
    }
    let cost = if req.method == Method::POST { 5.0 } else { 1.0 };
    if !allow_request(&req.ip(), cost) {
        return too_many_requests();
    }
    if req.method == Method::GET {
        return match blocking_io(vapid) {
            Ok(k) => json_cached(&json!({ "key": k.public }), "no-cache"),
            Err(err) => internal_error("push-key", err),
        };
    }
    let body = read_json_body(&req.headers, req.body.as_deref(), MAX_BODY).unwrap_or_default();
    let sub = parse_push_sub(&body["subscription"]);
    if req.method == Method::POST {
        let now_sec = Timestamp::now().as_millisecond() as f64 / 1000.0;
        let (Some(sub), Some(alert)) = (sub, alert_input(&body["alert"], now_sec)) else {
            return bad_request("Invalid subscription or alert");
        };
        if !get_push_alerts().add(&sub, &alert) {
            return full_store("Too many alerts", "300");
        }
        return no_content();
    }
    let (Some(sub), Some(key)) = (sub, body["key"].as_str()) else {
        return bad_request("Invalid subscription or key");
    };
    get_push_alerts().remove(&sub.endpoint, key);
    no_content()
}

/// `new Response(null, { status: 204 })`.
pub(super) fn no_content() -> Response<Body> {
    let mut res = Response::new(full(Bytes::new()));
    *res.status_mut() = StatusCode::NO_CONTENT;
    res
}

/// 503 `{ error }` with Retry-After `retry` seconds: the store is full.
pub(super) fn full_store(error: &str, retry: &'static str) -> Response<Body> {
    let mut res = json(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": error }).to_string());
    res.headers_mut().insert(RETRY_AFTER, HeaderValue::from_static(retry));
    res
}
