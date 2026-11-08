//! server/api/stops/route.ts: a zbiorkom feed's prebuilt stops body, or BB's merged KB + MZK view
//! (`Bb::merged_stops_view`, re-merged only when a stop list or a directions map changes), behind its ETag.

use std::sync::Arc;

use bytes::Bytes;
use hyper::header::{CACHE_CONTROL, ETAG, HeaderMap, HeaderValue, VARY};
use hyper::{Response, StatusCode};

use super::{ApiRequest, zb_live};
use crate::api_helpers::{etag_matches, prebuilt_json, upstream_error, warming};
use crate::fleet_tracker::blocking_io;
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::{Body, full, header_str};
use crate::poller_singleton::{Bb, BbKinds};

/// GET /api/stops?city=<zbiorkom slug>; None = a BB request (`get_bb` in owned mode, Node in proxy mode).
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
        return Some(not_modified(headers));
    }
    Some(prebuilt_json(&req.headers, &feed, || feed.stops_body.clone(), headers))
}

/// GET /api/stops of BB.
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return upstream_error("stops", err);
    }
    // a changed input re-merges (Hungarian assignment) and a first read loads the GTFS directions
    let view = blocking_io(|| bb.merged_stops_view());
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&view.etag) {
        headers.insert(ETAG, v);
    }
    headers.insert(VARY, HeaderValue::from_static("Accept-Encoding"));
    // a list still missing one operator is revalidated every time; the client refetches it every 20 s
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static(if view.partial { "no-cache" } else { "public, max-age=60" }),
    );
    if etag_matches(header_str(&req.headers, "if-none-match").as_deref(), &view.etag) {
        return not_modified(headers);
    }
    prebuilt_json(&req.headers, &view, || view.body.clone(), headers)
}

fn not_modified(headers: HeaderMap) -> Response<Body> {
    let mut res = Response::new(full(Bytes::new()));
    *res.status_mut() = StatusCode::NOT_MODIFIED;
    *res.headers_mut() = headers;
    res
}
