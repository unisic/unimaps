//! test/gzm-feed.test.ts (parse, shapes, upgrade, the OSRM matches of gzm_match, rejects, gzmRefreshDue;
//! serviceDayBase lives in src/time.rs, downloadGzmZip with the download) and the golden vectors of
//! lib/gzm-feed.ts (scripts/dump-vectors.ts: the support fixture and seeded hostile zbiorkom-style zips, some with
//! stored road matches, then the shape lookup and upgrade on each).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use unimaps::gtfs_csv::{NO_DROP_OFF, NO_PICKUP, PICKUP_ON_REQUEST};
use unimaps::gzm_feed::{GzmFeed, RefreshState, feed_area, gzm_refresh_due, parse_gzm_zip, raw_key};
use unimaps::gzm_match::Matcher;
use unimaps::js::{self, buffer_from_base64, num_value};
use unimaps::osrm::{MATCH_CHUNK_PUBLIC, OsrmHttp, OsrmTransport, osrm_match_base};
use unimaps::shape_store::ShapeSrc;
use unimaps::shared::polyline::{LatLng, LatLonBox, encode_polyline};

static V: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("vectors/gzm_feed.json")).unwrap());

/// Same JSON text: values, key order and number formatting.
fn same(got: &impl Serialize, want: &Value, what: &dyn std::fmt::Debug) {
    let (got, want) = (
        serde_json::to_string(got).unwrap(),
        serde_json::to_string(want).unwrap(),
    );
    if got != want {
        let at = got
            .bytes()
            .zip(want.bytes())
            .position(|(a, b)| a != b)
            .unwrap_or(got.len().min(want.len()));
        let cut = |s: &str| {
            String::from_utf8_lossy(&s.as_bytes()[at.saturating_sub(300)..(at + 300).min(s.len())]).into_owned()
        };
        panic!("{what:?}\n got: {}\nwant: {}", cut(&got), cut(&want));
    }
}

fn dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("unimaps-gzm-feed-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write_file(name: &str, bytes: &[u8]) -> PathBuf {
    let file = dir().join(name);
    std::fs::write(&file, bytes).unwrap();
    file
}

fn zip_of(files: &[(&str, String)]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, body) in files {
        w.start_file(*name, opts).unwrap();
        w.write_all(body.as_bytes()).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn none(_: &str) -> Option<String> {
    None
}

fn parse(name: &str, files: &[(&str, String)]) -> GzmFeed {
    parse_gzm_zip(&write_file(name, &zip_of(files)), "gzm", &none).unwrap()
}

/* ---------------- test/gzm-feed.test.ts ---------------- */

fn files() -> Vec<(&'static str, String)> {
    vec![
        (
            "routes.txt",
            [
                "route_id,agency_id,route_short_name,route_long_name,route_type",
                "1n,1,1N,\"Katowice, Plac Wolności - Sosnowiec\",3",
                "T6,1,,Tramwaj,0",
            ]
            .join("\r\n"),
        ),
        // nested member: the parser keys on the basename
        (
            "feed/stops.txt",
            [
                "stop_id,stop_name,stop_lat,stop_lon,location_type",
                "a,\"Katowice, Rynek 01\",50.2590,19.0220,0",
                "b,Plac Wolności 02,50.2600,19.0100,",
                "c,Sosnowiec Dworzec 03,50.2770,19.1300,0",
                "st,Parent station,50.2700,19.1300,1",
                "z,Zero,0,0,0",
                "u,Unused,50.3000,19.2000,0",
            ]
            .join("\n"),
        ),
        (
            "trips.txt",
            [
                "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,brigade",
                "1n,s1,t1,Sosnowiec,0,sh1,101",
                "1n,s1,t2,Katowice,1,,101",
                "1n,s1,t0,Sosnowiec,0,sh1,101",
                "T6,m1,t3,Plac,0,,7",
                "1n,s1,t4,Single,0,,",
            ]
            .join("\n"),
        ),
        (
            "stop_times.txt",
            [
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type",
                "t1,08:00:00,08:00:00,a,1,,0,1",
                "t1,08:05:00,08:06:00,b,2,Sosnowiec przez Rynek,3,0",
                "t1,08:15:00,08:15:00,c,3,,1,0",
                "t0,07:00:00,07:00:00,a,1,,,",
                "t0,07:10:00,07:10:00,c,2,,,",
                "t2,09:10:00,09:10:00,a,2,Katowice Rynek,,",
                "t2,09:00:00,09:00:00,c,1,Katowice,,",
                "t3,25:10:00,25:10:00,b,1,,,",
                "t3,25:20:00,25:20:00,a,2,,,",
                "t4,10:00:00,10:00:00,a,1,,,",
            ]
            .join("\n"),
        ),
        (
            "shapes.txt",
            [
                "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
                "sh1,50.2600,19.0100,2",
                "sh1,50.2590,19.0220,1",
                "sh1,50.2770,19.1300,3",
            ]
            .join("\n"),
        ),
        (
            "calendar.txt",
            [
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
                "s1,1,1,1,1,1,0,0,20261026,20261101",
            ]
            .join("\n"),
        ),
        (
            "calendar_dates.txt",
            [
                "service_id,date,exception_type",
                "s1,20261028,2",
                "s1,20261031,1",
                "m1,20261028,1",
            ]
            .join("\n"),
        ),
        (
            "feed_info.txt",
            [
                "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version",
                "ZTM,https://example.invalid,pl,20261028,20261031,1793153448968",
            ]
            .join("\n"),
        ),
    ]
}

fn with(
    mut files: Vec<(&'static str, String)>,
    name: &'static str,
    f: impl FnOnce(&str) -> String,
) -> Vec<(&'static str, String)> {
    match files.iter_mut().find(|(n, _)| *n == name) {
        Some(e) => e.1 = f(&e.1),
        None => files.push((name, f(""))),
    }
    files
}

static FEED: LazyLock<GzmFeed> = LazyLock::new(|| parse("gtfs.zip", &files()));

fn sorted_dates(f: &GzmFeed, id: &str) -> Vec<String> {
    let mut d: Vec<String> = f
        .trip(id)
        .unwrap()
        .t
        .dates
        .as_deref()
        .unwrap()
        .iter()
        .cloned()
        .collect();
    d.sort();
    d
}

#[test]
fn reads_feed_info_and_keeps_only_served_plain_stops_with_prefixed_ids() {
    let f = &*FEED;
    assert_eq!(f.version, "1793153448968");
    assert_eq!(f.start_date, "2026-10-28");
    assert_eq!(f.end_date, "2026-10-31");
    let mut ids: Vec<&str> = f.stops.keys().map(String::as_str).collect();
    ids.sort();
    assert_eq!(ids, ["gzm:a", "gzm:b", "gzm:c"]);
    assert_eq!(f.stops["gzm:a"].name, "Katowice, Rynek 01");
    let body: Value = serde_json::from_str(&f.stops_body).unwrap();
    assert_eq!(body["count"], 3);
    assert!(
        body["stops"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["id"] == s["designator"] && s["operator"] == "GZM")
    );
    let e = &f.stops_etag;
    assert!(
        e.len() == 24
            && e.starts_with('"')
            && e.ends_with('"')
            && e[1..23]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "{e}"
    );
}

#[test]
fn labels_trips_by_route_short_name_falling_back_to_route_id() {
    let f = &*FEED;
    assert_eq!(f.trip("gzm:t1").unwrap().t.line, "1N");
    assert_eq!(f.trip("gzm:t3").unwrap().t.line, "T6");
    let mut by: Vec<&str> = f.trips_of_line("1N").map(|t| t.t.trip_id.as_str()).collect();
    by.sort();
    assert_eq!(by, ["gzm:t0", "gzm:t1", "gzm:t2"]);
    assert!(f.trip("gzm:t4").is_none(), "a one-stop trip is dropped");
    assert_eq!(
        f.lines.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
        ["1N", "T6"]
    );
}

#[test]
fn resolves_dates_from_calendar_ranges_removals_and_calendar_dates_only_services() {
    let f = &*FEED;
    assert_eq!(
        sorted_dates(f, "gzm:t1"),
        ["2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30", "2026-10-31"]
    );
    assert_eq!(sorted_dates(f, "gzm:t3"), ["2026-10-28"]);
}

#[test]
fn keeps_times_past_24_h_pickup_flags_and_stop_headsigns_in_sequence_order() {
    let f = &*FEED;
    let t1 = f.trip("gzm:t1").unwrap();
    assert_eq!(t1.flags(), [NO_DROP_OFF, PICKUP_ON_REQUEST, NO_PICKUP]);
    assert_eq!(
        t1.x.stop_headsigns.as_deref().unwrap(),
        [None, Some("Sosnowiec przez Rynek".to_string()), None]
    );
    assert_eq!(
        (t1.t.stop_ids[1].as_str(), t1.t.seqs[1], t1.t.arr[1], t1.t.dep[1]),
        ("gzm:b", 2, 8 * 3600 + 300, 8 * 3600 + 360)
    );

    let t2 = f.trip("gzm:t2").unwrap();
    assert_eq!(&*t2.t.stop_ids, ["gzm:c", "gzm:a"], "sorted by stop_sequence");
    assert_eq!(
        t2.x.stop_headsigns.as_deref().unwrap(),
        [None, Some("Katowice Rynek".to_string())],
        "a stop headsign equal to the trip's is dropped"
    );

    assert!(f.trip("gzm:t0").unwrap().x.stop_headsigns.is_none());
    assert_eq!(f.trip("gzm:t3").unwrap().t.dep[0], 25 * 3600 + 600);
}

#[test]
fn chains_a_brigades_trips_of_one_route_and_service_by_first_departure() {
    let f = &*FEED;
    let next = |id: &str| f.trip(id).unwrap().x.next.map(|i| f.trip_at(i).t.trip_id.clone());
    assert_eq!(f.trip("gzm:t0").unwrap().x.brigade, "101");
    assert_eq!(next("gzm:t0").as_deref(), Some("gzm:t1"));
    assert_eq!(next("gzm:t1").as_deref(), Some("gzm:t2"));
    assert_eq!(next("gzm:t2"), None);
    assert_eq!(next("gzm:t3"), None);
}

#[test]
fn expands_a_frequencies_template_into_one_trip_per_headway_run_end_time_exclusive() {
    let fs = with(files(), "trips.txt", |s| format!("{s}\nT6,m1,f1,Metro,0,sh1,"));
    let fs = with(fs, "stop_times.txt", |s| {
        format!("{s}\nf1,05:00:00,05:00:00,a,1\nf1,05:04:00,05:05:00,b,2")
    });
    let fs = with(fs, "frequencies.txt", |_| {
        [
            "trip_id,start_time,end_time,headway_secs,exact_times",
            "f1,06:00:00,06:30:00,600,0",
            "f1,06:30:00,06:45:00,900,1",
            "f1,07:00:00,08:00:00,0,0",
        ]
        .join("\n")
    });
    let f = parse("freq.zip", &fs);
    assert!(f.trip("gzm:f1").is_none());
    let runs: Vec<_> = f.trips().filter(|t| t.t.headsign == "Metro").collect();
    assert_eq!(
        runs.iter().map(|t| t.t.trip_id.as_str()).collect::<Vec<_>>(),
        ["gzm:f1.21600", "gzm:f1.22200", "gzm:f1.22800", "gzm:f1.23400"]
    );
    let r = &runs[1].t;
    assert_eq!(
        r.dep
            .iter()
            .enumerate()
            .map(|(i, &d)| [r.arr[i], d])
            .collect::<Vec<_>>(),
        [[22200, 22200], [22440, 22500]]
    );
    assert_eq!(f.trip("gzm:t1").unwrap().t.dep[0], 8 * 3600);
}

fn is_wire_id(id: &str, key: &str) -> bool {
    id.strip_prefix(key)
        .and_then(|r| r.strip_prefix('.'))
        .is_some_and(|rev| rev.len() == 6 && rev.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

#[test]
fn serves_shapes_with_rev_stamped_wire_ids() {
    let f = &*FEED;
    assert_eq!(f.shapes.size(), 1);
    let id = f.shapes.wire_id("gzm:sh1").unwrap();
    assert!(is_wire_id(&id, "gzm:sh1"), "{id}");
    assert_eq!(f.shapes.status(Some("gzm:sh1")), "road");
    assert_eq!(f.shapes.status(Some("gzm:nope")), "none");
    let g = f.shapes.geometry("gzm:sh1").unwrap();
    assert_eq!(g.src, unimaps::shape_store::ShapeSrc::Gtfs);
    assert_eq!(g.stops.len(), 3, "placed with the first trip's stops");
    assert!(g.stops.iter().all(Option::is_some));

    let hit = f.shapes.lookup(std::slice::from_ref(&id));
    assert!(hit.exact);
    assert_eq!(hit.shapes[&id].src, unimaps::shape_store::ShapeSrc::Gtfs);
    let bare = f.shapes.lookup(&["gzm:sh1".into(), "gzm:nope.abcdef".into()]);
    assert!(!bare.exact);
    assert_eq!(bare.missing, ["gzm:nope.abcdef"]);
    assert_eq!(bare.shapes["gzm:sh1"].id, id);
    assert!(!f.shapes.lookup(&["gzm:sh1.000000".into()]).exact, "stale rev");
}

#[test]
fn upgrade_swaps_in_a_road_matched_shape_once_under_a_new_wire_id() {
    let f = parse("upgrade.zip", &files());
    let raw = f.shapes.unmatched("gzm:sh1").unwrap().rev;
    let poly = f.shapes.unmatched("gzm:sh1").unwrap().poly;
    let refs: Vec<Option<LatLng>> = vec![Some([50.259, 19.022]), Some([50.26, 19.01]), Some([50.277, 19.13])];
    let road: Vec<LatLng> = vec![
        [50.259, 19.022],
        [50.2597, 19.016],
        [50.26, 19.01],
        [50.27, 19.07],
        [50.277, 19.13],
    ];
    assert!(
        !f.shapes.upgrade("gzm:sh1", "000000", &road, &refs, false),
        "stale raw rev"
    );
    assert!(
        !f.shapes.upgrade("gzm:sh1", &raw, &road, &refs[1..], false),
        "stops of another trip"
    );
    let before = f.shapes.wire_id("gzm:sh1").unwrap();
    assert!(f.shapes.upgrade("gzm:sh1", &raw, &road, &refs, false));
    assert_ne!(f.shapes.wire_id("gzm:sh1").unwrap(), before);
    assert_eq!(
        f.shapes.geometry("gzm:sh1").unwrap().src,
        unimaps::shape_store::ShapeSrc::Osrm
    );
    assert!(f.shapes.unmatched("gzm:sh1").is_none());
    assert!(
        f.shapes.raw_keys().contains(&raw_key(&poly)),
        "the raw geometry's key stays known"
    );
    assert!(
        !f.shapes.upgrade("gzm:sh1", &raw, &road, &refs, false),
        "already matched"
    );
    assert!(
        !f.shapes.lookup(&[before]).exact,
        "the old wire id still resolves, to the new shape"
    );
}

#[test]
fn twin_shapes_share_one_raw_geometry() {
    let fs = with(files(), "trips.txt", |s| {
        s.replace("t0,Sosnowiec,0,sh1,", "t0,Sosnowiec,0,sh2,")
    });
    let fs = with(fs, "shapes.txt", |s| {
        format!("{s}\nsh2,50.2590,19.0220,1\nsh2,50.2600,19.0100,2\nsh2,50.2770,19.1300,3")
    });
    let f = parse("twins.zip", &fs);
    assert_eq!(
        f.shapes.unmatched("gzm:sh2").unwrap().poly,
        f.shapes.unmatched("gzm:sh1").unwrap().poly
    );
    assert_eq!(f.shapes.raw_keys().len(), 1);
}

#[test]
fn a_stored_match_applies_to_gzm_only() {
    let raw = FEED.shapes.unmatched("gzm:sh1").unwrap().poly;
    let key = raw_key(&raw);
    let road = unimaps::shared::polyline::encode_polyline(&[[50.259, 19.022], [50.27, 19.07], [50.277, 19.13]], 6);
    let matched = |k: &str| (k == key).then(|| road.clone());
    let file = write_file("matched.zip", &zip_of(&files()));
    let g = parse_gzm_zip(&file, "gzm", &matched).unwrap();
    assert!(g.shapes.unmatched("gzm:sh1").is_none());
    assert_eq!(
        g.shapes.geometry("gzm:sh1").unwrap().src,
        unimaps::shape_store::ShapeSrc::Osrm
    );
    assert!(g.shapes.raw_keys().contains(&key));
    let w = parse_gzm_zip(&file, "warsaw", &matched).unwrap();
    assert_eq!(w.shapes.unmatched("warsaw:sh1").unwrap().poly, raw);
}

/// Answers like /match: every trace point is on the road; `seen` gets each request's trace first.
struct Echo<F>(F);

impl<F: Fn(&[LatLng]) + Send + Sync> OsrmTransport for Echo<F> {
    async fn throttle(&self) {}

    async fn get(&self, url: &str) -> Result<OsrmHttp, String> {
        let u = url::Url::parse(url).unwrap();
        let pts: Vec<LatLng> = u
            .path()
            .rsplit('/')
            .next()
            .unwrap()
            .split(';')
            .map(|c| {
                let (lon, lat) = c.split_once(',').unwrap();
                [lat.parse().unwrap(), lon.parse().unwrap()]
            })
            .collect();
        (self.0)(&pts);
        let legs: Vec<Value> = pts[1..].iter().map(|_| json!({ "distance": 1 })).collect();
        let body = json!({ "code": "Ok", "matchings": [{ "geometry": encode_polyline(&pts, 6), "legs": legs }] });
        Ok(OsrmHttp {
            status: 200,
            body: Some(body),
            retry_after: None,
        })
    }
}

/// A matcher of its own (store file, pace) with the public host's chunks of 10.
fn matcher<F: Fn(&[LatLng]) + Send + Sync + 'static>(name: &str, interval_ms: i64, seen: F) -> Arc<Matcher<Echo<F>>> {
    Matcher::new(
        osrm_match_base("https://osrm.example/route/v1/driving"),
        MATCH_CHUNK_PUBLIC,
        interval_ms,
        Box::leak(Box::new(Mutex::new(0))),
        dir().join(format!("{name}.json")),
        Echo(seen),
    )
}

async fn wait_while(busy: impl Fn() -> bool, tries: usize) {
    for _ in 0..tries {
        if !busy() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn zigzag(lat: f64) -> Vec<String> {
    (0..28)
        .map(|i| {
            let la = js::to_fixed(lat + f64::from(i % 2) * 0.0004, 4);
            let lo = js::to_fixed(19.022 + f64::from(i) * 0.0015, 4);
            format!("sh1,{la},{lo},{}", i + 1)
        })
        .collect()
}

#[tokio::test]
async fn one_osrm_match_serves_every_shape_with_the_same_geometry() {
    let fs = with(files(), "trips.txt", |s| {
        s.replace("t0,Sosnowiec,0,sh1,", "t0,Sosnowiec,0,sh2,")
    });
    let fs = with(fs, "shapes.txt", |s| {
        format!("{s}\nsh2,50.2590,19.0220,1\nsh2,50.2600,19.0100,2\nsh2,50.2770,19.1300,3")
    });
    let f = parse("twins-match.zip", &fs);
    let poly = f.shapes.unmatched("gzm:sh1").unwrap().poly;
    assert_eq!(f.shapes.unmatched("gzm:sh2").unwrap().poly, poly);
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let m = matcher("twins", 50, move |_| {
        c.fetch_add(1, SeqCst);
    });
    let (a, b, c) = ([50.259, 19.022], [50.26, 19.01], [50.277, 19.13]);
    assert!(m.request(&f.shapes, "gzm:sh1", &[Some(a), Some(b), Some(c)], None));
    assert!(
        m.request(&f.shapes, "gzm:sh2", &[Some(a), Some(c)], None),
        "joins the running match"
    );
    let shapes = f.shapes.clone();
    wait_while(
        || shapes.unmatched("gzm:sh1").is_some() || shapes.unmatched("gzm:sh2").is_some(),
        150,
    )
    .await;
    assert_eq!(calls.load(SeqCst), 1);
    assert_eq!(f.shapes.geometry("gzm:sh1").unwrap().src, ShapeSrc::Osrm);
    assert_eq!(f.shapes.geometry("gzm:sh2").unwrap().src, ShapeSrc::Osrm);
    assert!(m.stored(&raw_key(&poly)).is_some());
    assert!(
        !m.request(&f.shapes, "gzm:sh1", &[Some(a), Some(b), Some(c)], None),
        "nothing left to match"
    );
    // the next feed build of the same geometry: the stored match applies at once, no request
    let g = parse("twins-match.zip", &fs);
    assert!(!m.request(&g.shapes, "gzm:sh1", &[Some(a), Some(b), Some(c)], None));
    assert_eq!(g.shapes.geometry("gzm:sh1").unwrap().src, ShapeSrc::Osrm);
    assert_eq!(calls.load(SeqCst), 1);
}

#[tokio::test]
async fn the_part_of_the_route_in_view_is_matched_first_and_served_before_the_rest() {
    // 28 points zigzagging 44 m: Douglas-Peucker keeps all, three chunks of 10 on the public host
    let header = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence".to_owned();
    let shapes_txt = std::iter::once(header)
        .chain(zigzag(50.259))
        .collect::<Vec<_>>()
        .join("\n");
    let f = parse("focus.zip", &with(files(), "shapes.txt", |_| shapes_txt));
    let raw_id = f.shapes.wire_id("gzm:sh1").unwrap();
    type Seen = (f64, Option<ShapeSrc>, Option<String>);
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let (log, shapes) = (seen.clone(), f.shapes.clone());
    let m = matcher("focus", 50, move |pts| {
        let src = shapes.geometry("gzm:sh1").map(|g| g.src);
        log.lock().unwrap().push((pts[0][1], src, shapes.wire_id("gzm:sh1")));
    });
    let refs = [Some([50.259, 19.022]), Some([50.26, 19.01]), Some([50.277, 19.13])];
    assert!(m.request(&f.shapes, "gzm:sh1", &refs, None));
    // the last chunk only (points 22-27); the worker has not picked yet, so this focus counts from the first request
    let view = LatLonBox {
        s: 50.258,
        w: 19.054,
        n: 50.26,
        e: 19.064,
    };
    m.focus(&f.shapes, "gzm:sh1", view);
    let shapes = f.shapes.clone();
    wait_while(|| shapes.unmatched("gzm:sh1").is_some(), 300).await;
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 3);
    assert!(seen[0].0 > 19.048, "the chunk in view goes first");
    assert_eq!(
        seen.iter().map(|x| x.1).collect::<Vec<_>>(),
        [Some(ShapeSrc::Gtfs), Some(ShapeSrc::Partial), Some(ShapeSrc::Partial)],
        "published as partial before the rest"
    );
    let partial_id = seen[1].2.clone().unwrap();
    assert_ne!(partial_id, raw_id);
    assert_eq!(f.shapes.geometry("gzm:sh1").unwrap().src, ShapeSrc::Osrm);
    assert_ne!(f.shapes.wire_id("gzm:sh1").unwrap(), partial_id);
    let stale = f.shapes.lookup(std::slice::from_ref(&partial_id));
    assert!(!stale.exact, "the partial id resolves to the full match");
    assert_eq!(stale.shapes[&partial_id].src, ShapeSrc::Osrm);
}

#[tokio::test]
async fn a_newly_opened_route_goes_before_the_rest_of_an_older_match() {
    // sh1: 28 points zigzagging 44 m, three chunks; sh2: one chunk, far north
    let fs = with(files(), "trips.txt", |s| {
        s.replace("t0,Sosnowiec,0,sh1,", "t0,Sosnowiec,0,sh2,")
    });
    let header = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence".to_owned();
    let shapes_txt = std::iter::once(header)
        .chain(zigzag(50.239))
        .chain(["sh2,50.3000,19.1000,1".to_owned(), "sh2,50.3010,19.1100,2".to_owned()])
        .collect::<Vec<_>>()
        .join("\n");
    let f = parse("preempt.zip", &with(fs, "shapes.txt", |_| shapes_txt));
    let calls: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let log = calls.clone();
    // 100 ms apart: the test asks for sh2 between the first and the second request
    let m = matcher("preempt", 100, move |pts| {
        log.lock().unwrap().push(if pts[0][0] > 50.29 { "sh2" } else { "sh1" });
    });
    let sh1 = [Some([50.239, 19.022]), Some([50.2394, 19.04]), Some([50.2394, 19.0625])];
    assert!(m.request(&f.shapes, "gzm:sh1", &sh1, None));
    wait_while(|| calls.lock().unwrap().is_empty(), 150).await;
    assert!(m.request(&f.shapes, "gzm:sh2", &[Some([50.3, 19.1]), Some([50.301, 19.11])], None));
    let shapes = f.shapes.clone();
    wait_while(
        || shapes.unmatched("gzm:sh1").is_some() || shapes.unmatched("gzm:sh2").is_some(),
        300,
    )
    .await;
    assert_eq!(
        *calls.lock().unwrap(),
        ["sh1", "sh2", "sh1", "sh1"],
        "sh2 waits one request, not the whole sh1 match"
    );
    assert_eq!(f.shapes.geometry("gzm:sh1").unwrap().src, ShapeSrc::Osrm);
    assert_eq!(f.shapes.geometry("gzm:sh2").unwrap().src, ShapeSrc::Osrm);
}

#[tokio::test]
async fn a_route_opened_again_goes_back_to_the_front() {
    let fs = with(files(), "trips.txt", |s| {
        s.replace("t0,Sosnowiec,0,sh1,", "t0,Sosnowiec,0,sh2,")
    });
    let header = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence".to_owned();
    let shapes_txt = std::iter::once(header)
        .chain(zigzag(50.239))
        .chain(["sh2,50.3000,19.1000,1".to_owned(), "sh2,50.3010,19.1100,2".to_owned()])
        .collect::<Vec<_>>()
        .join("\n");
    let f = parse("reopen.zip", &with(fs, "shapes.txt", |_| shapes_txt));
    let calls: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let log = calls.clone();
    let m = matcher("reopen", 100, move |pts| {
        log.lock().unwrap().push(if pts[0][0] > 50.29 { "sh2" } else { "sh1" });
    });
    let sh1 = [Some([50.239, 19.022]), Some([50.2394, 19.04]), Some([50.2394, 19.0625])];
    assert!(m.request(&f.shapes, "gzm:sh1", &sh1, None));
    wait_while(|| calls.lock().unwrap().is_empty(), 150).await;
    assert!(m.request(&f.shapes, "gzm:sh2", &[Some([50.3, 19.1]), Some([50.301, 19.11])], None));
    assert!(
        m.request(&f.shapes, "gzm:sh1", &sh1, None),
        "joins its own running match"
    );
    let shapes = f.shapes.clone();
    wait_while(
        || shapes.unmatched("gzm:sh1").is_some() || shapes.unmatched("gzm:sh2").is_some(),
        300,
    )
    .await;
    assert_eq!(*calls.lock().unwrap(), ["sh1", "sh1", "sh1", "sh2"]);
}

#[test]
fn rejects_a_zip_without_trips_and_a_file_that_is_no_zip() {
    let empty = write_file("empty.zip", &zip_of(&[("agency.txt", "agency_id\n1".into())]));
    let err = parse_gzm_zip(&empty, "gzm", &none).err().unwrap();
    assert!(err.contains("no trips or stops"), "{err}");
    let junk = write_file("junk.zip", b"not a zip at all");
    assert!(parse_gzm_zip(&junk, "gzm", &none).is_err());
    assert!(parse_gzm_zip(Path::new("/nonexistent/gtfs.zip"), "gzm", &none).is_err());
}

// 2026-10-28 is CET (UTC+1)
fn at(h: i64, m: i64) -> i64 {
    jiff::civil::date(2026, 10, 28)
        .at(0, 0, 0, 0)
        .to_zoned(jiff::tz::TimeZone::UTC)
        .unwrap()
        .timestamp()
        .as_millisecond()
        + ((h - 1) * 60 + m) * 60_000
}

#[test]
fn refresh_is_due_without_a_feed_unless_a_retry_is_pending() {
    let s = |retry_at| RefreshState {
        has_feed: false,
        checked_day: String::new(),
        retry_at,
    };
    assert!(gzm_refresh_due(&s(0), at(2, 0)));
    assert!(!gzm_refresh_due(&s(at(2, 30)), at(2, 0)));
}

#[test]
fn refresh_downloads_once_per_warsaw_day_from_04_00_on() {
    let s = |day: &str| RefreshState {
        has_feed: true,
        checked_day: day.into(),
        retry_at: 0,
    };
    assert!(!gzm_refresh_due(&s("2026-10-27"), at(3, 59)));
    assert!(gzm_refresh_due(&s("2026-10-27"), at(4, 0)));
    assert!(!gzm_refresh_due(&s("2026-10-28"), at(9, 0)));
}

// expectations from lib/gzm-feed.ts parseGzmZip on the same files
#[test]
fn skips_unknown_exception_types_and_empty_frequency_windows_keeps_midnight() {
    let f = parse(
        "edge.zip",
        &[
            (
                "routes.txt",
                "route_id,agency_id,route_short_name,route_long_name,route_type\n1n,1,1N,x,3".into(),
            ),
            (
                "stops.txt",
                "stop_id,stop_name,stop_lat,stop_lon\na,A 01,50.259,19.022\nb,B 02,50.26,19.01".into(),
            ),
            (
                "trips.txt",
                "route_id,service_id,trip_id,trip_headsign\n1n,s1,t1,X\n1n,s1,t5,Nocny\n1n,s1,f1,Metro".into(),
            ),
            (
                "stop_times.txt",
                [
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
                    "t1,08:00:00,08:00:00,a,1",
                    "t1,08:10:00,08:10:00,b,2",
                    "t5,00:00:00,00:00:00,a,1",
                    "t5,00:10:00,00:10:00,b,2",
                    "f1,05:00:00,05:00:00,a,1",
                    "f1,05:04:00,05:05:00,b,2",
                ]
                .join("\n"),
            ),
            (
                "calendar.txt",
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
                 s1,1,1,1,1,1,0,0,20261026,20261030"
                    .into(),
            ),
            (
                "calendar_dates.txt",
                "service_id,date,exception_type\ns1,20261027,3\ns1,20261028,\ns1,20261029,2".into(),
            ),
            (
                "frequencies.txt",
                "trip_id,start_time,end_time,headway_secs,exact_times\nf1,06:00:00,06:00:00,600,0\n\
                 f1,07:00:00,07:20:00,600,0"
                    .into(),
            ),
        ],
    );
    assert_eq!(
        sorted_dates(&f, "gzm:t1"),
        ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-30"]
    );
    assert_eq!(&*f.trip("gzm:t5").unwrap().t.dep, [0, 600]);
    assert_eq!(
        f.trips().map(|t| t.t.trip_id.as_str()).collect::<Vec<_>>(),
        ["gzm:t1", "gzm:t5", "gzm:f1.25200", "gzm:f1.25800"]
    );
}

/* ---------------- golden vectors ---------------- */

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().unwrap()
}

fn pt(v: &Value) -> LatLng {
    [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]
}

fn lookup_json(f: &GzmFeed, ids: &[String]) -> Value {
    let l = f.shapes.lookup(ids);
    json!({ "shapes": l.shapes, "missing": l.missing, "exact": l.exact })
}

fn trip_json(f: &GzmFeed, i: u32) -> Value {
    let t = f.trip_at(i);
    let mut dates: Vec<&String> = t.t.dates.as_deref().unwrap().iter().collect();
    dates.sort();
    json!({
        "id": t.t.trip_id,
        "service_id": t.t.service_id,
        "route_id": t.t.route_id,
        "line": t.t.line,
        "headsign": t.t.headsign,
        "stop_ids": &*t.t.stop_ids,
        "seqs": &*t.t.seqs,
        "arr": &*t.t.arr,
        "dep": &*t.t.dep,
        "dates": dates,
        "flags": t.flags(),
        "shape_id": t.x.shape_id,
        "brigade": t.x.brigade,
        "dir": num_value(t.x.dir),
        "stop_headsigns": t.x.stop_headsigns.as_deref(),
        "next": t.x.next.map(|n| f.trip_at(n).t.trip_id.clone()),
    })
}

#[test]
fn golden_parse_gzm_zip() {
    let matched: HashMap<String, String> = serde_json::from_value(V["matched"].clone()).unwrap();
    let lookup = |k: &str| matched.get(k).cloned();
    let cases = arr(&V["cases"]);
    assert!(cases.len() >= 20);
    let (mut ok, mut road, mut upgraded) = (0, 0, 0);
    for (n, c) in cases.iter().enumerate() {
        let slug = c["slug"].as_str().unwrap();
        let file = write_file(&format!("vec-{n}.zip"), &buffer_from_base64(c["zip"].as_str().unwrap()));
        let got = parse_gzm_zip(&file, slug, &lookup);
        if let Some(e) = c["error"].as_str() {
            assert_eq!(got.err().as_deref(), Some(e), "case {n}");
            continue;
        }
        let f = got.unwrap_or_else(|e| panic!("case {n}: {e}"));
        ok += 1;
        let what = |s: &str| format!("case {n} {slug} {s}");
        assert_eq!(f.version, c["version"], "{}", what("version"));
        assert_eq!(f.start_date, c["start_date"], "{}", what("start"));
        assert_eq!(f.end_date, c["end_date"], "{}", what("end"));
        let a = f.area;
        same(
            &json!({ "latMin": num_value(a.lat_min), "latMax": num_value(a.lat_max), "lonMin": num_value(a.lon_min), "lonMax": num_value(a.lon_max) }),
            &c["area"],
            &what("area"),
        );
        assert_eq!(
            f.stops_body,
            c["stops_body"].as_str().unwrap(),
            "{}",
            what("stops body")
        );
        assert_eq!(f.stops_etag, c["stops_etag"].as_str().unwrap(), "{}", what("etag"));
        same(&f.lines, &c["lines"], &what("lines"));
        let trips: Vec<Value> = (0..f.extra.len() as u32).map(|i| trip_json(&f, i)).collect();
        same(&trips, &c["trips"], &what("trips"));

        let want_by: HashMap<String, Vec<String>> = serde_json::from_value(c["trips_by_line"].clone()).unwrap();
        let got_by: HashMap<String, Vec<String>> = f
            .trips_by_line
            .iter()
            .map(|(k, v)| (k.clone(), v.iter().map(|&i| f.trip_at(i).t.trip_id.clone()).collect()))
            .collect();
        assert_eq!(got_by, want_by, "{}", what("trips by line"));

        // entries before any upgrade: the bare-key lookup answers the current entry
        let shapes = arr(&c["shapes"]);
        assert_eq!(f.shapes.size(), shapes.len(), "{}", what("shape count"));
        for s in shapes {
            let key = s["key"].as_str().unwrap();
            let l = f.shapes.lookup(&[key.to_string()]);
            let p = &l.shapes[key];
            let rev = p.id.rsplit('.').next().unwrap();
            same(
                &json!({ "key": key, "poly": p.poly, "len": p.len, "stops": p.stops, "rev": rev }),
                &json!({ "key": s["key"], "poly": s["poly"], "len": s["len"], "stops": s["stops"], "rev": s["rev"] }),
                &what(key),
            );
            let is_road = s.get("raw").is_some();
            road += usize::from(is_road);
            assert_eq!(f.shapes.unmatched(key).is_none(), is_road, "{}", what(key));
        }
        let mut raw_keys: Vec<String> = f.shapes.raw_keys().into_iter().collect();
        raw_keys.sort();
        same(&raw_keys, &c["raw_keys"], &what("raw keys"));
        for s in arr(&c["status"]) {
            assert_eq!(f.shapes.status(s[0].as_str()), s[1], "{}", what("status"));
        }

        let probe: Vec<String> = shapes
            .iter()
            .flat_map(|s| {
                let k = s["key"].as_str().unwrap();
                [
                    f.shapes.wire_id(k).unwrap(),
                    k.to_string(),
                    format!("{k}.000000"),
                    format!("{k}.ABCDEF"),
                ]
            })
            .chain([format!("{slug}:nope.abcdef"), String::new(), ".".into()])
            .collect();
        same(&lookup_json(&f, &probe), &c["before"], &what("lookup before"));
        let geometry: Vec<Value> = shapes
            .iter()
            .map(|s| match f.shapes.geometry(s["key"].as_str().unwrap()) {
                Some(g) => json!({
                    "src": g.src,
                    "rev": g.rev,
                    "stops": g.stops.iter().map(|x| x.map(num_value)).collect::<Vec<_>>(),
                    "len": num_value(g.pl.length),
                }),
                None => Value::Null,
            })
            .collect();
        same(&geometry, &c["geometry"], &what("geometry"));

        for u in arr(&c["upgrades"]) {
            let key = u["key"].as_str().unwrap();
            let rev = u["rev"].as_str().unwrap();
            let pts: Vec<LatLng> = arr(&u["pts"]).iter().map(pt).collect();
            let refs: Vec<Option<LatLng>> = arr(&u["refs"]).iter().map(|r| (!r.is_null()).then(|| pt(r))).collect();
            let partial = u["partial"].as_bool().unwrap();
            let ok1 = f.shapes.upgrade(key, rev, &pts, &refs, partial);
            assert_eq!(ok1, u["ok"], "{}", what("upgrade"));
            upgraded += usize::from(ok1);
            if u["ok2"].is_boolean() {
                assert_eq!(
                    f.shapes.upgrade(key, rev, &pts, &refs, false),
                    u["ok2"],
                    "{}",
                    what("upgrade 2")
                );
            }
            assert_eq!(f.shapes.wire_id(key).as_deref(), u["wire"].as_str(), "{}", what("wire"));
            assert_eq!(
                f.shapes.unmatched(key).map(|e| e.rev).as_deref(),
                u["unmatched"].as_str(),
                "{}",
                what("unmatched")
            );
        }
        same(&lookup_json(&f, &probe), &c["after"], &what("lookup after"));
    }
    assert!(
        ok >= 15 && road >= 3 && upgraded >= 8,
        "coverage {ok} {road} {upgraded}"
    );
    let _ = std::fs::remove_dir_all(dir());
}

#[test]
fn golden_feed_area() {
    for c in arr(&V["area"]) {
        let stops: Vec<(f64, f64)> = arr(&c["stops"])
            .iter()
            .map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap()))
            .collect();
        if stops.is_empty() {
            continue;
        }
        let a = feed_area(stops.into_iter());
        same(
            &json!({ "latMin": num_value(a.lat_min), "latMax": num_value(a.lat_max), "lonMin": num_value(a.lon_min), "lonMax": num_value(a.lon_max) }),
            &c["out"],
            c,
        );
    }
}

#[test]
fn golden_refresh_due() {
    for c in arr(&V["due"]) {
        let s = &c["state"];
        let state = RefreshState {
            has_feed: s["hasFeed"].as_bool().unwrap(),
            checked_day: s["checkedDay"].as_str().unwrap().into(),
            retry_at: s["retryAt"].as_i64().unwrap(),
        };
        assert_eq!(gzm_refresh_due(&state, c["now"].as_i64().unwrap()), c["out"], "{c}");
    }
}
