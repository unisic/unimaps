//! test/kb-api.test.ts (Python-parity pins of the pure helpers in lib/kb-api.ts) and the KbApi cache cases of
//! test/site-performance.test.ts. A failing test here means a parity regression in src/kb_api.rs.

mod gzm_rig;

use gzm_rig::{Fake, ok};
use serde_json::{Value, json};
use unimaps::gzm::ZbResponse;
use unimaps::kb_api::{
    KbApi, b64_exec_id, exec_id_path_segment, parse_int_strict, parse_stops, parse_trip, py_float, py_truthy,
};
use unimaps::types::{Stop, TripStop};

fn truthy(v: Value) -> bool {
    py_truthy(Some(&v))
}

fn int(v: Value) -> Option<f64> {
    parse_int_strict(Some(&v))
}

fn float(v: Value) -> Option<f64> {
    py_float(Some(&v))
}

// serde_json has no NaN / Infinity: a non-finite f64 becomes null, which is also how such a value reaches the parser
fn non_finite(x: f64) -> Value {
    Value::from(x)
}

// pyTruthy (Python truthiness)

#[test]
fn py_truthy_treats_empty_containers_and_zero_as_falsy() {
    assert!(!truthy(Value::Null));
    assert!(!py_truthy(None));
    assert!(!truthy(json!(false)));
    assert!(!truthy(json!(0)));
    assert!(!truthy(non_finite(f64::NAN)));
    assert!(!truthy(json!("")));
    assert!(!truthy(json!([])));
    assert!(!truthy(json!({})));
}

#[test]
fn py_truthy_treats_0_as_truthy_unlike_js_like_python() {
    assert!(truthy(json!("0")));
    assert!(truthy(json!(" ")));
}

#[test]
fn py_truthy_treats_non_empty_values_as_truthy() {
    assert!(truthy(json!(true)));
    assert!(truthy(json!(1)));
    assert!(truthy(json!(-1)));
    assert!(truthy(json!([0])));
    assert!(truthy(json!({ "a": 0 })));
}

// parseIntStrict (Python int())

#[test]
fn parse_int_strict_truncates_finite_numbers_toward_zero() {
    assert_eq!(int(json!(3.9)), Some(3.0));
    assert_eq!(int(json!(-3.9)), Some(-3.0));
    assert_eq!(int(json!(0)), Some(0.0));
}

#[test]
fn parse_int_strict_rejects_non_finite_numbers() {
    assert_eq!(int(non_finite(f64::INFINITY)), None);
    assert_eq!(int(non_finite(f64::NAN)), None);
}

#[test]
fn parse_int_strict_accepts_only_pure_integer_strings_trimmed_optional_sign() {
    assert_eq!(int(json!(" 42 ")), Some(42.0));
    assert_eq!(int(json!("+7")), Some(7.0));
    assert_eq!(int(json!("-7")), Some(-7.0));
    assert_eq!(int(json!("12.5")), None);
    assert_eq!(int(json!("0x10")), None);
    assert_eq!(int(json!("1e3")), None);
    assert_eq!(int(json!("")), None);
}

#[test]
fn parse_int_strict_rejects_non_number_non_string_values() {
    assert_eq!(int(Value::Null), None);
    assert_eq!(parse_int_strict(None), None);
    assert_eq!(int(json!([1])), None);
}

// pyFloat (Python float())

#[test]
fn py_float_passes_finite_numbers_through() {
    assert_eq!(float(json!(2.5)), Some(2.5));
    assert_eq!(float(json!(0)), Some(0.0));
    assert_eq!(float(non_finite(f64::NAN)), None);
    assert_eq!(float(non_finite(f64::INFINITY)), None);
}

#[test]
fn py_float_parses_numeric_strings_including_scientific_notation() {
    assert_eq!(float(json!("1e3")), Some(1000.0));
    assert_eq!(float(json!(" 2.5 ")), Some(2.5));
    assert_eq!(float(json!("")), None);
    assert_eq!(float(json!("abc")), None);
}

#[test]
fn py_float_rejects_everything_else() {
    assert_eq!(float(Value::Null), None);
    assert_eq!(float(json!(true)), None);
}

// b64ExecId

const REAL_IDS: [&str; 4] = ["1", "12345", "19132:39688", "999999:1:2"];

#[test]
fn b64_exec_id_pins_standard_base64_with_padding_for_the_real_id_shape() {
    assert_eq!(b64_exec_id("19132:39688"), "MTkxMzI6Mzk2ODg=");
}

#[test]
fn b64_exec_id_digits_and_colon_can_never_produce_slash_or_plus() {
    for id in REAL_IDS {
        assert!(!b64_exec_id(id).contains(['/', '+']), "{id}");
    }
}

// execIdPathSegment

#[test]
fn exec_id_path_segment_is_a_byte_identical_no_op_for_the_real_digit_colon_id_shape() {
    for id in REAL_IDS {
        assert_eq!(exec_id_path_segment(id), b64_exec_id(id));
    }
}

#[test]
fn exec_id_path_segment_escapes_slash_and_plus_so_an_exotic_id_cannot_rewrite_the_upstream_path() {
    assert_eq!(b64_exec_id("???"), "Pz8/");
    assert_eq!(exec_id_path_segment("???"), "Pz8%2F");
    assert_eq!(b64_exec_id("~~~"), "fn5+");
    assert_eq!(exec_id_path_segment("~~~"), "fn5%2B");
    assert!(!exec_id_path_segment("\u{FF}\u{FE}\u{FD}").contains(['/', '+']));
}

// parseStops (positional rows)

fn row(url_id: &str, internal_id: Value, name: &str, lon_micro: Value, lat_micro: Value, flags: &[Value]) -> Value {
    let mut r = vec![json!(url_id), internal_id, json!(name), lon_micro, lat_micro];
    r.extend_from_slice(flags);
    Value::Array(r)
}

fn stops(raw: Value) -> Vec<Stop> {
    parse_stops(Some(&raw))
}

#[test]
fn parse_stops_divides_micro_degree_coordinates_by_1e6() {
    let s = stops(json!({ "stops": [row("A:1", json!(10), "TESTOWA", json!(19_044_400), json!(49_822_500), &[])] }));
    assert_eq!(s.len(), 1);
    let [s] = s.as_slice() else { panic!("one stop") };
    assert_eq!(s.lon, 19.0444);
    assert_eq!(s.lat, 49.8225);
    assert_eq!(s.url_id, "A:1");
    assert_eq!(s.internal_id, 10);
    assert_eq!(s.stop_id, "10");
}

#[test]
fn parse_stops_dedupes_by_internal_id_keeping_the_first_row() {
    let s = stops(json!({ "stops": [
        row("A", json!(10), "FIRST", json!(1), json!(2), &[]),
        row("B", json!(10), "SECOND", json!(3), json!(4), &[]),
    ] }));
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].name, "FIRST");
}

#[test]
fn parse_stops_skips_short_rows_and_rows_with_unparsable_id_coords() {
    let s = stops(json!({ "stops": [
        ["A", 10, "SHORT", 1],
        row("B", json!("not-int"), "BAD-ID", json!(1), json!(2), &[]),
        row("C", json!(11), "BAD-LON", json!("abc"), json!(2), &[]),
        row("D", json!(12), "OK", json!(1), json!(2), &[]),
        "not-an-array",
    ] }));
    assert_eq!(s.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["OK"]);
}

#[test]
fn parse_stops_reads_optional_flag_columns_with_python_truthiness_defaulting_false() {
    let bare = stops(json!({ "stops": [row("A", json!(1), "N", json!(1), json!(2), &[])] }));
    assert!(!bare[0].only_disembarking);
    assert!(!bare[0].is_station);
    assert!(!bare[0].show_platforms);
    let flagged =
        stops(json!({ "stops": [row("B", json!(2), "N", json!(1), json!(2), &[json!(1), json!(0), json!(true)])] }));
    assert!(flagged[0].only_disembarking);
    assert!(!flagged[0].is_station);
    assert!(flagged[0].show_platforms);
}

#[test]
fn parse_stops_returns_empty_for_non_record_input_or_missing_stops_array() {
    assert_eq!(stops(Value::Null), []);
    assert_eq!(stops(json!("x")), []);
    assert_eq!(stops(json!({ "stops": "nope" })), []);
}

// parseTrip

#[test]
fn parse_trip_parses_times_with_null_coercions_and_defaults() {
    let raw = json!({
        "times": [
            {
                "stop_name": "PRZYSTANEK",
                "designator": 5.7,
                "place_id": "P:1",
                "departure_time": "05:30",
                "index": "2",
                "platform": 3,
            },
            {},
        ],
        "direction": "SZCZYRK",
        "line": { "name": "120", "type": "bus" },
        "vehicle_type": 1.9,
        "current_station_id": 44,
    });
    let trip = parse_trip(Some(&raw), "T1");
    assert_eq!(trip.trip_id, "T1");
    assert_eq!(trip.times.len(), 2);
    assert_eq!(
        trip.times[0],
        TripStop {
            stop_name: "PRZYSTANEK".into(),
            designator: Some(5),
            place_id: Some("P:1".into()),
            departure_time: "05:30".into(),
            index: 2,
            platform: Some("3".into()),
        }
    );
    assert_eq!(
        trip.times[1],
        TripStop {
            stop_name: String::new(),
            designator: None,
            place_id: None,
            departure_time: String::new(),
            index: 0,
            platform: None,
        }
    );
    assert_eq!(trip.direction, "SZCZYRK");
    assert_eq!(trip.line_name, "120");
    assert_eq!(trip.line_type.as_deref(), Some("bus"));
    assert_eq!(trip.vehicle_type, Some(1));
    assert_eq!(trip.current_station_id, Some(44));
}

#[test]
fn parse_trip_show_name_absent_true_present_falsy_py_truthy() {
    let show = |raw: Value| parse_trip(Some(&raw), "T").show_name;
    assert!(show(json!({ "line": {} })));
    assert!(!show(json!({ "line": { "show_name": 0 } })));
    assert!(show(json!({ "line": { "show_name": 1 } })));
}

#[test]
fn parse_trip_tolerates_completely_empty_input() {
    let trip = parse_trip(Some(&Value::Null), "T");
    assert_eq!(trip.times, []);
    assert_eq!(trip.direction, "");
    assert_eq!(trip.line_name, "");
    assert!(trip.show_name);
}

// Site Performance & Optimization Invariants > API Client & In-Memory Caching

#[tokio::test]
async fn kb_api_fetch_trips_batch_dedupes_ids_serves_repeats_from_cache_and_never_caches_a_miss() {
    let fake = Fake::new(|req| {
        if req.url.contains("/api/trip/404/") {
            return Ok(ZbResponse {
                status: 404,
                ..ZbResponse::default()
            });
        }
        Ok(ok(json!({ "id": req.url }).to_string()))
    });
    let api = KbApi::new(fake.clone());
    let ids = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    let first = api.fetch_trips_batch(&ids(&["1", "1", "2", "404"]), 0).await;
    let mut keys: Vec<&str> = first.trips.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["1", "2"]);
    assert_eq!(first.failed, 0, "a 404 is a missing trip, not a failed fetch");
    assert_eq!(fake.urls().len(), 3, "duplicate ids must share one upstream request");

    let second = api.fetch_trips_batch(&ids(&["1", "2", "404"]), 0).await;
    assert_eq!(second.trips, first.trips);
    let urls = fake.urls();
    assert_eq!(urls.len(), 4, "cached trips are not refetched; the 404 is retried");
    assert!(urls[3].contains("/api/trip/404/"));
}

#[tokio::test]
async fn kb_api_fetch_timetable_answers_a_repeat_for_the_same_stop_and_date_from_cache() {
    let fake = Fake::new(|_| Ok(ok(json!({ "departures": [{ "trip_id": 1 }] }).to_string())));
    let api = KbApi::new(fake.clone());
    let a = api.fetch_timetable("19117:39660", "2026-10-22").await.unwrap();
    let b = api.fetch_timetable("19117:39660", "2026-10-22").await.unwrap();
    assert_eq!(b, a);
    assert_eq!(fake.urls().len(), 1);
    api.fetch_timetable("19117:39660", "2026-10-23").await.unwrap();
    assert_eq!(fake.urls().len(), 2, "another date is another cache entry");
}
