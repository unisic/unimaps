//! Port of test/mzk-timetable.test.ts. The angle case lives in tests/mzk_poller.rs; the HH:MM format and parse
//! cases test lib/client/format.ts (browser code, no Rust counterpart) and are not ported.

use std::collections::HashMap;

use serde_json::{Value, json};
use unimaps::geo::{bearing, meters_between};
use unimaps::mzk_timetable::{CourseAccumulator, VariantSamples, add_stop_schedule, append_termini, finish_courses};

// describe("mzk-timetable and schedule logic")

#[test]
fn computes_movement_bearing_correctly_for_vehicle_displacement() {
    // Bus moving north along Warszawska
    let (lat1, lon1, lat2, lon2) = (49.82, 19.04, 49.83, 19.04);

    let dist = meters_between(lat1, lon1, lat2, lon2);
    assert!(dist > 500.0, "Distance should be > 500m");

    let brg = bearing(lat1, lon1, lat2, lon2).expect("a bearing");
    assert!(
        (brg - 0.0).abs() < 0.1 || (brg - 360.0).abs() < 0.1,
        "Expected North (0 deg), got {brg}"
    );

    // Bus moving south towards Cyganski Las
    let s_brg = bearing(lat2, lon2, lat1, lon1).expect("a bearing");
    assert!((s_brg - 180.0).abs() < 0.1, "Expected South (180 deg), got {s_brg}");
}

/// TS `{ courseId, sec, order, start? }`
struct Dep {
    course_id: f64,
    sec: f64,
    order: f64,
    start: Option<f64>,
}

fn dep(course_id: f64, sec: f64, order: f64) -> Dep {
    Dep {
        course_id,
        sec,
        order,
        start: None,
    }
}

fn dep_at(course_id: f64, sec: f64, order: f64, start: f64) -> Dep {
    Dep {
        start: Some(start),
        ..dep(course_id, sec, order)
    }
}

/// TS `schedule(dayType, deps)`; an undefined `courseStartSec` is left out, as JSON drops it.
fn schedule(day_type: &str, deps: &[Dep]) -> Value {
    let departures: Vec<Value> = deps
        .iter()
        .map(|d| {
            let mut o = json!({
                "courseId": d.course_id,
                "variantId": 13002,
                "scheduledDepartureSec": d.sec,
                "orderInCourse": d.order,
            });
            if let Some(start) = d.start {
                o["courseStartSec"] = json!(start);
            }
            o
        })
        .collect();
    json!({
        "dayTypeSymbol": day_type,
        "lineSchedules": {
            "22": { "lineName": "22", "destination": "Filarowa Zespół Szkół", "departures": departures },
        },
    })
}

fn calls(c: &[(&str, f64)]) -> Vec<(String, f64)> {
    c.iter().map(|(s, t)| ((*s).to_owned(), *t)).collect()
}

// describe("MZK timetable assembly")

#[test]
fn orders_a_course_s_calls_by_order_in_course_whatever_order_the_stops_were_read_in() {
    let mut acc = CourseAccumulator::new();
    add_stop_schedule(&mut acc, "2", &schedule("RsC", &[dep(1.0, 81960.0, 11.0)]), "RsC");
    add_stop_schedule(&mut acc, "329", &schedule("RsC", &[dep(1.0, 81000.0, 0.0)]), "RsC");
    add_stop_schedule(&mut acc, "3", &schedule("RsC", &[dep(1.0, 81900.0, 10.0)]), "RsC");
    let trips = finish_courses(acc, "RsC");
    let trip = &trips[0];
    assert_eq!(trip.id, "mzk:1:13002");
    assert_eq!(trip.headsign, "Filarowa Zespół Szkół");
    assert_eq!(trip.calls, calls(&[("329", 81000.0), ("3", 81900.0), ("2", 81960.0)]));
}

#[test]
fn ignores_a_stop_schedule_answered_for_another_day_type() {
    let mut acc = CourseAccumulator::new();
    assert_eq!(
        add_stop_schedule(&mut acc, "2", &schedule("Nc", &[dep(1.0, 100.0, 0.0)]), "RsC"),
        Some(false)
    );
    assert_eq!(acc.len(), 0);
}

#[test]
fn moves_calls_after_midnight_to_the_next_day_and_drops_single_call_courses() {
    let mut acc = CourseAccumulator::new();
    add_stop_schedule(
        &mut acc,
        "a",
        &schedule("RsC", &[dep_at(7.0, 85800.0, 0.0, 85800.0)]),
        "RsC",
    );
    add_stop_schedule(
        &mut acc,
        "b",
        &schedule("RsC", &[dep_at(7.0, 300.0, 1.0, 85800.0), dep(8.0, 50.0, 3.0)]),
        "RsC",
    );
    let trips = finish_courses(acc, "RsC");
    assert_eq!(trips.len(), 1);
    assert_eq!(trips[0].calls, calls(&[("a", 85800.0), ("b", 86700.0)]));
}

#[test]
fn wraps_calls_after_midnight_even_when_the_course_start_is_wrong() {
    let mut acc = CourseAccumulator::new();
    add_stop_schedule(
        &mut acc,
        "a",
        &schedule("RsC", &[dep_at(9.0, 86280.0, 0.0, 0.0)]),
        "RsC",
    );
    add_stop_schedule(
        &mut acc,
        "b",
        &schedule("RsC", &[dep_at(9.0, 86340.0, 1.0, 0.0)]),
        "RsC",
    );
    add_stop_schedule(&mut acc, "c", &schedule("RsC", &[dep_at(9.0, 60.0, 2.0, 0.0)]), "RsC");
    assert_eq!(
        finish_courses(acc, "RsC")[0].calls,
        calls(&[("a", 86280.0), ("b", 86340.0), ("c", 86460.0)])
    );
}

#[test]
fn appends_the_terminus_from_the_variant_sample_with_the_sample_s_run_time() {
    let mut acc = CourseAccumulator::new();
    add_stop_schedule(
        &mut acc,
        "291",
        &schedule("RsC", &[dep(1.0, 82260.0, 14.0), dep(2.0, 30000.0, 14.0)]),
        "RsC",
    );
    add_stop_schedule(
        &mut acc,
        "294",
        &schedule("RsC", &[dep(1.0, 82140.0, 13.0), dep(2.0, 29880.0, 13.0)]),
        "RsC",
    );
    let mut trips = finish_courses(acc, "RsC");
    let samples: VariantSamples = HashMap::from([(
        "13002".to_owned(),
        calls(&[("294", 82140.0), ("291", 82260.0), ("456", 82380.0)]),
    )]);
    assert_eq!(append_termini(&mut trips, &samples), 2);
    let last = trips
        .iter()
        .find(|t| t.id == "mzk:2:13002")
        .and_then(|t| t.calls.last().cloned());
    assert_eq!(last, Some(("456".to_owned(), 30120.0)));
    // a trip that already ends at the terminus is left alone
    assert_eq!(append_termini(&mut trips, &samples), 0);
}
