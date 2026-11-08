//! server/api/connections/route.ts budgeted(): allowSearch, the search and chargeSearch run in one event-loop turn,
//! so a search arriving while another runs sees that search's charge, and a failed search is charged too. Its own
//! test binary: the search budget is process-wide.

mod gzm_rig;

use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::time::Duration;

use gzm_rig::{Fake, at, now_fn};
use hyper::StatusCode;
use hyper::header::{HeaderMap, HeaderValue};
use unimaps::api::{ApiRequest, connections};
use unimaps::gzm::GzmLive;

/// A live layer whose feed getter (called inside the search) takes 300 ms, then answers "loading" or panics.
fn slow(panics: bool) -> Arc<GzmLive<Fake>> {
    let clock = Arc::new(AtomicI64::new(at("08:03", 0) * 1000));
    let live = GzmLive::new("gzm", Fake::positions(&Arc::default()))
        .with_now(now_fn(&clock))
        .with_feed(Arc::new(move || {
            std::thread::sleep(Duration::from_millis(300));
            assert!(!panics, "search failed");
            None
        }));
    Arc::new(live)
}

async fn search(live: &Arc<GzmLive<Fake>>, ip: &str) -> StatusCode {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", HeaderValue::from_str(ip).unwrap());
    let req = ApiRequest {
        param: String::new(),
        query: "city=gzm&from=gzm:a&to=gzm:c".into(),
        headers,
        ..Default::default()
    };
    let live = Arc::clone(live);
    tokio::spawn(async move { connections::handle(&req, |_| live).unwrap().status() })
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_search_arriving_during_another_sees_its_charge_and_a_failed_one_is_charged() {
    let live = slow(false);
    let (first, second) = tokio::join!(search(&live, "10.7.0.1"), async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        search(&live, "10.7.0.2").await
    });
    assert_eq!(
        (first, second),
        (StatusCode::SERVICE_UNAVAILABLE, StatusCode::TOO_MANY_REQUESTS)
    );

    // the budget is back above zero (-100 ms + 150 ms)
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(search(&slow(true), "10.7.0.3").await, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(search(&live, "10.7.0.4").await, StatusCode::TOO_MANY_REQUESTS);
}
