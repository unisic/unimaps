//! Rust counterpart of test/push-alerts-remote.test.ts: a zbiorkom alert reads its board in-process, from the city's
//! local feed. Its own binary: the config is read from the environment once per
//! process, and every upstream URL points at a closed local port.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::Timestamp;
use serde_json::{Value, json};
use unimaps::gzm_feed::get_gzm_feed;
use unimaps::push_alerts::{PushAlerts, live_board};
use unimaps::shared::alerts::Alert;
use unimaps::time::{agency_clock, service_day_base};
use unimaps::web_push::{PushKeys, PushSub, SendFn};

fn gtfs_time(secs: i64) -> String {
    format!("{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
}

/// Line 7 a -> c, its departure from a `dep` seconds after the service day's base, every day around `today`.
fn zip(dep: i64, today: jiff::civil::Date) -> Vec<u8> {
    let day = |d: jiff::civil::Date| d.strftime("%Y%m%d").to_string();
    let (from, to) = (
        today.yesterday().map(day).unwrap_or_default(),
        today.tomorrow().map(day).unwrap_or_default(),
    );
    let files = [
        ("routes.txt", "route_id,route_short_name,route_type\nr7,7,3".to_owned()),
        (
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\na,Alfa 01,50.2590,19.0220\nc,Gamma 01,50.2770,19.1300".to_owned(),
        ),
        (
            "trips.txt",
            "route_id,service_id,trip_id,trip_headsign\nr7,s1,t1,Gamma".to_owned(),
        ),
        (
            "stop_times.txt",
            format!(
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,{0},{0},a,1\nt1,{1},{1},c,2",
                gtfs_time(dep),
                gtfs_time(dep + 600)
            ),
        ),
        (
            "calendar.txt",
            format!(
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns1,1,1,1,1,1,1,1,{from},{to}"
            ),
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

#[tokio::test(flavor = "multi_thread")]
async fn a_zbiorkom_alert_reads_its_board_in_process() {
    let dir = std::env::temp_dir().join(format!("unimaps-push-zb-{}", std::process::id()));
    let closed = "http://127.0.0.1:9";
    // SAFETY: the only test of this binary, before anything reads the environment
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", &dir);
        std::env::set_var("KB_GZM_DIR", dir.join("gzm"));
        std::env::set_var("KB_GZM_GTFS_URL", format!("{closed}/gtfs"));
        std::env::set_var("KB_GZM_POSITIONS_URL", format!("{closed}/positions"));
        std::env::set_var("KB_ZB_API_URL", closed);
        std::env::set_var("KB_GZM_SDIP", "0");
    }
    let now_ms = Timestamp::now().as_millisecond();
    let (today, _) = agency_clock(Timestamp::from_millisecond(now_ms).unwrap());
    let now = now_ms as f64 / 1000.0;
    let dep = (now.round() as i64) - service_day_base(today) + 240;
    std::fs::create_dir_all(dir.join("gzm")).unwrap();
    std::fs::write(dir.join("gzm").join("gtfs.zip"), zip(dep, today)).unwrap();

    let sent: Arc<Mutex<Vec<Value>>> = Arc::default();
    let log = sent.clone();
    let send: SendFn = Arc::new(move |_to: PushSub, msg: Value, _ttl: f64| {
        log.lock().unwrap().push(msg);
        Box::pin(async { Ok(201) })
    });
    let s = PushAlerts::new(dir.join("push").join("alerts.json"), send, live_board()).load();
    let sub = PushSub {
        endpoint: "https://fcm.googleapis.com/fcm/send/1".into(),
        keys: PushKeys {
            p256dh: "x".into(),
            auth: "y".into(),
        },
    };
    let alert: Alert = serde_json::from_value(json!({
        "key": "gzm:t1#1",
        "designator": "gzm:a",
        "stopName": "Alfa 01",
        "line": "7",
        "dest": "Gamma",
        "leadMin": 5,
        "until": now + 1800.0,
    }))
    .unwrap();
    assert!(s.add(&sub, &alert));

    // the first read starts the city: no board while its feed loads, the alert waits for the next tick
    s.tick().await;
    assert_eq!(sent.lock().unwrap().len(), 0);
    assert_eq!(s.size(), 1);
    for _ in 0..250 {
        if get_gzm_feed("gzm").is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(get_gzm_feed("gzm").is_some(), "the kept feed loads");

    s.tick().await;
    let got: Vec<(Value, Value)> = sent
        .lock()
        .unwrap()
        .iter()
        .map(|m| (m["title"].clone(), m["tag"].clone()))
        .collect();
    assert_eq!(got, vec![(json!("7 za 4 min"), json!("gzm:t1#1"))]);
    assert_eq!(s.size(), 0);
    s.stop();
    let _ = std::fs::remove_dir_all(dir);
}
