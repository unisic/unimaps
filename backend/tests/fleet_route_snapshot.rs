//! server/api/fleet/route.ts builds `{ stats, vehicles }` from one synchronous read of the tracker, so the list and
//! its counters always describe the same poll. Here MZK polls land from another thread while the BB route answers.

#[allow(dead_code)]
#[path = "support/stops_fake.rs"]
mod rig;

#[allow(dead_code)]
#[path = "support/fleet.rs"]
mod fleet;

use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use http_body_util::BodyExt;
use serde_json::{Value, json};
use unimaps::api::{ApiRequest, fleet as fleet_route};
use unimaps::fleet_tracker::FleetTracker;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bb_list_stats_and_vehicles_come_from_one_poll() {
    LazyLock::force(&rig::ENV);
    let fake = rig::Fake::default();
    let bb = Box::leak(Box::new(rig::started(&fake, None, None).await));
    let tracker: &'static FleetTracker = Box::leak(Box::new(fleet::mem_tracker()));
    let running = [json!({
        "vehicleId": "230",
        "lineName": "7",
        "courseLoid": 1,
        "direction": "Zajezdnia MZK",
        "delaySec": 0,
        "latitude": 49.79,
        "longitude": 19.04,
        "orderInCourse": 1,
        "stopPoints": [
            fleet::stop("31", "Szyndzielnia", 0, 0.0, 1790080000000),
            fleet::stop("446", "Zajezdnia MZK", 1, 2300.0, 1790080300000),
        ],
    })];

    static DONE: AtomicBool = AtomicBool::new(false);
    let writers: Vec<_> = (0..4)
        .map(|i| {
            let running = running.clone();
            std::thread::spawn(move || {
                while !DONE.load(Ordering::Relaxed) {
                    fleet::update(tracker, &running);
                    for _ in 0..i * 500 {
                        std::hint::spin_loop();
                    }
                    fleet::update(tracker, &[]);
                }
            })
        })
        .collect();

    let mut mismatch = None;
    let req = ApiRequest {
        query: "?status=active".to_owned(),
        ..Default::default()
    };
    for _ in 0..20000 {
        let res = fleet_route::get_bb(&req, bb, || tracker).await;
        let bytes = res
            .into_body()
            .collect()
            .await
            .map(|b| b.to_bytes())
            .unwrap_or_default();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let listed = body["vehicles"]
            .as_array()
            .map_or(0, |v| v.iter().filter(|v| v["status"] == "active").count());
        let counted = body["stats"]["activeCount"].as_u64().unwrap_or(u64::MAX);
        if listed as u64 != counted {
            mismatch = Some((listed, counted));
            break;
        }
    }
    DONE.store(true, Ordering::Relaxed);
    for w in writers {
        let _ = w.join();
    }
    rig::stop(bb).await;
    assert_eq!(mismatch, None, "(active in vehicles[], stats.activeCount)");
}
