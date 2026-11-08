//! test/gtfs-connections-route.test.ts: the BB GET /api/connections rejects bad input before any search and is
//! rate limited per client. The singleton is a started `Bb` of fakes (support/stops_fake.rs), so a regression still
//! cannot start real pollers or touch the network. Its own binary: the rate-limit buckets are process-wide.

#[allow(dead_code)]
#[path = "support/stops_fake.rs"]
mod rig;

use std::sync::LazyLock;

use hyper::StatusCode;
use hyper::header::{HeaderMap, HeaderValue};
use rig::{ENV, Fake, Fakes, started};
use unimaps::api::{ApiRequest, connections};
use unimaps::poller_singleton::Bb;

async fn bb() -> &'static Bb<Fakes> {
    LazyLock::force(&ENV);
    Box::leak(Box::new(started(&Fake::default(), None, None).await))
}

async fn get(bb: &'static Bb<Fakes>, qs: &str, ip: &str) -> StatusCode {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", HeaderValue::from_str(ip).expect("ip header"));
    let req = ApiRequest {
        query: format!("?{qs}"),
        headers,
        ..Default::default()
    };
    assert!(connections::get(&req).is_none(), "a BB request");
    connections::get_bb(&req, bb).await.status()
}

#[tokio::test]
async fn rejects_a_non_numeric_limit_or_mintransfer_instead_of_searching_with_nan() {
    let bb = bb().await;
    let ip = "198.51.100.7";
    assert_eq!(get(bb, "from=A&to=B&limit=abc", ip).await, StatusCode::BAD_REQUEST);
    assert_eq!(
        get(bb, "from=A&to=B&minTransfer=abc", ip).await,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn is_rate_limited_per_client_like_the_passthrough_routes() {
    let bb = bb().await;
    let mut last = StatusCode::OK;
    // the per-IP burst is 600 requests; the CPU-bound search must not be callable without bound
    for _ in 0..650 {
        last = get(bb, "to=B", "198.51.100.8").await;
        if last == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}
