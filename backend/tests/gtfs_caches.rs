//! Port of test/gtfs-caches.test.ts and test/gtfs-no-feed.test.ts: the cached readers of KB_GTFS_DIR are empty
//! without a feed and see a new one after their invalidation. Alone in its binary: it sets the environment.

use std::fs;

use unimaps::gtfs_trips::{gtfs_trip_meta, invalidate_gtfs_trips};
use unimaps::lines::{get_lines, invalidate_lines};
use unimaps::stop_directions::{get_stop_directions, invalidate_stop_directions};

#[test]
fn caches_are_empty_without_a_feed_and_refresh_on_invalidation() {
    let dir = std::env::temp_dir().join(format!("unimaps-gtfs-caches-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // SAFETY: the only test in this binary, set before anything reads the environment
    unsafe { std::env::set_var("KB_GTFS_DIR", &dir) };

    // a route reads before the first build finished: empty everywhere
    assert!(get_lines().is_empty());
    assert_eq!(gtfs_trip_meta("t1"), None);
    assert!(get_stop_directions().is_empty());

    let write = |name: &str, text: &str| fs::write(dir.join(name), text).unwrap();
    write("routes.txt", "route_id,route_short_name,route_long_name\nL_1,1,A\n");
    write(
        "trips.txt",
        "route_id,service_id,trip_id,trip_headsign,trip_short_name\nL_1,S,t1,A,1\n",
    );
    write(
        "stops.txt",
        "stop_id,stop_name,stop_lat,stop_lon\n1,X,49.80,19.00\n2,Y,49.81,19.00\n",
    );
    write("stop_times.txt", "trip_id,stop_id,stop_sequence\nt1,1,0\nt1,2,1\n");
    // still the cached empty answers until a rebuild invalidates them
    assert!(get_lines().is_empty());
    invalidate_lines();
    invalidate_gtfs_trips();
    invalidate_stop_directions();

    assert_eq!(get_lines().len(), 1);
    assert_eq!(gtfs_trip_meta("t1").map(|m| m.line), Some("1".into()));
    assert_eq!(get_stop_directions().get("1"), Some(&vec![0.0]));
    fs::remove_dir_all(&dir).unwrap();
}
