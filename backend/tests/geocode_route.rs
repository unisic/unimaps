//! test/geocode-route.test.ts: `/api/geocode?city=gzm` with Photon stubbed (the rate limiter and the memo are
//! process-wide, so every request comes from its own address and every test uses its own query).

mod gzm_rig;

use std::sync::atomic::{AtomicUsize, Ordering};

use gzm_rig::{Fake, ok};
use http_body_util::BodyExt;
use hyper::Response;
use hyper::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use unimaps::api::{ApiRequest, geocode};
use unimaps::api_helpers::query_param;
use unimaps::gzm::ZbResponse;
use unimaps::http::Body;
use unimaps::js::encode_uri_component;

/// Photon's answer to "Czeladź Sportowa" (captured 2026-10-29, trimmed): the street twice (two OSM ways), a place
/// on it, plus a hit outside the GZM box
fn photon() -> String {
    let feature = |lon: f64, lat: f64, properties: Value| json!({ "type": "Feature", "geometry": { "type": "Point", "coordinates": [lon, lat] }, "properties": properties });
    json!({
        "type": "FeatureCollection",
        "features": [
            feature(19.0682041, 50.3175527, json!({ "name": "Sportowa", "city": "Czeladź", "type": "street" })),
            feature(19.0676975, 50.317499, json!({ "name": "Sportowa", "city": "Czeladź", "type": "street" })),
            feature(19.0677318, 50.3165803, json!({ "name": "Hala widowiskowo-sportowa MOSIR", "street": "Sportowa", "housenumber": "2", "city": "Czeladź" })),
            feature(21.0, 52.2, json!({ "name": "Sportowa", "city": "Warszawa" })),
            feature(19.07, 50.31, json!({ "type": "house" })),
        ],
    })
    .to_string()
}

fn stub_photon() -> Fake {
    Fake::new(|_| Ok(ok(photon())))
}

static IP: AtomicUsize = AtomicUsize::new(0);

async fn get(q: &str, photon: &Fake) -> Response<Body> {
    let mut headers = HeaderMap::new();
    let ip = format!("10.9.0.{}", IP.fetch_add(1, Ordering::Relaxed) + 1);
    headers.insert("x-forwarded-for", HeaderValue::from_str(&ip).unwrap());
    let req = ApiRequest {
        param: String::new(),
        query: format!("city=gzm&q={}", encode_uri_component(q)),
        headers,
        ..Default::default()
    };
    geocode::handle(&req, photon).await
}

async fn json_body(res: Response<Body>) -> Value {
    serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

struct First {
    status: u16,
    results: Value,
    urls: Vec<String>,
}

/// The first TS case, run once: the memo case after it relies on its answer being remembered (node:test runs the
/// cases in file order, cargo runs them in parallel).
async fn first() -> &'static First {
    static FIRST: OnceCell<First> = OnceCell::const_new();
    FIRST
        .get_or_init(|| async {
            let photon = stub_photon();
            let res = get("Czeladź  Sportowa ", &photon).await;
            let status = res.status().as_u16();
            let results = json_body(res).await["results"].clone();
            First {
                status,
                results,
                urls: photon.urls(),
            }
        })
        .await
}

#[tokio::test]
async fn lists_each_street_once_names_a_place_with_its_street_drops_hits_outside_the_city() {
    let r = first().await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.results,
        json!([
            { "name": "Sportowa", "detail": "Czeladź", "lat": 50.3175527, "lon": 19.0682041 },
            { "name": "Hala widowiskowo-sportowa MOSIR", "detail": "Sportowa 2, Czeladź", "lat": 50.3165803, "lon": 19.0677318 },
        ])
    );
    let query = r.urls[0].split_once('?').map_or("", |(_, q)| q);
    assert_eq!(query_param(query, "q").as_deref(), Some("Czeladź Sportowa"));
    assert_eq!(query_param(query, "bbox").as_deref(), Some("18.39,49.96,19.49,50.59"));
    assert_eq!(query_param(query, "lang").as_deref(), Some("default"));
}

#[tokio::test]
async fn answers_a_repeated_query_from_memory() {
    first().await;
    let photon = stub_photon();
    assert_eq!(get("czeladź sportowa", &photon).await.status(), 200);
    assert_eq!(photon.urls().len(), 0);
}

#[tokio::test]
async fn rejects_a_too_short_query_and_hides_upstream_failures_behind_a_502() {
    let photon = stub_photon();
    assert_eq!(get("ab", &photon).await.status(), 400);
    assert_eq!(photon.urls().len(), 0);
    let photon = Fake::new(|_| {
        Ok(ZbResponse {
            status: 500,
            body: "boom".into(),
            ..ZbResponse::default()
        })
    });
    let res = get("Katowice Mariacka", &photon).await;
    assert_eq!(res.status(), 502);
    assert_eq!(json_body(res).await["error"], "Upstream request failed");
}

/// Rust only (no TS test covers BB): a BB request gets BB's box and keeps only the hits inside it.
#[tokio::test]
async fn geocodes_bb_inside_its_own_box() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", HeaderValue::from_static("10.9.1.1"));
    let req = ApiRequest {
        query: format!("q={}", encode_uri_component("Bielsko Sportowa")),
        headers,
        ..Default::default()
    };
    let photon = Fake::new(|_| {
        let mut body: Value = serde_json::from_str(&photon()).unwrap();
        body["features"].as_array_mut().unwrap().push(json!({
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [19.0456, 49.8224] },
            "properties": { "name": "Sportowa", "city": "Bielsko-Biała" },
        }));
        Ok(ok(body.to_string()))
    });
    let res = geocode::handle(&req, &photon).await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        json_body(res).await["results"],
        json!([{ "name": "Sportowa", "detail": "Bielsko-Biała", "lat": 49.8224, "lon": 19.0456 }])
    );
    let urls = photon.urls();
    let query = urls[0].split_once('?').map_or("", |(_, q)| q);
    assert_eq!(query_param(query, "bbox").as_deref(), Some("18.8,49.65,19.37,50.06"));
}
