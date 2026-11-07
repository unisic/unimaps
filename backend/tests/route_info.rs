//! Ports of test/route-info.test.ts (minus vehicleExtras, kbNextStopIndex) and test/route-info-continuity.test.ts,
//! plus golden vectors from scripts/dump-vectors.ts.

use serde_json::{Value, json};
use unimaps::js;
use unimaps::mzk_shape::{MzkStopIndices, mzk_remap_dist, mzk_shape_from_course_details, mzk_stop_indices};
use unimaps::route_info::{PrevFix, estimate_fix_at, kb_ahead_m, kb_dist_along, next_speed, sched_speed};
use unimaps::shape_store::{ShapeGeometry, ShapeSrc, finalize_shape};
use unimaps::shared::polyline::{LatLng, decode_polyline, prepare_polyline};

const LAT0: f64 = 49.8;
const LON0: f64 = 19.0;

fn p(east: f64, north: f64) -> LatLng {
    let kx = 111_320.0 * (LAT0 * (std::f64::consts::PI / 180.0)).cos();
    [LAT0 + north / 111_320.0, LON0 + east / kx]
}

fn geom(pts: &[LatLng], stops: &[f64], src: ShapeSrc) -> ShapeGeometry {
    ShapeGeometry {
        pl: prepare_polyline(pts).unwrap(),
        stops: stops.iter().map(|&s| Some(s)).collect(),
        rev: "abcdef".into(),
        src,
    }
}

/// 1 km east, back 10 m north of it; stops 0, 500, 1000 (apex), 1510, 2010
fn out_and_back() -> ShapeGeometry {
    geom(
        &[p(0.0, 0.0), p(1000.0, 0.0), p(1000.0, 10.0), p(0.0, 10.0)],
        &[0.0, 500.0, 1000.0, 1510.0, 2010.0],
        ShapeSrc::Osrm,
    )
}

fn dist(
    g: &ShapeGeometry,
    at: LatLng,
    vti: Option<i64>,
    next: Option<i64>,
    hint: Option<f64>,
    ahead: Option<f64>,
) -> Option<f64> {
    kb_dist_along(g, at[0], at[1], vti, next, hint, ahead)
}

#[track_caller]
fn near(got: Option<f64>, want: f64, tol: f64) {
    assert!(got.is_some_and(|g| (g - want).abs() <= tol), "got {got:?}, want {want}");
}

#[test]
fn estimate_fix_at_cases() {
    let pf = |fix_at, updated_at| Some(PrevFix { fix_at, updated_at });
    assert_eq!(estimate_fix_at(None, 1000.0, true, 30.0), 1000.0);
    assert_eq!(estimate_fix_at(pf(Some(990.0), 1000.0), 1010.0, false, 30.0), 990.0);
    assert_eq!(estimate_fix_at(pf(None, 1000.0), 1010.0, false, 30.0), 1000.0);
    assert_eq!(estimate_fix_at(pf(Some(990.0), 1000.0), 1010.0, true, 30.0), 1005.0);
    // long gaps are capped
    assert_eq!(estimate_fix_at(pf(None, 1000.0), 1300.0, true, 30.0), 1285.0);
}

#[test]
fn next_speed_first_pair_then_smooths() {
    assert_eq!(next_speed(None, Some(120.0), 120.0, 12.0, 0.0, false), Some(10.0));
    let v = next_speed(Some(10.0), Some(120.0), 60.0, 12.0, 0.0, false).unwrap();
    assert!(v < 10.0 && v > 5.0);
}

#[test]
fn next_speed_rejects_non_moving_pairs() {
    let ns = |prev_move: Option<f64>, ds, dt, held, zone| next_speed(Some(10.0), prev_move, ds, dt, held, zone);
    assert_eq!(ns(Some(3.0), 150.0, 12.0, 0.0, false), None); // previous fix was standing
    assert_eq!(ns(Some(120.0), 10.0, 12.0, 0.0, false), None); // creeping
    assert_eq!(ns(Some(120.0), 150.0, 12.0, 40.0, false), None); // prev fix sat still 40 s
    assert_eq!(ns(Some(120.0), 600.0, 10.0, 0.0, false), None); // 60 m/s jump
    assert_eq!(ns(Some(120.0), 150.0, 1.0, 0.0, false), None);
    assert_eq!(ns(Some(120.0), 150.0, 120.0, 0.0, false), None);
    assert_eq!(ns(Some(120.0), 150.0, 12.0, 0.0, true), None); // stop zone
    assert_eq!(next_speed(None, None, 150.0, 12.0, 0.0, false), None); // first-ever fix
}

#[test]
fn next_speed_clamps_to_25() {
    assert_eq!(next_speed(None, Some(100.0), 300.0, 10.0, 0.0, false), Some(25.0));
    // 33 m/s exactly is still a fix (clamped), above it is a GPS jump
    assert_eq!(next_speed(None, Some(100.0), 330.0, 10.0, 0.0, false), Some(25.0));
    assert_eq!(next_speed(None, Some(100.0), 331.0, 10.0, 0.0, false), None);
}

#[test]
fn sched_speed_bounds_and_midnight() {
    let s = |v: &[f64]| v.iter().map(|&x| Some(x)).collect::<Vec<_>>();
    assert_eq!(sched_speed(&s(&[0.0, 3600.0]), &s(&[0.0, 120.0]), 0.0), Some(30.0));
    assert_eq!(sched_speed(&s(&[0.0, 3601.0]), &s(&[0.0, 120.0]), 0.0), None);
    // widened forward onto a stop back at the start: zero pace is no answer
    assert_eq!(sched_speed(&s(&[0.0, 100.0, 0.0]), &s(&[0.0, 60.0, 120.0]), 50.0), None);
    // dt -43201 wraps to +43199, -43200 stays negative
    close(
        sched_speed(&s(&[0.0, 1000.0]), &s(&[80_000.0, 36_799.0]), 0.0),
        1000.0 / 43_199.0,
    );
    assert_eq!(sched_speed(&s(&[0.0, 1000.0]), &s(&[80_000.0, 36_800.0]), 0.0), None);
}

fn opt(v: &[Option<f64>]) -> Vec<Option<f64>> {
    v.to_vec()
}

#[track_caller]
fn close(a: Option<f64>, b: f64) {
    assert!(a.is_some_and(|a| (a - b).abs() < 1e-6), "{a:?} != {b}");
}

#[test]
fn sched_speed_widens_forward_then_backward() {
    let s = |v: &[f64]| v.iter().map(|&x| Some(x)).collect::<Vec<_>>();
    close(
        sched_speed(&s(&[0.0, 500.0, 1000.0, 2000.0]), &s(&[0.0, 60.0, 60.0, 240.0]), 700.0),
        1500.0 / 180.0,
    );
    close(
        sched_speed(
            &s(&[0.0, 500.0, 1000.0, 2000.0]),
            &s(&[0.0, 60.0, 120.0, 150.0]),
            1500.0,
        ),
        2000.0 / 150.0,
    );
    close(
        sched_speed(
            &opt(&[Some(0.0), None, Some(1000.0), Some(1500.0)]),
            &opt(&[Some(0.0), Some(30.0), None, Some(180.0)]),
            200.0,
        ),
        1500.0 / 180.0,
    );
    // crosses midnight
    close(
        sched_speed(&s(&[0.0, 1500.0]), &s(&[86_280.0, 60.0]), 10.0),
        1500.0 / 180.0,
    );
    // outside the trip, too short to widen, absurd pace
    assert_eq!(
        sched_speed(&s(&[0.0, 500.0, 1000.0]), &s(&[0.0, 60.0, 120.0]), -5.0),
        None
    );
    assert_eq!(
        sched_speed(&s(&[0.0, 500.0, 1000.0]), &s(&[0.0, 60.0, 120.0]), 1000.0),
        None
    );
    assert_eq!(sched_speed(&s(&[0.0, 500.0]), &s(&[0.0, 60.0]), 100.0), None);
    assert_eq!(sched_speed(&s(&[0.0, 5000.0]), &s(&[0.0, 120.0]), 100.0), None);
}

#[test]
fn kb_dist_along_uses_upstream_window() {
    let g = out_and_back();
    near(dist(&g, p(300.0, 5.0), Some(0), Some(1), None, None), 300.0, 1.0);
    near(dist(&g, p(300.0, 5.0), Some(3), Some(4), None, None), 1710.0, 1.0);
    assert_eq!(dist(&g, p(300.0, 400.0), Some(0), Some(1), None, None), None);
}

#[test]
fn kb_dist_along_continuity() {
    let g = out_and_back();
    // stale vti before the apex + the hint on the return leg: the return leg stays the return leg
    near(
        dist(&g, p(700.0, 5.0), Some(1), Some(2), Some(1250.0), None),
        1310.0,
        1.0,
    );
    // without the hint: the outbound twin (the documented cold-start ambiguity)
    near(dist(&g, p(700.0, 5.0), Some(1), Some(2), None, None), 700.0, 1.0);
    // beyond the forward window: upstream's window; a wider window accepts it
    near(dist(&g, p(900.0, 5.0), Some(1), Some(2), Some(0.0), None), 900.0, 1.0);
    near(
        dist(&g, p(900.0, 5.0), Some(1), Some(2), Some(0.0), Some(1500.0)),
        900.0,
        1.0,
    );
    // never walks back more than jitter; 200 m back = upstream's window decides
    near(dist(&g, p(290.0, 5.0), Some(0), Some(1), Some(300.0), None), 290.0, 1.0);
    near(dist(&g, p(100.0, 5.0), Some(0), Some(1), Some(300.0), None), 100.0, 1.0);
    // no hint, no vti: strict whole-line search
    assert_eq!(dist(&g, p(300.0, 400.0), None, None, None, None), None);
    near(dist(&g, p(300.0, 5.0), None, None, None, None), 300.0, 1.0);
}

#[test]
fn kb_dist_along_real_u_turn_never_steps_back() {
    let fx: Value = serde_json::from_str(include_str!("../../test/fixtures/route-info-uturn-live.json")).unwrap();
    let pts = decode_polyline(fx["poly"].as_str().unwrap(), 6);
    let stops: Vec<f64> = fx["stops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_f64().unwrap())
        .collect();
    let g = ShapeGeometry {
        rev: "d8b925".into(),
        ..geom(&pts, &stops, ShapeSrc::Osrm)
    };
    let (mut d, mut at): (Option<f64>, Option<f64>) = (None, None);
    let fixes = fx["fixes"].as_array().unwrap();
    assert!(fixes.len() > 10);
    for f in fixes {
        let n = |i: usize| f[i].as_f64().unwrap();
        let fix_at = n(4);
        let ahead = kb_ahead_m(at.map_or(0.0, |a| fix_at - a));
        let got = kb_dist_along(&g, n(0), n(1), Some(n(2) as i64), Some(n(3) as i64), d, Some(ahead))
            .unwrap_or_else(|| panic!("no chainage at {fix_at}"));
        if let Some(prev) = d {
            assert!(got >= prev - 15.0, "{fix_at}: {prev} -> {got}");
        }
        d = Some(got);
        at = Some(fix_at);
    }
}

#[test]
fn kb_ahead_m_cases() {
    for (gap, want) in [
        (0.0, 500.0),
        (12.0, 510.0),
        (30.0, 1050.0),
        (45.0, 1500.0),
        (600.0, 2000.0),
        (-5.0, 500.0),
        (f64::NAN, 500.0),
    ] {
        assert_eq!(kb_ahead_m(gap), want, "{gap}");
    }
}

fn course() -> Value {
    let ll = |q: LatLng| json!({ "latitude": q[0], "longitude": q[1] });
    json!({
        "stopPoints": [ll(p(0.0, 0.0)), ll(p(500.0, 0.0)), ll(p(1000.0, 0.0))],
        "segments": [
            { "nodes": [ll(p(0.0, 0.0)), ll(p(250.0, 30.0)), ll(p(500.0, 0.0))] },
            { "nodes": [ll(p(500.0, 0.0)), ll(p(1000.0, 0.0))] },
        ],
    })
}

#[test]
fn mzk_segment_boundaries_are_stop_distances() {
    let r = mzk_shape_from_course_details(&course()).unwrap();
    assert_eq!(r.pts.len(), 4);
    assert_eq!(r.stops[0], Some(0.0));
    let seg1 = 250f64.hypot(30.0) * 2.0;
    near(r.stops[1], seg1, 1.0);
    near(r.stops[2], seg1 + 500.0, 1.0);
    assert_eq!(mzk_shape_from_course_details(&json!({})), None);
    // stop count off by one: the stops' own coordinates, 80 m off the road at most
    let ll = |q: LatLng| json!({ "latitude": q[0], "longitude": q[1] });
    let r = mzk_shape_from_course_details(&json!({
        "stopPoints": [ll(p(0.0, 0.0)), ll(p(500.0, 79.5)), ll(p(900.0, 80.5))],
        "segments": [{ "nodes": [ll(p(0.0, 0.0)), ll(p(1000.0, 0.0))] }],
    }))
    .unwrap();
    near(r.stops[1], 500.0, 0.5);
    assert_eq!(r.stops[2], None);
}

#[test]
fn mzk_reached_meters_map_piecewise() {
    let stops = [Some(0.0), Some(504.0), Some(1004.0)];
    let seg = [Some(0.0), Some(500.0), Some(500.0)];
    assert_eq!(mzk_remap_dist(250.0, &seg, &stops), Some(252.0));
    assert_eq!(mzk_remap_dist(750.0, &seg, &stops), Some(754.0));
    assert_eq!(mzk_remap_dist(5000.0, &seg, &stops), Some(1004.0));
    assert_eq!(mzk_remap_dist(250.0, &[Some(0.0), None, Some(500.0)], &stops), None);
    // a zero-length operator segment is valid and maps to its start
    let zero = [Some(0.0), Some(0.0), Some(100.0)];
    assert_eq!(
        mzk_remap_dist(0.0, &zero, &[Some(0.0), Some(50.0), Some(150.0)]),
        Some(0.0)
    );
    // exactly on a stop boundary: that stop, before the next (unknown) one is looked at
    assert_eq!(
        mzk_remap_dist(500.0, &seg, &[Some(0.0), Some(504.0), None]),
        Some(504.0)
    );
}

#[test]
fn mzk_stop_indices_cases() {
    let sp = json!([{ "symbol": "a" }, { "symbol": "b" }, { "symbol": "c" }, { "symbol": "d" }]);
    let idx = |served, next| MzkStopIndices { served, next };
    assert_eq!(
        mzk_stop_indices(&json!({ "onStopPoint": "b", "orderInCourse": 1, "stopPoints": sp })),
        idx(Some(1), Some(2))
    );
    assert_eq!(
        mzk_stop_indices(&json!({ "onStopPoint": "c", "orderInCourse": 1, "stopPoints": sp })),
        idx(Some(2), Some(3))
    );
    assert_eq!(
        mzk_stop_indices(&json!({ "orderInCourse": 1, "nearestSymbolOrderNo": 2, "stopPoints": sp })),
        idx(None, Some(2))
    );
    // bogus nearest (behind the bus) is ignored
    assert_eq!(
        mzk_stop_indices(&json!({ "orderInCourse": 2, "nearestSymbolOrderNo": 1, "stopPoints": sp })),
        idx(None, Some(3))
    );
    assert_eq!(
        mzk_stop_indices(&json!({ "orderInCourse": 3, "stopPoints": sp })),
        idx(None, None)
    );
    assert_eq!(mzk_stop_indices(&json!({ "stopPoints": [] })), idx(None, None));
    // false and "" mean "not at a stop", even against a symbol that stringifies the same
    let odd = json!([{ "symbol": "" }, { "symbol": "false" }, { "symbol": "a" }]);
    assert_eq!(
        mzk_stop_indices(&json!({ "onStopPoint": "", "stopPoints": odd })),
        idx(None, Some(1))
    );
    assert_eq!(
        mzk_stop_indices(&json!({ "onStopPoint": false, "stopPoints": odd })),
        idx(None, Some(1))
    );
    assert_eq!(
        mzk_stop_indices(&json!({ "onStopPoint": "false", "stopPoints": odd })),
        idx(Some(1), Some(2))
    );
}

#[test]
fn finalize_shape_smoke() {
    let f = finalize_shape(
        &[p(0.0, 0.0), p(1000.0, 0.0)],
        &[Some(p(0.0, 0.0)), Some(p(500.0, 3.0))],
        ShapeSrc::Osrm,
    )
    .unwrap();
    assert_eq!(f.rev.len(), 6);
    assert_eq!(f.stops[0], Some(0.0));
    near(f.stops[1], 500.0, 0.2);
    assert_eq!(finalize_shape(&[p(0.0, 0.0)], &[], ShapeSrc::Gtfs), None);
}

// golden vectors (scripts/dump-vectors.ts)

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/route_info.json")).unwrap()
}

fn cases<'a>(v: &'a Value, key: &str, min: usize) -> &'a [Value] {
    let c = v[key].as_array().unwrap();
    assert!(c.len() >= min, "{key}: {} cases", c.len());
    c
}

fn of(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn opts(v: &Value) -> Vec<Option<f64>> {
    v.as_array().unwrap().iter().map(Value::as_f64).collect()
}

fn latlng(v: &Value) -> LatLng {
    [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]
}

/// Unrounded floats behind a transcendental (cos, exp): libm and V8 differ in the last bit (see `js.rs`).
#[track_caller]
fn approx(got: Option<f64>, want: Option<f64>, ctx: &dyn std::fmt::Display) -> bool {
    match (got, want) {
        (Some(g), Some(w)) => {
            assert!((g - w).abs() <= 1e-12 * w.abs().max(1.0), "{g} != {w}: {ctx}");
            g != w
        }
        _ => {
            assert_eq!(got, want, "{ctx}");
            false
        }
    }
}

fn pts(v: &Value) -> Vec<LatLng> {
    v.as_array().unwrap().iter().map(latlng).collect()
}

#[test]
fn golden_kb_dist_along() {
    let v = vectors();
    let geoms: Vec<ShapeGeometry> = v["geoms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| ShapeGeometry {
            pl: prepare_polyline(&pts(&g["pts"])).unwrap(),
            stops: opts(&g["stops"]),
            rev: "000000".into(),
            src: serde_json::from_value(g["src"].clone()).unwrap(),
        })
        .collect();
    let mut hits = 0;
    for c in cases(&v, "dist", 3000) {
        let i = &c["in"];
        let g = &geoms[i["g"].as_u64().unwrap() as usize];
        let got = kb_dist_along(
            g,
            of(&i["lat"]).unwrap(),
            of(&i["lon"]).unwrap(),
            i["vti"].as_i64(),
            i["next"].as_i64(),
            of(&i["hint"]),
            of(&i["aheadM"]),
        );
        assert_eq!(got, of(&c["out"]), "{i}");
        hits += got.is_some() as usize;
    }
    assert!(hits > 2000, "{hits}");
}

#[test]
fn golden_sched_speed() {
    let v = vectors();
    for c in cases(&v, "sched", 800) {
        let i = &c["in"];
        assert_eq!(
            sched_speed(&opts(&i["stops"]), &opts(&i["times"]), of(&i["d"]).unwrap()),
            of(&c["out"]),
            "{i}"
        );
    }
}

#[test]
fn golden_next_speed() {
    let v = vectors();
    for c in cases(&v, "speed", 1500) {
        let i = &c["in"];
        let n = |k: &str| of(&i[k]).unwrap();
        let got = next_speed(
            of(&i["prevSpeed"]),
            of(&i["prevMoveDs"]),
            n("ds"),
            n("dt"),
            n("prevHeldSec"),
            i["inStopZone"].as_bool().unwrap(),
        );
        approx(got, of(&c["out"]), i);
        // the wire value (`speed`, 0.1 m/s)
        assert_eq!(got.map(js::round1), of(&c["out"]).map(js::round1), "{i}");
    }
}

#[test]
fn golden_estimate_fix_at() {
    let v = vectors();
    for c in cases(&v, "fix", 300) {
        let i = &c["in"];
        let prev = i.get("prev").map(|p| PrevFix {
            fix_at: of(&p["fixAt"]),
            updated_at: of(&p["updatedAt"]).unwrap(),
        });
        let got = estimate_fix_at(
            prev,
            of(&i["updatedAt"]).unwrap(),
            i["moved"].as_bool().unwrap(),
            of(&i["capSec"]).unwrap(),
        );
        assert_eq!(Some(got), of(&c["out"]), "{i}");
    }
}

#[test]
fn golden_mzk_shapes() {
    let v = vectors();
    for c in cases(&v, "mzkShapes", 150) {
        let got = mzk_shape_from_course_details(&c["in"]);
        match &c["out"] {
            Value::Null => assert_eq!(got, None, "{}", c["in"]),
            o => {
                let got = got.unwrap_or_else(|| panic!("None for {}", c["in"]));
                assert_eq!(got.pts, pts(&o["pts"]));
                let want = opts(&o["stops"]);
                assert_eq!(got.stops.len(), want.len());
                for (g, w) in got.stops.iter().zip(want) {
                    approx(*g, w, &c["in"]);
                }
            }
        }
    }
}

#[test]
fn golden_mzk_remap_and_indices() {
    let v = vectors();
    for c in cases(&v, "remap", 800) {
        let i = &c["in"];
        assert_eq!(
            mzk_remap_dist(of(&i["reached"]).unwrap(), &opts(&i["segDist"]), &opts(&i["stops"])),
            of(&c["out"]),
            "{i}"
        );
    }
    for c in cases(&v, "indices", 1000) {
        let o = &c["out"];
        let idx = |k: &str| o[k].as_u64().map(|x| x as usize);
        assert_eq!(
            mzk_stop_indices(&c["in"]),
            MzkStopIndices {
                served: idx("served"),
                next: idx("next")
            },
            "{}",
            c["in"]
        );
    }
}

#[test]
fn golden_finalize_shape() {
    let v = vectors();
    for c in cases(&v, "finals", 200) {
        let i = &c["in"];
        let refs: Vec<Option<LatLng>> = i["refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (!r.is_null()).then(|| latlng(r)))
            .collect();
        let src: ShapeSrc = serde_json::from_value(i["src"].clone()).unwrap();
        let got = finalize_shape(&pts(&i["pts"]), &refs, src);
        match &c["out"] {
            Value::Null => assert_eq!(got, None),
            o => {
                let got = got.unwrap();
                assert_eq!(got.poly, o["poly"].as_str().unwrap());
                assert_eq!(Some(got.len), of(&o["len"]));
                assert_eq!(got.stops, opts(&o["stops"]));
                assert_eq!(got.rev, o["rev"].as_str().unwrap(), "{}", o["poly"]);
            }
        }
    }
}
