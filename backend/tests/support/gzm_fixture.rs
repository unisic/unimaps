//! test/support/gzm-fixture.ts: the synthetic GZM feed shared by the GZM tests. Line 7 (tram), brigade 3 runs
//! tA a->c then tB c->a, brigade 4 runs tX a->c sharing tA's first call; every day 2026-10-20..2026-11-10.

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use unimaps::gzm_feed::{GzmFeed, parse_gzm_zip};

pub const DATE: &str = "2026-10-28";
pub const LAT: f64 = 50.25;
pub const LON_A: f64 = 19.0;
pub const LON_B: f64 = 19.01;
pub const LON_C: f64 = 19.02;

pub fn files() -> Vec<(&'static str, String)> {
    let stops = format!(
        "stop_id,stop_name,stop_lat,stop_lon,location_type\na,Alfa 01,{LAT},{LON_A},0\nb,Beta 01,{LAT},{LON_B},0\nc,Gamma 01,{LAT},{LON_C},0"
    );
    let shapes = format!(
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshA,{LAT},{LON_A},1\nshA,{LAT},{LON_B},2\nshA,{LAT},{LON_C},3"
    );
    vec![
        (
            "routes.txt",
            "route_id,agency_id,route_short_name,route_long_name,route_type\nr7,1,7,Tramwaj 7,0".into(),
        ),
        ("stops.txt", stops),
        (
            "trips.txt",
            "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,brigade\nr7,s1,tA,Gamma,0,shA,3\nr7,s1,tB,Alfa,1,,3\nr7,s1,tX,Gamma,0,,4".into(),
        ),
        (
            "stop_times.txt",
            [
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
                "tA,08:00:00,08:00:00,a,0",
                "tA,08:05:00,08:05:00,b,1",
                "tA,08:10:00,08:10:00,c,2",
                "tB,08:20:00,08:20:00,c,0",
                "tB,08:25:00,08:25:00,b,1",
                "tB,08:30:00,08:30:00,a,2",
                "tX,08:00:00,08:00:00,a,0",
                "tX,08:06:00,08:06:00,b,1",
                "tX,08:12:00,08:12:00,c,2",
            ]
            .join("\n"),
        ),
        ("shapes.txt", shapes),
        (
            "calendar.txt",
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns1,1,1,1,1,1,1,1,20261020,20261110".into(),
        ),
        (
            "feed_info.txt",
            "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\nZTM,https://example.invalid,pl,20261020,20261110,1".into(),
        ),
    ]
}

/// Parses `files` as city `slug` from a fresh temp dir (removed again).
pub fn load_gzm_feed(files: &[(&str, String)], slug: &str) -> GzmFeed {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "unimaps-gzm-fixture-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, body) in files {
        w.start_file(*name, opts).unwrap();
        w.write_all(body.as_bytes()).unwrap();
    }
    let file = dir.join("gtfs.zip");
    std::fs::write(&file, w.finish().unwrap().into_inner()).unwrap();
    let feed = parse_gzm_zip(&file, slug, &|_| None);
    let _ = std::fs::remove_dir_all(&dir);
    feed.unwrap()
}

/// `serviceDayBase(DATE)`
pub fn base() -> i64 {
    unimaps::time::service_day_base(DATE.parse().unwrap())
}

/// epoch secs of DATE hh:mm(+sec) Warsaw
pub fn at(hhmm: &str, sec: i64) -> i64 {
    let (h, m) = hhmm.split_once(':').unwrap();
    base() + h.parse::<i64>().unwrap() * 3600 + m.parse::<i64>().unwrap() * 60 + sec
}

#[derive(Default)]
pub struct RecOpts<'a> {
    pub key: Option<&'a str>,
    pub lon: Option<f64>,
    pub lat: Option<f64>,
    /// epoch secs
    pub ts: i64,
    pub calls: Vec<(i64, &'a str)>,
    pub delay: i64,
    pub brigade: Option<&'a str>,
    pub line: Option<&'a str>,
}

/// A zbiorkom positions record.
pub fn rec(o: &RecOpts) -> Value {
    let key = o.key.unwrap_or("283_4285");
    let id = key.split('_').nth(1).unwrap_or_default();
    let calls: Vec<Value> = o
        .calls
        .iter()
        .map(|&(seq, t)| json!({ "sequence": seq, "name": "x", "scheduledArrival": at(t, 0) * 1000, "scheduledDeparture": at(t, 0) * 1000 }))
        .collect();
    json!({
        "vehicle": { "id": id, "type": "0", "agency": "default", "model": "Konstal 105Na" },
        "routeName": o.line.unwrap_or("7"),
        "brigade": o.brigade.unwrap_or("3"),
        "location": [o.lon.unwrap_or(LON_B), o.lat.unwrap_or(LAT)],
        "timestamp": o.ts * 1000,
        "bearing": 90,
        "delay": o.delay * 1000,
        "headsign": "Gamma",
        "upcomingStops": calls,
        "url": format!("https://x.invalid/gzm/vehicle/0%3A{key}"),
    })
}
