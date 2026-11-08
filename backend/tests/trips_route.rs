//! test/trips-route.test.ts: the owned-mode GET /api/trips over a started `Bb` whose KB client is a fake
//! (support/stops_fake.rs `cached_trips` / `failing_trips`), never upstream. "has no POST handler" is
//! `api::tests::owned_mode_route_table_methods_and_allow` (/api/trips allows "GET, HEAD, OPTIONS" only).

#[allow(dead_code)]
#[path = "support/stops_fake.rs"]
mod rig;

use http_body_util::BodyExt;
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Response, StatusCode};
use rig::{ENV, Fake, Fakes, started, stop};
use serde_json::Value;
use std::sync::LazyLock;
use unimaps::api::{ApiRequest, trips};
use unimaps::http::Body;
use unimaps::poller_singleton::Bb;

/// `beforeEach`: a fresh fake behind an already started singleton.
async fn setup() -> (Fake, &'static Bb<Fakes>) {
    LazyLock::force(&ENV);
    let fake = Fake::default();
    let bb = started(&fake, None, None).await;
    (fake, Box::leak(Box::new(bb)))
}

fn ids(n: usize, from: usize) -> String {
    (from..from + n).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
}

async fn get(bb: &'static Bb<Fakes>, q: &str, ip: &str) -> Response<Body> {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", HeaderValue::from_str(ip).expect("ip header"));
    let req = ApiRequest {
        query: format!("?ids={q}"),
        headers,
        ..Default::default()
    };
    trips::get_owned(&req, bb).await
}

fn cache_control(res: &Response<Body>) -> Option<&str> {
    res.headers().get("cache-control").and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn charges_a_rate_limit_token_per_uncached_id_not_one_per_request() {
    let (fake, bb) = setup().await;
    assert_eq!(get(bb, &ids(300, 1), "10.0.0.1").await.status(), StatusCode::OK);
    assert_eq!(get(bb, &ids(300, 1), "10.0.0.1").await.status(), StatusCode::OK);
    assert_eq!(
        get(bb, &ids(300, 1), "10.0.0.1").await.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "600 upstream fetches spend the per-IP burst"
    );
    fake.with(|s| s.cached_trips.extend((1..=300).map(|i| i.to_string())));
    assert_eq!(get(bb, &ids(300, 1), "10.0.0.2").await.status(), StatusCode::OK);
    assert_eq!(get(bb, &ids(300, 1), "10.0.0.2").await.status(), StatusCode::OK);
    assert_eq!(
        get(bb, &ids(300, 1), "10.0.0.2").await.status(),
        StatusCode::OK,
        "cached ids cost no upstream fetch"
    );
    stop(bb).await;
}

#[tokio::test]
async fn a_failed_upstream_fetch_is_not_cached_as_no_such_trip_all_failed_is_a_502() {
    let (fake, bb) = setup().await;
    fake.with(|s| s.failing_trips.insert("2".to_owned()));
    let partial = get(bb, "1,2", "10.0.1.1").await;
    assert_eq!(partial.status(), StatusCode::OK);
    assert_eq!(cache_control(&partial), Some("no-store"));
    let bytes = partial.into_body().collect().await.expect("body").to_bytes();
    let body: Value = serde_json::from_slice(&bytes).expect("json body");
    let keys: Vec<&str> = body["trips"]
        .as_object()
        .map(|o| o.keys().map(String::as_str).collect())
        .unwrap_or_default();
    assert_eq!(keys, ["1"]);
    fake.with(|s| s.failing_trips.insert("1".to_owned()));
    assert_eq!(get(bb, "1,2", "10.0.1.1").await.status(), StatusCode::BAD_GATEWAY);
    fake.with(|s| s.failing_trips.clear());
    assert_eq!(
        cache_control(&get(bb, "1,2", "10.0.1.1").await),
        Some("public, max-age=3600")
    );
    stop(bb).await;
}
