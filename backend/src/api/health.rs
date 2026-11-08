//! server/api/health/route.ts in the split deployment: Node still builds the BB health, Rust owns zbiorkom, so
//! the answer is Node's with the "gzm" and "zb" values swapped for Rust's.

use hyper::{Response, StatusCode};
use indexmap::IndexMap;
use serde_json::Value;
use serde_json::value::{RawValue, to_raw_value};

use super::{ApiRequest, NodeClient, NodeResponse, node_headers, node_response};
use crate::gzm::{safe_gzm_health, safe_zb_health};
use crate::http::{Body, json};
use crate::logger;

/// Node's GET /api/health merged with `safe_gzm_health()` / `safe_zb_health()`; Node unreachable = the proxy's 502.
pub async fn get(req: &ApiRequest, node: &NodeClient) -> Response<Body> {
    match node.get("/api/health", node_headers(&req.headers)).await {
        Ok(res) => merge(res, safe_gzm_health, safe_zb_health),
        Err(err) => {
            logger::error("http", format_args!("api proxy: {err}"));
            json(StatusCode::BAD_GATEWAY, r#"{"error":"Upstream request failed"}"#)
        }
    }
}

/// Node's answer with the values of its top-level "gzm" and "zb" keys replaced in place (key order, status and
/// headers kept). A body without them (upstreamError's `{"error":..}`, a non-JSON answer) passes byte for byte;
/// the other values are copied raw, never re-formatted.
pub fn merge(mut res: NodeResponse, gzm: impl FnOnce() -> Value, zb: impl FnOnce() -> Value) -> Response<Body> {
    if let Ok(mut body) = serde_json::from_slice::<IndexMap<String, Box<RawValue>>>(&res.body) {
        let mut changed = false;
        if let Some(slot) = body.get_mut("gzm") {
            changed |= set(slot, &gzm());
        }
        if let Some(slot) = body.get_mut("zb") {
            changed |= set(slot, &zb());
        }
        if changed && let Ok(s) = serde_json::to_string(&body) {
            res.body = s.into();
        }
    }
    node_response(res)
}

fn set(slot: &mut Box<RawValue>, value: &Value) -> bool {
    to_raw_value(value).map(|raw| *slot = raw).is_ok()
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use http_body_util::BodyExt;
    use hyper::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
    use serde_json::json;

    use super::*;

    async fn merged(status: StatusCode, body: &'static str) -> (StatusCode, HeaderMap, Bytes) {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let res = NodeResponse {
            status,
            headers,
            body: Bytes::from_static(body.as_bytes()),
        };
        let res = merge(
            res,
            || json!({"enabled": true, "vehicles": 3}),
            || json!({"enabled": false}),
        );
        let (parts, body) = res.into_parts();
        let body = body.collect().await.map(|c| c.to_bytes()).unwrap_or_default();
        (parts.status, parts.headers, body)
    }

    #[tokio::test]
    async fn swaps_the_zbiorkom_blocks_in_place() {
        let (status, headers, body) = merged(
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"status":"degraded","gzm":{"enabled":true,"error":"x"},"feed_age_secs":1.5e-7,"zb":{},"tail":null}"#,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            headers.get(CONTENT_TYPE).map(|v| v.as_bytes()),
            Some(&b"application/json"[..])
        );
        assert_eq!(
            body,
            r#"{"status":"degraded","gzm":{"enabled":true,"vehicles":3},"feed_age_secs":1.5e-7,"zb":{"enabled":false},"tail":null}"#
        );
    }

    #[tokio::test]
    async fn other_answers_pass_byte_for_byte() {
        for body in [r#"{"error":"Upstream request failed"}"#, "not json", r#"[{"gzm":1}]"#] {
            let (status, _, out) = merged(StatusCode::BAD_GATEWAY, body).await;
            assert_eq!(
                (status, out),
                (StatusCode::BAD_GATEWAY, Bytes::from_static(body.as_bytes()))
            );
        }
    }
}
