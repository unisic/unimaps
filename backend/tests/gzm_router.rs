//! test/gzm-router.test.ts: gzmStopKey and the GZM-only router paths (dates, pickup flags, keyed pole groups,
//! stopEvents, lineTimetable, live delays) on a hand-built index.

use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexMap;
use unimaps::gtfs_csv::{NO_DROP_OFF, NO_PICKUP};
use unimaps::router::{
    CallPool, ConnectionItinerary, Point, RouteQuery, RouterIndex, RouterInput, RouterStopInput, SortBy, TripEntry,
    TripStopEntry, build_router_index, call_columns, find_connections, line_timetable, offset_date, stop_events,
};
use unimaps::shared::gzm_stop_key::gzm_stop_key;

#[test]
fn gzm_stop_key_drops_the_post_number_in_every_form_the_feed_uses() {
    assert_eq!(gzm_stop_key("Pszczelnik Park 02"), "Pszczelnik Park");
    assert_eq!(
        gzm_stop_key("Chorzów Stadion Śląski Pętla Zach. 1t"),
        "Chorzów Stadion Śląski Pętla Zach."
    );
    assert_eq!(gzm_stop_key("Katowice Sądowa 1A"), "Katowice Sądowa");
    assert_eq!(gzm_stop_key("Urbanowice II 01"), "Urbanowice II");
}

#[test]
fn gzm_stop_key_matches_the_regexp_on_edge_cases() {
    // the expectations are what `name.replace(/\s\d{1,2}[a-z]?$/i, "")` returns in Node
    for (name, want) in [
        ("Rynek 123", "Rynek 123"),
        ("Rynek12", "Rynek12"),
        ("Rynek 1ab", "Rynek 1ab"),
        ("Rynek\u{A0}3", "Rynek"),
        ("Rynek\u{85}3", "Rynek\u{85}3"),
        ("Rynek\u{FEFF}3b", "Rynek"),
        (" 7", ""),
        ("7", "7"),
        ("", ""),
        ("Ząb 2Ż", "Ząb 2Ż"),
    ] {
        assert_eq!(gzm_stop_key(name), want, "{name:?}");
    }
}

const DATE: &str = "2026-10-28";

fn secs(hhmm: &str) -> i32 {
    let (h, m) = hhmm.split_once(':').unwrap();
    h.parse::<i32>().unwrap() * 3600 + m.parse::<i32>().unwrap() * 60
}

fn trip(id: &str, calls: &[(&str, &str)], dates: &[&str], flags: Option<&[u8]>) -> TripEntry {
    let mut t = TripEntry {
        trip_id: id.into(),
        service_id: "s".into(),
        route_id: "r".into(),
        line: "7".into(),
        headsign: "Koniec".into(),
        dates: Some(Arc::new(dates.iter().map(|d| d.to_string()).collect())),
        flags: flags.map(Arc::from),
        ..Default::default()
    };
    let calls = (calls.iter().enumerate())
        .map(|(i, (stop_id, hhmm))| {
            let at = f64::from(secs(hhmm));
            TripStopEntry {
                stop_id: stop_id.to_string(),
                seq: (i + 1) as f64,
                arr: at,
                dep: at,
            }
        })
        .collect();
    call_columns(&mut t, calls, &mut CallPool::new());
    t
}

/// a line along lat 50.25: poles ~700 m apart, so no walking between A, B, C, D
fn index(trips: Vec<TripEntry>) -> RouterIndex {
    let stops = [
        ("gzm:a1", "Alfa 01", 50.25, 19.0),
        ("gzm:a2", "Alfa 02", 50.2503, 19.0),
        ("gzm:b", "Beta 01", 50.25, 19.01),
        ("gzm:c", "Gamma 1t", 50.25, 19.02),
        ("gzm:d", "Delta 01", 50.25, 19.03),
        ("gzm:e", "Epsilon 01", 50.25, 19.04),
    ];
    build_router_index(RouterInput {
        stops: (stops.iter())
            .map(|&(id, name, lat, lon)| RouterStopInput {
                id: id.into(),
                name: name.into(),
                lat,
                lon,
                key: Some(gzm_stop_key(name).into()),
            })
            .collect(),
        trips: trips
            .into_iter()
            .map(|t| (t.trip_id.clone(), t))
            .collect::<IndexMap<_, _>>(),
        services: HashMap::new(),
        mzk_day_types: HashMap::new(),
    })
}

/// `q(from, to, afterSecs, date)` of the TS test plus fields: the stop ids are temporaries of the enclosing statement
macro_rules! q {
    ($from:expr, $to:expr, $after:expr, $date:expr $(, $f:ident: $v:expr)* $(,)?) => {
        RouteQuery {
            from: $from,
            to: $to,
            from_ids: &[String::from($from)],
            to_ids: &[String::from($to)],
            after_secs: Some($after),
            date: Some($date),
            $($f: $v,)*
            ..Default::default()
        }
    };
}

fn run(q: &RouteQuery, idx: &RouterIndex) -> Vec<ConnectionItinerary> {
    find_connections(q, Some(idx))
}

fn trip_ids(res: &[ConnectionItinerary]) -> Vec<&str> {
    res.iter().map(|c| c.legs[0].trip_id.as_str()).collect()
}

#[test]
fn groups_the_posts_of_one_stop_so_a_query_from_post_01_boards_at_post_02() {
    let idx = index(vec![trip(
        "gzm:t1",
        &[("gzm:a2", "08:00"), ("gzm:b", "08:05")],
        &[DATE],
        None,
    )]);
    assert_eq!(idx.stops["gzm:a1"].name, "Alfa 01");
    let res = run(&q!("gzm:a1", "gzm:b", secs("07:00"), DATE), &idx);
    assert_eq!(res[0].legs[0].from_stop_id, "gzm:a2");
    assert_eq!(res[0].departure_time, "08:00");
}

#[test]
fn runs_a_trip_only_on_its_dates_an_empty_date_set_never_runs() {
    let idx = index(vec![
        trip("gzm:on", &[("gzm:a1", "08:00"), ("gzm:b", "08:05")], &[DATE], None),
        trip("gzm:never", &[("gzm:a1", "09:00"), ("gzm:b", "09:05")], &[], None),
    ]);
    assert_eq!(trip_ids(&run(&q!("gzm:a1", "gzm:b", 0, DATE), &idx)), ["gzm:on"]);
    assert!(run(&q!("gzm:a1", "gzm:b", 0, &offset_date(DATE, 1)), &idx).is_empty());
}

#[test]
fn never_boards_at_a_no_pickup_call_nor_alights_at_a_no_drop_off_call() {
    // B: drop-off only, C: pick-up only
    let idx = index(vec![
        trip(
            "gzm:t",
            &[
                ("gzm:a1", "08:00"),
                ("gzm:b", "08:05"),
                ("gzm:c", "08:10"),
                ("gzm:d", "08:15"),
            ],
            &[DATE],
            Some(&[0, NO_PICKUP, NO_DROP_OFF, 0]),
        ),
        trip("gzm:to-b", &[("gzm:e", "07:45"), ("gzm:b", "07:55")], &[DATE], None),
        trip("gzm:from-c", &[("gzm:c", "08:30"), ("gzm:e", "08:40")], &[DATE], None),
    ]);
    assert_eq!(run(&q!("gzm:a1", "gzm:b", 0, DATE), &idx)[0].arrival_time, "08:05");
    assert!(run(&q!("gzm:b", "gzm:d", 0, DATE), &idx).is_empty());
    assert!(run(&q!("gzm:a1", "gzm:c", 0, DATE), &idx).is_empty());
    assert_eq!(run(&q!("gzm:c", "gzm:d", 0, DATE), &idx)[0].departure_time, "08:10");
    // nor as a transfer: E -> B, then t at B; t to C, then C -> E
    assert!(run(&q!("gzm:e", "gzm:d", 0, DATE), &idx).is_empty());
    assert!(run(&q!("gzm:a1", "gzm:e", 0, DATE), &idx).is_empty());
}

#[test]
fn keeps_flagged_and_open_trips_of_one_stop_sequence_in_separate_patterns() {
    let calls = [("gzm:a1", "08:00"), ("gzm:b", "08:05"), ("gzm:c", "08:10")];
    let later = [("gzm:a1", "09:00"), ("gzm:b", "09:05"), ("gzm:c", "09:10")];
    let idx = index(vec![
        trip("gzm:open", &calls, &[DATE], None),
        trip("gzm:flagged", &later, &[DATE], Some(&[0, NO_PICKUP, 0])),
    ]);
    assert_ne!(idx.trips["gzm:open"].pattern, idx.trips["gzm:flagged"].pattern);
    // a first call's NO_DROP_OFF / last call's NO_PICKUP block nothing, so they don't split the pattern
    let idx2 = index(vec![
        trip("gzm:o", &calls, &[DATE], None),
        trip("gzm:f", &later, &[DATE], Some(&[NO_DROP_OFF, 0, NO_PICKUP])),
    ]);
    assert_eq!(idx2.trips["gzm:o"].pattern, idx2.trips["gzm:f"].pattern);
    assert!(run(&q!("gzm:b", "gzm:c", secs("08:30"), DATE), &idx).is_empty());
}

#[test]
fn answers_an_unreachable_target_with_nothing() {
    let idx = index(vec![trip(
        "gzm:t",
        &[("gzm:b", "08:00"), ("gzm:a1", "08:05")],
        &[DATE],
        None,
    )]);
    assert!(run(&q!("gzm:a1", "gzm:b", 0, DATE), &idx).is_empty());
}

#[test]
fn searches_only_fallback_days_following_days_of_a_today_query() {
    let today = unimaps::time::today_local().to_string();
    let in2 = offset_date(&today, 2);
    let idx = index(vec![trip(
        "gzm:t",
        &[("gzm:a1", "08:00"), ("gzm:b", "08:05")],
        &[&in2],
        None,
    )]);
    assert!(
        run(
            &q!("gzm:a1", "gzm:b", secs("23:00"), &today, fallback_days: Some(1)),
            &idx
        )
        .is_empty()
    );
    assert_eq!(
        run(
            &q!("gzm:a1", "gzm:b", secs("23:00"), &today, fallback_days: Some(2)),
            &idx
        )[0]
        .date,
        in2
    );
}

#[test]
fn starts_from_a_point_at_every_pole_within_800_m_departing_when_the_rider_leaves() {
    // the point is ~498 m (8 min) east of Alfa 01, ~213 m (4 min) west of Beta, ~925 m from Gamma
    let idx = index(vec![
        trip("gzm:from-a", &[("gzm:a1", "08:00"), ("gzm:d", "08:20")], &[DATE], None),
        trip("gzm:from-b", &[("gzm:b", "08:10"), ("gzm:d", "08:25")], &[DATE], None),
        trip("gzm:from-c", &[("gzm:c", "08:05"), ("gzm:d", "08:15")], &[DATE], None),
    ]);
    let from_point = Point {
        lat: 50.25,
        lon: 19.007,
        walk_m: None,
    };
    let from = |after: &str, walk_m: Option<f64>| {
        let q = q!("geo:50.25,19.007", "gzm:d", secs(after), DATE, from_point: Some(Point { walk_m, ..from_point }));
        run(&q, &idx)
    };
    let res = from("07:00", None);
    let got: Vec<_> = (res.iter())
        .map(|c| {
            (
                c.legs[0].trip_id.as_str(),
                c.departure_time.as_str(),
                c.access_walk_mins,
                c.walk_minutes,
                c.total_duration_mins,
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("gzm:from-a", "07:52", Some(8), 8, 28),
            ("gzm:from-b", "08:06", Some(4), 4, 19)
        ]
    );
    assert_eq!(res[0].legs[0].departure_time, "08:00");
    // leaving at 07:55 is too late for the 08:00 at Alfa
    assert_eq!(trip_ids(&from("07:55", None)), ["gzm:from-b"]);
    // a rider who walks at most 300 m reaches only Beta
    assert_eq!(trip_ids(&from("07:00", Some(300.0))), ["gzm:from-b"]);
    // a search from a stop carries no access walk
    assert_eq!(
        run(&q!("gzm:a1", "gzm:d", secs("07:00"), DATE), &idx)[0].access_walk_mins,
        None
    );
}

#[test]
fn ends_at_a_point_every_pole_within_800_m_the_walk_from_it_counted_into_the_arrival() {
    // the point is ~213 m (4 min) west of Delta, ~498 m (8 min) east of Gamma, ~925 m from Epsilon
    let idx = index(vec![
        trip("gzm:to-c", &[("gzm:a1", "08:00"), ("gzm:c", "08:10")], &[DATE], None),
        trip("gzm:to-d", &[("gzm:a1", "08:05"), ("gzm:d", "08:20")], &[DATE], None),
        trip("gzm:to-e", &[("gzm:a1", "08:06"), ("gzm:e", "08:12")], &[DATE], None),
    ]);
    let to_point = Some(Point {
        lat: 50.25,
        lon: 19.027,
        walk_m: None,
    });
    let res = run(
        &q!("gzm:a1", "geo:50.25,19.027", secs("07:00"), DATE, to_point: to_point),
        &idx,
    );
    let got: Vec<_> = (res.iter())
        .map(|c| {
            let l = &c.legs[0];
            (
                l.trip_id.as_str(),
                c.arrival_time.as_str(),
                l.arrival_time.as_str(),
                c.egress_walk_mins,
                c.walk_minutes,
                c.total_duration_mins,
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("gzm:to-c", "08:18", "08:10", Some(8), 8, 18),
            ("gzm:to-d", "08:24", "08:20", Some(4), 4, 19)
        ]
    );
    // a search to a stop carries no egress walk
    assert_eq!(
        run(&q!("gzm:a1", "gzm:d", secs("07:00"), DATE), &idx)[0].egress_walk_mins,
        None
    );
}

#[test]
fn arrive_by_keeps_the_latest_leaving_journeys_arriving_by_the_time() {
    let idx = index(
        (["07:00", "07:30", "08:00", "08:30"].iter().enumerate())
            .map(|(i, t)| {
                let arr = format!("{}2", &t[..4]);
                trip(&format!("gzm:t{i}"), &[("gzm:a1", t), ("gzm:d", &arr)], &[DATE], None)
            })
            .collect(),
    );
    let by = |hhmm: &str, limit: i32| -> Vec<String> {
        let q = q!("gzm:a1", "gzm:d", secs(hhmm), DATE, arrive_by: true, limit: Some(limit));
        (run(&q, &idx).iter())
            .map(|c| format!("{}-{}", c.departure_time, c.arrival_time))
            .collect()
    };
    assert_eq!(by("08:25", 2), ["07:30-07:32", "08:00-08:02"]);
    assert_eq!(by("08:02", 2), ["07:30-07:32", "08:00-08:02"]);
    assert_eq!(by("08:01", 5), ["07:00-07:02", "07:30-07:32"]);
    // nothing in the first 2 h before 12:00: the window grows back to the morning
    assert_eq!(by("12:00", 2), ["08:00-08:02", "08:30-08:32"]);
    assert!(by("06:00", 5).is_empty());
}

#[test]
fn walks_between_poles_across_a_grid_cell_boundary_not_beyond_350_m() {
    let cell = 350.0 / 111_320.0;
    let lat = (50.25_f64 / cell).ceil() * cell; // a cell edge
    let stop = |id: &str, name: &str, lat: f64| RouterStopInput {
        id: id.into(),
        name: name.into(),
        lat,
        lon: 19.1,
        key: None,
    };
    let idx = build_router_index(RouterInput {
        stops: vec![
            stop("gzm:p", "P 01", lat - 0.0003),
            stop("gzm:q", "Q 01", lat + 0.002),  // ~256 m north, next cell
            stop("gzm:r", "R 01", lat + 0.0045), // ~534 m north of p
        ],
        trips: IndexMap::new(),
        services: HashMap::new(),
        mzk_day_types: HashMap::new(),
    });
    let foot = |id: &str| -> Vec<&str> {
        idx.foot_of(idx.stop_num[id])
            .map(|(to, _)| idx.stop_ids[to as usize].as_str())
            .collect()
    };
    assert_eq!(foot("gzm:p"), ["gzm:q"]);
    assert_eq!(foot("gzm:q"), ["gzm:p", "gzm:r"]);
}

fn events_index() -> RouterIndex {
    index(vec![
        trip("gzm:late", &[("gzm:a1", "08:20"), ("gzm:b", "08:25")], &[DATE], None),
        trip(
            "gzm:early",
            &[("gzm:a2", "08:10"), ("gzm:b", "08:15"), ("gzm:c", "08:20")],
            &[DATE],
            Some(&[0, NO_PICKUP, 0]),
        ),
        trip(
            "gzm:night",
            &[("gzm:b", "25:10"), ("gzm:c", "25:20")],
            &[&offset_date(DATE, -1)],
            None,
        ),
        trip("gzm:out", &[("gzm:a1", "12:00"), ("gzm:b", "12:05")], &[DATE], None),
    ])
}

#[test]
fn stop_events_lists_boardable_calls_in_the_window_earliest_first_with_the_service_day() {
    let idx = events_index();
    let got: Vec<_> = (stop_events(&idx, ["gzm:a1", "gzm:a2", "gzm:b"], DATE, 0, secs("10:00"), None).into_iter())
        .map(|e| (e.trip.trip_id.clone(), e.pos, e.dep, e.service_date))
        .collect();
    let want = [
        ("gzm:night".to_string(), 0, secs("01:10"), offset_date(DATE, -1)),
        ("gzm:early".to_string(), 0, secs("08:10"), DATE.to_string()),
        ("gzm:late".to_string(), 0, secs("08:20"), DATE.to_string()),
    ];
    assert_eq!(got, want);
}

#[test]
fn stop_events_skips_last_calls_and_no_pickup_calls_honours_the_limit() {
    let idx = events_index();
    assert!(stop_events(&idx, ["gzm:b"], DATE, secs("02:00"), secs("23:00"), None).is_empty());
    assert_eq!(
        stop_events(&idx, ["gzm:a1", "gzm:a2"], DATE, 0, 86400, Some(2)).len(),
        2
    );
    assert!(stop_events(&idx, ["gzm:unknown"], DATE, 0, 86400, None).is_empty());
}

#[test]
fn line_timetable_groups_the_days_trips_by_stop_pattern_busiest_first() {
    let other = TripEntry {
        line: "8".into(),
        ..trip("gzm:x", &[("gzm:a1", "07:00"), ("gzm:b", "07:05")], &[DATE], None)
    };
    let idx = index(vec![
        trip("gzm:late", &[("gzm:a1", "09:00"), ("gzm:b", "09:05")], &[DATE], None),
        trip("gzm:early", &[("gzm:a1", "08:00"), ("gzm:b", "08:04")], &[DATE], None),
        trip("gzm:short", &[("gzm:b", "08:30"), ("gzm:c", "08:35")], &[DATE], None),
        trip("gzm:night", &[("gzm:b", "23:58"), ("gzm:c", "24:03")], &[DATE], None),
        trip(
            "gzm:tomorrow",
            &[("gzm:c", "08:00"), ("gzm:d", "08:05")],
            &[&offset_date(DATE, 1)],
            None,
        ),
        other,
    ]);
    let v = line_timetable("7", "GZM", DATE, Some(&idx)).unwrap();
    let names: Vec<Vec<&str>> = v
        .iter()
        .map(|x| x.stops.iter().map(|s| s.name.as_str()).collect())
        .collect();
    assert_eq!(names, [["Alfa 01", "Beta 01"], ["Beta 01", "Gamma 1t"]]);
    assert_eq!(v[0].times, [[480, 484], [540, 545]]);
    assert_eq!(v[1].times, [[510, 515], [1438, 1443]]);
    assert_eq!(v[0].headsign, "Koniec");
    assert!(line_timetable("7", "MZK", DATE, Some(&idx)).unwrap().is_empty());
    assert!(
        line_timetable("7", "GZM", &offset_date(DATE, 2), Some(&idx))
            .unwrap()
            .is_empty()
    );
}

// router options: today's searches (the agency's clock)

fn today() -> String {
    unimaps::time::today_local().to_string()
}

fn at(id: &str, calls: &[(&str, &str)], line: &str, route_id: &str) -> TripEntry {
    TripEntry {
        line: line.into(),
        route_id: route_id.into(),
        ..trip(id, calls, &[&today()], None)
    }
}

#[test]
fn boards_a_late_bus_that_left_on_paper_keeps_its_timetable_time_on_the_wire() {
    let today = today();
    let idx = index(vec![
        at("gzm:t1", &[("gzm:a1", "10:00"), ("gzm:b", "10:10")], "7", "r"),
        at("gzm:t2", &[("gzm:a1", "10:30"), ("gzm:b", "10:40")], "7", "r"),
    ]);
    assert_eq!(
        run(&q!("gzm:a1", "gzm:b", secs("10:03"), &today), &idx)[0].legs[0].trip_id,
        "gzm:t2"
    );
    let live = |id: &str, d: &str| (id == "gzm:t1" && d == today).then_some(300);
    let res = run(&q!("gzm:a1", "gzm:b", secs("10:03"), &today, live: Some(&live)), &idx);
    let leg = &res[0].legs[0];
    assert_eq!(leg.trip_id, "gzm:t1");
    assert_eq!(leg.departure_time, "10:00");
    assert_eq!(leg.delay_sec, Some(300));
}

#[test]
fn drops_a_transfer_the_feeders_delay_breaks_ignores_live_data_on_another_day() {
    let today = today();
    let idx = index(vec![
        at("gzm:f", &[("gzm:a1", "10:00"), ("gzm:b", "10:10")], "7", "r"),
        at("gzm:n1", &[("gzm:b", "10:15"), ("gzm:c", "10:25")], "7", "r"),
        at("gzm:n2", &[("gzm:b", "10:45"), ("gzm:c", "10:55")], "7", "r"),
    ]);
    let second_leg = |day: &str| {
        let late = |id: &str, d: &str| (id == "gzm:f" && d == day).then_some(600);
        let res = run(
            &q!("gzm:a1", "gzm:c", secs("09:50"), &today, live: Some(&late), limit: Some(1)),
            &idx,
        );
        res[0].legs[1].trip_id.clone()
    };
    assert_eq!(second_leg(&today), "gzm:n2");
    assert_eq!(second_leg(&offset_date(&today, -1)), "gzm:n1");
}

#[test]
fn never_rides_an_avoided_line_or_route() {
    let today = today();
    let idx = index(vec![
        at("gzm:l7", &[("gzm:a1", "10:00"), ("gzm:b", "10:10")], "7", "r"),
        at("gzm:l8", &[("gzm:a1", "10:05"), ("gzm:b", "10:15")], "8", "tram"),
        at("gzm:l9", &[("gzm:a1", "10:20"), ("gzm:b", "10:30")], "9", "r"),
    ]);
    let (lines, routes) = (["7".to_string()], ["tram".to_string()]);
    let q = q!("gzm:a1", "gzm:b", secs("09:50"), &today, limit: Some(3), avoid_lines: &lines, avoid_routes: &routes);
    let got: Vec<_> = run(&q, &idx).iter().map(|c| c.legs[0].line.clone()).collect();
    assert_eq!(got, ["9"]);
}

#[test]
fn puts_the_fewest_transfers_first_on_the_transfers_profile() {
    let today = today();
    let idx = index(vec![
        at("gzm:x1", &[("gzm:a1", "10:00"), ("gzm:b", "10:10")], "7", "r"),
        at("gzm:x2", &[("gzm:b", "10:15"), ("gzm:c", "10:30")], "8", "r"),
        at(
            "gzm:d1",
            &[("gzm:a1", "10:30"), ("gzm:b", "10:40"), ("gzm:c", "11:00")],
            "9",
            "r",
        ),
    ]);
    let transfers = |sort_by| -> Vec<i32> {
        let q = q!("gzm:a1", "gzm:c", secs("09:50"), &today, limit: Some(2), sort_by: sort_by);
        run(&q, &idx).iter().map(|c| c.transfers_count).collect()
    };
    assert_eq!(transfers(SortBy::Departure), [1, 0]);
    assert_eq!(transfers(SortBy::Transfers), [0, 1]);
}
