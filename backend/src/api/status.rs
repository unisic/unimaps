//! server/api/status/route.ts: whether each city's live data is flowing (crate::city_status), swept at most every
//! 2 min.

use hyper::Response;

use super::json_cached;
use crate::api_helpers::upstream_error;
use crate::city_status::city_status;
use crate::http::Body;
use crate::poller_singleton::{Bb, BbKinds};

/// GET /api/status.
pub async fn get<T: BbKinds>(bb: &'static Bb<T>) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return upstream_error("status", err);
    }
    match city_status(bb, bb.now_ms()).await {
        Some(body) => json_cached(&*body, "no-cache"),
        None => upstream_error("status", "status sweep failed"),
    }
}
