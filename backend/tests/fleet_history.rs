//! test/fleet-history.test.ts: day kinds, the packed history and its successors, the course chain and the tracker
//! reading the day files. The records are the TS `rec()` literals (a partial `VehicleCourseRecord`), read the way a
//! day file is.

#[allow(dead_code)]
#[path = "support/fleet.rs"]
mod fleet;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fleet::{Clock, TmpDir, opts, update};
use serde_json::{Value, json};
use unimaps::fleet_history::{CourseEnd, DayKind, FleetHistory, Successor, course_chain, course_key, day_kind};
use unimaps::fleet_tracker::{FleetTracker, FleetTrackerOptions};
use unimaps::js::{JsNum, num_value};
use unimaps::mzk_timetable::{MzkDayCourse, MzkDaySchedule};
use unimaps::shared::fleet::{
    CourseStatus, FleetHistoryDay, PredictionConfidence, PredictionSeen, PredictionSource, VehicleCourseRecord,
    fold_text,
};

const H: f64 = 3600.0;

fn course(line: &str, first_sym: &str, first_name: &str, start: f64, last_name: &str, end: f64) -> MzkDayCourse {
    MzkDayCourse {
        line: line.to_owned(),
        headsign: last_name.to_owned(),
        first_sym: first_sym.to_owned(),
        first_name: first_name.to_owned(),
        start,
        last_name: last_name.to_owned(),
        end,
    }
}

fn schedule(mut courses: Vec<MzkDayCourse>) -> MzkDaySchedule {
    let mut s = MzkDaySchedule::default();
    courses.sort_by(|a, b| a.start.total_cmp(&b.start));
    for c in courses {
        s.by_key
            .insert(course_key(&c.line, Some(&c.first_sym), c.start), c.clone());
        s.from_stop.entry(fold_text(&c.first_name)).or_default().push(c);
    }
    s
}

/// The TS `rec()` literal: the record fields the history reads; the rest of a saved course does not matter here.
fn rec_json(id: &str, c: &MzkDayCourse) -> Value {
    json!({
        "id": id,
        "lineName": c.line,
        "direction": c.headsign,
        "firstStopName": c.first_name,
        "firstStopSymbol": c.first_sym,
        "lastStopName": c.last_name,
        "startSecs": num_value(c.start),
        "endSecs": num_value(c.end),
        "delaySec": 60,
        "status": "completed",
        "drivenMeters": 5000,
        "stopsCount": 10,
    })
}

/// TS `rec(id, c)` in memory; the TS cast leaves startTime/endTime undefined, the history never reads them
fn rec(id: &str, c: &MzkDayCourse) -> VehicleCourseRecord {
    VehicleCourseRecord {
        id: id.to_owned(),
        course_loid: None,
        line_name: c.line.clone(),
        direction: c.headsign.clone(),
        first_stop_name: c.first_name.clone(),
        last_stop_name: c.last_name.clone(),
        first_stop_symbol: Some(c.first_sym.clone()),
        last_stop_symbol: None,
        start_time: String::new(),
        end_time: String::new(),
        start_secs: c.start as i64,
        end_secs: c.end as i64,
        brigade: None,
        delay_sec: 60,
        stops_count: 10,
        status: CourseStatus::Completed,
        cancelled_reason: None,
        cancelled_at_stop_name: None,
        completed_at: None,
        length_meters: None,
        driven_meters: Some(JsNum(5000.0)),
        stops: None,
    }
}

/// 50: Silesia 12:00 -> Karpackie 12:40; history says the bus then runs 16 from Karpackie at 13:00,
/// while the timetable rule alone would pick the 50 back at 12:50
fn a() -> MzkDayCourse {
    course(
        "50",
        "2375",
        "Czechowice-Dziedzice Silesia",
        12.0 * H,
        "Osiedle Karpackie",
        12.0 * H + 2400.0,
    )
}
fn b() -> MzkDayCourse {
    course("16", "307", "Osiedle Karpackie", 13.0 * H, "Dworzec", 13.0 * H + 1800.0)
}
fn c() -> MzkDayCourse {
    course(
        "50",
        "307",
        "Osiedle Karpackie",
        12.0 * H + 3000.0,
        "Czechowice-Dziedzice Silesia",
        13.0 * H + 2400.0,
    )
}
fn d() -> MzkDayCourse {
    course("16", "9", "Dworzec", 13.0 * H + 2400.0, "Zajezdnia MZK", 14.0 * H)
}
fn sched() -> MzkDaySchedule {
    schedule(vec![a(), b(), c(), d()])
}

fn add(h: &mut FleetHistory, date: &str, side: &str, courses: &[VehicleCourseRecord]) {
    h.add_day(date, [(side, courses)]);
}

fn dates(days: &[FleetHistoryDay]) -> Vec<&str> {
    days.iter().map(|d| d.date.as_str()).collect()
}

/// TS `Date.UTC(year, month0, day, h, m, s)`
fn date_utc(year: i16, month0: i8, day: i8, h: i8, m: i8, s: i8) -> i64 {
    jiff::civil::date(year, month0 + 1, day)
        .at(h, m, s, 0)
        .to_zoned(jiff::tz::TimeZone::UTC)
        .unwrap()
        .timestamp()
        .as_millisecond()
}

#[test]
fn classifies_days_by_weekday() {
    let kinds: Vec<DayKind> = ["2026-10-05", "2026-10-10", "2026-10-11"].map(day_kind).to_vec();
    assert_eq!(kinds, [DayKind::Wd, DayKind::Sat, DayKind::Sun]);
}

#[test]
fn packs_days_serves_them_per_vehicle_and_counts_successors_per_day_kind() {
    let (a, b, c, d) = (a(), b(), c(), d());
    let mut h = FleetHistory::new(28, true);
    h.set_today("2026-10-05");
    // Mon + Tue: A then B; Wed: A then a break (> 45 min), so END; a Saturday never counts for a weekday
    add(&mut h, "2026-09-28", "233", &[rec("1", &b), rec("2", &a)]);
    add(&mut h, "2026-09-29", "233", &[rec("3", &a), rec("4", &b)]);
    let d15 = MzkDayCourse { start: 15.0 * H, ..d };
    add(&mut h, "2026-09-30", "233", &[rec("5", &a), rec("6", &d15)]);
    add(&mut h, "2026-10-03", "233", &[rec("7", &a), rec("8", &c)]);
    add(&mut h, "2026-09-28", "999", &[rec("x", &a)]); // a date already held is ignored
    add(&mut h, "2026-08-01", "999", &[rec("y", &a)]); // older than 28 days
    add(&mut h, "2026-10-04", "233", &[rec("synth-1", &a)]); // invented courses never count

    let key_a = course_key("50", Some("2375"), a.start);
    assert_eq!(
        h.successor(DayKind::Wd, &key_a),
        None,
        "unknown until the files are read"
    );
    // TS `load(null)`: an empty dir is falsy there too, so nothing is read and the history is complete
    h.load_sync(Path::new(""), |c| c);
    assert_eq!(
        h.successor(DayKind::Wd, &key_a),
        Some(Successor {
            key: course_key("16", Some("307"), b.start),
            count: 2,
            total: 3
        })
    );
    assert_eq!(
        h.successor(DayKind::Sat, &key_a),
        Some(Successor {
            key: course_key("50", Some("307"), c.start),
            count: 1,
            total: 1
        })
    );

    let days = h.vehicle_days("233");
    assert_eq!(dates(&days), ["2026-10-03", "2026-09-30", "2026-09-29", "2026-09-28"]);
    let lines: Vec<&str> = days[3].courses.iter().map(|c| c.line_name.as_str()).collect();
    assert_eq!(lines, ["50", "16"], "by scheduled start");
    assert_eq!(days[3].courses[0].first_stop_name, "Czechowice-Dziedzice Silesia");
    assert_eq!(h.vehicle_days("999"), []);

    h.set_today("2026-10-30"); // drops what fell out of the 28 days
    assert_eq!(dates(&h.vehicle_days("233")), ["2026-10-03"]);
}

#[test]
fn chains_the_history_successor_then_the_timetable_until_the_depot() {
    let (a, b, c, d, sched) = (a(), b(), c(), d(), sched());
    let at = CourseEnd {
        line: a.line.clone(),
        first_sym: Some(a.first_sym.clone()),
        start: a.start,
        end: a.end,
        last_name: a.last_name.clone(),
        arrival: a.end + 120.0,
    };
    let key_a = course_key("50", Some("2375"), a.start);
    let key_b = course_key("16", Some("307"), b.start);
    let seen = |key: &str| {
        (key == key_a).then(|| Successor {
            key: key_b.clone(),
            count: 3,
            total: 3,
        })
    };
    let chain: Vec<_> = course_chain(at.clone(), &sched, seen, 5)
        .into_iter()
        .map(|s| (s.course.line, s.course.start, s.source, s.confidence))
        .collect();
    assert_eq!(
        chain,
        [
            (
                "16".to_owned(),
                b.start,
                PredictionSource::History,
                PredictionConfidence::High
            ),
            (
                "16".to_owned(),
                d.start,
                PredictionSource::Timetable,
                PredictionConfidence::Medium
            ),
        ],
        "stops after the course into the depot"
    );
    // no history: the same line from the terminus first, even after another line
    let one: Vec<_> = course_chain(at.clone(), &sched, |_: &str| None, 1)
        .into_iter()
        .map(|s| (s.course.line, s.course.start))
        .collect();
    assert_eq!(one, [("50".to_owned(), c.start)]);
    // arriving too late for any course within 45 min of the scheduled end
    let late = CourseEnd {
        arrival: a.end + 50.0 * 60.0,
        ..at
    };
    assert_eq!(course_chain(late, &sched, |_: &str| None, 5), []);
}

#[tokio::test]
async fn reads_the_day_files_and_predicts_from_history_in_the_tracker() {
    let (a, b) = (a(), b());
    let dir = TmpDir::new();
    for date in ["2026-09-28", "2026-09-29"] {
        let courses: Vec<Value> = [&a, &b]
            .iter()
            .enumerate()
            .map(|(i, c)| rec_json(&format!("{date}-{i}"), c))
            .collect();
        let day = json!({ "_v": 2, "233": { "todayCourses": courses } });
        std::fs::write(dir.path().join(format!("fleet-history-{date}.json")), day.to_string()).unwrap();
    }
    // Monday 2026-10-05 12:10 Warsaw (CEST)
    let clock = Clock::at(date_utc(2026, 9, 5, 10, 10, 0));
    let sched = Arc::new(sched());
    let t = FleetTracker::new(FleetTrackerOptions {
        static_fleet: None,
        schedule: Some(Arc::new(move |_: &str| Some(sched.clone()))),
        save_debounce_ms: 3_600_000,
        ..opts(Some(dir.path().to_path_buf()), &clock)
    });
    // the reads run on the blocking pool: poll every 20 ms, at most 3 s
    for _ in 0..150 {
        if t.vehicle_history("233").complete {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(t.vehicle_history("233").complete, "history loaded within 3 s");
    let counts: Vec<usize> = t.vehicle_history("233").days.iter().map(|d| d.courses.len()).collect();
    assert_eq!(counts, [2, 2]);

    let ms = |secs: f64| (date_utc(2026, 9, 5, 0, 0, 0) - 2 * 3_600_000) as f64 + secs * 1000.0;
    update(
        &t,
        &[json!({
            "vehicleId": "233",
            "lineName": "50",
            "courseLoid": 1,
            "direction": "Osiedle Karpackie",
            "delaySec": 120,
            "latitude": 49.93,
            "longitude": 19.0,
            "orderInCourse": 1,
            "stopPoints": [
                { "symbol": "2375", "name": a.first_name, "orderNo": 0, "distance": 0, "scheduledDeparture": ms(a.start), "plannedDeparture": ms(a.start) },
                { "symbol": "307", "name": a.last_name, "orderNo": 1, "distance": 9000, "scheduledDeparture": ms(a.end), "plannedDeparture": ms(a.end) },
            ],
        })],
    );
    let p = t
        .get_vehicle_detail("233")
        .and_then(|v| v.predicted_next_course)
        .expect("a predicted next course");
    assert_eq!(p.source, PredictionSource::History);
    assert_eq!(p.line_name, "16");
    assert_eq!(p.departure_time, "13:00");
    assert_eq!(p.confidence, PredictionConfidence::High);
    assert_eq!(p.seen, Some(PredictionSeen { days: 2, of: 2 }));
    assert_eq!(p.pause_minutes, 18, "arrives 12:42 (+2 min), leaves 13:00");
    let later: Option<Vec<_>> = p.later.map(|l| {
        l.into_iter()
            .map(|l| (l.line_name, l.departure_time, l.confidence))
            .collect()
    });
    assert_eq!(
        later,
        Some(vec![(
            "16".to_owned(),
            "13:40".to_owned(),
            PredictionConfidence::Medium
        )])
    );
}
