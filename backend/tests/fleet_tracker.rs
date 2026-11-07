//! test/fleet-tracker.test.ts describe "fleet-tracker" (lines 1-663). Records are the TS literals as OnTime JSON,
//! read through `support::fleet::input` like the MZK poller reads them.

#[allow(dead_code)]
#[path = "support/fleet.rs"]
mod fleet;

use fleet::{Clock, NOON_OCT4_MS, detail, mem_tracker, mem_tracker_at, stop, stop_p, update, with};
use serde_json::{Value, json};
use unimaps::fleet_tracker::FleetSummaryFilter;
use unimaps::js::JsNum;
use unimaps::shared::fleet::{
    CourseStatus, CourseStopStatus, FleetTimelinePoint, FleetVehicleDetail, PredictionConfidence, TIMELINE_SLOT_SECS,
    VehicleCourseRecord, VehicleStatus,
};

fn course(veh: &FleetVehicleDetail, loid: i64) -> &VehicleCourseRecord {
    veh.today_courses
        .iter()
        .find(|c| c.course_loid == Some(loid))
        .unwrap_or_else(|| panic!("course {loid} missing"))
}

fn query(q: &str) -> FleetSummaryFilter<'_> {
    FleetSummaryFilter {
        query: Some(q),
        ..FleetSummaryFilter::default()
    }
}

/// line 7 into the depot, 4 stops (`stop_p` with the given planned offset in ms; 0 = planned = scheduled)
fn depot_stops(planned_offset_ms: i64) -> Value {
    let s = |sym: &str, name: &str, ord: i64, dist: f64, sched: i64| {
        stop_p(sym, name, ord, dist, sched, sched + planned_offset_ms)
    };
    json!([
        s("31", "Szyndzielnia", 0, 0.0, 1790080000000),
        s("22", "Armii Krajowej Karbowa", 1, 739.0, 1790080100000),
        s("44", "Boboli Szpital", 2, 1500.0, 1790080200000),
        s("446", "Zajezdnia MZK", 3, 2300.0, 1790080300000),
    ])
}

fn line7(course_loid: i64, delay_sec: i64, order_in_course: i64, stop_points: Value) -> Value {
    json!({
        "vehicleId": "230",
        "lineName": "7",
        "courseLoid": course_loid,
        "direction": "Zajezdnia MZK",
        "delaySec": delay_sec,
        "latitude": 49.79,
        "longitude": 19.04,
        "orderInCourse": order_in_course,
        "stopPoints": stop_points,
    })
}

#[test]
fn initializes_with_full_static_fleet_in_depot_state() {
    let tracker = mem_tracker();
    let stats = tracker.get_stats();

    assert!(
        stats.total_fleet >= 140,
        "Expected >= 140 vehicles, got {}",
        stats.total_fleet
    );
    assert_eq!(stats.active_count, 0);
    assert_eq!(stats.depot_count, stats.total_fleet);
    assert_eq!(stats.seen_today_count, 0);
    assert_eq!(stats.median_delay_sec, None);

    let veh230 = tracker.get_vehicle_detail("230").expect("Vehicle 230 should exist");
    assert_eq!(veh230.side_number, "230");
    assert_eq!(veh230.model, "Isuzu Novociti Life");
    assert_eq!(veh230.status, VehicleStatus::Depot);
    assert_eq!(veh230.lines, Vec::<String>::new());
    assert_eq!(veh230.main_line, None);
    assert_eq!(
        tracker.get_vehicle_detail("#230").map(|v| v.side_number).as_deref(),
        Some("230")
    );
}

#[test]
fn updates_vehicle_status_and_current_course_on_active_running_vehicles() {
    let tracker = mem_tracker();

    update(
        &tracker,
        &[json!({
            "vehicleId": "233",
            "lineName": "50",
            "courseLoid": 5057156,
            "direction": "Os. Karpackie",
            "delaySec": 120,
            "latitude": 49.928,
            "longitude": 19.008,
            "angle": 180,
            "orderInCourse": 2,
            "stopPoints": [
                stop_p("2375", "Czechowice-Dziedzice Silesia", 0, 0.0, 1790097000000, 1790097060000),
                stop_p("2376", "Czechowice-Dz. Górnicza", 1, 371.0, 1790097060000, 1790097120000),
                stop_p("2373", "Czechowice-Dz. Węglowa", 2, 850.0, 1790097120000, 1790097240000),
                stop_p("307", "Osiedle Karpackie", 3, 25000.0, 1790099820000, 1790099940000),
            ],
        })],
    );

    let stats = tracker.get_stats();
    assert_eq!(stats.active_count, 1);
    assert_eq!(stats.depot_count, stats.total_fleet - 1);
    assert_eq!(stats.active_lines, ["50"]);
    assert_eq!(stats.measured_count, 1);
    assert_eq!(stats.median_delay_sec, Some(120));

    let veh233 = tracker.get_vehicle_detail("233").expect("Vehicle 233 should be found");
    assert_eq!(veh233.status, VehicleStatus::Active);
    // OnTime publishes no duty rosters: the served lines, never an invented "50/1" brigade
    assert_eq!(veh233.lines, ["50"]);
    assert_eq!(veh233.main_line.as_deref(), Some("50"));

    let cur = veh233.current_course.as_ref().expect("Current course must exist");
    assert_eq!(cur.line_name, "50");
    assert_eq!(cur.first_stop_name, "Czechowice-Dziedzice Silesia");
    assert_eq!(cur.last_stop_name, "Osiedle Karpackie");
    assert_eq!(cur.current_stop_name, "Czechowice-Dz. Węglowa");
    assert_eq!(cur.next_stop_name.as_deref(), Some("Osiedle Karpackie"));
    assert_eq!(cur.delay_sec, 120);
    assert_eq!(cur.length_meters, Some(JsNum(26221.0)));
    assert_eq!(cur.driven_meters, Some(JsNum(1221.0)));

    // next course: an estimate (8 min default layover, measured from the scheduled arrival)
    let next = veh233
        .predicted_next_course
        .as_ref()
        .expect("Predicted next course should be computed");
    assert_eq!(next.line_name, "50");
    assert_eq!(next.from_stop_name, "Osiedle Karpackie");
    assert_eq!(next.direction, "Czechowice-Dziedzice Silesia");
    assert_eq!(next.pause_minutes, 6); // 8 min after the scheduled arrival, the bus arrives 2 min late
    assert_eq!(next.confidence, PredictionConfidence::Low); // no shuttle observed yet
}

#[test]
fn never_back_fills_invented_courses_for_a_vehicle_first_seen_mid_day() {
    let tracker = mem_tracker();
    update(
        &tracker,
        &[json!({
            "vehicleId": "250",
            "lineName": "1",
            "courseLoid": 1001,
            "direction": "Os. Beskidzkie",
            "delaySec": 0,
            "latitude": 49.8,
            "longitude": 19.0,
            "orderInCourse": 0,
            "lastStopOrderNo": 0,
            "reachedMeters": 200,
            "stopPoints": [
                stop("1", "Cygański Las", 0, 0.0, 1790080000000),
                stop("2", "Os. Beskidzkie", 1, 8000.0, 1790082000000),
            ],
        })],
    );
    let veh = detail(&tracker, "250");
    assert_eq!(veh.today_courses, Vec::new());
    assert_eq!(veh.stats.total_courses_today, 1);
    assert_eq!(veh.stats.completed_courses_today, 0);
}

#[test]
fn counts_real_kilometres_from_ontime_stop_distances_clamped_between_the_stops_served() {
    let tracker = mem_tracker();
    let base = json!({
        "vehicleId": "250",
        "lineName": "1",
        "courseLoid": 2001,
        "direction": "D",
        "delaySec": 30,
        "latitude": 49.8,
        "longitude": 19.0,
        "orderInCourse": 1,
        "lastStopOrderNo": 1,
        "stopPoints": [
            stop("10", "A", 0, 0.0, 1790080000000),
            stop("11", "B", 1, 500.0, 1790080120000),
            stop("12", "C", 2, 700.0, 1790080240000),
            stop("13", "D", 3, 800.0, 1790080360000),
        ],
    });
    let run = |over: Value| with(&base, over);

    // at stop B (index 1): reachedMeters below the stop is lifted to it
    update(&tracker, &[run(json!({ "onStopPoint": "11", "reachedMeters": 300 }))]);
    let veh = detail(&tracker, "250");
    let cur = veh.current_course.as_ref();
    assert_eq!(cur.and_then(|c| c.length_meters), Some(JsNum(2000.0)));
    assert_eq!(cur.and_then(|c| c.driven_meters), Some(JsNum(500.0)));
    assert_eq!(cur.map(|c| c.progress_pct), Some(25));
    assert_eq!(veh.stats.km_today, JsNum(0.5));

    // between B and C: OnTime's reachedMeters is used as is
    update(&tracker, &[run(json!({ "reachedMeters": 900 }))]);
    let veh = detail(&tracker, "250");
    assert_eq!(veh.current_course.and_then(|c| c.driven_meters), Some(JsNum(900.0)));

    // the card's "Pozycja X temu" reads the GPS fix time, not the poll time
    update(
        &tracker,
        &[run(json!({ "reachedMeters": 900, "lastPingDate": 1790080150500_i64 }))],
    );
    assert_eq!(
        detail(&tracker, "250").current_course.and_then(|c| c.fix_at),
        Some(1790080150)
    );

    // a reading past the next stop is capped at it
    update(&tracker, &[run(json!({ "reachedMeters": 5000 }))]);
    assert_eq!(
        detail(&tracker, "250").current_course.and_then(|c| c.driven_meters),
        Some(JsNum(1200.0))
    );

    // a course that ends on time counts its whole length
    update(&tracker, &[]);
    let veh = detail(&tracker, "250");
    assert_eq!(veh.today_courses[0].status, CourseStatus::Completed);
    assert_eq!(veh.today_courses[0].driven_meters, Some(JsNum(2000.0)));
    assert_eq!(veh.stats.km_today, JsNum(2.0));
    assert_eq!(tracker.get_stats().km_today, JsNum(2.0));
}

#[test]
fn archives_previous_course_to_today_courses_when_course_changes() {
    let tracker = mem_tracker();

    update(
        &tracker,
        &[json!({
            "vehicleId": "250",
            "lineName": "1",
            "courseLoid": 1001,
            "direction": "Os. Beskidzkie",
            "delaySec": 60,
            "latitude": 49.8,
            "longitude": 19.0,
            "orderInCourse": 1,
            "stopPoints": [
                stop("1", "Cygański Las", 0, 0.0, 1790080000000),
                stop_p("2", "Os. Beskidzkie", 1, 8000.0, 1790082000000, 1790082060000),
            ],
        })],
    );

    let veh = detail(&tracker, "250");
    assert_eq!(veh.current_course.and_then(|c| c.course_loid), Some(1001));

    update(
        &tracker,
        &[json!({
            "vehicleId": "250",
            "lineName": "1",
            "courseLoid": 1002,
            "direction": "Cygański Las",
            "delaySec": 0,
            "latitude": 49.82,
            "longitude": 19.03,
            "orderInCourse": 0,
            "stopPoints": [
                stop("2", "Os. Beskidzkie", 0, 0.0, 1790083000000),
                stop("1", "Cygański Las", 1, 8000.0, 1790085000000),
            ],
        })],
    );

    let veh = detail(&tracker, "250");
    assert_eq!(veh.current_course.as_ref().and_then(|c| c.course_loid), Some(1002));
    assert_eq!(veh.today_courses.len(), 1);
    let archived = &veh.today_courses[0];
    assert_eq!(archived.course_loid, Some(1001));
    assert_eq!(archived.status, CourseStatus::Completed);
    assert_eq!(archived.first_stop_name, "Cygański Las");
    assert_eq!(archived.last_stop_name, "Os. Beskidzkie");

    // the bus shuttles on line 1: the estimate says so (observed 1000 s layover, ~17 min)
    let next = veh.predicted_next_course.as_ref();
    assert_eq!(next.map(|n| n.confidence), Some(PredictionConfidence::Medium));
    assert_eq!(next.map(|n| n.direction.as_str()), Some("Os. Beskidzkie"));
    let end_secs = veh.current_course.as_ref().map(|c| c.end_secs).expect("current course");
    assert_eq!(next.map(|n| n.departure_secs), Some(JsNum((end_secs + 17 * 60) as f64)));
}

#[test]
fn derives_served_lines_in_order_of_first_service_and_the_main_line_by_course_count() {
    let tracker = mem_tracker();
    let course = |course_loid: i64, line_name: &str, start_ms: i64| {
        json!({
            "vehicleId": "238",
            "lineName": line_name,
            "courseLoid": course_loid,
            "direction": "B",
            "delaySec": 0,
            "latitude": 49.82,
            "longitude": 19.04,
            "orderInCourse": 1,
            "stopPoints": [stop("1", "A", 0, 0.0, start_ms), stop("2", "B", 1, 3000.0, start_ms + 1_200_000)],
        })
    };
    update(&tracker, &[course(1, "7", 1790080000000)]);
    update(&tracker, &[course(2, "50", 1790083600000)]);
    update(&tracker, &[course(3, "50", 1790087200000)]);
    let veh = detail(&tracker, "238");
    assert_eq!(veh.lines, ["7", "50"]);
    assert_eq!(veh.main_line.as_deref(), Some("50"));

    // the line filter finds a depot vehicle by the lines it served today
    update(&tracker, &[]);
    let by_line = FleetSummaryFilter {
        line: Some("7"),
        ..FleetSummaryFilter::default()
    };
    assert!(
        tracker
            .get_fleet_summary(&by_line)
            .iter()
            .any(|v| v.side_number == "238")
    );
    assert_eq!(
        tracker.get_fleet_summary(&query("#238"))[0].last_line_name.as_deref(),
        Some("50")
    );
}

#[test]
fn filters_fleet_summary_by_line_status_propulsion_and_search_query() {
    let tracker = mem_tracker();

    update(
        &tracker,
        &[
            // Solaris hydrogen
            json!({
                "vehicleId": "256",
                "lineName": "8",
                "courseLoid": 8001,
                "direction": "Szyndzielnia",
                "delaySec": 0,
                "latitude": 49.8,
                "longitude": 19.0,
            }),
            // Solaris electric MEGA
            json!({
                "vehicleId": "250",
                "lineName": "1",
                "courseLoid": 1001,
                "direction": "Cygański Las",
                "delaySec": 30,
                "latitude": 49.8,
                "longitude": 19.0,
            }),
        ],
    );

    let hits256 = tracker.get_fleet_summary(&query("#256"));
    assert_eq!(hits256.len(), 1);
    assert_eq!(hits256[0].side_number, "256");

    let propulsion = |p| FleetSummaryFilter {
        propulsion: Some(p),
        ..FleetSummaryFilter::default()
    };
    let h2_list = tracker.get_fleet_summary(&propulsion("hydrogen"));
    assert!(!h2_list.is_empty());
    assert!(
        h2_list
            .iter()
            .all(|v| detail(&tracker, &v.side_number).features.hydrogen == Some(true))
    );

    let electric_list = tracker.get_fleet_summary(&propulsion("electric"));
    assert!(!electric_list.is_empty());
    assert!(
        electric_list
            .iter()
            .all(|v| detail(&tracker, &v.side_number).features.electric == Some(true))
    );

    let active = tracker.get_fleet_summary(&FleetSummaryFilter {
        status: Some(VehicleStatus::Active),
        ..FleetSummaryFilter::default()
    });
    assert_eq!(active.len(), 2);
    assert_eq!(
        active.iter().map(|v| v.side_number.as_str()).collect::<Vec<_>>(),
        ["250", "256"], // running vehicles by line number: 1 before 8
    );

    let by_line = FleetSummaryFilter {
        line: Some("8"),
        ..FleetSummaryFilter::default()
    };
    assert_eq!(
        tracker
            .get_fleet_summary(&by_line)
            .iter()
            .map(|v| v.side_number.as_str())
            .collect::<Vec<_>>(),
        ["256"],
    );
}

#[test]
fn marks_all_stops_in_completed_course_as_passed_when_vehicle_goes_to_depot_or_changes_course() {
    let tracker = mem_tracker();

    update(
        &tracker,
        &[json!({
            "vehicleId": "230",
            "lineName": "7",
            "courseLoid": 999991,
            "direction": "Zajezdnia MZK",
            "delaySec": 0,
            "latitude": 49.79,
            "longitude": 19.04,
            "orderInCourse": 1,
            "stopPoints": [
                stop("31", "Szyndzielnia", 0, 0.0, 1790080000000),
                stop("22", "Armii Krajowej Karbowa", 1, 739.0, 1790080100000),
                stop("44", "Boboli Szpital", 2, 1500.0, 1790080200000),
                stop("446", "Zajezdnia MZK", 3, 2300.0, 1790080300000),
            ],
        })],
    );

    let veh = detail(&tracker, "230");
    let cur = veh.current_course.as_ref().expect("current course");
    let stops = cur.stops.as_deref().unwrap_or_default();
    assert_eq!(stops.get(1).map(|s| s.status), Some(CourseStopStatus::Current));
    assert_eq!(stops.get(2).map(|s| s.status), Some(CourseStopStatus::Upcoming));
    assert_eq!(
        veh.predicted_next_course, None,
        "a course into the depot has no next course"
    );

    update(&tracker, &[]);

    let veh = detail(&tracker, "230");
    assert_eq!(veh.status, VehicleStatus::Depot);
    assert_eq!(veh.current_course, None);

    let completed = course(&veh, 999991);
    assert_eq!(completed.status, CourseStatus::Completed);
    let stops = completed.stops.as_deref().unwrap_or_default();
    assert_eq!(stops.len(), 4);
    for s in stops {
        assert_eq!(
            s.status,
            CourseStopStatus::Passed,
            "Stop {} in completed course should be 'passed', was '{:?}'",
            s.name,
            s.status
        );
    }
}

#[test]
fn formats_course_times_strictly_in_europe_warsaw_timezone() {
    let tracker = mem_tracker();

    // 1727092800000 ms = 2024-09-23 12:00:00 UTC = 14:00:00 CEST (Europe/Warsaw)
    update(
        &tracker,
        &[json!({
            "vehicleId": "250",
            "lineName": "1",
            "courseLoid": 888801,
            "direction": "Osiedle Beskidzkie",
            "delaySec": 0,
            "latitude": 49.82,
            "longitude": 19.04,
            "orderInCourse": 0,
            "stopPoints": [
                stop("1", "Cygański Las", 0, 0.0, 1727092800000),
                stop("307", "Osiedle Beskidzkie", 1, 4000.0, 1727094000000),
            ],
        })],
    );

    let veh = detail(&tracker, "250");
    let cur = veh.current_course.as_ref().expect("current course");
    assert_eq!(cur.start_time, "14:00");
    assert_eq!(cur.end_time, "14:20");
    let stops = cur.stops.as_deref().unwrap_or_default();
    assert_eq!(stops.first().map(|s| s.scheduled_time.as_str()), Some("14:00"));
    assert_eq!(stops.get(1).map(|s| s.scheduled_time.as_str()), Some("14:20"));
}

#[test]
fn sorts_today_courses_in_road_card_from_newest_to_oldest() {
    let tracker = mem_tracker();
    let course = |course_loid: i64, direction: &str, start_ms: i64| {
        json!({
            "vehicleId": "238",
            "lineName": "8",
            "courseLoid": course_loid,
            "direction": direction,
            "delaySec": 0,
            "latitude": 49.82,
            "longitude": 19.04,
            "orderInCourse": 0,
            "stopPoints": [stop("1", "Start A", 0, 0.0, start_ms), stop("2", "End A", 1, 2000.0, start_ms + 1_800_000)],
        })
    };

    update(&tracker, &[course(777001, "Warszawska", 1727064000000)]); // 06:00
    update(&tracker, &[course(777002, "Szyndzielnia", 1727085600000)]); // 12:00
    update(&tracker, &[course(777003, "Warszawska", 1727096400000)]); // 15:00
    update(&tracker, &[]);

    let veh = detail(&tracker, "238");
    assert_eq!(veh.status, VehicleStatus::Depot);
    assert_eq!(
        veh.today_courses.iter().map(|c| c.course_loid).collect::<Vec<_>>(),
        [Some(777003), Some(777002), Some(777001)],
    );
}

#[test]
fn detects_broken_down_vehicle_with_50_minutes_delay_disappearing_from_gps_and_marks_course_as_cancelled() {
    let tracker = mem_tracker();

    // 50 min delay
    update(&tracker, &[line7(999992, 3000, 1, depot_stops(3_000_000))]);

    let veh = detail(&tracker, "230");
    let cur = veh.current_course.as_ref().expect("current course");
    assert_eq!(cur.delay_sec, 3000);
    assert_eq!(cur.current_stop_name, "Armii Krajowej Karbowa");

    // the bus disappears from GPS mid-route (broke down, towed, or turned off)
    update(&tracker, &[]);

    let veh = detail(&tracker, "230");
    assert_eq!(veh.status, VehicleStatus::Depot);
    assert_eq!(veh.current_course, None);

    let cancelled = course(&veh, 999992);
    assert_eq!(cancelled.status, CourseStatus::Cancelled);
    assert_eq!(
        cancelled.cancelled_at_stop_name.as_deref(),
        Some("Armii Krajowej Karbowa")
    );
    let reason = cancelled.cancelled_reason.as_deref().unwrap_or_default();
    assert!(
        reason.contains("50 min") && reason.contains("Armii Krajowej Karbowa"),
        "Expected cancellation reason to describe 50 min delay and stop, got: {:?}",
        cancelled.cancelled_reason
    );
    // only the distance to the last stop reached counts as driven
    assert_eq!(cancelled.driven_meters, Some(JsNum(739.0)));

    let stops = cancelled.stops.as_deref().unwrap_or_default();
    assert_eq!(stops.len(), 4);
    assert_eq!(stops[0].status, CourseStopStatus::Passed);
    assert_eq!(stops[1].status, CourseStopStatus::Current);
    assert_eq!(stops[2].status, CourseStopStatus::Upcoming);
    assert_eq!(stops[3].status, CourseStopStatus::Upcoming);

    assert_eq!(veh.stats.cancelled_courses_today, 1);
    assert_eq!(veh.stats.completed_courses_today, 0);
    assert!(
        veh.last_known_location
            .as_ref()
            .is_some_and(|l| l.name.contains("Utrata sygnału GPS")),
        "Expected breakdown description in lastKnownLocation, got: {:?}",
        veh.last_known_location.as_ref().map(|l| &l.name)
    );

    let summary = tracker.get_fleet_summary(&query("#230"));
    assert_eq!(summary.len(), 1);
    assert_eq!(summary[0].cancelled_courses_today, 1);
    assert_eq!(tracker.get_stats().courses_cancelled_today, 1);
}

#[test]
fn marks_course_as_completed_if_vehicle_reaches_terminus_even_with_large_delay() {
    let tracker = mem_tracker();

    update(&tracker, &[line7(999993, 3000, 3, depot_stops(3_000_000))]);
    update(&tracker, &[]);

    let veh = detail(&tracker, "230");
    let completed = course(&veh, 999993);
    assert_eq!(completed.status, CourseStatus::Completed);
    assert!(
        completed
            .stops
            .as_deref()
            .is_some_and(|s| s.iter().all(|s| s.status == CourseStopStatus::Passed))
    );
}

#[test]
fn recovers_cleanly_without_duplicates_when_gps_reconnects_after_temporary_dropout() {
    let tracker = mem_tracker();

    let course_data = line7(999994, 3000, 1, depot_stops(3_000_000));

    update(&tracker, std::slice::from_ref(&course_data));
    update(&tracker, &[]);
    let veh = detail(&tracker, "230");
    assert_eq!(veh.status, VehicleStatus::Depot);
    assert!(veh.today_courses.iter().any(|c| c.course_loid == Some(999994)));

    update(&tracker, &[course_data]);
    let veh = detail(&tracker, "230");
    assert_eq!(veh.status, VehicleStatus::Active);
    assert_eq!(veh.current_course.as_ref().and_then(|c| c.course_loid), Some(999994));
    assert!(
        !veh.today_courses.iter().any(|c| c.course_loid == Some(999994)),
        "Live reconnected course must be removed from todayCourses to prevent duplicates"
    );
    assert_eq!(veh.stats.cancelled_courses_today, 0);
}

// OnTime drops a course on arrival (or hands the bus its next one) before the terminus registers
#[test]
fn a_late_course_that_leaves_the_feed_on_its_last_leg_was_run_to_the_end() {
    let tracker = mem_tracker();
    update(&tracker, &[line7(999995, 900, 2, depot_stops(0))]);
    update(&tracker, &[]);

    let veh = detail(&tracker, "230");
    let c = course(&veh, 999995);
    assert_eq!(c.status, CourseStatus::Completed);
    assert_eq!(c.cancelled_reason, None);
    assert_eq!(c.driven_meters, c.length_meters);
    assert_eq!(veh.stats.cancelled_courses_today, 0);
    assert!(
        !veh.last_known_location
            .as_ref()
            .is_some_and(|l| l.name.contains("Utrata sygnału GPS"))
    );
}

#[test]
fn a_late_course_that_leaves_the_feed_within_300_m_of_its_end_was_run_stops_left_or_not() {
    let tracker = mem_tracker();
    let stops = json!([
        stop("31", "Szyndzielnia", 0, 0.0, 1790080000000),
        stop("22", "Armii Krajowej Karbowa", 1, 1500.0, 1790080100000),
        stop("44", "Boboli Szpital", 2, 120.0, 1790080200000),
        stop("45", "Boboli", 3, 100.0, 1790080250000),
        stop("446", "Zajezdnia MZK", 4, 80.0, 1790080300000),
    ]);
    let raw = with(&line7(999996, 1200, 1, stops), json!({ "reachedMeters": 1560 }));
    update(&tracker, &[raw]);
    update(&tracker, &[]);

    let veh = detail(&tracker, "230");
    let c = course(&veh, 999996);
    assert_eq!(c.status, CourseStatus::Completed);
    assert_eq!(c.driven_meters, Some(JsNum(1800.0)));
}

#[test]
fn a_late_bus_moved_to_its_next_course_mid_route_the_first_one_was_cut_short_not_lost() {
    let tracker = mem_tracker();
    let course_of = |course_loid: i64, order_in_course: i64| line7(course_loid, 900, order_in_course, depot_stops(0));
    update(&tracker, &[course_of(999997, 1)]);
    update(&tracker, &[course_of(999998, 0)]);

    let veh = detail(&tracker, "230");
    assert_eq!(veh.current_course.as_ref().and_then(|c| c.course_loid), Some(999998));
    let cut = course(&veh, 999997);
    assert_eq!(cut.status, CourseStatus::Cancelled);
    assert_eq!(cut.cancelled_at_stop_name.as_deref(), Some("Armii Krajowej Karbowa"));
    assert!(
        cut.cancelled_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("Kurs skrócony")),
        "got: {:?}",
        cut.cancelled_reason
    );
    assert_eq!(cut.driven_meters, Some(JsNum(739.0)));
}

#[test]
fn samples_the_running_fleet_into_5_minute_punctuality_slots_last_sample_wins() {
    let clock = Clock::at(NOON_OCT4_MS + 70_000); // 12:01:10
    let tracker = mem_tracker_at(&clock);
    let base = |vehicle_id: &str, delay_sec: i64| {
        json!({
            "vehicleId": vehicle_id,
            "lineName": "1",
            "courseLoid": vehicle_id.parse::<i64>().unwrap_or(0),
            "direction": "B",
            "delaySec": delay_sec,
            "latitude": 49.8,
            "longitude": 19.0,
            "orderInCourse": 1,
        })
    };
    let waiting = with(
        &base("250", 840),
        json!({ "orderInCourse": 0, "lastStopOrderNo": null }),
    );

    update(&tracker, &[base("230", 0), base("233", 900), waiting]);
    let tl = tracker.get_timeline();
    assert_eq!(tl.len(), 1);
    let point = |waiting, early, on_time, late, very_late| FleetTimelinePoint {
        t: 12 * 3600,
        waiting,
        early,
        on_time,
        late,
        very_late,
    };
    assert_eq!(tl[0], point(1, 0, 1, 0, 1));

    // same slot: overwritten, not added up
    clock.set(NOON_OCT4_MS + 200_000);
    update(&tracker, &[base("230", -120)]);
    let tl = tracker.get_timeline();
    assert_eq!(tl.len(), 1);
    assert_eq!(tl[0], point(0, 1, 0, 0, 0));

    // next slot
    clock.set(NOON_OCT4_MS + TIMELINE_SLOT_SECS * 1000);
    update(&tracker, &[base("230", 300)]);
    let tl = tracker.get_timeline();
    assert_eq!(
        tl.iter().map(|p| p.t).collect::<Vec<_>>(),
        [12 * 3600, 12 * 3600 + TIMELINE_SLOT_SECS]
    );
    assert_eq!(tl[1].late, 1);
}
