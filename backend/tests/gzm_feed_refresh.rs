//! The feed refresh end to end (lib/gzm-feed.ts startGzmFeed, no TS test): first download, a restart from the
//! kept zip, a failing city. Its own binary: the config is read from the environment once per process.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::time::Duration;

use jiff::Timestamp;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use unimaps::gzm_feed::{
    RefreshState, checked_day_at, get_gzm_feed, gzm_feed_health, gzm_refresh_due, start_gzm_feed, stop_gzm_feed,
};

const T1: &str = "route_id,service_id,trip_id,trip_headsign\n1n,s1,t1,Dworzec";
const T2: &str = "route_id,service_id,trip_id,trip_headsign\n1n,s1,t1,Dworzec\n1n,s1,t2,Dworzec";

fn zip(trips: &str) -> Vec<u8> {
    let calls = ["t1", "t2"].iter().filter(|t| trips.contains(&format!(",{t},"))).fold(
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence".to_owned(),
        |acc, t| format!("{acc}\n{t},08:00:00,08:00:00,a,1\n{t},08:10:00,08:10:00,c,2"),
    );
    let files = [
        ("routes.txt", "route_id,route_short_name,route_type\n1n,1N,3"),
        (
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\na,Rynek,50.2590,19.0220\nc,Dworzec,50.2770,19.1300",
        ),
        ("trips.txt", trips),
        ("stop_times.txt", &calls),
        (
            "calendar.txt",
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns1,1,1,1,1,1,1,1,20261026,20261231",
        ),
    ];
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, body) in files {
        w.start_file(name, opts).unwrap();
        w.write_all(body.as_bytes()).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// `/gtfs`: the zip, then 304 to a conditional request; `/stale/…`: `newer` after 300 ms, conditional or not;
/// anything else: 500. Counts the zip requests.
async fn serve(body: Vec<u8>, newer: Vec<u8>, hits: Arc<AtomicUsize>) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            let (mut head, mut buf) = (Vec::new(), [0u8; 1024]);
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = s.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                head.extend_from_slice(&buf[..n]);
            }
            let head = String::from_utf8_lossy(&head).to_lowercase();
            let mut out = Vec::new();
            if head.starts_with("get /stale/") {
                tokio::time::sleep(Duration::from_millis(300)).await;
                hits.fetch_add(1, SeqCst);
                out.extend_from_slice(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", newer.len()).as_bytes());
                out.extend_from_slice(&newer);
            } else if !head.starts_with("get /gtfs ") {
                out.extend_from_slice(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
            } else if head.contains("if-modified-since:") {
                out.extend_from_slice(b"HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\n\r\n");
            } else {
                hits.fetch_add(1, SeqCst);
                out.extend_from_slice(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes());
                out.extend_from_slice(&body);
            }
            s.write_all(&out).await.unwrap();
            let _ = s.shutdown().await;
        }
    });
    base
}

async fn wait_for(what: &str, ok: impl Fn() -> bool) {
    for _ in 0..250 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_once_restarts_from_the_kept_zip_and_reports_a_failing_city() {
    let dir = std::env::temp_dir().join(format!("unimaps-gzm-refresh-{}", std::process::id()));
    let body = zip(T1);
    let newer = zip(T2);
    let hits = Arc::new(AtomicUsize::new(0));
    let base = serve(body.clone(), newer, hits.clone()).await;
    // SAFETY: the only test of this binary, before anything reads the environment
    unsafe {
        std::env::set_var("KB_GZM_DIR", &dir);
        std::env::set_var("KB_GZM_GTFS_URL", format!("{base}/gtfs"));
        std::env::set_var("KB_ZB_API_URL", &base);
    }
    let kept: PathBuf = dir.join("gtfs.zip");

    start_gzm_feed("gzm");
    start_gzm_feed("gzm");
    wait_for("the first feed", || get_gzm_feed("gzm").is_some()).await;
    let h = gzm_feed_health("gzm");
    assert_eq!(hits.load(SeqCst), 1);
    assert_eq!(
        (h["downloads"].as_u64(), h["download_bytes"].as_u64()),
        (Some(1), Some(body.len() as u64))
    );
    assert_eq!(h["stops"], 2);
    assert_eq!(h["trips"], 1);
    assert_eq!(h["last_error"], Value::Null);
    let today = checked_day_at(Timestamp::now().as_millisecond());
    assert_eq!(h["checked_day"].as_str().unwrap_or(""), today);
    assert_eq!(std::fs::read(&kept).unwrap(), body);
    assert!(!dir.join("gtfs.zip.tmp").exists());

    stop_gzm_feed("gzm");
    assert!(get_gzm_feed("gzm").is_none());
    assert_eq!(gzm_feed_health("gzm")["downloads"], 0);
    start_gzm_feed("gzm");
    wait_for("the kept feed", || get_gzm_feed("gzm").is_some()).await;
    // before 04:00 Warsaw the kept zip does not count for today: a conditional request, answered 304
    let settled = || gzm_feed_health("gzm")["checked_day"].as_str().unwrap_or("") == today;
    wait_for("the check", settled).await;
    assert_eq!(hits.load(SeqCst), 1, "no second download");
    assert_eq!(gzm_feed_health("gzm")["downloads"], 0);

    start_gzm_feed("broken");
    wait_for("the failure", || !gzm_feed_health("broken")["last_error"].is_null()).await;
    let h = gzm_feed_health("broken");
    assert_eq!(h["last_error"], "Error: GZM GTFS HTTP 500");
    assert_eq!(h["version"], Value::Null);
    assert!(get_gzm_feed("broken").is_none());
    stop_gzm_feed("broken");

    // a kept zip from two days ago and a newer feed upstream: the city's first feed is already the new one
    let old = dir.join("stale/gtfs.zip");
    std::fs::create_dir_all(old.parent().unwrap()).unwrap();
    std::fs::write(&old, &body).unwrap();
    let two_days_ago = std::time::SystemTime::now() - Duration::from_secs(2 * 86_400);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(two_days_ago)
        .unwrap();
    let kept = RefreshState {
        has_feed: true,
        checked_day: checked_day_at(Timestamp::try_from(two_days_ago).unwrap().as_millisecond()),
        retry_at: 0,
    };
    // before 04:00 Warsaw a check is not due: the kept zip shows and nothing is downloaded
    let due = gzm_refresh_due(&kept, Timestamp::now().as_millisecond());
    let hits_before = hits.load(SeqCst);
    start_gzm_feed("stale");
    wait_for("the stale city's feed", || get_gzm_feed("stale").is_some()).await;
    let h = gzm_feed_health("stale");
    assert_eq!(h["trips"], if due { 2 } else { 1 }, "first feed published");
    assert_eq!(h["downloads"], u64::from(due));
    assert_eq!(hits.load(SeqCst) - hits_before, usize::from(due));
    stop_gzm_feed("stale");
    stop_gzm_feed("gzm");
    let _ = std::fs::remove_dir_all(dir);
}
