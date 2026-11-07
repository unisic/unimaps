//! test/osrm.test.ts: never touches the network; route/match calls get a fake transport that answers like OSRM
//! (polyline6 geometry + legs).

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use unimaps::osrm::*;
use unimaps::shared::polyline::{LatLng, encode_polyline, seg_meters};

const LAT0: f64 = 49.8;
const LON0: f64 = 19.0;

fn kx() -> f64 {
    111_320.0 * (LAT0 * (std::f64::consts::PI / 180.0)).cos()
}

#[allow(non_snake_case)]
fn P(east: f64, north: f64) -> LatLng {
    [LAT0 + north / 111_320.0, LON0 + east / kx()]
}

type Behave = Box<dyn Fn(&[LatLng], &str) -> Option<(u16, Value, Option<&'static str>)> + Send + Sync>;

/// Fake OSRM: routes straight through the requested coordinates unless `behave` answers.
struct Fake {
    behave: Behave,
    calls: Mutex<Vec<String>>,
    throttled: AtomicUsize,
}

fn fake(
    behave: impl Fn(&[LatLng], &str) -> Option<(u16, Value, Option<&'static str>)> + Send + Sync + 'static,
) -> Fake {
    Fake {
        behave: Box::new(behave),
        calls: Mutex::new(vec![]),
        throttled: AtomicUsize::new(0),
    }
}

fn plain() -> Fake {
    fake(|_, _| None)
}

impl Fake {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

fn coords_of(url: &str) -> Vec<LatLng> {
    let u = url::Url::parse(url).unwrap();
    let path = u.path();
    path[path.rfind('/').unwrap() + 1..]
        .split(';')
        .map(|c| {
            let (lon, lat) = c.split_once(',').unwrap();
            [lat.parse().unwrap(), lon.parse().unwrap()]
        })
        .collect()
}

fn ok_body(coords: &[LatLng], legs: Vec<f64>) -> Value {
    json!({ "code": "Ok", "routes": [{ "geometry": encode_polyline(coords, 6), "legs": legs.iter().map(|d| json!({ "distance": d })).collect::<Vec<_>>() }] })
}

fn straight_legs_of(coords: &[LatLng]) -> Vec<f64> {
    coords
        .windows(2)
        .map(|w| seg_meters(w[0][0], w[0][1], w[1][0], w[1][1]))
        .collect()
}

impl OsrmTransport for Fake {
    async fn throttle(&self) {
        self.throttled.fetch_add(1, Ordering::Relaxed);
    }

    async fn get(&self, url: &str) -> Result<OsrmHttp, String> {
        self.calls.lock().unwrap().push(url.to_owned());
        let coords = coords_of(url);
        let (status, body, ra) = (self.behave)(&coords, url).unwrap_or_else(|| {
            let legs = straight_legs_of(&coords);
            (200, ok_body(&coords, legs), None)
        });
        Ok(OsrmHttp {
            status,
            body: Some(body),
            retry_after: ra.map(str::to_owned),
        })
    }
}

const BASE: &str = "https://osrm.test/route/v1/driving";

fn kind(r: &OsrmOutcome) -> &'static str {
    match r {
        Ok(_) => "ok",
        Err(f) => f.kind.as_str(),
    }
}

/* ---------------- chunkWaypoints / mergeChunkGeometries ---------------- */

#[test]
fn splits_into_overlapping_chunks_of_at_most_12_points() {
    let pts: Vec<LatLng> = (0..27).map(|i| P(i as f64 * 100.0, 0.0)).collect();
    let chunks = chunk_waypoints(&pts, OSRM_CHUNK);
    assert_eq!(chunks.len(), 3);
    assert!(chunks.iter().all(|c| c.len() <= 12 && c.len() >= 2));
    assert_eq!(chunks[0][11], chunks[1][0]);
    assert_eq!(*chunks[2].last().unwrap(), pts[26]);
    assert_eq!(chunk_waypoints(&[P(0.0, 0.0)], OSRM_CHUNK).len(), 0);
}

#[test]
fn merge_drops_the_duplicated_joint() {
    let merged = merge_chunk_geometries(&[vec![P(0.0, 0.0), P(1.0, 0.0)], vec![P(1.0, 0.0), P(2.0, 0.0)]]);
    assert_eq!(merged.len(), 3);
}

#[test]
fn url_carries_polyline6_and_lon_lat_order() {
    let url = osrm_route_url("https://x/route/v1/driving/", &[P(0.0, 0.0), P(10.0, 0.0)], true, None);
    assert!(
        url.starts_with("https://x/route/v1/driving/19.000000,49.800000;"),
        "{url}"
    );
    assert!(url.contains("geometries=polyline6"));
    assert!(url.contains("continue_straight=true"));
    assert!(!url.contains("bearings="));
    let with_b = osrm_route_url(
        "https://x/route/v1/driving",
        &[P(0.0, 0.0), P(10.0, 0.0), P(20.0, 0.0)],
        true,
        Some(&[Some(90), None, Some(270)]),
    );
    assert!(with_b.ends_with("&bearings=90,45;;270,45"), "{with_b}");
}

/* ---------------- waypointBearings ---------------- */

#[test]
fn bearings_from_previous_to_next_none_when_too_close() {
    assert_eq!(
        waypoint_bearings(&[P(0.0, 0.0), P(100.0, 0.0), P(100.0, 100.0)]),
        [Some(90), Some(45), Some(0)]
    );
    assert_eq!(waypoint_bearings(&[P(0.0, 0.0), P(10.0, 0.0)]), [None, None]);
    assert_eq!(waypoint_bearings(&[P(0.0, 0.0)]), [None]);
}

/* ---------------- classifyOsrmResponse ---------------- */

#[test]
fn classifies_every_failure_family() {
    let k = |s: u16, b: Option<Value>, ra: Option<&str>| kind(&classify_osrm_response(s, b.as_ref(), ra));
    assert_eq!(k(400, Some(json!({ "code": "NoRoute" })), None), "unroutable");
    assert_eq!(k(400, Some(json!({ "code": "NoSegment" })), None), "unroutable");
    assert_eq!(k(400, Some(json!({ "code": "InvalidQuery" })), None), "config");
    assert_eq!(k(404, None, None), "config");
    assert_eq!(k(414, None, None), "config");
    assert_eq!(k(403, None, None), "blocked");
    assert_eq!(k(503, None, None), "unavailable");
    assert_eq!(k(200, None, None), "unavailable");
    assert_eq!(k(429, None, None), "ratelimited");
    let rl = classify_osrm_response(429, None, Some("120")).unwrap_err();
    assert_eq!(rl.retry_after_sec, Some(120.0));
}

#[test]
fn decodes_a_good_response() {
    let pts = [P(0.0, 0.0), P(100.0, 0.0)];
    let r = classify_osrm_response(200, Some(&ok_body(&pts, vec![100.0])), None).unwrap();
    assert_eq!(r.pts.len(), 2);
    assert_eq!(r.legs, [100.0]);
}

/* ---------------- implausibleLegs ---------------- */

#[test]
fn flags_around_the_block_legs_only() {
    let wps = [P(0.0, 0.0), P(200.0, 0.0), P(400.0, 0.0)];
    assert!(implausible_legs(&[210.0, 205.0], &wps).is_empty());
    assert_eq!(implausible_legs(&[900.0, 205.0], &wps), [0]);
    // 2.5x but only 300 m extra: tolerated (short legs on winding roads)
    assert!(implausible_legs(&[500.0, 200.0], &wps).is_empty());
}

#[test]
fn absurd_only_past_3x_and_3_km() {
    let wps = [P(0.0, 0.0), P(934.0, 0.0)];
    assert!(absurd_legs(&[2422.0], &wps).is_empty());
    assert_eq!(absurd_legs(&[4500.0], &wps), [0]);
    assert!(absurd_legs(&[3100.0], &[P(0.0, 0.0), P(1500.0, 0.0)]).is_empty());
}

/* ---------------- routeWaypoints ---------------- */

#[tokio::test]
async fn routes_every_chunk_throttling_every_request() {
    let f = plain();
    let wps: Vec<LatLng> = (0..27).map(|i| P(i as f64 * 100.0, 0.0)).collect();
    let r = route_waypoints(BASE, &wps, &f).await.unwrap();
    assert_eq!(r.straight_legs, 0);
    assert_eq!(r.total_legs, 26);
    // each chunk with and without the stop directions
    assert_eq!(f.calls().len(), 6);
    assert_eq!(f.throttled.load(Ordering::Relaxed), 6);
    assert_eq!(r.pts.len(), 27);
}

#[tokio::test]
async fn aborts_on_a_hard_failure() {
    let f = fake(|_, _| Some((503, Value::Null, None)));
    let r = route_waypoints(BASE, &[P(0.0, 0.0), P(100.0, 0.0)], &f).await;
    assert_eq!(r.unwrap_err().kind, OsrmFailure::Unavailable);
}

#[tokio::test]
async fn unroutable_chunks_degrade_to_straight_lines() {
    let f = fake(|_, _| Some((400, json!({ "code": "NoRoute" }), None)));
    let r = route_waypoints(BASE, &[P(0.0, 0.0), P(100.0, 0.0), P(200.0, 0.0)], &f)
        .await
        .unwrap();
    assert_eq!(r.straight_legs, 2);
    // continue_straight, bearings, plain: for the chunk, then for each of its two pairs
    assert_eq!(f.calls().len(), 9);
}

#[tokio::test]
async fn one_unroutable_stop_costs_its_own_two_legs() {
    let bad = P(200.0, 0.0);
    let f = fake(move |coords, _| {
        coords
            .iter()
            .any(|c| (c[1] - bad[1]).abs() < 2e-6)
            .then(|| (400, json!({ "code": "NoSegment" }), None))
    });
    let wps: Vec<LatLng> = (0..6).map(|i| P(i as f64 * 100.0, 0.0)).collect();
    let r = route_waypoints(BASE, &wps, &f).await.unwrap();
    assert_eq!(r.straight_legs, 2);
    assert_eq!(r.total_legs, 5);
}

/// Fake OSRM where the 2nd->3rd leg is `detour(straight)` long unless `fixed(url)` says otherwise.
fn detour_osrm(detour: fn(f64) -> f64, fixed: fn(&str) -> bool) -> Fake {
    fake(move |coords, url| {
        let legs: Vec<f64> = coords
            .windows(2)
            .map(|w| {
                let d = seg_meters(w[0][0], w[0][1], w[1][0], w[1][1]);
                let hit = (w[0][1] - LON0 - 100.0 / kx()).abs() < 2e-6 && !fixed(url);
                if hit { detour(d) } else { d }
            })
            .collect();
        Some((200, ok_body(coords, legs), None))
    })
}

fn four() -> [LatLng; 4] {
    [P(0.0, 0.0), P(100.0, 0.0), P(200.0, 0.0), P(300.0, 0.0)]
}

#[tokio::test]
async fn an_absurd_leg_is_rerouted_pair_by_pair_and_goes_straight_if_still_bad() {
    let f = detour_osrm(|d| d * 5.0 + 5000.0, |_| false);
    let r = route_waypoints(BASE, &four(), &f).await.unwrap();
    assert_eq!(r.straight_legs, 1);
    assert_eq!(r.total_legs, 3);
}

#[tokio::test]
async fn a_long_but_bounded_detour_stays_on_the_road() {
    let f = detour_osrm(|d| d * 5.0 + 1000.0, |_| false);
    let r = route_waypoints(BASE, &four(), &f).await.unwrap();
    assert_eq!(r.straight_legs, 0);
    // every way of asking tried once, the shortest kept
    assert_eq!(f.calls().len(), 3);
}

#[tokio::test]
async fn the_stop_directions_settle_a_wrong_carriageway_detour() {
    let f = detour_osrm(|d| d * 5.0 + 1000.0, |url| url.contains("bearings="));
    let r = route_waypoints(BASE, &four(), &f).await.unwrap();
    assert_eq!(r.straight_legs, 0);
    let calls = f.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls[1].contains("&bearings=90,45;90,45;90,45;90,45"), "{}", calls[1]);
}

#[tokio::test]
async fn a_plausible_answer_still_loses_to_a_shorter_one_with_the_stop_directions() {
    let f = detour_osrm(|d| d + 150.0, |url| url.contains("bearings="));
    let wps = four();
    let r = route_chunk(BASE, &wps, &f, Some(&waypoint_bearings(&wps)))
        .await
        .unwrap();
    assert_eq!(
        r.legs.iter().map(|d| d.round()).collect::<Vec<_>>(),
        [100.0, 100.0, 100.0]
    );
    assert_eq!(f.calls().len(), 2);
}

#[tokio::test]
async fn a_shorter_answer_that_snaps_a_stop_far_off_its_pole_loses() {
    let f = fake(|coords, url| {
        let br = url.contains("bearings=");
        let legs: Vec<f64> = straight_legs_of(coords)
            .iter()
            .enumerate()
            .map(|(i, d)| d - if br && i == 1 { 40.0 } else { 0.0 })
            .collect();
        let mut body = ok_body(coords, legs);
        body["waypoints"] = (0..coords.len())
            .map(|i| json!({ "distance": if br && i == 2 { 59 } else { 3 } }))
            .collect();
        Some((200, body, None))
    });
    let wps = four();
    let r = route_chunk(BASE, &wps, &f, Some(&waypoint_bearings(&wps)))
        .await
        .unwrap();
    assert_eq!(
        r.legs.iter().map(|d| d.round()).collect::<Vec<_>>(),
        [100.0, 100.0, 100.0]
    );
}

/* ---------------- map matching ---------------- */

const MATCH_BASE: &str = "https://osrm.test/match/v1/driving";

fn trace() -> Vec<LatLng> {
    (0..25).map(|i| P(i as f64 * 100.0, (i % 2) as f64 * 8.0)).collect()
}

/// answers like /match: the chunk snapped onto the y = 0 road (or `lat` off it)
fn snapped(coords: &[LatLng], lat: f64) -> Value {
    let road: Vec<LatLng> = coords.iter().map(|c| [lat, c[1]]).collect();
    json!({ "code": "Ok", "matchings": [{ "geometry": encode_polyline(&road, 6), "legs": road[1..].iter().map(|_| json!({ "distance": 100 })).collect::<Vec<_>>() }] })
}

#[test]
fn match_base_and_url() {
    assert_eq!(
        osrm_match_base("https://router.project-osrm.org/route/v1/driving").as_deref(),
        Some("https://router.project-osrm.org/match/v1/driving")
    );
    assert_eq!(osrm_match_base("https://osrm.example/v1/driving"), None);
    let url = url::Url::parse(&osrm_match_url(
        "https://osrm.test/match/v1/driving/",
        &[P(0.0, 0.0), P(100.0, 0.0)],
    ))
    .unwrap();
    assert_eq!(url.path().rsplit('/').next().unwrap().split(';').count(), 2);
    let q: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(q["radiuses"], "25;25");
    assert_eq!(q["gaps"], "ignore");
}

#[test]
fn plausible_match_rejects_a_detour_and_a_far_off_match() {
    let line = [P(0.0, 0.0), P(500.0, 0.0)];
    assert!(plausible_match(&[P(0.0, 5.0), P(500.0, 5.0)], &line));
    assert!(!plausible_match(
        &[
            P(0.0, 0.0),
            P(0.0, 55.0),
            P(250.0, 55.0),
            P(250.0, -55.0),
            P(500.0, -55.0),
            P(500.0, 0.0)
        ],
        &line
    ));
    assert!(!plausible_match(&[P(0.0, 80.0), P(500.0, 80.0)], &line));
}

#[tokio::test]
async fn snaps_a_chunk_onto_the_road_chunks_share_a_point() {
    let trace = trace();
    let chunks = chunk_waypoints(&trace, 10);
    assert!(chunks.iter().all(|c| c.len() <= 10));
    assert_eq!(chunks[1][0], *chunks[0].last().unwrap());
    let f = fake(|coords, _| Some((200, snapped(coords, LAT0), None)));
    let r = match_chunk(MATCH_BASE, &chunks[0], &f).await.unwrap();
    assert!(!r.kept);
    assert_eq!(f.calls().len(), 1);
    assert!(r.pts.iter().all(|p| (p[0] - LAT0).abs() < 1e-9));
    assert_eq!(r.pts[0], [LAT0, trace[0][1]]);
}

#[tokio::test]
async fn a_chunk_matched_implausibly_or_in_pieces_keeps_its_own_points() {
    let chunk = chunk_waypoints(&trace(), 10)[0].clone();
    let far = fake(|coords, _| Some((200, snapped(coords, LAT0 + 0.01), None)));
    let none = fake(|_, _| Some((200, json!({ "code": "NoMatch", "message": "no match" }), None)));
    for f in [far, none] {
        let r = match_chunk(MATCH_BASE, &chunk, &f).await.unwrap();
        assert!(r.kept);
        assert_eq!(r.pts, chunk, "a kept chunk keeps the trace's own zigzag");
    }
}

#[tokio::test]
async fn a_hard_failure_is_reported_not_kept() {
    let f = fake(|_, _| Some((429, json!({ "message": "slow down" }), Some("30"))));
    let r = match_chunk(MATCH_BASE, &chunk_waypoints(&trace(), 10)[0], &f).await;
    assert_eq!(f.calls().len(), 1);
    assert_eq!(r.unwrap_err().kind, OsrmFailure::Ratelimited);
}

#[test]
fn pace_spaces_callers_that_share_one_pace() {
    let pace: OsrmPace = Mutex::new(0);
    let slept: Vec<i64> = [5000, 5200, 9000]
        .into_iter()
        .map(|now| book_slot(&pace, 1000, now))
        .filter(|&w| w > 0)
        .collect();
    assert_eq!(slept, [800]);
    assert_eq!(*pace.lock().unwrap(), 10_000);
}
