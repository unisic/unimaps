//! server/api/gtfs-rt.pb/route.ts: the KB poller's GTFS-Realtime VehiclePositions feed (BB only).

use hyper::Response;
use hyper::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, HeaderValue};

use crate::api_helpers::upstream_error;
use crate::http::{Body, full};
use crate::poller_singleton::{Bb, BbKinds};

/// GET /api/gtfs-rt.pb.
pub async fn get<T: BbKinds>(bb: &'static Bb<T>) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return upstream_error("gtfs-rt", err);
    }
    let data = bb.poller().to_protobuf();
    let mut res = Response::new(full(data.to_vec()));
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/x-protobuf"));
    h.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=VehiclePositions.pb"),
    );
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    res
}
