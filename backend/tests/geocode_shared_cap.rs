//! server/api/geocode/route.ts keeps ONE `inFlight` counter (MAX_IN_FLIGHT = 4) for every city: BB and zbiorkom
//! geocodes share the public Photon host's 4 requests in flight. Photon here accepts every connection and holds it
//! until the test releases it, then drops it (the route's 502).

use std::net::TcpListener;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

#[allow(dead_code)]
#[path = "support/owned_front.rs"]
mod owned_front;

use owned_front::{Front, Res};

/// connections Photon accepted
static ACCEPTED: AtomicUsize = AtomicUsize::new(0);
/// each step lets go of every connection accepted before it
static RELEASED: AtomicUsize = AtomicUsize::new(0);
static IP: AtomicUsize = AtomicUsize::new(0);

static FRONT: LazyLock<Front> = LazyLock::new(|| {
    let photon = TcpListener::bind("127.0.0.1:0").unwrap();
    let photon_addr = photon.local_addr().unwrap();
    thread::spawn(move || {
        for stream in photon.incoming().flatten() {
            // read before counting: a release the test sends after seeing the count lets this one go
            let step = RELEASED.load(Ordering::SeqCst);
            ACCEPTED.fetch_add(1, Ordering::SeqCst);
            thread::spawn(move || {
                while RELEASED.load(Ordering::SeqCst) == step {
                    thread::sleep(Duration::from_millis(10));
                }
                drop(stream);
            });
        }
    });
    let dir = std::env::temp_dir().join(format!("unimaps-geocode-cap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // SAFETY: runs once, before anything in this binary reads the environment (the one test starts with FRONT)
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", dir.join("output"));
        std::env::set_var("KB_GEOCODER_URL", format!("http://{photon_addr}/api/"));
        std::env::set_var("KB_GZM_GTFS_URL", "http://127.0.0.1:9/gtfs");
        std::env::set_var("KB_GZM_POSITIONS_URL", "http://127.0.0.1:9/positions");
        std::env::set_var("KB_ZB_API_URL", "http://127.0.0.1:9");
        std::env::set_var("KB_GZM_SDIP", "0");
        std::env::set_var("KB_GZM_NEWS_URL", "off");
        std::env::set_var("KB_OSRM_URL", "off");
        std::env::set_var("KB_LOG_LEVEL", "error");
    }
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("404.html"), "<!doctype html>").unwrap();
    Front::serve(&out)
});

/// `method path` from its own client address (the per-IP bucket never decides here)
fn send(method: &str, path: &str) -> Res {
    let ip = format!("10.7.0.{}", IP.fetch_add(1, Ordering::SeqCst) + 1);
    FRONT.request(method, path, &[("x-forwarded-for", &ip)], b"")
}

fn hold(paths: Vec<String>) -> Vec<thread::JoinHandle<Res>> {
    paths
        .into_iter()
        .map(|p| thread::spawn(move || send("GET", &p)))
        .collect()
}

fn until(want: usize) {
    for _ in 0..500 {
        if ACCEPTED.load(Ordering::SeqCst) >= want {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("waited for {want}, got {}", ACCEPTED.load(Ordering::SeqCst));
}

fn release(held: Vec<thread::JoinHandle<Res>>) {
    RELEASED.fetch_add(1, Ordering::SeqCst);
    for h in held {
        assert_eq!(h.join().unwrap().status, 502);
    }
}

#[test]
fn one_in_flight_cap_over_bb_and_zbiorkom_geocodes() {
    LazyLock::force(&FRONT);
    let too_many = (429, r#"{"error":"Too many requests"}"#);

    // four BB searches wait on Photon: the next cache miss of any city gets 429 and never reaches Photon
    let bb = hold((0..4).map(|i| format!("/api/geocode?q=hold-bb-{i}")).collect());
    until(4);
    let r = send("GET", "/api/geocode?city=gzm&q=katowice");
    assert_eq!((r.status, r.body.as_str()), too_many);
    let r = send("HEAD", "/api/geocode?city=gzm&q=katowice");
    assert_eq!((r.status, r.body.as_str()), (429, ""));
    // the 400 comes before the in-flight check
    assert_eq!(send("GET", "/api/geocode?q=ab").status, 400);
    assert_eq!(ACCEPTED.load(Ordering::SeqCst), 4, "a refused search reached Photon");
    release(bb);

    // four zbiorkom searches wait on Photon: a BB cache miss gets 429
    let zb = hold(
        (0..4)
            .map(|i| format!("/api/geocode?city=gzm&q=zb-search-{i}"))
            .collect(),
    );
    until(8);
    let r = send("GET", "/api/geocode?q=bielsko");
    assert_eq!((r.status, r.body.as_str()), too_many);
    assert_eq!(ACCEPTED.load(Ordering::SeqCst), 8, "a refused search reached Photon");
    release(zb);

    // every slot given back: a BB search reaches Photon again
    let again = hold(vec!["/api/geocode?q=bielsko".into()]);
    until(9);
    release(again);
}
