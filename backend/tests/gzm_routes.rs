//! test/gzm-routes.test.ts: the `gzm:` id spaces and every route's zbiorkom branch answered from a rigged GzmLive on
//! the synthetic feed (never the network). The parseCity cases live in tests/api_helpers.rs.

mod gzm_rig;

use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};

use flate2::read::GzDecoder;
use gzm_rig::{DATE, FEED, RecOpts, Rig, at, rec, rig};
use http_body_util::BodyExt;
use hyper::Response;
use hyper::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use unimaps::api::{
    ApiRequest, NodeClient, connections, lines, shapes, stop_departures, stop_timetable, stops, trip, trip_execution,
    trips, vehicles,
};
use unimaps::api_helpers::{is_valid_id, is_valid_shape_id};
use unimaps::gzm::{get_gzm, safe_gzm_health};
use unimaps::http::Body;
use unimaps::shared::cities::zb_city_of;

static IP: AtomicUsize = AtomicUsize::new(0);

/// The TS `get(url, headers)`: a fresh client per request (the rate limiter is not under test here).
fn get(param: &str, query: &str, extra: &[(&'static str, &str)]) -> ApiRequest {
    let n = IP.fetch_add(1, Ordering::Relaxed) + 1;
    let mut headers = HeaderMap::new();
    let ip = format!("10.9.{}.{}", n / 256, n % 256);
    headers.insert("x-forwarded-for", HeaderValue::from_str(&ip).unwrap());
    for &(k, v) in extra {
        headers.insert(k, HeaderValue::from_str(v).unwrap());
    }
    ApiRequest {
        param: param.into(),
        query: query.into(),
        headers,
    }
}

/// The TS `before`: the fixture feed at 08:03, one tram seeded by the first poll.
async fn seeded() -> Rig {
    let r = rig();
    let tram = rec(&RecOpts {
        ts: at("08:02", 40),
        calls: vec![(1, "08:05"), (2, "08:10")],
        delay: 60,
        ..Default::default()
    });
    r.poll(at("08:03", 0), vec![tram]).await;
    r
}

fn header(res: &Response<Body>, name: &str) -> Option<String> {
    res.headers().get(name).map(|v| v.to_str().unwrap().to_owned())
}

async fn bytes(res: Response<Body>) -> Vec<u8> {
    res.into_body().collect().await.unwrap().to_bytes().to_vec()
}

async fn json_of(res: Response<Body>) -> Value {
    serde_json::from_slice(&bytes(res).await).unwrap()
}

/// `/^<prefix>[0-9a-f]{6}$/`
fn rev_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix)
        .is_some_and(|rev| rev.len() == 6 && rev.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')))
}

#[test]
fn accepts_real_gzm_stop_trip_vehicle_ids() {
    assert!(is_valid_id("gzm:pszczelnik-park02-1irj5"));
    assert!(is_valid_id(&format!("gzm:{}", "a".repeat(52))));
    assert!(is_valid_id("gzm:49c1791d4acf03df"));
    assert!(is_valid_id("gzm:283_4285"));
    assert_eq!(zb_city_of("gzm:283_4285"), Some("gzm"));
    assert_eq!(zb_city_of("warsaw:3_1234"), Some("warsaw"));
    assert_eq!(zb_city_of("mzk:13954"), None);
    assert_eq!(zb_city_of("krk:1"), None);
}

#[test]
fn accepts_zbiorkom_shape_ids_sanitised_gtfs_ids_optional_rev_of_registry_cities_only() {
    assert!(is_valid_shape_id("gzm:0_428"));
    assert!(is_valid_shape_id("gzm:0_428.7b21c0"));
    assert!(is_valid_shape_id("warsaw:TP-BAN_a1b2c3"));
    assert!(!is_valid_shape_id("gzm:0/428"));
    assert!(!is_valid_shape_id("gzm:"));
    assert!(!is_valid_shape_id("krk:0_428"));
    assert!(!is_valid_shape_id(&format!("gzm:{}", "a".repeat(61))));
}

#[tokio::test(flavor = "multi_thread")]
async fn vehicles_the_prebuilt_body_uncached_with_the_server_clock_an_unknown_city_is_a_400() {
    let r = seeded().await;
    let res = vehicles::handle(&get("", "city=gzm", &[]), |_| r.live.clone()).unwrap();
    assert_eq!(res.status(), 200);
    assert!(header(&res, "cache-control").unwrap_or_default().contains("no-store"));
    let clock = header(&res, "x-server-time").unwrap_or_default();
    assert!(clock.parse::<f64>().is_ok_and(|ms| ms > 0.0), "{clock}");
    let body = json_of(res).await;
    let got: Vec<Value> = body["vehicles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| json!([v["id"], v["trip_id"], v["delay"]]))
        .collect();
    assert_eq!(got, vec![json!(["gzm:283_4285", "gzm:tA", 60])]);
    let bad = vehicles::handle(&get("", "city=krk", &[]), |_| r.live.clone()).unwrap();
    assert_eq!(bad.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn vehicles_gzip_when_the_client_accepts_it_next_leaves_route_bodies_uncompressed() {
    let r = seeded().await;
    let plain = bytes(vehicles::handle(&get("", "city=gzm", &[]), |_| r.live.clone()).unwrap()).await;
    let req = get("", "city=gzm", &[("accept-encoding", "gzip, deflate, br")]);
    let res = vehicles::handle(&req, |_| r.live.clone()).unwrap();
    assert_eq!(header(&res, "content-encoding").as_deref(), Some("gzip"));
    assert_eq!(header(&res, "vary").as_deref(), Some("Accept-Encoding"));
    let mut text = String::new();
    GzDecoder::new(bytes(res).await.as_slice())
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text.as_bytes(), plain.as_slice());
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_the_feeds_body_with_an_etag_that_revalidates_to_304() {
    let r = seeded().await;
    let res = stops::handle(&get("", "city=gzm", &[]), |_| r.live.clone()).unwrap();
    let etag = header(&res, "etag").unwrap_or_default();
    let body = json_of(res).await;
    let got: Vec<Value> = body["stops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| json!([s["id"], s["operator"]]))
        .collect();
    assert_eq!(
        got,
        vec![
            json!(["gzm:a", "GZM"]),
            json!(["gzm:b", "GZM"]),
            json!(["gzm:c", "GZM"])
        ]
    );
    assert!(!etag.is_empty());
    let again = stops::handle(&get("", "city=gzm", &[("if-none-match", &etag)]), |_| r.live.clone()).unwrap();
    assert_eq!(again.status(), 304);
}

#[tokio::test(flavor = "multi_thread")]
async fn lines_name_gtfs_type_and_operator() {
    let r = seeded().await;
    let body = json_of(lines::handle(&get("", "city=gzm", &[]), |_| r.live.clone()).unwrap()).await;
    let got: Vec<Value> = body["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| json!([l["name"], l["type"], l["operator"]]))
        .collect();
    assert_eq!(got, vec![json!(["7", "0", "GZM"])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn trip_and_trips_static_trips_from_the_feed_an_unknown_id_is_empty_no_kb_fetch() {
    let r = seeded().await;
    let t = json_of(trip::handle(&get("gzm:tA", "", &[]), |_| r.live.clone()).unwrap()).await;
    assert_eq!(t["times"].as_array().map(Vec::len), Some(3));
    let shape_id = t["shape_id"].as_str().unwrap_or_default();
    assert!(rev_id(shape_id, "gzm:shA."), "{shape_id}");
    let none = json_of(trip::handle(&get("gzm:nope", "", &[]), |_| r.live.clone()).unwrap()).await;
    assert_eq!(none, json!({}));
    // an all-zbiorkom batch never asks Node: port 1 would fail the fetch
    let node = NodeClient::new(1);
    let res = trips::handle(&get("", "ids=gzm:tA,gzm:nope", &[]), &node, |_| r.live.clone())
        .await
        .unwrap();
    let cache = header(&res, "cache-control");
    let b = json_of(res).await;
    let keys: Vec<&String> = b["trips"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["gzm:tA"]);
    assert_eq!(b["trips"]["gzm:tA"]["times"].as_array().map(Vec::len), Some(3));
    // a Node fetch would have failed and made it no-store
    assert_eq!(cache.as_deref(), Some("public, max-age=3600"));
}

#[tokio::test(flavor = "multi_thread")]
async fn trip_execution_the_vehicles_live_trip_a_malformed_gzm_id_is_a_400() {
    let r = seeded().await;
    let res = trip_execution::handle(&get("", "exec_id=gzm:283_4285", &[]), |_| r.live.clone()).unwrap();
    let t = json_of(res).await;
    assert_eq!(t["vehicle_trip_index"], 1);
    let diffs: Vec<Value> = t["trip"]["times"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["estimate"]["time_diff"].clone())
        .collect();
    assert_eq!(diffs, vec![Value::Null, json!(60), json!(60)]);
    let bad = trip_execution::handle(&get("", "exec_id=gzm:../x", &[]), |_| r.live.clone()).unwrap();
    assert_eq!(bad.status(), 400);
    let res = trip_execution::handle(&get("", "exec_id=gzm:1_1", &[]), |_| r.live.clone()).unwrap();
    assert_eq!(json_of(res).await, json!({}));
}

#[tokio::test(flavor = "multi_thread")]
async fn departures_and_timetable_from_the_feed_an_unknown_pole_is_a_404() {
    let r = seeded().await;
    let d = json_of(stop_departures::handle(&get("gzm:b", "", &[]), |_| r.live.clone()).unwrap()).await;
    let rows: Vec<Value> = d["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| json!([x["trip_id"], x["delay_sec"]]))
        .collect();
    assert_eq!(
        rows,
        vec![json!(["gzm:tA", 60]), json!(["gzm:tX", null]), json!(["gzm:tB", null])]
    );
    let unknown = stop_departures::handle(&get("gzm:zz", "", &[]), |_| r.live.clone()).unwrap();
    assert_eq!(unknown.status(), 404);
    let query = format!("date={DATE}");
    let tt = json_of(stop_timetable::handle(&get("gzm:a", &query, &[]), |_| r.live.clone()).unwrap()).await;
    let mut ids: Vec<&str> = tt["departures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["trip_id"].as_str().unwrap_or_default())
        .collect();
    ids.sort_unstable();
    assert_eq!(ids, ["gzm:tA", "gzm:tX"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn shapes_feed_shapes_by_wire_id_beside_the_stores_missing_ids_listed() {
    let r = seeded().await;
    let id = FEED.shapes.wire_id("gzm:shA").unwrap_or_default();
    let node = NodeClient::new(1);
    let res = shapes::handle(&get("", &format!("ids={id},gzm:nope"), &[]), &node, |_| r.live.clone())
        .await
        .unwrap();
    let cache = header(&res, "cache-control").unwrap_or_default();
    let body = json_of(res).await;
    let keys: Vec<&String> = body["shapes"].as_object().unwrap().keys().collect();
    assert_eq!(keys, [&id]);
    assert_eq!(body["shapes"][&id]["src"], "gtfs");
    assert_eq!(body["missing"], json!(["gzm:nope"]));
    assert!(!cache.contains("immutable"), "{cache}");
}

#[tokio::test(flavor = "multi_thread")]
async fn connections_searched_in_the_gzm_feed_only_legs_tagged_gzm_with_their_shape() {
    let r = seeded().await;
    let query = format!("city=gzm&from=gzm:a&to=gzm:c&date={DATE}&time=07:50");
    let body = json_of(connections::handle(&get("", &query, &[]), |_| r.live.clone()).unwrap()).await;
    let legs: Vec<&Value> = body["connections"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|c| c["legs"].as_array().unwrap())
        .collect();
    assert!(!legs.is_empty());
    assert!(legs.iter().all(|l| l["operator"] == "GZM"));
    let t_a = legs.iter().find(|l| l["tripId"] == "gzm:tA");
    let shape_id = t_a.and_then(|l| l["shape_id"].as_str()).unwrap_or_default();
    assert!(shape_id.starts_with("gzm:shA."), "{shape_id}");
}

#[tokio::test(flavor = "multi_thread")]
async fn every_branch_answers_503_retry_after_while_the_feed_loads() {
    let r = seeded().await;
    *r.feed.lock().unwrap() = None;
    let live = |_: &'static str| r.live.clone();
    for res in [
        stops::handle(&get("", "city=gzm", &[]), live),
        lines::handle(&get("", "city=gzm", &[]), live),
        trip::handle(&get("gzm:tA", "", &[]), live),
        stop_departures::handle(&get("gzm:b", "", &[]), live),
        connections::handle(&get("", "city=gzm&from=gzm:a&to=gzm:c", &[]), live),
    ] {
        let res = res.unwrap();
        assert_eq!(res.status(), 503);
        assert_eq!(header(&res, "retry-after").as_deref(), Some("10"));
    }
    let node = NodeClient::new(1);
    let res = trips::handle(&get("", "ids=gzm:tA", &[]), &node, live).await.unwrap();
    assert_eq!(header(&res, "cache-control").as_deref(), Some("no-store"));
}

/// The TS swaps the rigged live into the singleton; Rust's singleton is fixed, so `enabled` comes from
/// `safe_gzm_health()` and the counters from the rigged live's own block, which `safe_gzm_health` spreads after it.
#[tokio::test(flavor = "multi_thread")]
async fn health_block_informational_counters() {
    let r = seeded().await;
    let h = r.live.health();
    assert_eq!(safe_gzm_health()["enabled"], true);
    assert_eq!(h["vehicles"], 1);
    assert_eq!(h["matched"], 1);
    let spread: Vec<String> = std::iter::once("enabled".to_owned())
        .chain(get_gzm().health().as_object().unwrap().keys().cloned())
        .collect();
    let got: Vec<String> = safe_gzm_health().as_object().unwrap().keys().cloned().collect();
    assert_eq!(got, spread);
    assert!(got.iter().any(|k| k == "vehicles") && got.iter().any(|k| k == "matched"));
}
