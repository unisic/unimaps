//! test/polyline.test.ts

use unimaps::geo::meters_between;
use unimaps::shared::polyline::*;

const LAT0: f64 = 49.8;
const LON0: f64 = 19.0;

/// Point `east` / `north` metres from (49.8, 19.0).
fn p(east: f64, north: f64) -> LatLng {
    let kx = 111_320.0 * (LAT0 * (std::f64::consts::PI / 180.0)).cos();
    [LAT0 + north / 111_320.0, LON0 + east / kx]
}

fn m(a: LatLng, b: LatLng) -> f64 {
    meters_between(a[0], a[1], b[0], b[1])
}

fn near(got: f64, want: f64, tol: f64) {
    assert!((got - want).abs() < tol, "got {got}, want {want} +- {tol}");
}

fn project(pl: &Polyline, at: LatLng, s_min: f64, s_max: f64, hint: Option<f64>) -> Option<Projection> {
    project_on_polyline(pl, at[0], at[1], s_min, s_max, hint, 15.0)
}

#[test]
fn matches_googles_reference_vector_at_precision_5() {
    let pts = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
    assert_eq!(encode_polyline(&pts, 5), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    let back = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    assert_eq!(back.len(), 3);
    for (b, w) in back.iter().zip(pts) {
        near(b[0], w[0], 1e-9);
        near(b[1], w[1], 1e-9);
    }
}

#[test]
fn round_trips_precision_6_negatives_and_empty_input() {
    let pts = [p(0.0, 0.0), p(123.4, -56.7), [-33.123456, 151.654321], p(-5.0, 5.0)];
    let back = decode_polyline(&encode_polyline(&pts, 6), 6);
    assert_eq!(back.len(), pts.len());
    for (b, w) in back.iter().zip(pts) {
        near(b[0], w[0], 1e-6);
        near(b[1], w[1], 1e-6);
    }
    assert!(decode_polyline(&encode_polyline(&[], 6), 6).is_empty());
}

#[test]
fn decoding_p6_as_p6_never_lands_10x_off() {
    let enc = encode_polyline(&[p(0.0, 0.0), p(100.0, 0.0)], 6);
    near(decode_polyline(&enc, 6)[0][0], LAT0, 1e-5);
}

#[test]
fn decode_stops_at_malformed_input() {
    // a truncated pair and a byte outside the alphabet both end the list
    let enc = encode_polyline(&[p(0.0, 0.0), p(100.0, 0.0)], 6);
    assert_eq!(decode_polyline(&enc[..enc.len() - 1], 6).len(), 1);
    assert_eq!(decode_polyline(&format!("{enc} "), 6).len(), 2);
}

#[test]
fn cumulative_length_agrees_with_meters_between_and_drops_duplicates() {
    let pts = [
        p(0.0, 0.0),
        p(0.0, 0.0),
        p(300.0, 0.0),
        p(300.0, 400.0),
        [f64::NAN, 1.0],
    ];
    let pl = prepare_polyline(&pts).unwrap();
    assert_eq!(pl.n(), 3);
    near(pl.length, m(pts[0], pts[2]) + m(pts[2], pts[3]), 1e-6);
    near(pl.length, 700.0, 1.0);
}

#[test]
fn prepare_returns_none_for_fewer_than_2_usable_points() {
    assert!(prepare_polyline(&[p(0.0, 0.0)]).is_none());
    assert!(prepare_polyline(&[p(0.0, 0.0), p(0.0, 0.0)]).is_none());
}

#[test]
fn point_at_interpolates_and_clamps() {
    let pl = prepare_polyline(&[p(0.0, 0.0), p(300.0, 0.0), p(300.0, 400.0)]).unwrap();
    for (s, want) in [
        (150.0, p(150.0, 0.0)),
        (500.0, p(300.0, 200.0)),
        (-10.0, p(0.0, 0.0)),
        (1e6, p(300.0, 400.0)),
    ] {
        let a = point_at(&pl, s, None);
        assert!(m([a.lat, a.lon], want) < 0.5, "s {s}");
    }
}

#[test]
fn tangent_heading_east_then_north() {
    let pl = prepare_polyline(&[p(0.0, 0.0), p(300.0, 0.0), p(300.0, 400.0)]).unwrap();
    near(tangent_bearing(&pl, 100.0, 5.0, 15.0).unwrap(), 90.0, 1.0);
    near(tangent_bearing(&pl, 500.0, 5.0, 15.0).unwrap(), 0.0, 1.0);
}

/// out-and-back: east 500 m, then back west 10 m north of the outbound leg
fn out_and_back() -> Polyline {
    prepare_polyline(&[p(0.0, 0.0), p(500.0, 0.0), p(500.0, 10.0), p(0.0, 10.0)]).unwrap()
}

#[test]
fn projection_respects_the_window_so_the_opposite_leg_cant_steal_the_fix() {
    let pl = out_and_back();
    near(project(&pl, p(200.0, 6.0), 0.0, 500.0, None).unwrap().s, 200.0, 1.0);
    near(
        project(&pl, p(200.0, 4.0), 510.0, pl.length, None).unwrap().s,
        810.0,
        1.0,
    );
}

#[test]
fn projection_hint_picks_among_near_equal_candidates() {
    let pl = out_and_back();
    near(
        project(&pl, p(200.0, 5.0), 0.0, f64::INFINITY, Some(800.0)).unwrap().s,
        810.0,
        1.0,
    );
    near(
        project(&pl, p(200.0, 5.0), 0.0, f64::INFINITY, Some(150.0)).unwrap().s,
        200.0,
        1.0,
    );
}

#[test]
fn projection_returns_none_for_an_empty_or_nan_window() {
    let pl = out_and_back();
    assert!(project(&pl, p(0.0, 0.0), 2000.0, 3000.0, None).is_none());
    assert!(project(&pl, p(0.0, 0.0), f64::NAN, 3000.0, None).is_none());
    assert!(project(&pl, p(0.0, 0.0), 0.0, f64::NAN, None).is_none());
}

#[test]
fn stops_along_are_monotone_and_handle_loops_and_far_or_missing_stops() {
    // square loop starting and ending at the origin
    let pl = prepare_polyline(&[p(0.0, 0.0), p(400.0, 0.0), p(400.0, 400.0), p(0.0, 400.0), p(0.0, 0.0)]).unwrap();
    let stops = [
        Some(p(0.0, 3.0)),
        Some(p(400.0, 200.0)),
        None,
        Some(p(5000.0, 5000.0)),
        Some(p(0.0, 2.0)),
    ];
    let s = project_stops_along(&pl, &stops, 80.0);
    near(s[0].unwrap(), 0.0, 5.0);
    near(s[1].unwrap(), 600.0, 1.0);
    assert_eq!(s[2], None);
    assert_eq!(s[3], None);
    near(s[4].unwrap(), 1600.0, 5.0);
}

#[test]
fn out_and_back_return_stop_gets_the_later_distance() {
    let pl = prepare_polyline(&[p(0.0, 0.0), p(500.0, 0.0), p(0.0, 0.0)]).unwrap();
    let s = project_stops_along(
        &pl,
        &[Some(p(100.0, 5.0)), Some(p(500.0, 0.0)), Some(p(100.0, -5.0))],
        80.0,
    );
    near(s[0].unwrap(), 100.0, 1.0);
    near(s[1].unwrap(), 500.0, 1.0);
    near(s[2].unwrap(), 900.0, 1.0);
}

#[test]
fn douglas_peucker_keeps_endpoints_and_drops_collinear_points() {
    let pts = [p(0.0, 0.0), p(100.0, 0.5), p(200.0, 0.0), p(300.0, 0.0)];
    assert_eq!(simplify_polyline(&pts, 2.0), vec![pts[0], pts[3]]);
    let corner = [p(0.0, 0.0), p(100.0, 0.0), p(100.0, 100.0)];
    assert_eq!(simplify_polyline(&corner, 2.0).len(), 3);
}

#[test]
fn removes_a_short_stub_but_keeps_a_protected_terminus_stub() {
    let pts = [p(0.0, 0.0), p(200.0, 0.0), p(200.0, 80.0), p(203.0, 2.0), p(400.0, 0.0)];
    assert_eq!(
        prune_spurs(&pts, &[], 150.0, 10.0),
        vec![pts[0], pts[1], pts[3], pts[4]]
    );
    assert_eq!(prune_spurs(&pts, &[p(200.0, 80.0)], 150.0, 10.0).len(), pts.len());
}

#[test]
fn slices_between_along_distances() {
    let pl = prepare_polyline(&[p(0.0, 0.0), p(300.0, 0.0), p(300.0, 400.0)]).unwrap();
    let part = slice_polyline(&pl, 100.0, 500.0);
    assert_eq!(part.len(), 3);
    assert!(m(part[0], p(100.0, 0.0)) < 0.5);
    assert!(m(part[2], p(300.0, 200.0)) < 0.5);
}
