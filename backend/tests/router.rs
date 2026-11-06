//! test/router.test.ts, test/router-mzk.test.ts and the golden vectors of lib/router.ts (scripts/dump-vectors.ts:
//! the fixture feed with the captured MZK timetable, and a seeded synthetic zbiorkom-style index with pickup flags,
//! dates and live delays). test/router-oracle.test.ts is not ported: it pins the TS router to a brute-force profile
//! on the same corridors the vectors pin this port to.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unimaps::router::{
    CallPool, ConnectionItinerary, LiveFn, Point, RouteQuery, RouterIndex, RouterInput, RouterStopInput, SortBy,
    TripEntry, TripStopEntry, build_router_index, call_columns, clean_text, find_connections, find_connections_at,
    line_timetable, load_index_from, offset_date, stop_events, weekday_monday0,
};

const GTFS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/gtfs");
const MZK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/mzk-timetable.v1.json");
const NO_MZK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/no-mzk-timetable.json");

static KB: LazyLock<RouterIndex> = LazyLock::new(|| load_index_from(Path::new(GTFS), Path::new(NO_MZK)).unwrap());
static KB_MZK: LazyLock<RouterIndex> = LazyLock::new(|| load_index_from(Path::new(GTFS), Path::new(MZK)).unwrap());
static V: LazyLock<Vectors> = LazyLock::new(|| serde_json::from_str(include_str!("vectors/router.json")).unwrap());

#[derive(Deserialize)]
struct Vectors {
    today: String,
    now_secs: i32,
    clean: Vec<(String, String)>,
    dates: Vec<(String, i32, String, usize)>,
    feed: Vec<Case>,
    line_views: Vec<LineCase>,
    synthetic: Synthetic,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Query {
    from: String,
    to: String,
    #[serde(default)]
    from_ids: Vec<String>,
    #[serde(default)]
    to_ids: Vec<String>,
    from_point: Option<P>,
    to_point: Option<P>,
    after_secs: Option<i32>,
    #[serde(default)]
    arrive_by: bool,
    limit: Option<i32>,
    #[serde(default)]
    direct_only: bool,
    min_transfer_secs: Option<i32>,
    max_transfer_secs: Option<i32>,
    date: Option<String>,
    day_label: Option<String>,
    sort_by: Option<String>,
    #[serde(default)]
    avoid_lines: Vec<String>,
    #[serde(default)]
    avoid_routes: Vec<String>,
    #[serde(default)]
    live: bool,
    fallback_days: Option<u32>,
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct P {
    lat: f64,
    lon: f64,
    walk_m: Option<f64>,
}

#[derive(Deserialize)]
struct Case {
    query: Query,
    result: Value,
}

#[derive(Deserialize)]
struct LineCase {
    line: String,
    #[serde(default)]
    operator: String,
    date: Option<String>,
    result: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SStop {
    id: String,
    name: String,
    lat: f64,
    lon: f64,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct STrip {
    trip_id: String,
    line: String,
    route_id: String,
    headsign: String,
    calls: Vec<(String, f64, f64)>,
    dates: Vec<String>,
    flags: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct EventCase {
    poles: Vec<String>,
    date: String,
    from: i32,
    to: i32,
    limit: Option<usize>,
    result: Vec<(String, usize, i32, i32, String)>,
}

#[derive(Deserialize)]
struct Synthetic {
    stops: Vec<SStop>,
    trips: Vec<STrip>,
    live: HashMap<String, i32>,
    queries: Vec<Case>,
    events: Vec<EventCase>,
    lines: Vec<LineCase>,
    foot: Vec<Vec<(String, i32)>>,
}

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

fn sort_by(s: Option<&str>) -> SortBy {
    match s {
        None | Some("departure") => SortBy::Departure,
        Some("duration") => SortBy::Duration,
        Some("arrival") => SortBy::Arrival,
        Some("transfers") => SortBy::Transfers,
        Some("walk") => SortBy::Walk,
        Some(s) => panic!("sortBy {s}"),
    }
}

fn point(p: P) -> Point {
    Point {
        lat: p.lat,
        lon: p.lon,
        walk_m: p.walk_m,
    }
}

fn search(q: &Query, idx: &RouterIndex, live: &LiveFn) -> Vec<ConnectionItinerary> {
    let rq = RouteQuery {
        from: &q.from,
        to: &q.to,
        from_ids: &q.from_ids,
        to_ids: &q.to_ids,
        from_point: q.from_point.map(point),
        to_point: q.to_point.map(point),
        after_secs: q.after_secs,
        arrive_by: q.arrive_by,
        limit: q.limit,
        direct_only: q.direct_only,
        min_transfer_secs: q.min_transfer_secs,
        max_transfer_secs: q.max_transfer_secs,
        date: q.date.as_deref(),
        day_label: q.day_label.as_deref(),
        sort_by: sort_by(q.sort_by.as_deref()),
        avoid_lines: &q.avoid_lines,
        avoid_routes: &q.avoid_routes,
        live: q.live.then_some(live),
        fallback_days: q.fallback_days,
    };
    find_connections_at(&rq, idx, &V.today, V.now_secs)
}

fn synthetic_index(s: &Synthetic) -> RouterIndex {
    let mut trips = IndexMap::new();
    for t in &s.trips {
        let mut e = TripEntry {
            trip_id: t.trip_id.clone(),
            service_id: "s".into(),
            route_id: t.route_id.clone(),
            line: t.line.clone(),
            headsign: t.headsign.clone(),
            dates: Some(Arc::new(t.dates.iter().cloned().collect())),
            flags: t.flags.as_deref().map(Arc::from),
            ..Default::default()
        };
        let calls = (t.calls.iter().enumerate())
            .map(|(i, (stop_id, arr, dep))| TripStopEntry {
                stop_id: stop_id.clone(),
                seq: (i + 1) as f64,
                arr: *arr,
                dep: *dep,
            })
            .collect();
        call_columns(&mut e, calls, &mut CallPool::new());
        trips.insert(t.trip_id.clone(), e);
    }
    let stops = (s.stops.iter())
        .map(|s| RouterStopInput {
            id: s.id.clone(),
            name: s.name.clone(),
            lat: s.lat,
            lon: s.lon,
            key: Some(s.key.clone()),
        })
        .collect();
    build_router_index(RouterInput {
        stops,
        trips,
        services: HashMap::new(),
        mzk_day_types: HashMap::new(),
    })
}

#[test]
fn clean_text_offset_date_and_weekday_match_node() {
    for (s, want) in &V.clean {
        assert_eq!(&clean_text(s), want, "{s:?}");
    }
    for (d, o, want, wd) in &V.dates {
        assert_eq!(&offset_date(d, *o), want, "{d} {o}");
        assert_eq!(weekday_monday0(d), *wd, "{d}");
    }
}

#[test]
fn connections_on_the_fixture_feed_match_node() {
    let none: &LiveFn = &|_, _| None;
    for (i, c) in V.feed.iter().enumerate() {
        same(&search(&c.query, &KB_MZK, none), &c.result, &(i, &c.query));
    }
}

#[test]
fn line_views_on_the_fixture_feed_match_node() {
    for c in &V.line_views {
        let date = c.date.as_deref().unwrap();
        same(
            &line_timetable(&c.line, &c.operator, date, Some(&KB_MZK)),
            &c.result,
            &(&c.line, &c.operator, date),
        );
    }
}

#[test]
fn connections_on_a_synthetic_city_with_live_delays_match_node() {
    let s = &V.synthetic;
    let idx = synthetic_index(s);
    let live = |id: &str, d: &str| s.live.get(&format!("{id}|{d}")).copied();
    for (i, c) in s.queries.iter().enumerate() {
        same(&search(&c.query, &idx, &live), &c.result, &(i, &c.query));
    }
}

#[test]
fn stop_events_line_views_and_footpaths_on_a_synthetic_city_match_node() {
    let s = &V.synthetic;
    let idx = synthetic_index(s);
    for c in &s.events {
        let got: Vec<_> = stop_events(&idx, &c.poles, &c.date, c.from, c.to, c.limit)
            .into_iter()
            .map(|e| (e.trip.trip_id.clone(), e.pos, e.arr, e.dep, e.service_date))
            .collect();
        assert_eq!(got, c.result, "{:?} {} {}..{}", c.poles, c.date, c.from, c.to);
    }
    for c in &s.lines {
        same(
            &line_timetable(&c.line, "GZM", &V.today, Some(&idx)),
            &c.result,
            &c.line,
        );
    }
    for (stop, want) in s.stops.iter().zip(&s.foot) {
        let got: Vec<_> = idx
            .foot_of(idx.stop_num[&stop.id])
            .map(|(to, secs)| (idx.stop_ids[to as usize].clone(), secs))
            .collect();
        assert_eq!(&got, want, "{}", stop.id);
    }
}

#[test]
fn no_feed_no_index() {
    let empty = std::env::temp_dir().join(format!("unimaps-router-empty-{}", std::process::id()));
    std::fs::create_dir_all(&empty).unwrap();
    assert!(load_index_from(&empty, Path::new(NO_MZK)).is_none());
    std::fs::remove_dir(&empty).unwrap();
    let q = RouteQuery {
        from: "10000",
        to: "21141",
        date: Some("2026-09-30"),
        ..Default::default()
    };
    assert!(find_connections(&q, None).is_empty());
    assert!(line_timetable("120", "KB", "2026-09-30", None).is_none());
}

// test/router.test.ts: the fixture feed without an MZK timetable, pinned weekday

const DATE: &str = "2026-09-30";

fn kb(from: &str, to: &str, date: Option<&str>, after: Option<i32>, limit: Option<i32>) -> Vec<ConnectionItinerary> {
    let q = RouteQuery {
        from,
        to,
        date,
        after_secs: after,
        limit,
        ..Default::default()
    };
    find_connections(&q, Some(&KB))
}

#[test]
fn returns_empty_array_for_non_existent_stops() {
    assert!(kb("NON_EXISTENT_STOP_XYZ", "ANOTHER_NON_EXISTENT", Some(DATE), None, None).is_empty());
}

#[test]
fn finds_direct_connections_between_bielsko_biala_da_and_szczyrk() {
    let res = kb(
        "BIELSKO-BIAŁA D.A.",
        "SZCZYRK SKALITE",
        Some(DATE),
        Some(14 * 3600),
        Some(3),
    );
    let first = &res[0];
    assert_eq!(first.kind, "direct");
    assert_eq!(first.transfers_count, 0);
    assert_eq!(first.legs.len(), 1);
    assert!(!first.legs[0].line.is_empty());
    assert!(first.departure_secs >= 14 * 3600);
    assert!(first.arrival_secs > first.departure_secs);
    assert!(first.total_duration_mins > 0);
}

#[test]
fn finds_transfer_connections_when_no_direct_line_exists() {
    let res = kb(
        "BIELSKO-BIAŁA WAPIENICA CENTRUM",
        "SZCZYRK SKALITE",
        Some(DATE),
        Some(14 * 3600),
        Some(3),
    );
    let t = res
        .iter()
        .find(|r| r.kind == "transfer")
        .expect("expected a transfer itinerary");
    assert_eq!(t.transfers_count, 1);
    assert_eq!(t.legs.len(), 2);
    assert!(t.transfer_wait_mins.unwrap_or(0) >= 3);
    assert!(t.legs[0].arrival_secs <= t.legs[1].departure_secs);
}

#[test]
fn resolves_stops_by_numeric_id_as_well_as_name() {
    let res = kb("10000", "SZCZYRK SKALITE", Some(DATE), Some(14 * 3600), Some(1));
    assert_eq!(res[0].legs[0].from_stop_name, "BIELSKO-BIAŁA D.A.");
}

#[test]
fn direct_only_keeps_direct_itineraries_and_finds_none_without_one() {
    let direct = |from| {
        let q = RouteQuery {
            from,
            to: "SZCZYRK SKALITE",
            date: Some(DATE),
            after_secs: Some(14 * 3600),
            direct_only: true,
            limit: Some(5),
            ..Default::default()
        };
        find_connections(&q, Some(&KB))
    };
    let res = direct("BIELSKO-BIAŁA D.A.");
    assert!(!res.is_empty());
    assert!(
        res.iter()
            .all(|i| i.kind == "direct" && i.transfers_count == 0 && i.legs.len() == 1)
    );
    assert!(direct("BIELSKO-BIAŁA WAPIENICA CENTRUM").is_empty());
}

#[test]
fn attaches_date_and_day_label_metadata_to_itineraries() {
    let q = RouteQuery {
        from: "BIELSKO-BIAŁA D.A.",
        to: "SZCZYRK SKALITE",
        after_secs: Some(14 * 3600),
        date: Some("2026-09-14"),
        day_label: Some("Jutro"),
        limit: Some(1),
        ..Default::default()
    };
    let res = find_connections(&q, Some(&KB));
    assert_eq!(res[0].date, "2026-09-14");
    assert_eq!(res[0].day_label.as_deref(), Some("Jutro"));
}

#[test]
fn sorts_by_duration() {
    let q = RouteQuery {
        from: "BIELSKO-BIAŁA D.A.",
        to: "SZCZYRK SKALITE",
        date: Some(DATE),
        after_secs: Some(10 * 3600),
        sort_by: SortBy::Duration,
        limit: Some(5),
        ..Default::default()
    };
    let res = find_connections(&q, Some(&KB));
    assert!(res.len() >= 2);
    assert!(
        res.windows(2)
            .all(|w| w[1].total_duration_mins >= w[0].total_duration_mins)
    );
}

#[test]
fn resolves_a_city_name_to_its_main_hub_also_in_the_evening() {
    let res = kb("SZCZYRK CENTRUM", "KĘTY", Some(DATE), Some(12 * 3600), Some(3));
    assert_eq!(res[0].legs.last().unwrap().to_stop_name, "KĘTY D.A.");
    let res = kb(
        "SZCZYRK CENTRUM",
        "KĘTY",
        Some(DATE),
        Some(20 * 3600 + 52 * 60),
        Some(3),
    );
    assert!(res[0].departure_secs >= 20 * 3600 + 52 * 60);
}

#[test]
fn a_transfer_itinerary_carries_every_leg_stop_with_coordinates() {
    let res = kb(
        "BIELSKO-BIAŁA WAPIENICA CENTRUM",
        "SZCZYRK SKALITE",
        Some("2026-09-14"),
        Some(8 * 3600),
        Some(5),
    );
    let first = &res[0];
    assert!(first.transfers_count >= 1);
    assert_eq!(first.legs.len() as i32, first.transfers_count + 1);
    assert!(first.transfer_wait_mins.unwrap_or(0) >= 3);
    assert!(first.transfer_stop_name.as_deref().is_some_and(|s| !s.is_empty()));
    for leg in &first.legs {
        assert!(leg.stops.len() >= 2);
        let (a, z) = (&leg.stops[0], leg.stops.last().unwrap());
        assert_eq!(a.stop_name, leg.from_stop_name);
        assert_eq!(z.stop_name, leg.to_stop_name);
        let v = serde_json::to_value(a).unwrap();
        assert!(v["lat"].as_f64().unwrap() > 45.0 && v["lon"].as_f64().unwrap() > 15.0);
        assert!(!a.departure_time.is_empty() && !z.arrival_time.is_empty());
    }
}

#[test]
fn falls_back_to_the_next_service_day_without_a_date() {
    let res = kb(
        "BIELSKO-BIAŁA WAPIENICA CENTRUM",
        "SZCZYRK SKALITE",
        None,
        None,
        Some(3),
    );
    assert!(!res.is_empty());
}

#[test]
fn no_itinerary_is_strictly_dominated() {
    let res = kb(
        "BIELSKO-BIAŁA WAPIENICA CENTRUM",
        "SZCZYRK SKALITE",
        Some("2026-09-14"),
        Some(8 * 3600),
        Some(10),
    );
    for (i, it) in res.iter().enumerate() {
        let dominated = res.iter().enumerate().any(|(j, o)| {
            j != i
                && o.departure_secs >= it.departure_secs
                && o.arrival_secs <= it.arrival_secs
                && o.transfers_count <= it.transfers_count
                && (o.departure_secs > it.departure_secs
                    || o.arrival_secs < it.arrival_secs
                    || o.transfers_count < it.transfers_count)
        });
        assert!(!dominated);
    }
}

#[test]
fn resolves_stops_with_punctuation_and_street_names() {
    let res = kb(
        "PIETRZYKOWICE, KOŚCIÓŁ",
        "KĘTY, D.A.",
        Some("2026-09-14"),
        Some(15 * 3600),
        Some(5),
    );
    assert!(res[0].transfers_count >= 1);
    assert!(
        res[0]
            .transfer_stop_name
            .as_deref()
            .is_some_and(|s| s.contains("BIELSKO-BIAŁA"))
    );
    let res = kb(
        "PIETRZYKOWICE KOŚCIÓŁ",
        "KĘTY, D.A. UL. SIENKIEWICZA",
        Some("2026-09-14"),
        Some(15 * 3600),
        Some(3),
    );
    assert!(!res.is_empty());
}

#[test]
fn resolves_no_stop_from_input_without_letters_or_digits() {
    assert!(kb("-", "SZCZYRK SKALITE", Some(DATE), Some(14 * 3600), None).is_empty());
}

// test/router-mzk.test.ts: the fixture feed plus one captured MZK course (line 22, 5088899)

fn mzk(from: &str, from_ids: &[String], to: &str, date: &str, after: Option<i32>) -> Vec<ConnectionItinerary> {
    let q = RouteQuery {
        from,
        from_ids,
        to,
        date: Some(date),
        after_secs: after,
        ..Default::default()
    };
    find_connections(&q, Some(&KB_MZK))
}

#[test]
fn finds_a_direct_mzk_course_on_a_day_of_its_day_type() {
    let res = mzk("mzk:2", &[], "mzk:456", "2026-09-30", None);
    let first = &res[0];
    assert_eq!(first.kind, "direct");
    assert_eq!(first.legs[0].trip_id, "mzk:5088899:13002");
    assert_eq!(first.legs[0].line, "22");
    assert_eq!(
        (first.departure_time.as_str(), first.arrival_time.as_str()),
        ("22:46", "22:53")
    );
}

#[test]
fn runs_a_course_only_on_the_dates_of_its_day_type() {
    let sunday = mzk("mzk:2", &[], "mzk:456", "2026-10-04", None);
    assert_eq!(sunday[0].legs[0].trip_id, "mzk:5087953:13002");
    assert_eq!(sunday[0].departure_time, "21:46");
    let uncovered = mzk("mzk:2", &[], "mzk:456", "2026-10-01", None);
    assert!(
        uncovered
            .iter()
            .all(|c| c.legs.iter().all(|l| !l.trip_id.starts_with("mzk:")))
    );
}

#[test]
fn transfers_from_a_kb_trip_to_an_mzk_course_on_a_nearby_pole() {
    let res = mzk("22191", &[], "mzk:456", "2026-09-30", Some(21 * 3600));
    let conn = res
        .iter()
        .find(|c| c.legs.len() >= 2)
        .expect("expected a KB -> MZK itinerary");
    assert!(!conn.legs[0].trip_id.starts_with("mzk:"));
    let last = conn.legs.last().unwrap();
    assert_eq!(last.trip_id, "mzk:5088899:13002");
    assert!(conn.transfers_count >= 1);
    assert_eq!(last.walk_mins, Some(5));
    assert_eq!(conn.walk_minutes, 5);
}

#[test]
fn a_kb_and_an_mzk_pole_of_one_shelter_are_one_stop() {
    let res = mzk("10031", &[], "mzk:456", "2026-09-30", Some(21 * 3600 + 1800));
    let conn = (res.iter())
        .find(|c| c.legs.len() == 2 && c.legs[1].from_stop_id == "mzk:3")
        .expect("expected a transfer at 10071 / mzk:3");
    assert_eq!(conn.legs[0].to_stop_id, "10071");
    assert_eq!(conn.legs[0].walk_mins, None);
    assert_eq!(conn.legs[1].walk_mins, Some(0));
    assert_eq!(conn.walk_minutes, 0);
}

#[test]
fn resolves_the_origin_from_explicit_stop_ids_before_the_name() {
    let ids = ["10021".to_string(), "mzk:2".to_string()];
    assert_eq!(
        mzk("no such stop", &ids, "mzk:456", "2026-09-30", None)[0].legs[0].trip_id,
        "mzk:5088899:13002"
    );
    let unknown = ["mzk:999999".to_string()];
    assert_eq!(
        mzk("3 Maja Dworzec", &unknown, "mzk:456", "2026-09-30", None)[0].legs[0].trip_id,
        "mzk:5088899:13002"
    );
}
