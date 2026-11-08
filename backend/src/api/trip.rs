//! server/api/trip/[tripId]/route.ts: the zbiorkom branch (a static trip of the city's feed; opening it requests
//! the road match of its shape) and, in owned mode, the BB branch (KB upstream passthrough, MZK from mzk_trip).

use std::sync::Arc;

use hyper::Response;
use serde_json::{Map, Value, json};

use super::announcements::message_of;
use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{bad_request, is_valid_id, not_found, query_param, upstream_error, warming, zb_enabled};
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::js;
use crate::kb_api::{KbSource, parse_int_strict_str, py_truthy};
use crate::mzk_trip::resolve_mzk_trip;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shape_store::ShapePrio;
use crate::shared::cities::zb_city_of;

/// `?index=`: absent = 0, else lib/kb-api.ts parseIntStrict (`/^[+-]?\d+$/` after trim); None = the route's 400.
// ponytail: an index past 2^53 goes upstream as the i64 of the JS double, where the TS prints the double; upstream
// has no such trip either way
pub(super) fn index_of(query: &str) -> Option<i64> {
    match query_param(query, "index") {
        None => Some(0),
        Some(raw) => parse_int_strict_str(&raw).map(|x| x as i64),
    }
}

/// `{...v}` of an object literal for the kinds the routes spread: an object's entries, an array's under its index
/// keys, nothing for anything else.
// ponytail: a deep clone where the TS spread copies references (a few KB per KB trip, at most 300 per batch); a
// serializer writing the shared object plus the extra keys if a profile ever shows it
pub(super) fn spread(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m.clone(),
        Some(Value::Array(a)) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        _ => Map::new(),
    }
}

/// `{...res.trip, shape: res.shape, ...(res.shape_id ? { shape_id } : {}), shape_status: res.shape_status}` of a
/// resolveMzkTrip result.
pub(super) fn mzk_trip_body(res: &Map<String, Value>) -> Map<String, Value> {
    let mut out = spread(res.get("trip"));
    let mut set = |key: &str| match res.get(key) {
        Some(v) => {
            out.insert(key.to_owned(), v.clone());
        }
        // `key: undefined` overrides a spread key and JSON.stringify drops it
        None => {
            out.shift_remove(key);
        }
    };
    set("shape");
    if js::truthy(res.get("shape_id")) {
        set("shape_id");
    }
    set("shape_status");
    out
}

/// GET /api/trip/<zbiorkom trip id>[?index=N]; None = not a zbiorkom trip (`get_bb` in owned mode, Node in proxy
/// mode).
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
    if index_of(&req.query).is_none() {
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

/// GET /api/trip/<KB trip id | mzk:..>[?index=N] of BB: the KB upstream trip (the shared cache object spread, never
/// mutated) with its road-shape ref, or the static MZK course; `{}` = upstream returned nothing.
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    if !allow_request(&req.ip(), 1.0) {
        return too_many_requests();
    }
    if !is_valid_id(&req.param) {
        return bad_request("Invalid trip id");
    }
    let Some(index) = index_of(&req.query) else {
        return bad_request("index must be an integer");
    };
    if let Err(err) = bb.start_poller().await {
        return upstream_error("trip", err);
    }
    if req.param.starts_with("mzk:") {
        const CACHE: &str = "public, max-age=300";
        return match resolve_mzk_trip(bb, &req.param, false).await {
            Ok(Some(res)) => json_cached(&mzk_trip_body(&res), CACHE),
            Ok(None) => json_cached(&json!({}), CACHE),
            Err(err) => upstream_error("trip", message_of(&err)),
        };
    }
    let data = match bb.api().fetch_trip_raw(&req.param, index).await {
        Ok(data) => data,
        Err(err) => return upstream_error("trip", message_of(&err)),
    };
    if !py_truthy(Some(&data)) || !(data.is_object() || data.is_array()) {
        return json_cached(&json!({}), "public, max-age=3600");
    }
    let shape = bb.kb_shape_ref(&data, ShapePrio::Urgent);
    // a pending road shape is usually ready within minutes: don't pin the status for an hour
    let cache = match shape.get("shape_status").and_then(Value::as_str) {
        Some("pending") => "public, max-age=300",
        _ => "public, max-age=3600",
    };
    let mut body = spread(Some(&data));
    body.extend(shape);
    json_cached(&body, cache)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spreads_like_an_object_literal() {
        assert_eq!(
            Value::Object(spread(Some(&json!(["a", "b"])))),
            json!({"0": "a", "1": "b"})
        );
        assert!(spread(Some(&json!("x"))).is_empty());
        assert!(spread(None).is_empty());
        let res = json!({"trip": {"shape": 1, "shape_id": "own", "a": 2}, "shape_id": "", "shape_status": "none"});
        let body = Value::Object(mzk_trip_body(res.as_object().unwrap_or(&Map::new())));
        // `shape: undefined` drops the trip's key, a falsy shape_id keeps the trip's own
        assert_eq!(body.to_string(), r#"{"shape_id":"own","a":2,"shape_status":"none"}"#);
    }

    #[test]
    fn index_follows_parse_int_strict() {
        assert_eq!(index_of(""), Some(0));
        assert_eq!(index_of("index=%2B3"), Some(3));
        assert_eq!(index_of("index=-2"), Some(-2));
        assert_eq!(index_of("index="), None);
        assert_eq!(index_of("index=1.5"), None);
    }
}
