//! server/api/shapes/route.ts over a `Bb` nothing started yet: the route's own `startPoller()` loads the store
//! file synchronously (`st.shapes.start()`), so the lookup on the next line already sees the stored road shape.

#[allow(dead_code)]
#[path = "support/stops_fake.rs"]
mod rig;

use std::path::PathBuf;
use std::sync::LazyLock;

use http_body_util::BodyExt;
use hyper::StatusCode;
use hyper::header::{HeaderMap, HeaderValue};
use rig::{ENV, Fake, Fakes, NoOsrm, stop};
use serde_json::{Value, json};
use unimaps::api::{ApiRequest, shapes};
use unimaps::mzk_poller::MzkPoller;
use unimaps::poller::{LivePoller, LivePollerOptions};
use unimaps::poller_singleton::Bb;
use unimaps::shape_store::{ShapeStore, ShapeStoreOptions};

const KEY: &str = "kb:3f9a0c11d2e4";
const ID: &str = "kb:3f9a0c11d2e4.7b21c0";

/// A cold `Bb` of fakes whose store file holds road entry `KEY` at rev 7b21c0.
fn cold(name: &str) -> &'static Bb<Fakes> {
    LazyLock::force(&ENV);
    let dir = std::env::temp_dir().join(format!("unimaps-shapes-owned-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let file: PathBuf = dir.join("route-shapes.v1.json");
    let entry =
        json!({ "src": "osrm", "poly": "_p~iF~ps|U_ulLnnqC", "len": 1234.5, "stops": [0, 1234.5], "rev": "7b21c0" });
    let body = json!({ "format": "kb-map/route-shapes", "version": 1, "shapes": { KEY: entry } });
    std::fs::write(&file, body.to_string()).expect("store file");
    let fake = Fake::default();
    let store = ShapeStore::new(ShapeStoreOptions {
        file: Some(file),
        timers: false,
        ..ShapeStoreOptions::new(NoOsrm)
    });
    let bb = Bb::<Fakes>::from_parts(
        fake.clone(),
        LivePoller::new(fake.clone(), LivePollerOptions::default()),
        fake.clone(),
        MzkPoller::new(fake).with_stop_dirs_file(None),
        store,
    )
    .with_gtfs_dir(dir.join("no-gtfs"));
    Box::leak(Box::new(bb))
}

fn request(ip: &str, if_none_match: Option<&str>) -> ApiRequest {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", HeaderValue::from_str(ip).expect("ip"));
    if let Some(tag) = if_none_match {
        headers.insert("if-none-match", HeaderValue::from_str(tag).expect("tag"));
    }
    ApiRequest {
        query: format!("?ids={ID}"),
        headers,
        ..Default::default()
    }
}

async fn settle(bb: &'static Bb<Fakes>) {
    let _ = bb.start_poller().await;
    stop(bb).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cold_lookup_sees_the_stored_shape_immutable() {
    let bb = cold("plain");
    let res = shapes::get_owned(&request("10.0.0.1", None), bb).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get("cache-control").and_then(|v| v.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );
    let bytes = res.into_body().collect().await.expect("body").to_bytes();
    let body: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(body["shapes"][ID]["id"], ID);
    assert_eq!(body["missing"], json!([]));
    settle(bb).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cold_lookup_answers_304_to_its_own_id() {
    let bb = cold("etag");
    let tag = format!("\"{ID}\"");
    let res = shapes::get_owned(&request("10.0.0.2", Some(&tag)), bb).await;
    assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
    settle(bb).await;
}
