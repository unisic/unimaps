//! Walking transfers timed along an installed footpath graph (its own test binary: the graph is process-wide).

use std::collections::HashMap;

use indexmap::IndexMap;
use unimaps::footpaths::{FootGraph, install};
use unimaps::router::{RouterInput, RouterStopInput, build_router_index};

/// metres east / north of 50.25 N 19.0 E
fn p(east: f64, north: f64) -> (f64, f64) {
    (
        50.25 + north / 111_320.0,
        19.0 + east / (111_320.0 * 50.25f64.to_radians().cos()),
    )
}

#[test]
fn transfers_follow_the_footpaths_and_fall_back_off_them() {
    // round three sides of a 100 m block, then a 10 km street so it is no island
    let coords = [
        p(0.0, 0.0),
        p(0.0, 100.0),
        p(100.0, 100.0),
        p(100.0, 0.0),
        p(10_100.0, 0.0),
    ];
    let coords = coords.iter().map(|&(lat, lon)| (lat as f32, lon as f32)).collect();
    assert!(install(FootGraph::build(coords, &[0, 1, 2, 3, 4], &[5], |_| true)));
    let stop = |id: &str, (lat, lon): (f64, f64)| RouterStopInput {
        id: id.into(),
        name: id.into(),
        lat,
        lon,
        key: None,
    };
    let idx = build_router_index(RouterInput {
        stops: vec![
            stop("A", p(0.0, -5.0)),
            stop("B", p(100.0, -5.0)),
            stop("C", p(-150.0, -250.0)),
        ],
        trips: IndexMap::new(),
        services: HashMap::new(),
        mzk_day_types: HashMap::new(),
    });
    let n = |id: &str| idx.stop_num[id];
    let secs = |a: &str, b: &str| idx.foot_of(n(a)).find(|f| f.0 == n(b)).map(|f| f.1);
    // 310 m along the path at 1.3 m/s, not 100 m straight (2 min)
    assert_eq!(secs("A", "B"), Some(240));
    assert_eq!(secs("B", "A"), Some(240));
    // C stands 290 m off the network: straight line, 287 m at 1.1 m/s
    assert_eq!(secs("A", "C"), Some(300));
}
