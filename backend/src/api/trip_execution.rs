//! server/api/trip_execution/route.ts: the zbiorkom branch (the live trip of a vehicle on the city's map, answered
//! from memory) and, in owned mode, the BB branch (KB upstream passthrough fed into the poller, MZK from mzk_trip).

use std::sync::Arc;

use hyper::Response;
use serde_json::{Map, Value, json};

use super::announcements::message_of;
use super::stop_departures::json_no_store;
use super::trip::index_of;
use super::{ApiRequest, zb_live};
use crate::api_helpers::{bad_request, not_found, query_param, upstream_error, zb_enabled};
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::Body;
use crate::js;
use crate::kb_api::{KbSource, py_truthy};
use crate::mzk_trip::resolve_mzk_trip;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shape_store::ShapePrio;
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

/// GET /api/trip_execution?exec_id=<zbiorkom vehicle id>[&index=N]; None = not a zbiorkom id (`get_bb` in owned
/// mode, Node in proxy mode).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    // a zbiorkom id is never empty: the TS 400 for a missing exec_id is `get_bb`'s
    let exec_id = query_param(&req.query, "exec_id")?;
    let slug = zb_city_of(&exec_id)?;
    if !allow_request(&req.ip(), 1.0) {
        return Some(too_many_requests());
    }
    if index_of(&req.query).is_none() {
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

/// GET /api/trip_execution?exec_id=<raw KB exec id | mzk:..>[&index=N] of BB. A KB id is base64-encoded by the
/// client (`fetch_trip_execution`), so it skips `is_valid_id` on purpose; the reply is ingested into the live
/// positions and answered with its road-shape ref and recorded arrivals.
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    if !allow_request(&req.ip(), 1.0) {
        return too_many_requests();
    }
    let exec_id = query_param(&req.query, "exec_id").unwrap_or_default();
    if exec_id.is_empty() {
        return bad_request("exec_id query parameter is required");
    }
    let Some(index) = index_of(&req.query) else {
        return bad_request("index must be an integer");
    };
    if let Err(err) = bb.start_poller().await {
        return upstream_error("trip_execution", err);
    }
    if exec_id.starts_with("mzk:") {
        return match resolve_mzk_trip(bb, &exec_id, true).await {
            Ok(trip) => json_no_store(&trip.unwrap_or_default()),
            Err(err) => upstream_error("trip_execution", message_of(&err)),
        };
    }
    // a reply landing after a newer poller fix must not overwrite it
    let req_ms = bb.now_ms();
    let data = match bb.api().fetch_trip_execution(&exec_id, index).await {
        Ok(data) => data,
        Err(err) => return upstream_error("trip_execution", message_of(&err)),
    };
    if !py_truthy(Some(&data)) {
        return json_no_store(&json!({}));
    }
    if !data.is_object() {
        return json_no_store(&data);
    }
    let pos = bb.poller().ingest_trip_execution(&exec_id, &data, Some(req_ms));
    let trip = data.get("trip").filter(|t| t.is_object()).unwrap_or(&Value::Null);
    let shape = bb.kb_shape_ref(trip, ShapePrio::Urgent);
    let mut body = match data {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    body.extend(shape);
    // epoch secs per times[] position, which upstream drops for passed stops
    if let Some(a) = pos.as_ref().and_then(|p| p.arrivals.as_ref()) {
        let arrived = a.arrived.iter().map(|x| x.map_or(Value::Null, js::num_value)).collect();
        body.insert("arrived".into(), Value::Array(arrived));
    }
    json_no_store(&body)
}
