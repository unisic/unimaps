//! lib/lines.ts, lib/gtfs-trips.ts and lib/stop-directions.ts against the gtfs_tables vectors from
//! scripts/dump-vectors.ts, plus the port of test/stop-directions.test.ts.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{Map, Value};
use unimaps::gtfs_trips::read_gtfs_trips;
use unimaps::js::num_value;
use unimaps::lines::read_lines;
use unimaps::stop_directions::read_stop_directions;

static V: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("vectors/gtfs_tables.json")).unwrap());

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/gtfs");

fn dirs_json(m: &HashMap<String, Vec<f64>>) -> Value {
    let o: Map<String, Value> = m
        .iter()
        .map(|(k, d)| (k.clone(), d.iter().map(|&b| num_value(b)).collect()))
        .collect();
    Value::Object(o)
}

/// Every reader on `dir` against one vector entry; objects compare by key, not order.
fn check(dir: &Path, want: &Value, what: &str) {
    assert_eq!(
        serde_json::to_value(read_lines(dir)).unwrap(),
        want["lines"],
        "{what}: lines"
    );
    assert_eq!(
        serde_json::to_value(read_gtfs_trips(dir)).unwrap(),
        want["trips"],
        "{what}: trips"
    );
    assert_eq!(dirs_json(&read_stop_directions(dir)), want["dirs"], "{what}: dirs");
}

#[test]
fn golden_fixture_feed() {
    let f = &V["fixture"];
    assert!(f["lines"].as_array().unwrap().len() >= 40);
    assert!(f["trips"].as_object().unwrap().len() >= 900);
    assert!(f["dirs"].as_object().unwrap().len() >= 900);
    check(Path::new(FIXTURE), f, "fixture");
}

#[test]
fn golden_crafted_feeds() {
    let feeds = V["feeds"].as_array().unwrap();
    assert_eq!(feeds.len(), 6);
    for (i, feed) in feeds.iter().enumerate() {
        let dir = std::env::temp_dir().join(format!("unimaps-gtfs-tables-{}-{i}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for (name, text) in feed["files"].as_object().unwrap() {
            fs::write(dir.join(name), text.as_str().unwrap()).unwrap();
        }
        check(&dir, feed, &format!("feed {i}"));
        fs::remove_dir_all(&dir).unwrap();
    }
    let hubs = V["feeds"][5]["dirs"].as_object().unwrap();
    let two = hubs
        .iter()
        .filter(|(k, d)| k.starts_with('H') && d.as_array().unwrap().len() == 2)
        .count();
    assert!((40..60).contains(&two), "hubs keep and drop the opposite way: {two}");
}

#[test]
fn missing_feed_is_empty() {
    let dir = PathBuf::from(FIXTURE).join("no-such-dir");
    assert!(read_lines(&dir).is_empty());
    assert!(read_gtfs_trips(&dir).is_empty());
    assert!(read_stop_directions(&dir).is_empty());
}

/// test/stop-directions.test.ts
#[test]
fn road_directions_and_no_station_arrows() {
    let dirs = read_stop_directions(Path::new(FIXTURE));
    assert!(!dirs.is_empty());
    // Bielsko-Biała, Czechowice-Dziedzice, Andrychów and Kęty D.A.
    for id in ["10000", "23000", "50000", "40000"] {
        assert!(!dirs.contains_key(id), "{id} is a bus station");
    }
    for (id, d) in &dirs {
        match d[..] {
            [a, b] => {
                let raw = (a - b).abs() % 360.0;
                let diff = if raw > 180.0 { 360.0 - raw } else { raw };
                assert!(diff >= 100.0, "stop {id} {d:?}: opposite ways along the road");
            }
            [_] => {}
            _ => panic!("stop {id} {d:?}: one or two directions"),
        }
    }
}
