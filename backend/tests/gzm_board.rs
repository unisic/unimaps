//! test/stop-group.test.ts (nearestWithin, whole-stop board) and test/gzm-routes.test.ts (connection memo) over `GzmLive`'s route answers,
//! plus the memo under concurrent searches and a feed swap.

#[path = "support/gzm_fixture.rs"]
#[allow(dead_code)]
mod gzm_fixture;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use gzm_fixture::{LAT, LON_A, LON_B, LON_C, at, files, load_gzm_feed};
use serde_json::{Value, json};
use unimaps::geo::nearest_within;
use unimaps::gzm::{GzmLive, Lookup, ZbResponse, ZbTransport};
use unimaps::gzm_feed::GzmFeed;
use unimaps::router::RouteQuery;

static FEED: LazyLock<Arc<GzmFeed>> = LazyLock::new(|| Arc::new(load_gzm_feed(&files(), "gzm")));

#[derive(Clone, Default)]
struct Fake(Arc<Mutex<Vec<Value>>>);

impl ZbTransport for Fake {
    fn get(
        &self,
        _url: &str,
        _headers: &[(&str, &str)],
        _timeout: Duration,
        _max_body: usize,
    ) -> impl Future<Output = Result<ZbResponse, String>> + Send {
        let body = json!({ "positions": *self.0.lock().unwrap() }).to_string();
        async move {
            Ok(ZbResponse {
                status: 200,
                body,
                ..ZbResponse::default()
            })
        }
    }
}

struct Rig {
    live: GzmLive<Fake>,
    clock: Arc<AtomicI64>,
}

fn rig(feed: Option<Arc<GzmFeed>>) -> Rig {
    let up = Fake::default();
    let clock = Arc::new(AtomicI64::new(at("08:03", 0) * 1000));
    let c = Arc::clone(&clock);
    let live = GzmLive::new("gzm", up)
        .with_now(Arc::new(move || c.load(Ordering::SeqCst)))
        .with_feed(Arc::new(move || feed.clone()))
        .with_url(Some("https://x.invalid/positions".into()))
        .with_sdip_url(None);
    Rig { live, clock }
}

fn found(l: Lookup<Value>) -> Value {
    match l {
        Lookup::Found(v) => v,
        other => panic!("{other:?}"),
    }
}

#[test]
fn nearest_within_keeps_the_points_within_the_radius_nearest_first_at_most_max() {
    let all = [("far", 19.01), ("b", 19.002), ("self", 19.0), ("a", 19.001)];
    let ids = |max| -> Vec<&str> {
        nearest_within((LAT, all[2].1), all, |p| (LAT, p.1), 600.0, max)
            .into_iter()
            .map(|p| p.0)
            .collect()
    };
    assert_eq!(ids(10), ["self", "a", "b"]);
    assert_eq!(ids(2), ["self", "a"]);
}

#[test]
fn lists_one_pole_by_default_every_nearby_pole_with_its_post_number_with_all() {
    // b2 "Beta 03" is ~70 m from b "Beta 01"; c renamed "Beta 02" shares the name but is ~700 m away
    let mut f = files();
    for (name, body) in &mut f {
        match *name {
            "stops.txt" => {
                *body = format!(
                    "stop_id,stop_name,stop_lat,stop_lon,location_type\na,Alfa 01,{LAT},{LON_A},0\nb,Beta 01,{LAT},{LON_B},0\nb2,Beta 03,{LAT},{},0\nc,Beta 02,{LAT},{LON_C},0",
                    LON_B + 0.001
                );
            }
            "trips.txt" => body.push_str("\nr7,s1,tY,Beta,0,,5"),
            "stop_times.txt" => {
                body.push_str("\ntY,08:00:00,08:00:00,a,0\ntY,08:07:00,08:07:00,b2,1\ntY,08:09:00,08:09:00,c,2")
            }
            _ => {}
        }
    }
    let r = rig(Some(Arc::new(load_gzm_feed(&f, "gzm"))));
    let one = found(r.live.departures("gzm:b", false));
    assert_eq!(one["poles"], 2, "the far same-name pole is not part of the stop");
    let rows = one["rows"].as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|x| x["trip_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["gzm:tA", "gzm:tX", "gzm:tB"]);
    assert!(rows.iter().all(|x| x.get("pole").is_none()));
    let all = found(r.live.departures("gzm:b", true));
    assert_eq!(all["poles"], 2);
    let got: Vec<(&str, &str)> = all["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| (x["trip_id"].as_str().unwrap(), x["pole"].as_str().unwrap()))
        .collect();
    assert_eq!(
        got,
        [("gzm:tA", "01"), ("gzm:tX", "01"), ("gzm:tY", "03"), ("gzm:tB", "01")]
    );
    let single = found(r.live.departures("gzm:a", true));
    assert_eq!(single.get("poles"), None, "a one-pole stop offers no whole-stop board");
}

#[test]
fn memoizes_connections_per_minute_and_per_feed_with_gzm_legs() {
    let feed: Arc<Mutex<Arc<GzmFeed>>> = Arc::new(Mutex::new(Arc::clone(&FEED)));
    let f = Arc::clone(&feed);
    let r = rig(None);
    let live = r.live.with_feed(Arc::new(move || Some(Arc::clone(&f.lock().unwrap()))));
    r.clock.store(at("07:50", 0) * 1000, Ordering::SeqCst);
    let q = RouteQuery {
        from: "gzm:a",
        to: "gzm:c",
        ..RouteQuery::default()
    };
    let first = live.connections(&q, &[]).unwrap();
    let wire = serde_json::to_value(&*first).unwrap();
    let leg = &wire[0]["legs"][0];
    assert_eq!(leg["tripId"], "gzm:tA");
    assert_eq!(leg["operator"], "GZM");
    assert!(leg["shape_id"].as_str().unwrap().starts_with("gzm:shA."));
    assert!(Arc::ptr_eq(&first, &live.connections(&q, &[]).unwrap()), "a memo hit");
    r.clock.store((at("07:50", 0) + 61) * 1000, Ordering::SeqCst);
    let second = live.connections(&q, &[]).unwrap();
    assert!(!Arc::ptr_eq(&first, &second), "a minute later: searched again");
    *feed.lock().unwrap() = Arc::new(load_gzm_feed(&files(), "gzm"));
    assert!(
        !Arc::ptr_eq(&second, &live.connections(&q, &[]).unwrap()),
        "a new feed: searched again"
    );
    let trams = ["0".to_owned()];
    assert!(
        live.connections(&q, &trams).unwrap().is_empty(),
        "every trip is a tram: nothing to ride"
    );
}

/// TS runs a whole search on the event loop, so an identical query that arrives meanwhile hits the memo.
#[test]
fn concurrent_identical_connection_queries_search_once() {
    for _ in 0..100 {
        let r = rig(Some(Arc::clone(&FEED)));
        r.clock.store(at("07:50", 0) * 1000, Ordering::SeqCst);
        let start = std::sync::Barrier::new(8);
        let res: Vec<_> = std::thread::scope(|s| {
            let hs: Vec<_> = (0..8)
                .map(|_| {
                    s.spawn(|| {
                        let q = RouteQuery {
                            from: "gzm:a",
                            to: "gzm:c",
                            ..RouteQuery::default()
                        };
                        start.wait();
                        r.live.connections(&q, &[]).unwrap()
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(
            res.iter().all(|x| Arc::ptr_eq(x, &res[0])),
            "one search, the rest memo hits"
        );
    }
}

/// A search that took the old feed must not wipe the new feed's memo when it ends after the swap.
#[test]
fn a_search_ending_after_a_feed_swap_keeps_the_new_feeds_memo() {
    let f2 = Arc::new(load_gzm_feed(&files(), "gzm"));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let done_rx = Mutex::new(done_rx);
    let calls = AtomicI64::new(0);
    let r = rig(None);
    let live = r.live.with_feed(Arc::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) > 0 {
            return Some(Arc::clone(&f2));
        }
        entered_tx.send(()).ok();
        done_rx.lock().unwrap().recv_timeout(Duration::from_millis(300)).ok();
        Some(Arc::clone(&FEED))
    }));
    r.clock.store(at("07:50", 0) * 1000, Ordering::SeqCst);
    let q = || RouteQuery {
        from: "gzm:a",
        to: "gzm:c",
        ..RouteQuery::default()
    };
    let b = std::thread::scope(|s| {
        let a = s.spawn(|| live.connections(&q(), &[]).unwrap());
        entered_rx.recv().unwrap();
        let b = live.connections(&q(), &[]).unwrap();
        done_tx.send(()).ok();
        a.join().unwrap();
        b
    });
    assert!(
        Arc::ptr_eq(&b, &live.connections(&q(), &[]).unwrap()),
        "a memo hit on the new feed"
    );
}
