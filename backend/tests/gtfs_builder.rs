//! test/gtfs-builder.test.ts: the service-date sampling and the publish / keep-the-old-feed paths of
//! src/gtfs_builder.rs. The KB source is a fake: no upstream is ever contacted.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use unimaps::gtfs_builder::{BuildGtfsOptions, ServiceDates, build_gtfs, get_service_dates};
use unimaps::kb_api::KbSource;
use unimaps::types::{Stop, Trip, TripStop};

fn stop(internal_id: i64, url_id: &str, lat: f64) -> Stop {
    Stop {
        url_id: url_id.into(),
        internal_id,
        name: format!("STOP {internal_id}"),
        lat,
        lon: 19.0,
        stop_id: internal_id.to_string(),
        ..Stop::default()
    }
}

fn trip_stop(name: &str, designator: i64, place_id: &str, departure_time: &str, index: i64) -> TripStop {
    TripStop {
        stop_name: name.into(),
        designator: Some(designator),
        place_id: Some(place_id.into()),
        departure_time: departure_time.into(),
        index,
        platform: None,
    }
}

fn trip() -> Trip {
    Trip {
        trip_id: "t1".into(),
        direction: "STOP 2".into(),
        line_name: "120".into(),
        line_type: None,
        show_name: true,
        vehicle_type: None,
        current_station_id: None,
        times: vec![
            trip_stop("STOP 1", 1, "u1", "08:00", 0),
            trip_stop("STOP 2", 2, "u2", "08:10", 1),
        ],
    }
}

/// The upstream calls of the TS FakeKbApi; a timetable of a stop in `failing` fails as "HTTP 503".
struct FakeKb {
    failing: HashSet<String>,
}

impl FakeKb {
    fn new(failing: &[&str]) -> Self {
        Self {
            failing: failing.iter().map(|s| (*s).to_owned()).collect(),
        }
    }
}

impl KbSource for FakeKb {
    async fn fetch_revision(&self) -> String {
        "1".into()
    }

    async fn fetch_stops(&self, _revision: Option<&str>) -> Result<Vec<Stop>, String> {
        Ok(vec![stop(1, "u1", 49.8), stop(2, "u2", 49.81)])
    }

    async fn fetch_multiple_departures(&self, _stop_url_ids: &[String]) -> Result<Value, String> {
        Err("not used".into())
    }

    async fn fetch_trip_execution(&self, _trip_execution_id: &str, _index: i64) -> Result<Value, String> {
        Err("not used".into())
    }

    async fn fetch_timetable(&self, stop_url_id: &str, _date: &str) -> Result<Arc<Value>, String> {
        if self.failing.contains(stop_url_id) {
            return Err("HTTP 503".into());
        }
        Ok(Arc::new(json!({ "departures": [{ "trip_id": "t1" }] })))
    }

    async fn fetch_trip(&self, _trip_id: &str, _index: i64) -> Result<Option<Trip>, String> {
        Ok(Some(trip()))
    }
}

/// The TS `ROOT` mkdtemp, removed when the test ends (also on a failed assertion).
struct TempRoot(PathBuf);

impl TempRoot {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("kb-gtfs-builder-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn read(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap()
}

fn dir_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn opts(date: &str, out_dir: PathBuf) -> BuildGtfsOptions {
    BuildGtfsOptions {
        date: date.into(),
        out_dir,
        zip: false,
        full_schedule: true,
    }
}

fn dates(weekday: &str, saturday: &str, sunday: &str) -> ServiceDates {
    ServiceDates {
        weekday_date: weekday.into(),
        saturday_date: saturday.into(),
        sunday_date: sunday.into(),
    }
}

#[test]
fn samples_the_weekday_service_from_today_on_mon_fri_never_a_past_monday() {
    assert_eq!(
        get_service_dates("2026-10-22").unwrap(),
        dates("2026-10-22", "2026-10-24", "2026-10-25")
    );
    assert_eq!(get_service_dates("2026-10-19").unwrap().weekday_date, "2026-10-19");
    assert_eq!(
        get_service_dates("2026-10-24").unwrap(),
        dates("2026-10-26", "2026-10-24", "2026-10-25")
    );
    assert_eq!(
        get_service_dates("2026-10-25").unwrap(),
        dates("2026-10-26", "2026-10-31", "2026-10-25")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn publishes_a_feed_whose_calendar_is_valid_from_the_build_date_on_with_no_temp_dir_left_behind() {
    let root = TempRoot::new("ok");
    let out = root.0.join("ok").join("gtfs");
    build_gtfs(&FakeKb::new(&[]), &opts("2026-12-30", out.clone()))
        .await
        .unwrap();
    assert!(read(&out, "trips.txt").contains(",t1_KB_WEEKDAY,"));
    let calendar = read(&out, "calendar.txt");
    let cal = calendar.trim().split('\n').nth(1).unwrap();
    let cols: Vec<&str> = cal.split(',').collect();
    let &[.., start, end] = cols.as_slice() else {
        panic!("calendar row {cal} has fewer than 2 columns");
    };
    assert_eq!(start, "20261230");
    assert!(end > "20270101", "calendar end {end} must lie past the year boundary");
    let feed_info = read(&out, "feed_info.txt");
    let info: Vec<&str> = feed_info.trim().split('\n').nth(1).unwrap().split(',').collect();
    assert_eq!(info[3], "20261230");
    assert_eq!(info[4], end);
    assert_eq!(dir_names(out.parent().unwrap()), ["gtfs"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_published_feed_when_upstream_failed_for_many_timetables() {
    let root = TempRoot::new("fail");
    let out = root.0.join("fail").join("gtfs");
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("trips.txt"), "the old feed\n").unwrap();
    assert!(
        build_gtfs(&FakeKb::new(&["u1"]), &opts("2026-10-22", out.clone()))
            .await
            .is_err()
    );
    assert_eq!(read(&out, "trips.txt"), "the old feed\n");
    assert_eq!(dir_names(out.parent().unwrap()), ["gtfs"]);
}
