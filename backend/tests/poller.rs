//! Port of test/poller.test.ts: the pure schedule/geometry helpers of lib/poller.ts.

use serde_json::{Map, Value, json};
use unimaps::geo::{bearing, meters_between};
use unimaps::poller::{hhmm_to_secs, vehicle_to_json};
use unimaps::time::now_secs;
use unimaps::vehicle::VehiclePos;

/// lib/client/geo.ts haversineMeters (client code, the independent reference of the planar check)
fn haversine_meters(a_lat: f64, a_lon: f64, b_lat: f64, b_lon: f64) -> f64 {
    let rad = std::f64::consts::PI / 180.0;
    let d_lat = (b_lat - a_lat) * rad;
    let d_lon = (b_lon - a_lon) * rad;
    let s = (d_lat / 2.0).sin().powi(2) + (a_lat * rad).cos() * (b_lat * rad).cos() * (d_lon / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * s.sqrt().atan2((1.0 - s).sqrt())
}

/// `assert.equal` on a number is Object.is: +0 and -0 differ
fn same(a: Option<f64>, b: Option<f64>) -> bool {
    a.map(f64::to_bits) == b.map(f64::to_bits)
}

#[test]
fn hhmm_to_secs_parses_hh_mm_ignoring_a_seconds_part() {
    assert_eq!(hhmm_to_secs(Some(&json!("5:30"))), Some(19800.0));
    assert_eq!(hhmm_to_secs(Some(&json!("05:30:45"))), Some(19800.0));
    assert_eq!(hhmm_to_secs(Some(&json!("7:5"))), Some(25500.0));
}

#[test]
fn hhmm_to_secs_returns_null_for_anything_unparsable() {
    assert_eq!(hhmm_to_secs(Some(&json!(""))), None);
    assert_eq!(hhmm_to_secs(Some(&json!("abc"))), None);
    assert_eq!(hhmm_to_secs(Some(&json!("12"))), None);
    assert_eq!(hhmm_to_secs(Some(&json!("10:xx"))), None);
    assert_eq!(hhmm_to_secs(Some(&Value::Null)), None);
    assert_eq!(hhmm_to_secs(Some(&json!(1230))), None);
}

#[test]
fn meters_between_agrees_with_haversine_within_a_few_percent_at_city_scale() {
    let planar = meters_between(49.8225, 19.0444, 49.7167, 19.0333);
    let exact = haversine_meters(49.8225, 19.0444, 49.7167, 19.0333);
    assert!((planar - exact).abs() / exact < 0.03, "planar={planar} exact={exact}");
}

#[test]
fn meters_between_15_m_at_the_ghost_filter_epsilon_scale() {
    let d = meters_between(49.8225, 19.0444, 49.822635, 19.0444);
    assert!((d - 15.0).abs() < 0.1, "got {d}");
}

#[test]
fn bearing_cardinal_directions() {
    assert!(same(bearing(0.0, 0.0, 1.0, 0.0), Some(0.0)));
    assert!(same(bearing(0.0, 0.0, 0.0, 1.0), Some(90.0)));
    assert!(same(bearing(1.0, 0.0, 0.0, 0.0), Some(180.0)));
    assert!(same(bearing(0.0, 1.0, 0.0, 0.0), Some(270.0)));
}

#[test]
fn bearing_null_for_identical_points_always_in_0_360() {
    assert_eq!(bearing(49.8, 19.0, 49.8, 19.0), None);
    let b = bearing(49.8, 19.0, 49.9, 18.9);
    assert!(b.is_some_and(|b| (0.0..360.0).contains(&b)));
}

fn num(j: &Map<String, Value>, k: &str) -> Option<f64> {
    j.get(k).and_then(Value::as_f64)
}

#[test]
fn vehicle_to_json_rounds_coords_to_6_dp_bearing_to_1_dp_updated_at_to_1_dp_nulls_pass_through() {
    let pos = VehiclePos {
        exec_id: "19132:39688".into(),
        trip_id: "T1".into(),
        route_id: "L_120".into(),
        line: "120".into(),
        headsign: "SZCZYRK".into(),
        lat: 49.123_456_7,
        lon: 19.765_432_1,
        vehicle_type: 1,
        current_stop_sequence: Some(4),
        at_stop: false,
        delay: Some(-30.0),
        timestamp: 1_700_000_000.0,
        updated_at: 1_700_000_000.123,
        bearing: Some(123.456),
        next_stop_name: Some("TESTOWA".into()),
        next_stop_lat: None,
        next_stop_lon: Some(19.876_543_21),
        last_moved_at: 0.0,
        anchor_lat: 0.0,
        anchor_lon: 0.0,
        finished: false,
        ..Default::default()
    };
    let j = vehicle_to_json(&pos);
    assert_eq!(j.get("id"), Some(&json!("19132:39688")));
    assert_eq!(num(&j, "lat"), Some(49.123457));
    assert_eq!(num(&j, "lon"), Some(19.765432));
    assert_eq!(num(&j, "bearing"), Some(123.5));
    assert_eq!(num(&j, "updated_at"), Some(1_700_000_000.1));
    assert_eq!(j.get("next_stop_lat"), Some(&Value::Null));
    assert_eq!(num(&j, "next_stop_lon"), Some(19.876543));
    assert_eq!(num(&j, "delay"), Some(-30.0));
    assert_eq!(num(&j, "current_stop_sequence"), Some(4.0));
    let nulled = vehicle_to_json(&VehiclePos {
        bearing: None,
        delay: None,
        current_stop_sequence: None,
        ..pos
    });
    assert_eq!(nulled.get("bearing"), Some(&Value::Null));
    assert_eq!(nulled.get("delay"), Some(&Value::Null));
    assert_eq!(nulled.get("current_stop_sequence"), Some(&Value::Null));
}

#[test]
fn now_secs_is_an_integer_in_0_86400() {
    let s = now_secs();
    assert!((0..86400).contains(&s));
}

#[test]
fn now_secs_matches_an_independently_computed_europe_warsaw_wall_clock_2_s() {
    // jiff's Zoned instead of crate::time's AGENCY_TZ.to_datetime: a different assembly path
    let tz = jiff::tz::TimeZone::get("Europe/Warsaw").unwrap();
    let z = jiff::Timestamp::now().to_zoned(tz);
    let expected = (i32::from(z.hour()) % 24) * 3600 + i32::from(z.minute()) * 60 + i32::from(z.second());
    let got = now_secs();
    let diff = (got - expected).abs();
    assert!(diff <= 2 || diff >= 86398, "got={got} expected={expected}");
}

#[test]
fn movement_bearing_calculates_movement_bearing_when_vehicle_moves_beyond_jitter_threshold() {
    let (p1, p2) = ((49.8225, 19.0444), (49.8225, 19.0460));
    let dist = meters_between(p1.0, p1.1, p2.0, p2.1);
    assert!(dist >= 8.0, "distance should exceed threshold, was {dist}");
    let b = bearing(p1.0, p1.1, p2.0, p2.1).unwrap();
    assert!((b - 90.0).abs() < 1.0, "bearing should be ~90 (east), got {b}");
}

#[test]
fn movement_bearing_identifies_movement_south_west() {
    let b = bearing(49.8225, 19.0444, 49.8200, 19.0400).unwrap();
    assert!(b > 180.0 && b < 270.0, "bearing should be SW, got {b}");
}
