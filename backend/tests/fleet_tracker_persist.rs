//! test/fleet-tracker.test.ts lines 664-893: describe "fleet-tracker persistence" and the "shared fleet helpers"
//! case not in tests/fleet.rs (matchesFleetQuery).

#[allow(dead_code)]
#[path = "support/fleet.rs"]
mod fleet;

use fleet::{Clock, NOON_OCT4_MS, TmpDir, detail, opts, stop, update, with};
use serde_json::{Value, json};
use unimaps::fleet_tracker::FleetTracker;
use unimaps::js::JsNum;
use unimaps::shared::fleet::{
    CourseStatus, CourseStopStatus, FleetSummaryItem, VehicleCourseRecord, VehicleStatus, matches_fleet_query,
};

/// `Date.UTC(2026, 9, 4, h, m, 0)`
fn oct4_utc(h: i64, m: i64) -> i64 {
    NOON_OCT4_MS + ((h - 10) * 60 + m) * 60_000
}

fn write_json(tmp: &TmpDir, name: &str, body: &Value) {
    std::fs::write(tmp.path().join(name), body.to_string()).unwrap();
}

fn all_passed(c: &VehicleCourseRecord) -> bool {
    c.stops
        .as_ref()
        .is_some_and(|s| s.iter().all(|s| s.status == CourseStopStatus::Passed))
}

#[test]
fn restores_the_days_history_drops_back_filled_synth_courses_and_sanitizes_completed_stops() {
    let clock = Clock::at(NOON_OCT4_MS);
    let dir = TmpDir::new();
    let real_course = json!({
        "id": "c-555001",
        "courseLoid": 555001,
        "lineName": "16",
        "direction": "Hałcnów",
        "firstStopName": "Dworzec",
        "lastStopName": "Hałcnów",
        "startTime": "09:00",
        "endTime": "09:30",
        "startSecs": 9 * 3600,
        "endSecs": 9 * 3600 + 1800,
        "delaySec": 60,
        "stopsCount": 2,
        "status": "completed",
        "lengthMeters": 6400,
        "stops": [
            { "symbol": "1", "name": "Dworzec", "scheduledTime": "09:00", "plannedTime": "09:00", "status": "passed" },
            { "symbol": "2", "name": "Hałcnów", "scheduledTime": "09:30", "plannedTime": "09:31", "status": "current" },
        ],
    });
    // `{ ...realCourse, id, courseLoid: undefined, startSecs }`: JSON.stringify drops the undefined key
    let mut synth = with(
        &real_course,
        json!({ "id": "synth-167-0", "startSecs": 5 * 3600 + 1800 }),
    );
    if let Some(o) = synth.as_object_mut() {
        o.remove("courseLoid");
    }
    write_json(
        &dir,
        "fleet-history-2026-10-04.json",
        &json!({
            "_v": 2,
            "_timeline": [{ "t": 9 * 3600, "waiting": 0, "early": 0, "onTime": 3, "late": 1, "veryLate": 0 }],
            "167": { "todayCourses": [real_course, synth], "lastSeenAt": NOON_OCT4_MS / 1000 - 3600 },
        }),
    );

    let tracker = FleetTracker::new(opts(Some(dir.path().to_path_buf()), &clock));
    let veh = detail(&tracker, "167");
    assert_eq!(
        veh.today_courses.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["c-555001"]
    );
    assert!(all_passed(&veh.today_courses[0]));
    assert_eq!(veh.stats.km_today, JsNum(6.4));
    assert_eq!(veh.lines, ["16"]);
    assert_eq!(veh.status, VehicleStatus::Depot);
    assert_eq!(tracker.get_timeline().len(), 1);
    assert_eq!(tracker.get_stats().seen_today_count, 1);
}

#[test]
fn re_judges_saved_interrupted_courses_one_that_left_on_its_last_leg_was_run() {
    let clock = Clock::at(NOON_OCT4_MS);
    let dir = TmpDir::new();
    let base = json!({
        "lineName": "7",
        "direction": "Zajezdnia MZK",
        "firstStopName": "Szyndzielnia",
        "lastStopName": "Zajezdnia MZK",
        "startTime": "09:00",
        "endTime": "09:30",
        "startSecs": 9 * 3600,
        "endSecs": 9 * 3600 + 1800,
        "delaySec": 1500,
        "stopsCount": 3,
        "status": "cancelled",
        "lengthMeters": 4000,
        "drivenMeters": 2500,
        "cancelledReason": "Kurs przerwany: …",
        "cancelledAtStopName": "Boboli Szpital",
    });
    let stops = |current: usize| {
        ["Szyndzielnia", "Boboli Szpital", "Zajezdnia MZK"]
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let status = match i.cmp(&current) {
                    std::cmp::Ordering::Less => "passed",
                    std::cmp::Ordering::Equal => "current",
                    std::cmp::Ordering::Greater => "upcoming",
                };
                json!({
                    "symbol": i.to_string(),
                    "name": name,
                    "scheduledTime": "09:00",
                    "plannedTime": "09:25",
                    "status": status,
                })
            })
            .collect::<Vec<_>>()
    };
    write_json(
        &dir,
        "fleet-history-2026-10-04.json",
        &json!({
            "_v": 2,
            "167": {
                "todayCourses": [
                    with(&base, json!({ "id": "c-1", "courseLoid": 1, "stops": stops(1) })),
                    with(
                        &base,
                        json!({ "id": "c-2", "courseLoid": 2, "startSecs": 8 * 3600, "drivenMeters": 0, "stops": stops(0) }),
                    ),
                ],
                "lastSeenAt": NOON_OCT4_MS / 1000 - 3600,
            },
        }),
    );

    let veh = detail(&FleetTracker::new(opts(Some(dir.path().to_path_buf()), &clock)), "167");
    let run = veh.today_courses.iter().find(|c| c.id == "c-1").unwrap();
    assert_eq!(run.status, CourseStatus::Completed);
    assert_eq!(run.cancelled_reason, None);
    assert_eq!(run.driven_meters, Some(JsNum(4000.0)));
    assert!(all_passed(run));
    let cut = veh.today_courses.iter().find(|c| c.id == "c-2").unwrap();
    assert_eq!(cut.status, CourseStatus::Cancelled);
    assert_eq!(veh.stats.cancelled_courses_today, 1);
}

#[test]
fn rolls_over_at_warsaw_midnight_the_old_day_is_saved_the_new_day_starts_empty() {
    let clock = Clock::at(oct4_utc(21, 50)); // 23:50 Warsaw
    let dir = TmpDir::new();
    let tracker = FleetTracker::new(opts(Some(dir.path().to_path_buf()), &clock));
    update(
        &tracker,
        &[json!({
            "vehicleId": "250",
            "lineName": "1",
            "courseLoid": 4242,
            "direction": "B",
            "delaySec": 0,
            "latitude": 49.8,
            "longitude": 19.0,
            "orderInCourse": 1,
            "stopPoints": [stop("1", "A", 0, 0.0, 1790080000000), stop("2", "B", 1, 3000.0, 1790081200000)],
        })],
    );
    update(&tracker, &[]);
    assert_eq!(detail(&tracker, "250").today_courses.len(), 1);

    clock.set(oct4_utc(22, 5)); // 00:05 Warsaw, 2026-10-05
    update(&tracker, &[]);
    let veh = detail(&tracker, "250");
    assert_eq!(veh.today_courses, []);
    assert_eq!(veh.last_seen_at, 0);
    assert_eq!(tracker.get_stats().km_today, JsNum(0.0));
    assert_eq!(tracker.get_timeline().len(), 1, "only the new day's first sample");

    let text = std::fs::read_to_string(dir.path().join("fleet-history-2026-10-04.json")).unwrap();
    let saved: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(saved["250"]["todayCourses"][0]["courseLoid"], json!(4242));
}

#[test]
fn flush_sync_writes_a_pending_debounced_save_at_once_graceful_shutdown() {
    let clock = Clock::at(oct4_utc(10, 0));
    let dir = TmpDir::new();
    let tracker = FleetTracker::new(opts(Some(dir.path().to_path_buf()), &clock));
    update(
        &tracker,
        &[json!({
            "vehicleId": "251",
            "lineName": "1",
            "courseLoid": 4243,
            "direction": "B",
            "delaySec": 0,
            "latitude": 49.8,
            "longitude": 19.0,
            "orderInCourse": 1,
            "stopPoints": [],
        })],
    );
    let file = dir.path().join("fleet-history-2026-10-04.json");
    assert!(!file.exists(), "the save is still pending");
    tracker.flush_sync();
    assert!(file.exists());
}

#[test]
fn the_rollover_deletes_day_files_past_the_retention_window_and_nothing_else() {
    let clock = Clock::at(oct4_utc(21, 50)); // 23:50 Warsaw
    let dir = TmpDir::new();
    let names = [
        "fleet-history-2025-10-04.json", // 366 days before 2026-10-05: dropped
        "fleet-history-2025-10-05.json", // 365 days: kept
        "fleet-history-2020-01-01.json.tmp",
        "fleet-history-old.json",
        "route-shapes.v1.json",
    ];
    for n in names {
        std::fs::write(dir.path().join(n), "{}").unwrap();
    }
    let tracker = FleetTracker::new(opts(Some(dir.path().to_path_buf()), &clock));
    update(&tracker, &[]);
    clock.set(oct4_utc(22, 5)); // 00:05 Warsaw, 2026-10-05
    update(&tracker, &[]);
    let left: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!left.iter().any(|n| n == names[0]));
    for n in &names[1..] {
        assert!(left.iter().any(|l| l == n), "{n}");
    }
    assert!(left.iter().any(|n| n == "fleet-history-2026-10-04.json"));
}

#[test]
fn matches_side_numbers_lines_and_folded_text_without_line_side_confusion() {
    let v = FleetSummaryItem {
        side_number: "123".into(),
        model: "Solaris Urbino 12".into(),
        producer: "Solaris".into(),
        lines: vec!["7".into()],
        line_name: Some("50".into()),
        direction: Some("Żywiec Dworzec".into()),
        current_stop_name: Some("Hałcnów".into()),
        ..FleetSummaryItem::default()
    };
    assert!(matches_fleet_query(&v, ""));
    assert!(matches_fleet_query(&v, "#12"));
    assert!(matches_fleet_query(&v, "#")); // a bare "#" while typing matches everything
    assert!(matches_fleet_query(&v, "123"));
    assert!(
        !matches_fleet_query(&v, "1"),
        "line 1 must match neither side 123 nor model Urbino 12"
    );
    assert!(matches_fleet_query(&v, "urbino 12"));
    assert!(matches_fleet_query(&v, "50"));
    assert!(matches_fleet_query(&v, "7"));
    assert!(matches_fleet_query(&v, "zywiec"));
    assert!(matches_fleet_query(&v, "halcnow"));
    assert!(!matches_fleet_query(&v, "#urbino"));
}
