//! server/api/vehicles/route.ts, zbiorkom branch: the city's vehicles body, prebuilt once per poll and gzipped once
//! per body (`prebuilt_json` keyed by the body itself, so a dropped city's gzip goes with its last body).

use std::sync::Arc;

use hyper::Response;
use hyper::header::{CACHE_CONTROL, HeaderMap, HeaderName, HeaderValue, PRAGMA};
use jiff::Timestamp;

use super::{ApiRequest, zb_live};
use crate::api_helpers::prebuilt_json;
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::Body;

const X_SERVER_TIME: HeaderName = HeaderName::from_static("x-server-time");
const X_NEXT_UPDATE: HeaderName = HeaderName::from_static("x-next-update");

/// GET /api/vehicles?city=<zbiorkom slug>; None = a BB request (Node answers it).
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
    let mut headers = HeaderMap::new();
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
    );
    headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
    // server clock for the client motion engine: a header, so an unchanged payload still dedupes in swr()
    headers.insert(X_SERVER_TIME, HeaderValue::from(Timestamp::now().as_millisecond()));
    let live = live(slug);
    let body = live.vehicles_body();
    if let Some(next) = live.next_body_at().filter(|&n| n != 0) {
        headers.insert(X_NEXT_UPDATE, HeaderValue::from(next));
    }
    Some(prebuilt_json(&req.headers, &body, || body.to_string(), headers))
}
