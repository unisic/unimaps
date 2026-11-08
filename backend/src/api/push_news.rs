//! server/api/push/news/route.ts: POST `{subscription, city}` pushes this browser the city's new announcements,
//! DELETE `{subscription, city}` stops it. 404 while push is off.

use hyper::{Method, Response};

use super::ApiRequest;
use super::push::{MAX_BODY, full_store, no_content};
use crate::api_helpers::{bad_request, not_found, read_json_body};
use crate::config::{GZM_ENABLED, PUSH_ENABLED};
use crate::http::Body;
use crate::push_news::{City, get_push_news, parse_city};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::web_push::parse_push_sub;

/// The route, by the handler's method (the front lets only POST and DELETE through).
pub fn handle(req: &ApiRequest) -> Response<Body> {
    if !*PUSH_ENABLED {
        return not_found("Not found");
    }
    let post = req.method == Method::POST;
    if !allow_request(&req.ip(), if post { 5.0 } else { 1.0 }) {
        return too_many_requests();
    }
    let body = read_json_body(&req.headers, req.body.as_deref(), MAX_BODY).unwrap_or_default();
    let (Some(sub), Some(city)) = (parse_push_sub(&body["subscription"]), parse_city(&body["city"])) else {
        return bad_request("Invalid subscription or city");
    };
    if !post {
        get_push_news().remove(&sub.endpoint, city);
        return no_content();
    }
    if city == City::Gzm && !*GZM_ENABLED {
        return bad_request("Invalid subscription or city");
    }
    if !get_push_news().add(&sub, &body["subscription"], city) {
        return full_store("Too many subscriptions", "3600");
    }
    no_content()
}
