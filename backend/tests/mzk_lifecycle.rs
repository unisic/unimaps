//! Port of test/mzk-lifecycle-integration.test.ts: MzkPoller + fleet tracker on REAL OnTime records (22:54:42
//! snapshot of getRunningVehicles.json, test/fixtures/mzk-running-vehicles.json): a bus waiting at the first stop
//! must not publish OnTime's placeholder delay anywhere. The buildMzkTimes cases wait for lib/mzk-trip.ts.

use std::sync::{Arc, LazyLock};

use serde_json::{Value, json};
use unimaps::fleet_tracker::{FleetSummaryFilter, FleetTracker, FleetTrackerOptions};
use unimaps::js;
use unimaps::mzk_api::{MzkLine, MzkRunningVehicle, MzkSource, MzkStopPoint};
use unimaps::mzk_poller::{MzkPoller, mzk_fleet_input};
use unimaps::route_info::vehicle_extras;
use unimaps::shared::fleet::VehicleStatus;
use unimaps::vehicle::{VehiclePos, vehicle_to_json};

static FX: LazyLock<Value> = LazyLock::new(|| {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/mzk-running-vehicles.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
});

/// `V.<name>`
fn v(name: &str) -> Value {
    FX["vehicles"][name].clone()
}

fn f(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap()
}

/// The TS `fakeApi(running)`: the methods MzkPoller calls.
struct FakeApi {
    running: Vec<MzkRunningVehicle>,
}

impl MzkSource for FakeApi {
    async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
        Ok(self.running.clone())
    }

    async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }

    async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
        Ok(serde_json::from_value(FX["stopPoints"].clone()).unwrap())
    }

    async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
        Ok(vec![MzkLine {
            id: 1.0,
            name: "10".into(),
            long_name: None,
            night_line: false,
            line_type: "BUS".into(),
        }])
    }
}

// describe("fixture sanity (real OnTime placeholder)")

#[test]
fn every_stop_of_a_not_started_course_carries_scheduled_plus_delay_sec() {
    for v in [v("not_started_late"), v("not_started_early")] {
        for sp in v["stopPoints"].as_array().unwrap() {
            // delaySec is whole seconds, plannedDeparture carries milliseconds
            let off = (f(sp, "plannedDeparture") - f(sp, "scheduledDeparture")) / 1000.0 - f(&v, "delaySec");
            assert!(off.abs() < 2.0, "{}", v["vehicleId"]);
        }
    }
    assert_eq!(f(&v("not_started_early"), "delaySec"), -60.0); // the floor
    assert!(f(&v("not_started_late"), "delaySec") > 0.0);
}

// describe("MzkPoller")

#[tokio::test]
async fn publishes_delay_null_plus_not_started_for_buses_waiting_at_the_first_stop_real_delay_otherwise() {
    let names = ["not_started_late", "not_started_early", "just_departed", "running"];
    let poller = Arc::new(
        MzkPoller::new(FakeApi {
            running: names.iter().map(|n| v(n)).collect(),
        })
        .with_stop_dirs_file(None),
    );
    poller.poll_once().await.unwrap();
    let positions = Arc::clone(&poller.state().positions);
    let get = |name: &str| -> Arc<VehiclePos> {
        let rec = v(name);
        let key = format!("mzk:{}:{}", rec["courseLoid"], rec["vehicleId"].as_str().unwrap());
        Arc::clone(positions.get(&key).unwrap_or_else(|| panic!("{key} missing")))
    };

    for name in ["not_started_late", "not_started_early"] {
        let p = get(name);
        assert!(p.not_started, "{name}");
        assert_eq!(p.delay, None, "{name}");
        assert_eq!(p.current_stop_sequence, Some(0));
    }
    assert!(!get("just_departed").not_started);
    assert_eq!(
        get("just_departed").delay,
        Some(js::round(f(&v("just_departed"), "delaySec")))
    );
    assert!(!get("running").not_started);
    assert_eq!(get("running").delay, Some(js::round(f(&v("running"), "delaySec"))));

    // wire: vehicleToJson (Python port) untouched -> delay null; the flag rides on vehicleExtras
    let p = get("not_started_late");
    assert_eq!(vehicle_to_json(&p).get("delay"), Some(&Value::Null));
    assert_eq!(vehicle_extras(&p, None, 0.0).get("not_started"), Some(&json!(true)));
    assert_eq!(vehicle_extras(&get("running"), None, 0.0).get("not_started"), None);
}

// describe("FleetTracker (brygady)")

/// `new FleetTracker()`; the TS points its history at a throw-away dir, so nothing is restored or kept.
fn tracker() -> FleetTracker {
    FleetTracker::new(FleetTrackerOptions {
        history_dir: None,
        ..FleetTrackerOptions::default()
    })
}

/// `t.updateFromRunningVehicles([asRunning(rec)])`, the record read the way the MZK poller feeds the tracker
fn update(t: &FleetTracker, rec: &Value) {
    t.update_from_running_vehicles(&[mzk_fleet_input(rec)], None, None);
}

/// `{ ...structuredClone(base), ...over }`
fn with(base: &Value, over: Value) -> Value {
    let mut out = base.clone();
    if let (Some(o), Value::Object(over)) = (out.as_object_mut(), over) {
        o.extend(over);
    }
    out
}

#[test]
fn a_not_started_course_shows_no_delay_is_not_counted_in_punctuality_and_is_not_archived_as_history() {
    let t = tracker();
    let late = with(&v("not_started_late"), json!({ "delaySec": 14 * 60 })); // the +14 min of screenshot B
    let side = late["vehicleId"].as_str().unwrap();
    update(&t, &late);
    let d = t.get_vehicle_detail(side).unwrap();
    let cur = d.current_course.as_ref().unwrap();
    assert_eq!(cur.not_started, Some(true));
    assert_eq!(cur.delay_sec, 0);
    assert_eq!(cur.current_stop_index, 0);
    assert!(
        cur.stops
            .as_ref()
            .unwrap()
            .iter()
            .all(|s| s.planned_time == s.scheduled_time)
    );
    let active = FleetSummaryFilter {
        status: Some(VehicleStatus::Active),
        ..FleetSummaryFilter::default()
    };
    let summary = t.get_fleet_summary(&active);
    let item = summary.iter().find(|x| x.side_number == side).unwrap();
    assert_eq!(item.delay_sec, None);
    assert_eq!(item.not_started, Some(true));
    assert_eq!(t.get_stats().on_time_percentage, 100); // nobody counted -> neutral, not "0 % punctual"
    assert_eq!(t.get_stats().average_delay_sec, 0);
    assert_eq!(t.get_stats().active_count, 1);

    // the bus is reassigned before it ever starts: that course must not become a "completed" history row
    let next = with(&v("running"), json!({ "vehicleId": side, "courseLoid": 999_001 }));
    update(&t, &next);
    let loid = late["courseLoid"].as_i64();
    assert!(
        !t.get_vehicle_detail(side)
            .unwrap()
            .today_courses
            .iter()
            .any(|c| c.course_loid == loid)
    );
}

#[test]
fn a_running_vehicle_still_reports_its_delay_plus_counted() {
    let t = tracker();
    let run = with(&v("running"), json!({ "delaySec": 120 }));
    update(&t, &run);
    let d = t.get_vehicle_detail(run["vehicleId"].as_str().unwrap()).unwrap();
    assert_eq!(d.current_course.as_ref().unwrap().not_started, Some(false));
    assert_eq!(d.current_course.as_ref().unwrap().delay_sec, 120);
}

#[test]
fn null_planned_departure_never_renders_as_00_00() {
    let t = tracker();
    let mut rec = v("running");
    for sp in rec["stopPoints"].as_array_mut().unwrap().iter_mut().take(2) {
        sp["plannedDeparture"] = Value::Null;
    }
    update(&t, &rec);
    let d = t.get_vehicle_detail(rec["vehicleId"].as_str().unwrap()).unwrap();
    let stops = d.current_course.unwrap().stops.unwrap();
    assert!(
        stops[..2]
            .iter()
            .all(|s| s.planned_time == s.scheduled_time && s.planned_time != "00:00")
    );
}
