//! server/api/trips/route.ts for a batch holding a zbiorkom id: the whole batch is validated as the TS does, the
//! zbiorkom ids come from their cities' feeds, the rest (KB, MZK) from Node in one sub-request, and the two parts
//! are merged into the answer the one TS route would give.

use std::sync::Arc;

use hyper::header::CACHE_CONTROL;
use hyper::{Response, StatusCode};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;

use super::{ApiRequest, NodeClient, NodeResponse, batch_ids, json_cached, node_headers, node_response, zb_live};
use crate::api_helpers::{bad_request, is_valid_id, query_param, zb_enabled};
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;
use crate::{js, logger};

const MAX_BATCH_IDS: usize = 300;

/// The zbiorkom half of a batch: trips found in the feeds; `loading` = a city's feed is still parsing (its ids are
/// absent and the answer is not cached).
#[derive(Debug, Default)]
pub struct ZbTrips {
    pub trips: IndexMap<String, Value>,
    pub loading: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Trip {
    Zb(Value),
    Node(Box<RawValue>),
}

#[derive(Deserialize)]
struct NodeTrips {
    trips: IndexMap<String, Box<RawValue>>,
}

#[derive(Serialize)]
struct TripsBody {
    count: usize,
    trips: IndexMap<String, Trip>,
}

/// GET /api/trips?ids=<batch with a zbiorkom id>.
pub async fn get(req: &ApiRequest, node: &NodeClient) -> Option<Response<Body>> {
    handle(req, node, zb_live).await
}

/// The route with each city's live layer from `live` (the started registry entry in `get`, a rigged one in a
/// test); `node` is asked only when the batch holds a non-zbiorkom id.
pub async fn handle<T: ZbTransport>(
    req: &ApiRequest,
    node: &NodeClient,
    live: impl Fn(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let param = query_param(&req.query, "ids").unwrap_or_default();
    if param.is_empty() {
        return Some(bad_request("Missing ?ids= query parameter"));
    }
    let ids = batch_ids(&param);
    if ids.is_empty() {
        return Some(bad_request("ids list cannot be empty"));
    }
    if ids.len() > MAX_BATCH_IDS {
        return Some(bad_request(&format!("Exceeded maximum of {MAX_BATCH_IDS} ids")));
    }
    if let Some(bad) = ids.iter().find(|id| !is_valid_id(id)) {
        return Some(bad_request(&format!("Invalid trip id: {bad}")));
    }
    let (zb_ids, rest): (Vec<String>, Vec<String>) = ids.into_iter().partition(|id| zb_city_of(id).is_some());
    let node_part = if rest.is_empty() {
        // Math.max(1, 0): a zbiorkom id costs no upstream fetch; a mixed batch is charged by Node for its own ids
        if !allow_request(&req.ip(), 1.0) {
            return Some(too_many_requests());
        }
        None
    } else {
        let path = format!("/api/trips?ids={}", rest.join(","));
        Some(node.get(&path, node_headers(&req.headers)).await)
    };
    Some(merge_trips(node_part, || zb_trips(&zb_ids, live)))
}

/// Each zbiorkom id's static trip, the TS loop over `zbIds` (a disabled city's ids are skipped).
fn zb_trips<T: ZbTransport>(ids: &[String], live: impl Fn(&'static str) -> Arc<GzmLive<T>>) -> ZbTrips {
    let mut out = ZbTrips::default();
    for id in ids {
        let Some(slug) = zb_city_of(id).filter(|s| zb_enabled(s)) else {
            continue;
        };
        match live(slug).trip(id, false) {
            Lookup::Loading => out.loading = true,
            Lookup::Unknown => {}
            Lookup::Found(t) => {
                out.trips.insert(id.clone(), t);
            }
        }
    }
    out
}

/// Node's answer for the non-zbiorkom ids (None = the batch had none) merged with the zbiorkom half `zb`, which runs
/// only when the answer is a merge: a 4xx from Node (its rate limit) goes out as is. A 5xx, a failed call or an
/// unreadable body counts as every Node id failed, which the TS route answers with a 200 `no-store` since the
/// zbiorkom ids never fail. Keys follow `Object.keys` of the TS object: index-like (KB) ids ascending, then
/// zbiorkom, then the rest of Node's in its order.
pub fn merge_trips(node: Option<Result<NodeResponse, String>>, zb: impl FnOnce() -> ZbTrips) -> Response<Body> {
    let mut node_trips = IndexMap::new();
    let (mut failed, mut pending) = (false, false);
    match node {
        None => {}
        Some(Ok(res)) if res.status.is_client_error() => return node_response(res),
        Some(Ok(res)) if res.status == StatusCode::OK => match serde_json::from_slice::<NodeTrips>(&res.body) {
            Ok(body) => {
                // Node's own Cache-Control over its part: no-store = a fetch failed, 300 = a road shape is pending
                let cc = res.headers.get(CACHE_CONTROL).and_then(|v| v.to_str().ok());
                failed = cc == Some("no-store");
                pending = cc == Some("public, max-age=300");
                node_trips = body.trips;
            }
            Err(err) => {
                logger::warn("trips", format_args!("node answer unreadable: {err}"));
                failed = true;
            }
        },
        Some(Ok(_)) => failed = true,
        Some(Err(err)) => {
            logger::warn("trips", format_args!("node: {err}"));
            failed = true;
        }
    }
    let zb = zb();
    pending |= zb
        .trips
        .values()
        .any(|t| t.get("shape_status").and_then(Value::as_str) == Some("pending"));
    let mut trips: IndexMap<String, Trip> = zb.trips.into_iter().map(|(k, v)| (k, Trip::Zb(v))).collect();
    for (k, v) in node_trips {
        trips.insert(k, Trip::Node(v));
    }
    js::sort_object_keys(&mut trips);
    let cache = match (failed || zb.loading, pending) {
        (true, _) => "no-store",
        (false, true) => "public, max-age=300",
        (false, false) => "public, max-age=3600",
    };
    json_cached(
        &TripsBody {
            count: trips.len(),
            trips,
        },
        cache,
    )
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use http_body_util::BodyExt;
    use hyper::header::{HeaderMap, HeaderValue};
    use serde_json::json;

    use super::*;

    fn node(status: u16, cache: &str, body: &str) -> Option<Result<NodeResponse, String>> {
        let mut headers = HeaderMap::new();
        headers.insert(CACHE_CONTROL, HeaderValue::from_str(cache).unwrap());
        Some(Ok(NodeResponse {
            status: StatusCode::from_u16(status).unwrap(),
            headers,
            body: Bytes::from(body.to_owned()),
        }))
    }

    fn zb(loading: bool) -> ZbTrips {
        let mut trips = IndexMap::new();
        trips.insert("gzm:tA".to_owned(), json!({"times": [], "shape_status": "road"}));
        ZbTrips { trips, loading }
    }

    async fn parts(res: Response<Body>) -> (StatusCode, String, String) {
        let cc = res
            .headers()
            .get(CACHE_CONTROL)
            .map_or("", |v| v.to_str().unwrap())
            .to_owned();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, cc, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn merge_follows_the_ts_answer() {
        let r = parts(merge_trips(None, || zb(false))).await;
        assert_eq!(r.0, StatusCode::OK);
        assert_eq!(r.1, "public, max-age=3600");
        assert_eq!(
            r.2,
            r#"{"count":1,"trips":{"gzm:tA":{"times":[],"shape_status":"road"}}}"#
        );

        assert_eq!(parts(merge_trips(None, || zb(true))).await.1, "no-store");

        // Node's part verbatim (1e+21 stays as Node wrote it), index-like ids first, Node's pending shape counts
        let body = r#"{"count":3,"trips":{"7":{"a":1e+21},"12":null,"mzk:9":{"shape_status":"pending"}}}"#;
        let r = parts(merge_trips(node(200, "public, max-age=300", body), || zb(false))).await;
        assert_eq!(r.1, "public, max-age=300");
        assert_eq!(
            r.2,
            r#"{"count":4,"trips":{"7":{"a":1e+21},"12":null,"gzm:tA":{"times":[],"shape_status":"road"},"mzk:9":{"shape_status":"pending"}}}"#
        );

        let r = parts(merge_trips(node(200, "no-store", r#"{"count":0,"trips":{}}"#), || {
            zb(false)
        }))
        .await;
        assert_eq!(r.1, "no-store");

        let mut ran = false;
        let r = parts(merge_trips(node(429, "", r#"{"error":"Too many requests"}"#), || {
            ran = true;
            zb(false)
        }))
        .await;
        assert_eq!(
            (r.0, r.2.as_str()),
            (StatusCode::TOO_MANY_REQUESTS, r#"{"error":"Too many requests"}"#)
        );
        assert!(!ran);

        for failed in [
            node(502, "", r#"{"error":"Upstream request failed"}"#),
            Some(Err("refused".into())),
        ] {
            let r = parts(merge_trips(failed, || zb(false))).await;
            assert_eq!(r.0, StatusCode::OK);
            assert_eq!(r.1, "no-store");
            assert_eq!(
                r.2,
                r#"{"count":1,"trips":{"gzm:tA":{"times":[],"shape_status":"road"}}}"#
            );
        }
    }
}
