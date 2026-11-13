//! `/api/traffic` with TomTom stubbed (the rate limiter is process-wide: every request comes from its own address).

mod gzm_rig;

use std::sync::atomic::{AtomicUsize, Ordering};

use gzm_rig::{Fake, ok};
use http_body_util::BodyExt;
use hyper::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use unimaps::api::{ApiRequest, traffic};
use unimaps::gzm::ZbResponse;

static IP: AtomicUsize = AtomicUsize::new(0);

async fn get(query: &str, tomtom: &Fake, key: Option<&str>) -> (u16, Value) {
    let mut headers = HeaderMap::new();
    let ip = format!("10.8.0.{}", IP.fetch_add(1, Ordering::Relaxed) + 1);
    headers.insert("x-forwarded-for", HeaderValue::from_str(&ip).unwrap());
    let req = ApiRequest {
        query: query.to_owned(),
        headers,
        ..Default::default()
    };
    let res = traffic::handle(&req, tomtom, key).await;
    let status = res.status().as_u16();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

/// Flow Segment Data's documented JSON answer, trimmed
fn segment(speed: u32, confidence: f64) -> Fake {
    let body = json!({ "flowSegmentData": { "frc": "FRC2", "currentSpeed": speed, "freeFlowSpeed": 50, "currentTravelTime": 153, "freeFlowTravelTime": 90, "confidence": confidence, "roadClosure": false } });
    Fake::new(move |_| Ok(ok(body.to_string())))
}

#[tokio::test]
async fn answers_the_live_speed_in_metres_per_second() {
    let tomtom = segment(18, 0.9);
    let (status, body) = get("lat=50.2649&lon=19.0238", &tomtom, Some("k&ey")).await;
    assert_eq!((status, body), (200, json!({ "speed": 5.0 })));
    let urls = tomtom.urls();
    assert_eq!(urls.len(), 1);
    assert!(
        urls[0].starts_with("https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/22/json?"),
        "{}",
        urls[0]
    );
    assert!(urls[0].contains("key=k%26ey&point=50.26490%2C19.02380"), "{}", urls[0]);
}

#[tokio::test]
async fn a_guess_from_history_is_no_speed() {
    let (status, body) = get("lat=50.2649&lon=19.0238", &segment(18, 0.2), Some("k")).await;
    assert_eq!((status, body), (200, json!({ "speed": null })));
}

#[tokio::test]
async fn off_without_a_key_and_refuses_points_outside_poland() {
    let tomtom = segment(18, 0.9);
    assert_eq!(get("lat=50.26&lon=19.02", &tomtom, None).await.0, 404);
    for q in [
        "lat=50.26",
        "lat=x&lon=19.02",
        "lat=40.4&lon=-3.7",
        "lat=NaN&lon=19.02",
        "lat=50.26&lon=inf",
    ] {
        assert_eq!(get(q, &tomtom, Some("k")).await.0, 400, "{q}");
    }
    assert!(tomtom.urls().is_empty());
}

#[tokio::test]
async fn an_upstream_failure_is_a_generic_502() {
    let tomtom = Fake::new(|_| {
        Ok(ZbResponse {
            status: 403,
            body: r#"{"detailedError":{"message":"key k is invalid"}}"#.into(),
            ..ZbResponse::default()
        })
    });
    let (status, body) = get("lat=50.26&lon=19.02", &tomtom, Some("k")).await;
    assert_eq!((status, body), (502, json!({ "error": "Upstream request failed" })));
}
