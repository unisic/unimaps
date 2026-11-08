//! server/api/shapes/route.ts for a batch holding a zbiorkom shape id: the whole request is validated as the TS
//! does, zbiorkom shapes come from their cities' feeds (a `near` box re-aims their running road matches), store
//! shapes (kb:, mzk:) from Node in one sub-request, merged into the answer the one TS route would give.

use std::sync::Arc;

use bytes::Bytes;
use hyper::header::{CACHE_CONTROL, HeaderValue};
use hyper::{Response, StatusCode};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::{ApiRequest, NodeClient, NodeResponse, batch_ids, json_cached, node_headers, node_response, zb_live};
use crate::api_helpers::{bad_request, etag_matches, internal_error, is_valid_shape_id, query_param, zb_enabled};
use crate::gzm::{GzmLive, ZbTransport};
use crate::gzm_feed::{ShapeLookup, ShapePayload};
use crate::http::{Body, full, header_str};
use crate::js;
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;
use crate::shared::polyline::LatLonBox;

const MAX_IDS: usize = 50;
const MAX_IDS_PARAM: usize = 1300;
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

#[derive(Serialize)]
#[serde(untagged)]
enum Shape {
    Node(Box<RawValue>),
    Zb(ShapePayload),
}

#[derive(Deserialize)]
struct NodeShapes {
    shapes: IndexMap<String, Box<RawValue>>,
    missing: Vec<String>,
}

#[derive(Serialize)]
struct ShapesBody {
    precision: u8,
    shapes: IndexMap<String, Shape>,
    missing: Vec<String>,
}

/// parseBox: `s,w,n,e` in range with s < n and w < e; None = invalid.
fn parse_box(v: &str) -> Option<LatLonBox> {
    let p: Vec<f64> = v.split(',').map(js::number).collect();
    if v.encode_utf16().count() > 100 || !p.iter().all(|x| x.is_finite()) {
        return None;
    }
    let [s, w, n, e] = p[..] else {
        return None;
    };
    (s < n && w < e && s >= -90.0 && n <= 90.0 && w >= -180.0 && e <= 180.0).then_some(LatLonBox { s, w, n, e })
}

/// GET /api/shapes?ids=<batch with a zbiorkom id>[&near=s,w,n,e].
pub async fn get(req: &ApiRequest, node: &NodeClient) -> Option<Response<Body>> {
    handle(req, node, zb_live).await
}

/// The route with each city's live layer from `live` (the started registry entry in `get`, a rigged one in a
/// test); `node` is asked only when the batch holds a store id.
pub async fn handle<T: ZbTransport>(
    req: &ApiRequest,
    node: &NodeClient,
    live: impl Fn(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    if !allow_request(&req.ip(), 1.0) {
        return Some(too_many_requests());
    }
    let param = query_param(&req.query, "ids").unwrap_or_default();
    let focus = match query_param(&req.query, "near") {
        None => None,
        Some(near) => match parse_box(&near) {
            None => return Some(bad_request("Invalid near box")),
            focus => focus,
        },
    };
    if param.is_empty() {
        return Some(bad_request("Missing ?ids= query parameter"));
    }
    if param.encode_utf16().count() > MAX_IDS_PARAM {
        return Some(bad_request("ids parameter too long"));
    }
    let ids = batch_ids(&param);
    if ids.is_empty() {
        return Some(bad_request("ids list cannot be empty"));
    }
    if ids.len() > MAX_IDS {
        return Some(bad_request(&format!("Exceeded maximum of {MAX_IDS} ids")));
    }
    if !ids.iter().all(|id| is_valid_shape_id(id)) {
        return Some(bad_request("Invalid shape id"));
    }
    let mut by_city: IndexMap<&'static str, Vec<String>> = IndexMap::new();
    let mut store = Vec::new();
    for id in &ids {
        match zb_city_of(id) {
            Some(slug) => by_city.entry(slug).or_default().push(id.clone()),
            None => store.push(id.as_str()),
        }
    }
    let node_part = if store.is_empty() {
        None
    } else {
        // no If-None-Match: the whole batch has two ids or more, so the TS never answers it 304, but Node would
        // answer its one-id part 304 without a body
        let path = format!("/api/shapes?ids={}", store.join(","));
        Some(node.get(&path, node_headers(&req.headers)).await)
    };
    let etag_hit = match &ids[..] {
        [id] => etag_matches(
            header_str(&req.headers, "if-none-match").as_deref(),
            &format!("\"{id}\""),
        ),
        _ => false,
    };
    Some(merge_shapes(node_part, || zb_shapes(&by_city, focus, live), etag_hit))
}

/// The TS loop over `byCity`: each enabled city's feed shapes (a disabled city's ids are missing, never exact).
fn zb_shapes<T: ZbTransport>(
    by_city: &IndexMap<&'static str, Vec<String>>,
    focus: Option<LatLonBox>,
    live: impl Fn(&'static str) -> Arc<GzmLive<T>>,
) -> ShapeLookup {
    let mut out = ShapeLookup {
        exact: true,
        ..ShapeLookup::default()
    };
    for (&slug, ids) in by_city {
        if !zb_enabled(slug) {
            out.missing.extend(ids.iter().cloned());
            out.exact = false;
            continue;
        }
        let city = live(slug);
        if let Some(focus) = focus {
            city.focus_match(ids, focus);
        }
        let r = city.shapes(ids);
        out.shapes.extend(r.shapes);
        out.missing.extend(r.missing);
        out.exact &= r.exact;
    }
    out
}

/// Node's answer for the store ids (None = the batch had none) merged with the zbiorkom half `zb`, which runs only
/// when the answer is a merge: any other Node status (its 429, its 500 for a store lookup that threw) goes out as
/// is. Store shapes first, then zbiorkom; `etag_hit` = a one-id batch whose If-None-Match names it (304 when exact).
pub fn merge_shapes(
    node: Option<Result<NodeResponse, String>>,
    zb: impl FnOnce() -> ShapeLookup,
    etag_hit: bool,
) -> Response<Body> {
    let mut shapes = IndexMap::new();
    let mut missing = Vec::new();
    let mut exact = true;
    match node {
        None => {}
        Some(Ok(res)) if res.status == StatusCode::OK => match serde_json::from_slice::<NodeShapes>(&res.body) {
            Ok(body) => {
                // Node's own Cache-Control over its part: immutable = every store id an exact hit
                exact = res.headers.get(CACHE_CONTROL).is_some_and(|v| v == IMMUTABLE);
                shapes = body.shapes.into_iter().map(|(k, v)| (k, Shape::Node(v))).collect();
                missing = body.missing;
            }
            Err(err) => return internal_error("shapes", format_args!("node answer unreadable: {err}")),
        },
        Some(Ok(res)) => return node_response(res),
        Some(Err(err)) => return internal_error("shapes", format_args!("node: {err}")),
    }
    let zb = zb();
    shapes.extend(zb.shapes.into_iter().map(|(k, v)| (k, Shape::Zb(v))));
    missing.extend(zb.missing);
    exact &= zb.exact;
    let cache = if exact { IMMUTABLE } else { "public, max-age=30" };
    if exact && etag_hit {
        let mut res = Response::new(full(Bytes::new()));
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static(cache));
        return res;
    }
    json_cached(
        &ShapesBody {
            precision: 6,
            shapes,
            missing,
        },
        cache,
    )
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;
    use hyper::header::HeaderMap;

    use super::*;
    use crate::js::JsNum;
    use crate::shape_store::ShapeSrc;

    fn node(status: u16, cache: &str, body: &str) -> Option<Result<NodeResponse, String>> {
        let mut headers = HeaderMap::new();
        headers.insert(CACHE_CONTROL, HeaderValue::from_str(cache).unwrap());
        Some(Ok(NodeResponse {
            status: StatusCode::from_u16(status).unwrap(),
            headers,
            body: Bytes::from(body.to_owned()),
        }))
    }

    fn zb(exact: bool) -> ShapeLookup {
        let mut shapes = IndexMap::new();
        let payload = ShapePayload {
            id: "gzm:s1.abcdef".into(),
            src: ShapeSrc::Gtfs,
            poly: "_p~iF".into(),
            len: JsNum(120.0),
            stops: vec![Some(JsNum(0.0)), None],
        };
        shapes.insert(payload.id.clone(), payload);
        ShapeLookup {
            shapes,
            missing: vec!["gzm:nope".into()],
            exact,
        }
    }

    const ZB: &str = r#""gzm:s1.abcdef":{"id":"gzm:s1.abcdef","src":"gtfs","poly":"_p~iF","len":120,"stops":[0,null]}"#;

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
        let r = parts(merge_shapes(None, || zb(true), false)).await;
        assert_eq!((r.0, r.1.as_str()), (StatusCode::OK, IMMUTABLE));
        assert_eq!(
            r.2,
            format!(r#"{{"precision":6,"shapes":{{{ZB}}},"missing":["gzm:nope"]}}"#)
        );

        let r = parts(merge_shapes(None, || zb(true), true)).await;
        assert_eq!(
            (r.0, r.1.as_str(), r.2.as_str()),
            (StatusCode::NOT_MODIFIED, IMMUTABLE, "")
        );
        assert_eq!(parts(merge_shapes(None, || zb(false), true)).await.0, StatusCode::OK);

        // store shapes verbatim and first, missing likewise; a non-exact store part makes the whole answer short-lived
        let store = r#"{"precision":6,"shapes":{"kb:0123456789ab.0c9e1f":{"len":1e+21}},"missing":["mzk:1"]}"#;
        for (cache, want) in [(IMMUTABLE, IMMUTABLE), ("public, max-age=30", "public, max-age=30")] {
            let r = parts(merge_shapes(node(200, cache, store), || zb(true), false)).await;
            assert_eq!((r.0, r.1.as_str()), (StatusCode::OK, want));
            assert_eq!(
                r.2,
                format!(
                    r#"{{"precision":6,"shapes":{{"kb:0123456789ab.0c9e1f":{{"len":1e+21}},{ZB}}},"missing":["mzk:1","gzm:nope"]}}"#
                )
            );
        }

        for (status, body) in [
            (429, r#"{"error":"Too many requests"}"#),
            (500, r#"{"error":"Internal error"}"#),
        ] {
            let mut ran = false;
            let r = parts(merge_shapes(
                node(status, "", body),
                || {
                    ran = true;
                    zb(true)
                },
                false,
            ))
            .await;
            assert_eq!((r.0.as_u16(), r.2.as_str()), (status, body));
            assert!(!ran);
        }
        let r = parts(merge_shapes(Some(Err("refused".into())), || zb(true), false)).await;
        assert_eq!(r.0, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn near_box() {
        assert_eq!(
            parse_box("50.1, 18.9,50.3,19.2"),
            Some(LatLonBox {
                s: 50.1,
                w: 18.9,
                n: 50.3,
                e: 19.2
            })
        );
        for bad in [
            "50.3,18.9,50.1,19.2",
            "50.1,18.9,50.3",
            "50.1,18.9,50.3,19.2,1",
            "a,18.9,50.3,19.2",
            "-91,0,1,1",
        ] {
            assert_eq!(parse_box(bad), None, "{bad}");
        }
    }
}
