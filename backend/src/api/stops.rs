//! server/api/stops/route.ts, zbiorkom branch: the feed's prebuilt stops body behind its ETag.

use std::sync::Arc;

use bytes::Bytes;
use hyper::header::{CACHE_CONTROL, ETAG, HeaderMap, HeaderValue, VARY};
use hyper::{Response, StatusCode};

use super::{ApiRequest, zb_live};
use crate::api_helpers::{etag_matches, prebuilt_json, warming};
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::{Body, full, header_str};

/// GET /api/stops?city=<zbiorkom slug>; None = a BB request (Node answers it).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let slug = match req.zb_city() {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    let Some(feed) = live(slug).current_feed() else {
        return Some(warming());
    };
    // the feed swaps once a day; the client revalidates like the BB list (focus, every 15 min)
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&feed.stops_etag) {
        headers.insert(ETAG, v);
    }
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=60"));
    headers.insert(VARY, HeaderValue::from_static("Accept-Encoding"));
    if etag_matches(header_str(&req.headers, "if-none-match").as_deref(), &feed.stops_etag) {
        let mut res = Response::new(full(Bytes::new()));
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        *res.headers_mut() = headers;
        return Some(res);
    }
    Some(prebuilt_json(&req.headers, &feed, || feed.stops_body.clone(), headers))
}
