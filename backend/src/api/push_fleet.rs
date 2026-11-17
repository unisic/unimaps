//! POST `{subscription, side}` pushes this browser once when that vehicle starts a course ("Powiadom, gdy wyjedzie"
//! on /brygady), DELETE `{subscription, side}` cancels it. 404 while push is off.

use hyper::{Method, Response};

use super::ApiRequest;
use super::push::{MAX_BODY, full_store, no_content};
use crate::api_helpers::{bad_request, not_found, read_json_body};
use crate::config::{GZM_ENABLED, PUSH_ENABLED};
use crate::gzm_fleet::is_gzm_side;
use crate::http::Body;
use crate::push_fleet::{get_push_fleet, is_fleet_side};
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
    let side = body["side"]
        .as_str()
        .filter(|s| is_fleet_side(s) && (*GZM_ENABLED || !is_gzm_side(s)));
    let (Some(sub), Some(side)) = (parse_push_sub(&body["subscription"]), side) else {
        return bad_request("Invalid subscription or side");
    };
    if !post {
        get_push_fleet().remove(&sub.endpoint, side);
        return no_content();
    }
    if !get_push_fleet().add(&sub, side) {
        return full_store("Too many watches", "3600");
    }
    no_content()
}
