//! Port of test/detours.test.ts and test/shape-patterns.test.ts plus the shape_patterns vectors from
//! scripts/dump-vectors.ts (Number#toFixed, injectDetourPoints, buildKbPattern, readGtfsPatternSeeds).

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use serde_json::{Value, json};
use unimaps::js::{number_to_string, to_fixed};
use unimaps::shape_patterns::{
    GtfsSeed, KbPattern, ResolvedStop, build_kb_pattern, raw_trip_id, read_gtfs_pattern_seeds,
};
use unimaps::shared::detours::{adjust_stop_route_point, get_line_detour, inject_detour_points};
use unimaps::shared::polyline::LatLng;

static V: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("vectors/shape_patterns.json")).unwrap());

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn pt(v: &Value) -> Option<LatLng> {
    Some([v[0].as_f64()?, v[1].as_f64()?])
}

fn pts(v: &Value) -> Vec<LatLng> {
    arr(v).iter().map(|p| pt(p).unwrap()).collect()
}

fn inject(points: &[LatLng], line: &str, dir: Option<&str>) -> (Vec<LatLng>, Option<&'static str>) {
    let (out, d) = inject_detour_points(points, Some(line), dir);
    (out.unwrap_or_else(|| points.to_vec()), d.map(|d| d.id.as_str()))
}

fn detour_id(line: &str) -> Option<&'static str> {
    get_line_detour(line, None).map(|d| d.id.as_str())
}

#[test]
fn get_line_detour_matches_the_listed_lines() {
    assert_eq!(detour_id("121"), Some("bielsko-piastowska"));
    assert_eq!(detour_id("134"), Some("bielsko-piastowska"));
    assert_eq!(detour_id("141"), Some("osiek-beskidzka"));
    assert_eq!(detour_id("999"), None);
    assert_eq!(detour_id(""), None);
}

#[test]
fn injects_waypoints_where_the_trip_crosses_the_area() {
    let p = [[49.827, 19.049], [49.823, 19.040], [49.818, 19.025]];
    let (out, d) = inject(&p, "121", Some("Hulanka"));
    assert!(d.is_some());
    assert!(out.len() > p.len());
    assert!(out.iter().any(|q| (q[0] - 49.823333).abs() < 1e-4));
}

#[test]
fn keeps_every_stop_of_the_134_loop() {
    let p = [
        [49.8302, 19.0427],
        [49.8272, 19.0391],
        [49.8233, 19.0344],
        [49.8200, 19.0291],
        [49.8145, 19.0185],
        [49.8000, 18.9000],
        [49.8142, 19.0180],
        [49.8302, 19.0427],
    ];
    let (out, d) = inject(&p, "134", Some("Grodziec Zagóra"));
    assert_eq!(d, Some("bielsko-piastowska"));
    assert_eq!(out.len(), p.len());
    assert!(out.iter().any(|q| (q[0] - 49.8).abs() < 1e-4));
}

#[test]
fn one_way_detour_leaves_the_reverse_direction_alone() {
    let p = [[49.8145, 19.0185], [49.825851, 19.032577], [49.830227, 19.042746]];
    assert_eq!(inject(&p, "121", Some("BIELSKO-BIAŁA D.A.")), (p.to_vec(), None));
}

#[test]
fn a_single_stop_inside_the_area_is_no_spur() {
    let p = [[49.92, 19.23], [49.965, 19.245], [49.98, 19.3]];
    assert_eq!(inject(&p, "141", None), (p.to_vec(), None));
}

#[test]
fn a_line_without_detour_keeps_its_points() {
    let p = [[49.827, 19.049], [49.818, 19.025]];
    assert_eq!(inject(&p, "999", None), (p.to_vec(), None));
}

#[test]
fn adjust_stop_route_point_moves_only_mapped_poles() {
    assert_eq!(
        adjust_stop_route_point(Some("21181"), [49.702919, 19.001412]),
        [49.70298, 19.00137]
    );
    assert_eq!(adjust_stop_route_point(Some("99999"), [49.8, 19.0]), [49.8, 19.0]);
}

static STOPS: LazyLock<HashMap<u32, ResolvedStop>> = LazyLock::new(|| {
    [
        (1, 49.8, 19.0),
        (2, 49.81, 19.01),
        (3, 49.82, 19.02),
        (21181, 49.703, 19.002),
        // inside the Piastowska detour trigger area
        (10, 49.82, 19.035),
        (11, 49.83, 19.05),
    ]
    .into_iter()
    .map(|(id, lat, lon)| {
        (
            id,
            ResolvedStop {
                id: id.to_string(),
                lat,
                lon,
            },
        )
    })
    .collect()
});

fn resolve(t: &Value) -> Option<ResolvedStop> {
    STOPS.get(&u32::try_from(t.get("designator")?.as_u64()?).ok()?).cloned()
}

fn times(ds: &[Option<u32>]) -> Vec<Value> {
    ds.iter()
        .map(|d| d.map_or_else(|| json!({}), |d| json!({ "designator": d })))
        .collect()
}

fn pattern(ds: &[Option<u32>], line: &str, dir: &str) -> Option<KbPattern> {
    build_kb_pattern(&times(ds), line, dir, resolve)
}

#[test]
fn build_kb_pattern_is_stable_with_one_slot_per_entry() {
    let a = pattern(&[Some(1), Some(2), Some(3)], "103", "X").unwrap();
    let b = pattern(&[Some(1), Some(2), Some(3)], "103", "X").unwrap();
    let hex = a.key.strip_prefix("kb:").unwrap();
    assert!(hex.len() == 12 && hex.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_eq!((&a.key, &a.wp_sig), (&b.key, &b.wp_sig));
    assert_eq!(a.stop_pts.len(), 3);
}

#[test]
fn unresolved_entries_are_empty_slots_and_change_the_key() {
    let p = pattern(&[Some(1), None, Some(3)], "103", "X").unwrap();
    assert_eq!(p.stop_pts[1], None);
    assert_eq!(p.waypoints.len(), 2);
    assert_ne!(p.key, pattern(&[Some(1), Some(2), Some(3)], "103", "X").unwrap().key);
}

#[test]
fn lines_on_the_same_stops_share_a_key_unless_a_detour_applies() {
    let plain = pattern(&[Some(1), Some(2), Some(3)], "103", "X").unwrap();
    assert_eq!(
        plain.key,
        pattern(&[Some(1), Some(2), Some(3)], "999", "Y").unwrap().key
    );
    let via_area = pattern(&[Some(11), Some(10), Some(1)], "999", "Y").unwrap();
    let detoured = pattern(&[Some(11), Some(10), Some(1)], "121", "HULANKA").unwrap();
    assert_ne!(via_area.key, detoured.key);
    assert!(detoured.waypoints.len() > via_area.waypoints.len());
}

#[test]
fn stop_pole_adjustments_touch_waypoints_only() {
    let p = pattern(&[Some(1), Some(21181)], "999", "").unwrap();
    assert_eq!(p.stop_pts[1], Some([49.703, 19.002]));
    assert_eq!(p.waypoints[1], [49.70298, 19.00137]);
}

#[test]
fn fewer_than_two_resolved_stops_is_no_pattern() {
    assert_eq!(pattern(&[Some(1), None], "1", ""), None);
}

fn seed_json(s: &GtfsSeed) -> String {
    json!({ "rawTripIds": s.raw_trip_ids, "line": s.line, "dir": s.dir, "times": s.times }).to_string()
}

fn fixture_dir() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/gtfs"))
}

#[test]
fn read_gtfs_pattern_seeds_groups_the_fixture_feed() {
    let seeds = read_gtfs_pattern_seeds(fixture_dir());
    assert!(!seeds.is_empty());
    assert!(seeds.iter().all(|s| !s.raw_trip_ids.is_empty() && !s.times.is_empty()));
    let mut all: Vec<&String> = seeds.iter().flat_map(|s| &s.raw_trip_ids).collect();
    let n = all.len();
    all.sort();
    all.dedup();
    assert_eq!(all.len(), n);
    assert!(read_gtfs_pattern_seeds(Path::new("/nonexistent/dir")).is_empty());
}

#[test]
fn raw_trip_id_strips_the_service_suffix() {
    assert_eq!(raw_trip_id("35678182_KB_SATURDAY"), "35678182");
    assert_eq!(raw_trip_id("35678182"), "35678182");
}

#[test]
fn to_fixed_breaks_ties_away_from_zero_like_js() {
    assert_eq!(to_fixed(2.5, 0), "3");
    assert_eq!(to_fixed(-2.5, 0), "-3");
    assert_eq!(to_fixed(-9.5, 0), "-10");
    assert_eq!(to_fixed(49.015625, 5), "49.01563");
    assert_eq!(to_fixed(1.005, 2), "1.00");
    assert_eq!(to_fixed(-0.0, 5), "0.00000");
    assert_eq!(to_fixed(-0.000001, 2), "-0.00");
    assert_eq!(to_fixed(-0.4, 0), "-0");
    assert_eq!(to_fixed(1e21, 2), "1e+21");
    assert_eq!(to_fixed(f64::NAN, 2), "NaN");
    assert_eq!(to_fixed(f64::NEG_INFINITY, 2), "-Infinity");
    assert_eq!(to_fixed(5e-324, 2), "0.00");
}

#[test]
fn golden_to_fixed() {
    let cases = arr(&V["fixed"]);
    assert!(cases.len() >= 700);
    for c in cases {
        let (x, d) = (c[0].as_f64().unwrap(), c[1].as_u64().unwrap() as usize);
        assert_eq!(to_fixed(x, d), c[2].as_str().unwrap(), "{x}.toFixed({d})");
    }
}

#[test]
fn golden_inject_detour_points() {
    let cases = arr(&V["detours"]);
    let (mut new, mut same) = (0, 0);
    for c in cases {
        let points = pts(&c["points"]);
        let (out, d) = inject_detour_points(&points, c["line"].as_str(), c["dir"].as_str());
        let want = (!c["out"].is_null()).then(|| pts(&c["out"]));
        assert_eq!(out, want, "{c}");
        assert_eq!(d.map(|d| d.id.as_str()), c["id"].as_str(), "{c}");
        match (&want, d) {
            (Some(_), _) => new += 1,
            (None, Some(_)) => same += 1,
            _ => {}
        }
    }
    assert!(
        new >= 10 && same >= 5,
        "vectors must cover both outcomes: {new} new, {same} banner-only"
    );
    for c in arr(&V["adjust"]) {
        assert_eq!(Some(adjust_stop_route_point(c[0].as_str(), [49.8, 19.0])), pt(&c[1]));
    }
}

#[test]
fn golden_build_kb_pattern() {
    let stops: HashMap<&str, ResolvedStop> = V["stops"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, s)| {
            let r = ResolvedStop {
                id: s["id"].as_str().unwrap().into(),
                lat: s["lat"].as_f64().unwrap(),
                lon: s["lon"].as_f64().unwrap(),
            };
            (k.as_str(), r)
        })
        .collect();
    let resolve = |t: &Value| {
        let d = t.get("designator")?.as_f64()?;
        stops.get(number_to_string(d).as_str()).cloned()
    };
    let mut built = 0;
    for c in arr(&V["patterns"]) {
        let (line, dir) = (c["line"].as_str().unwrap(), c["dir"].as_str().unwrap());
        let got = build_kb_pattern(arr(&c["times"]), line, dir, resolve);
        let o = &c["out"];
        let Some(p) = got else {
            assert!(o.is_null(), "{c}");
            continue;
        };
        built += 1;
        assert_eq!(p.key, o["key"].as_str().unwrap(), "{c}");
        assert_eq!(p.wp_sig, o["wpSig"].as_str().unwrap(), "{c}");
        assert_eq!(p.stop_pts, arr(&o["stopPts"]).iter().map(pt).collect::<Vec<_>>(), "{c}");
        assert_eq!(p.waypoints, pts(&o["waypoints"]), "{c}");
        assert_eq!(
            (p.line.as_str(), p.dir.as_str()),
            (o["line"].as_str().unwrap(), o["dir"].as_str().unwrap())
        );
    }
    assert!(built >= 100);
}

#[test]
fn golden_read_gtfs_pattern_seeds() {
    let dir = std::env::temp_dir().join(format!("unimaps-seeds-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    for (name, text) in V["feed"].as_object().unwrap() {
        fs::write(dir.join(name), text.as_str().unwrap()).unwrap();
    }
    let crafted = read_gtfs_pattern_seeds(&dir);
    fs::remove_dir_all(&dir).unwrap();
    for (seeds, want) in [
        (crafted, &V["crafted"]),
        (read_gtfs_pattern_seeds(fixture_dir()), &V["fixture"]),
    ] {
        let want: Vec<String> = arr(want).iter().map(Value::to_string).collect();
        assert_eq!(seeds.iter().map(seed_json).collect::<Vec<_>>(), want);
    }
    for c in arr(&V["raw"]) {
        assert_eq!(raw_trip_id(c[0].as_str().unwrap()), c[1].as_str().unwrap());
    }
}
