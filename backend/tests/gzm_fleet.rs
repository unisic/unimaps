//! test/gzm-fleet.test.ts: the GZM fleet input, the GZM-configured tracker and the default MZK tracker's output shape.
//! The TS `mock.timers` Date is the tracker's injected clock; the TS swap of the global tracker is the `*_of` /
//! `feed_fleet` / `fleet_list_body` variants taking a tracker.

#[allow(dead_code)]
#[path = "support/fleet.rs"]
mod fleet;

use std::path::PathBuf;
use std::sync::Arc;

use fleet::{Clock, NOON_OCT4_MS, TmpDir, input, opts, stop, with};
use serde_json::{Value, json};
use unimaps::fleet_tracker::{FleetSummaryFilter, FleetTracker, FleetTrackerOptions};
use unimaps::gzm::{GzmFleetSource, GzmFleetStop, GzmLiveVehicle, GzmNextTrip};
use unimaps::gzm_fleet::{
    feed_fleet, fleet_list_body, gzm_company, gzm_fleet_input, gzm_fleet_options, gzm_length_by_number, idle_detail_of,
    is_gzm_side,
};
use unimaps::js::JsNum;
use unimaps::shared::fleet::{CourseStatus, FleetLengthCategory, FleetOperator, LastKnownLocation, VehicleStatus};

/// 2026-10-04 12:00:00 Europe/Warsaw = service-day second 43 200
const NOON: i32 = 43_200;

fn gstop(id: &str, name: &str, dep: i32, dist_m: Option<f64>) -> GzmFleetStop {
    GzmFleetStop {
        id: id.into(),
        name: name.into(),
        dep,
        dist_m,
    }
}

// Side numbers 9xxx are absent from lib/phototrans.json on purpose: a listed vehicle takes its model from there.
/// Brigade 69/1 at noon: 11:40 -> 12:05, served the second of three stops.
fn src() -> GzmFleetSource {
    GzmFleetSource {
        side: "283_9285".into(),
        label: "9285".into(),
        model: Some("Solaris Urbino 12".into()),
        vehicle_type: "3".into(),
        line: "69".into(),
        brigade: Some("1".into()),
        trip_id: "0123456789abcdef".into(),
        headsign: "Sosnowiec Pętla".into(),
        stops: vec![
            gstop("s1", "Katowice Dworzec", NOON - 1200, Some(0.0)),
            gstop("s2", "Katowice Rondo", NOON - 600, Some(1500.0)),
            gstop("s3", "Sosnowiec Pętla", NOON + 300, Some(6000.0)),
        ],
        served_idx: Some(1),
        next_idx: Some(2),
        reached_m: Some(2500.0),
        at_stop: false,
        not_started: false,
        delay_sec: Some(60.0),
        lat: 50.26,
        lon: 19.03,
        bearing: Some(90.0),
        fix_at: Some((NOON_OCT4_MS / 1000 - 4) as f64),
        next_trips: vec![],
    }
}

/// The same brigade's next trip: 12:15 back from the terminus.
fn second_trip() -> GzmFleetSource {
    GzmFleetSource {
        trip_id: "fedcba9876543210".into(),
        headsign: "Katowice Dworzec".into(),
        stops: vec![
            gstop("s3", "Sosnowiec Pętla", NOON + 900, Some(0.0)),
            gstop("s1", "Katowice Dworzec", NOON + 2400, Some(6000.0)),
        ],
        served_idx: Some(0),
        next_idx: Some(1),
        reached_m: Some(200.0),
        ..src()
    }
}

/// TS `createGzmFleetTracker(dir)` while `mock.timers` is enabled
fn gzm_tracker(clock: &Clock, dir: Option<PathBuf>) -> FleetTracker {
    FleetTracker::new(FleetTrackerOptions {
        now: clock.now_fn(),
        ..gzm_fleet_options(dir)
    })
}

/// TS `t.updateFromRunningVehicles(sources.map(gzmFleetInput))`
fn update(t: &FleetTracker, sources: &[GzmFleetSource]) {
    let running: Vec<_> = sources.iter().map(gzm_fleet_input).collect();
    t.update_from_running_vehicles(&running, None, None);
}

fn summary(t: &FleetTracker) -> Vec<unimaps::shared::fleet::FleetSummaryItem> {
    t.get_fleet_summary(&FleetSummaryFilter::default())
}

/* ---------------- gzm-fleet input ---------------- */

#[test]
fn maps_a_gzm_source_to_the_tracker_input() {
    let v = gzm_fleet_input(&src());
    assert_eq!(v.vehicle_id, "283_9285");
    assert_eq!(v.course_loid, 0x0123456789ab);
    assert_eq!(v.line_name, "69");
    assert_eq!(v.direction, "Sosnowiec Pętla");
    assert_eq!(v.delay_sec, 60.0);
    assert_eq!(v.angle, Some(90.0));
    assert_eq!(v.last_ping_date, Some((NOON_OCT4_MS - 4000) as f64));
    assert_eq!(v.reached_meters, Some(2500.0));
    // orderNo is the stop's index by construction (TS `orderNo: i`); the Rust input carries the order as the index
    assert_eq!(
        v.stop_points
            .iter()
            .enumerate()
            .map(|(i, s)| (s.symbol.as_str(), i, s.distance))
            .collect::<Vec<_>>(),
        [("s1", 0, 0.0), ("s2", 1, 1500.0), ("s3", 2, 4500.0)]
    );
    assert_eq!(
        v.stop_secs,
        Some(vec![
            i64::from(NOON - 1200),
            i64::from(NOON - 600),
            i64::from(NOON + 300)
        ])
    );
    assert_eq!(v.served_idx, Some(1));
    assert_eq!(v.next_idx, Some(2));
    assert_eq!(v.brigade.as_deref(), Some("1"));
    assert_eq!(v.label.as_deref(), Some("9285"));
    assert_eq!(v.company.as_deref(), Some("PKM Tychy"));
    assert_eq!(v.not_started, Some(false));
}

#[test]
fn drops_distances_unless_every_stop_has_one_and_reads_a_null_delay_as_on_time() {
    let v = gzm_fleet_input(&GzmFleetSource {
        delay_sec: None,
        bearing: None,
        fix_at: None,
        stops: vec![gstop("s1", "A", NOON, Some(0.0)), gstop("s2", "B", NOON + 60, None)],
        ..src()
    });
    assert_eq!(v.delay_sec, 0.0);
    assert_eq!(v.angle, None);
    assert_eq!(v.last_ping_date, None);
    assert_eq!(v.reached_meters, None);
    assert_eq!(v.stop_points.iter().map(|s| s.distance).collect::<Vec<_>>(), [0.0, 0.0]);
}

#[test]
fn names_companies_by_their_code_and_validates_keys() {
    assert_eq!(gzm_company("125_712"), "Tramwaje Śląskie");
    assert_eq!(gzm_company("999_1"), "Przewoźnik 999");
    assert!(is_gzm_side("283_9285"));
    assert!(!is_gzm_side("283"));
    assert!(!is_gzm_side("283_9285/../x"));
}

/* ---------------- gzm-fleet tracker ---------------- */

#[test]
fn splits_a_brigades_consecutive_trips_into_two_courses_the_first_archived_completed() {
    let clock = Clock::at(NOON_OCT4_MS);
    let t = gzm_tracker(&clock, None);
    update(&t, &[src()]);
    clock.set(NOON_OCT4_MS + 6 * 60_000);
    update(&t, &[second_trip()]);

    let d = t.get_vehicle_detail("283_9285").expect("vehicle");
    assert_eq!(d.operator, FleetOperator::Gzm);
    assert_eq!(d.label.as_deref(), Some("9285"));
    assert_eq!(d.company.as_deref(), Some("PKM Tychy"));
    let cur = d.current_course.as_ref();
    assert_eq!(cur.and_then(|c| c.course_loid), Some(0xfedcba987654));
    assert_eq!(cur.and_then(|c| c.brigade.as_deref()), Some("1"));
    assert_eq!(cur.map(|c| c.start_time.as_str()), Some("12:15"));
    assert_eq!(d.today_courses.len(), 1);
    let first = &d.today_courses[0];
    assert_eq!(first.course_loid, Some(0x0123456789ab));
    assert_eq!(first.status, CourseStatus::Completed);
    assert_eq!(first.brigade.as_deref(), Some("1"));
    assert_eq!(first.start_time, "11:40");
    assert_eq!(first.end_time, "12:05");
    assert_eq!(first.driven_meters, Some(JsNum(6000.0)));
    // GZM keeps no stop table for finished courses (day-file size)
    assert_eq!(first.stops, None);
    assert_eq!(d.stats.total_courses_today, 2);

    let rows = summary(&t);
    let row = &rows[0];
    assert_eq!(row.side_number, "283_9285");
    assert_eq!(row.label.as_deref(), Some("9285"));
    assert_eq!(row.company.as_deref(), Some("PKM Tychy"));
    assert_eq!(row.brigade.as_deref(), Some("1"));
}

#[test]
fn does_not_archive_a_course_that_never_began() {
    let clock = Clock::at(NOON_OCT4_MS);
    let t = gzm_tracker(&clock, None);
    update(
        &t,
        &[GzmFleetSource {
            not_started: true,
            served_idx: None,
            next_idx: Some(0),
            ..src()
        }],
    );
    let rows = summary(&t);
    let waiting = &rows[0];
    assert_eq!(waiting.not_started, Some(true));
    assert_eq!(waiting.delay_sec, None);

    clock.set(NOON_OCT4_MS + 60_000);
    update(&t, &[second_trip()]);
    assert_eq!(t.get_vehicle_detail("283_9285").map(|d| d.today_courses.len()), Some(0));

    clock.set(NOON_OCT4_MS + 2 * 60_000);
    let t2 = gzm_tracker(&clock, None);
    update(
        &t2,
        &[GzmFleetSource {
            not_started: true,
            ..src()
        }],
    );
    update(&t2, &[]);
    let gone = t2.get_vehicle_detail("283_9285");
    assert_eq!(gone.as_ref().map(|d| d.status), Some(VehicleStatus::Depot));
    assert_eq!(gone.map(|d| d.today_courses.len()), Some(0));
}

fn next_trip(line: &str, headsign: &str, first_stop_name: &str, first_stop_id: &str, dep: i32) -> GzmNextTrip {
    GzmNextTrip {
        line: line.into(),
        headsign: headsign.into(),
        first_stop_name: first_stop_name.into(),
        first_stop_id: first_stop_id.into(),
        dep,
    }
}

#[test]
fn predicts_the_next_courses_from_the_brigades_next_scheduled_trips() {
    let clock = Clock::at(NOON_OCT4_MS);
    let t = gzm_tracker(&clock, None);
    let next_trips = vec![
        next_trip("69", "Katowice Dworzec", "Sosnowiec Pętla", "s3", NOON + 900),
        next_trip("69", "Sosnowiec Pętla", "Katowice Dworzec", "s1", NOON + 3900),
    ];
    update(&t, &[GzmFleetSource { next_trips, ..src() }]);
    let p = t.get_vehicle_detail("283_9285").and_then(|d| d.predicted_next_course);
    assert_eq!(
        serde_json::to_value(p).ok(),
        Some(json!({
            "lineName": "69",
            "direction": "Katowice Dworzec",
            "departureTime": "12:15",
            "departureSecs": NOON + 900,
            "fromStopName": "Sosnowiec Pętla",
            "fromStopSymbol": "s3",
            // ends 12:05 +1 min late, leaves 12:15
            "pauseMinutes": 9,
            "confidence": "high",
            "source": "schedule",
            "reason": "Według rozkładu brygady 69/1.",
            "later": [{
                "lineName": "69",
                "direction": "Sosnowiec Pętla",
                "departureTime": "13:05",
                "fromStopName": "Katowice Dworzec",
                "confidence": "high",
            }],
        }))
    );
}

#[test]
fn wraps_a_next_trip_past_midnight_service_day_seconds_over_86_400() {
    let clock = Clock::at(NOON_OCT4_MS);
    let t = gzm_tracker(&clock, None);
    let late = GzmFleetSource {
        delay_sec: Some(0.0),
        stops: vec![
            gstop("s1", "A", 85_000, Some(0.0)),
            gstop("s2", "B", 86_100, Some(900.0)),
        ],
        served_idx: Some(0),
        next_idx: Some(1),
        next_trips: vec![next_trip("69", "A", "B", "s2", 86_400 + 600)],
        ..src()
    };
    update(&t, &[late]);
    let p = t.get_vehicle_detail("283_9285").and_then(|d| d.predicted_next_course);
    assert_eq!(p.as_ref().map(|p| p.departure_time.as_str()), Some("00:10"));
    assert_eq!(p.as_ref().map(|p| p.departure_secs), Some(JsNum(600.0)));
    assert_eq!(p.map(|p| p.pause_minutes), Some(15));
}

#[test]
fn sorts_by_company_then_fleet_number_numerically() {
    let clock = Clock::at(NOON_OCT4_MS);
    let t = gzm_tracker(&clock, None);
    let sides = ["283_9285", "108_12", "2_900", "108_3"];
    let sources: Vec<_> = sides
        .iter()
        .enumerate()
        .map(|(i, side)| GzmFleetSource {
            side: (*side).into(),
            label: side.split('_').nth(1).unwrap_or_default().into(),
            trip_id: i.to_string().repeat(16),
            ..src()
        })
        .collect();
    update(&t, &sources);
    assert_eq!(
        summary(&t).iter().map(|v| v.side_number.as_str()).collect::<Vec<_>>(),
        ["2_900", "108_3", "108_12", "283_9285"]
    );
}

#[test]
fn feeds_only_trips_with_a_course_key_and_caches_the_list_body_per_update() {
    let clock = Clock::at(NOON_OCT4_MS);
    let t = gzm_tracker(&clock, None);
    feed_fleet(
        &t,
        &[
            src(),
            GzmFleetSource {
                side: "108_3".into(),
                trip_id: String::new(),
                ..src()
            },
        ],
    );
    let a = fleet_list_body(&t);
    let body: Value = serde_json::from_str(&a.body).expect("list body is JSON");
    assert_eq!(body["count"], json!(1));
    assert_eq!(body["vehicles"][0]["sideNumber"], json!("283_9285"));
    assert!(body.get("serverNow").is_none());
    let tag = a.etag.as_bytes();
    assert!(
        tag.len() == 24
            && tag[0] == b'"'
            && tag[23] == b'"'
            && tag[1..23]
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-'),
        "etag {}",
        a.etag
    );
    assert!(Arc::ptr_eq(&fleet_list_body(&t), &a));

    clock.set(NOON_OCT4_MS + 10_000);
    feed_fleet(
        &t,
        &[GzmFleetSource {
            delay_sec: Some(240.0),
            ..src()
        }],
    );
    assert_ne!(fleet_list_body(&t).etag, a.etag);
}

#[test]
fn gives_a_vehicle_on_the_map_but_never_on_a_course_an_idle_card_without_storing_it() {
    let clock = Clock::at(NOON_OCT4_MS);
    let t = gzm_tracker(&clock, None);
    let fix_at = NOON_OCT4_MS / 1000 - 15;
    let d = idle_detail_of(
        &t,
        "104_9008",
        &GzmLiveVehicle {
            label: "9008".into(),
            model: Some("Mercedes Citaro".into()),
            line: "744".into(),
            lat: 50.3,
            lon: 18.9,
            fix_at: fix_at as f64,
        },
    );
    assert_eq!(d.side_number, "104_9008");
    assert_eq!(d.label.as_deref(), Some("9008"));
    assert_eq!(d.company.as_deref(), Some("PKM Świerklaniec"));
    assert_eq!(d.model, "Mercedes Citaro");
    assert_eq!(d.status, VehicleStatus::Depot);
    assert_eq!(d.current_course, None);
    assert_eq!(d.last_seen_at, fix_at);
    assert_eq!(
        d.last_known_location,
        Some(LastKnownLocation {
            lat: JsNum(50.3),
            lon: JsNum(18.9),
            name: "Na mapie bez kursu, linia 744".into(),
        })
    );
    assert_eq!(t.get_vehicle_detail("104_9008"), None);
}

#[test]
fn reads_the_length_class_from_the_fleet_number_block() {
    use FleetLengthCategory::{Maxi, Mega};
    // real vehicles, 2026-11-08: model as GZM publishes it
    let cases = [
        ("283_4271", Some(Maxi)), // MAN NL273 Lion`s City CNG
        ("120_313", Some(Maxi)),  // 0313, PKM Gliwice
        ("120_670", Some(Mega)),  // 0670, Solaris Urbino 18
        ("107_5405", Some(Mega)), // BMC Procity 18LF
        ("116_5605", Some(Maxi)), // Isuzu Citiport 12
        ("116_5903", Some(Mega)), // Mercedes-Benz Conecto G
        ("118_6115", Some(Maxi)), // BMC Procity 12LF
        ("118_6401", Some(Mega)), // Mercedes-Benz Conecto G
        ("134_8216", Some(Maxi)), // Iveco Streetway 12M
        ("118_6051", None),       // BMC Neocity 8,5LF: the first 100 mix mini and midi
        ("108_1346", None),       // Solaris Urbino 18: PKM Katowice does not follow the blocks
        ("119_7", None),          // an old number outside Sosnowiec's 2xxx
        ("284_4903", None),       // TLT 49xx
        ("125_801", None),        // a tram
        ("120_x", None),
    ];
    for (side, want) in cases {
        assert_eq!(gzm_length_by_number(side), want, "{side}");
    }
}

#[test]
fn restores_a_day_of_a_vehicle_without_a_static_fleet_from_its_own_file() {
    let clock = Clock::at(NOON_OCT4_MS);
    let dir = TmpDir::new();
    let t = gzm_tracker(&clock, Some(dir.path().to_path_buf()));
    update(&t, &[src()]);
    clock.set(NOON_OCT4_MS + 6 * 60_000);
    update(&t, &[second_trip()]);
    t.flush_sync();
    let files: Vec<String> = std::fs::read_dir(dir.path())
        .expect("history dir")
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    assert_eq!(files, ["fleet-history-2026-10-04.json"]);

    let back = gzm_tracker(&clock, Some(dir.path().to_path_buf()))
        .get_vehicle_detail("283_9285")
        .expect("restored vehicle");
    assert_eq!(back.label.as_deref(), Some("9285"));
    assert_eq!(back.company.as_deref(), Some("PKM Tychy"));
    assert_eq!(back.model, "Solaris Urbino 12");
    assert_eq!(back.today_courses.len(), 1);
    assert_eq!(back.today_courses[0].brigade.as_deref(), Some("1"));
    assert_eq!(back.current_course.and_then(|c| c.course_loid), Some(0xfedcba987654));
}

/* ---------------- default MZK tracker ---------------- */

/// The keys of a serialized object, in order.
fn keys(v: &impl serde::Serialize) -> Vec<String> {
    match serde_json::to_value(v) {
        Ok(Value::Object(o)) => o.keys().cloned().collect(),
        _ => vec![],
    }
}

/// The TS `Object.keys` list as JSON.stringify writes it: a key holding `undefined` in the TS object is listed by
/// Object.keys but absent from the JSON, and the Rust structs serialize the JSON. `undefined` = the keys the TS
/// object holds as undefined in this scenario (checked by running the TS rig).
fn wire_keys(ts_keys: &[&str], undefined: &[&str]) -> Vec<String> {
    ts_keys
        .iter()
        .filter(|k| !undefined.contains(k))
        .map(|k| (*k).to_owned())
        .collect()
}

#[test]
fn keeps_its_output_unchanged_for_an_existing_style_input() {
    // the wire and file shape of the MZK fleet, key order included: GZM fields never leak in
    let base = NOON_OCT4_MS - 20 * 60_000;
    let out = json!({
        "vehicleId": "233",
        "lineName": "50",
        "courseLoid": 1,
        "direction": "Os. Karpackie",
        "delaySec": 120,
        "latitude": 49.9,
        "longitude": 19.0,
        "orderInCourse": 2,
        "lastStopOrderNo": 1,
        "reachedMeters": 500,
        "stopPoints": [
            stop("1", "Czechowice-Dziedzice Silesia", 0, 0.0, base),
            stop("2", "B", 1, 400.0, base + 60_000),
            stop("3", "Osiedle Karpackie", 2, 900.0, base + 600_000),
        ],
    });
    let back = with(
        &out,
        json!({
            "courseLoid": 2,
            "direction": "Czechowice-Dziedzice Silesia",
            "orderInCourse": 1,
            "lastStopOrderNo": 0,
            "stopPoints": [
                stop("3", "Osiedle Karpackie", 0, 0.0, base + 900_000),
                stop("2", "B", 1, 400.0, base + 960_000),
                stop("1", "Czechowice-Dziedzice Silesia", 2, 900.0, base + 1_500_000),
            ],
        }),
    );

    let clock = Clock::at(NOON_OCT4_MS);
    let t = FleetTracker::new(opts(None, &clock));
    t.update_from_running_vehicles(&[input(&out)], None, None);
    clock.set(NOON_OCT4_MS + 60_000);
    t.update_from_running_vehicles(&[input(&back)], None, None);

    let d = t.get_vehicle_detail("233").expect("vehicle 233");
    let cur = d.current_course.as_ref().expect("current course");
    assert_eq!(d.operator, FleetOperator::Mzk);
    assert_eq!(
        keys(&d),
        wire_keys(
            &[
                "sideNumber",
                "operator",
                "model",
                "producer",
                "year",
                "lengthCategory",
                "fuelType",
                "features",
                "status",
                "lines",
                "mainLine",
                "currentCourse",
                "predictedNextCourse",
                "todayCourses",
                "lastSeenAt",
                "lastKnownLocation",
                "stats",
            ],
            &[]
        )
    );
    assert_eq!(
        keys(cur),
        wire_keys(
            &[
                "id",
                "courseLoid",
                "lineName",
                "direction",
                "firstStopName",
                "lastStopName",
                "firstStopSymbol",
                "lastStopSymbol",
                "startTime",
                "endTime",
                "startSecs",
                "endSecs",
                "delaySec",
                "notStarted",
                "atStop",
                "stopsCount",
                "currentStopIndex",
                "currentStopName",
                "nextStopName",
                "lat",
                "lon",
                "bearing",
                "progressPct",
                "lengthMeters",
                "drivenMeters",
                "status",
                "stops",
            ],
            &[]
        )
    );
    assert_eq!(
        keys(&d.today_courses[0]),
        wire_keys(
            &[
                "id",
                "courseLoid",
                "lineName",
                "direction",
                "firstStopName",
                "lastStopName",
                "firstStopSymbol",
                "lastStopSymbol",
                "startTime",
                "endTime",
                "startSecs",
                "endSecs",
                "delaySec",
                "stopsCount",
                "status",
                "cancelledReason",
                "cancelledAtStopName",
                "completedAt",
                "lengthMeters",
                "drivenMeters",
                "stops",
            ],
            &["cancelledReason", "cancelledAtStopName"]
        )
    );
    assert_eq!(d.today_courses[0].stops.as_ref().map(Vec::len), Some(3));
    let rows = summary(&t);
    let row = rows.iter().find(|x| x.side_number == "233").expect("row 233");
    assert_eq!(
        keys(row),
        wire_keys(
            &[
                "sideNumber",
                "model",
                "producer",
                "year",
                "lengthCategory",
                "fuelType",
                "status",
                "lines",
                "lineName",
                "direction",
                "startTime",
                "firstStopName",
                "currentStopName",
                "nextStopName",
                "atStop",
                "delaySec",
                "notStarted",
                "progressPct",
                "coursesCountToday",
                "cancelledCoursesToday",
                "kmToday",
                "lastSeenAt",
                "lastLineName",
            ],
            &["notStarted", "lastLineName"]
        )
    );
    assert_eq!(
        serde_json::to_value(&d.predicted_next_course).ok(),
        Some(json!({
            "lineName": "50",
            "direction": "Osiedle Karpackie",
            "departureTime": "12:10",
            "departureSecs": 43_800,
            "fromStopName": "Czechowice-Dziedzice Silesia",
            "fromStopSymbol": "1",
            "pauseMinutes": 3,
            "confidence": "medium",
            "source": "estimate",
            "reason": "Pojazd kursuje dziś wahadłowo na linii 50, postój na pętli ok. 5 min.",
        }))
    );
}
