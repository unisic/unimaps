//! test/trip-progress.test.ts: the fixture sanity check and the server chain (kbDistAlong with the previous poll's
//! dist_m as hint) over the real line-120 loop capture. stopAlongFor, stopsAtChainage and progressFromVehicle are
//! client code (lib/shared/trip-progress.ts) with no server counterpart: their own cases are not ported.

#[path = "support/trip_progress.rs"]
mod trip_progress;

use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::Value;
use trip_progress::stops_at_chainage;
use unimaps::poller::kb_next_stop_index;
use unimaps::route_info::{kb_ahead_m, kb_dist_along};
use unimaps::shape_store::{ShapeGeometry, ShapeSrc};
use unimaps::shared::polyline::{LatLng, decode_polyline, prepare_polyline, project_stops_along};

#[derive(Deserialize)]
struct Snap {
    t: i64,
    lat: f64,
    lon: f64,
    vti: i64,
    ndi: i64,
    at: bool,
}

#[derive(Deserialize)]
struct FxStop {
    lat: f64,
    lon: f64,
}

#[derive(Deserialize)]
struct Fixture {
    polyline: String,
    stops: Vec<FxStop>,
    snapshots: Vec<Snap>,
}

struct Setup {
    fx: Fixture,
    along: Vec<Option<f64>>,
    sg: ShapeGeometry,
}

static SETUP: LazyLock<Setup> = LazyLock::new(|| {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/line120-loop-capture.json"
    );
    let fx: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let pl = prepare_polyline(&decode_polyline(&fx.polyline, 6)).unwrap();
    let stop_pts: Vec<Option<LatLng>> = fx.stops.iter().map(|s| Some([s.lat, s.lon])).collect();
    let along = project_stops_along(&pl, &stop_pts, 80.0);
    let sg = ShapeGeometry {
        pl,
        stops: along.clone(),
        rev: "000000".into(),
        src: ShapeSrc::Osrm,
    };
    Setup { fx, along, sg }
});

/* fixture sanity */

#[test]
fn the_loop_s_twin_stops_are_14_49_m_apart_but_0_9_2_8_km_apart_along_the_route() {
    let st = &*SETUP;
    // `along[i]!` in arithmetic: null coerces to 0
    let along = |i: usize| st.along[i].unwrap_or(0.0);
    for (a, b) in [(20, 27), (21, 26), (22, 25)] {
        let d_lat = (st.fx.stops[a].lat - st.fx.stops[b].lat) * 111_320.0;
        let d_lon =
            (st.fx.stops[a].lon - st.fx.stops[b].lon) * 111_320.0 * (49.72 * std::f64::consts::PI / 180.0).cos();
        assert!(d_lat.hypot(d_lon) < 50.0);
        assert!(along(b) - along(a) > 900.0);
    }
}

/* server chain (kbDistAlong with the previous poll's dist_m as hint + stopsAtChainage), real line-120 capture */

/// what attachRouteInfo does per poll; `freeze_at` = upstream's index sticks there once the bus reaches it (a pole
/// passed outside its geofence)
fn replay(freeze_at: Option<i64>) -> Vec<String> {
    let st = &*SETUP;
    let n = st.fx.stops.len();
    let mut hint: Option<f64> = None;
    let mut prev_t: Option<i64> = None;
    let mut bad = Vec::new();
    for s in &st.fx.snapshots {
        let frozen = freeze_at.filter(|&f| s.vti >= f);
        let vti = frozen.unwrap_or(s.vti);
        let at = frozen.is_none() && s.at;
        let ndi = frozen.map_or(s.ndi, |f| f + 1);
        let gap_s = prev_t.map_or(0.0, |p| (s.t - p) as f64 / 1000.0);
        prev_t = Some(s.t);
        let when = jiff::Timestamp::from_millisecond(s.t)
            .map(|t| t.to_string())
            .unwrap_or_default();
        let next = kb_next_stop_index(Some(&Value::from(vti)), Some(&Value::from(ndi)), at, n);
        let Some(d) = kb_dist_along(&st.sg, s.lat, s.lon, Some(vti), next, hint, Some(kb_ahead_m(gap_s))) else {
            bad.push(format!("{when} dist_m null"));
            continue;
        };
        hint = Some(d);
        let r = stops_at_chainage(&st.along, d, vti, at);
        // what upstream really said; while at a stop the next stop is an equally valid reading (the bus is leaving)
        let exp = if s.at {
            (s.vti, true)
        } else {
            ((s.vti + 1).min(n as i64 - 1), false)
        };
        let ok = r.is_some_and(|(i, _)| {
            let i = i as i64;
            i == exp.0 || (exp.1 && i == exp.0 + 1)
        });
        if !ok {
            let got = r.map_or("undefined".to_string(), |(i, at)| {
                format!("{i}{}", if at { "@" } else { "" })
            });
            bad.push(format!(
                "{when} upstream {}{} (sent {vti}) -> {got}",
                s.vti,
                if s.at { "@" } else { "" }
            ));
        }
    }
    bad
}

#[test]
fn upstream_right_the_live_case_index_upstream_s_at_every_snapshot_incl_both_twin_legs() {
    assert_eq!(replay(None), Vec::<String>::new());
}

macro_rules! frozen_at {
    ($($name:ident: $k:expr),* $(,)?) => {$(
        #[test]
        fn $name() {
            assert_eq!(replay(Some($k)), Vec::<String>::new());
        }
    )*};
}

frozen_at! {
    upstream_index_frozen_at_17_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 17,
    upstream_index_frozen_at_19_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 19,
    upstream_index_frozen_at_20_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 20,
    upstream_index_frozen_at_21_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 21,
    upstream_index_frozen_at_22_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 22,
    upstream_index_frozen_at_23_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 23,
    upstream_index_frozen_at_24_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 24,
    upstream_index_frozen_at_25_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 25,
    upstream_index_frozen_at_26_the_next_pole_was_passed_outside_the_geofence_the_return_leg_is_still_counted: 26,
}
