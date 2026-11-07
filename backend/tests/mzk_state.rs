//! Port of test/mzk-state.test.ts (real OnTime records from test/fixtures/mzk-lifecycle.json) plus the golden
//! vectors of scripts/dump-vectors.ts.

use serde::Deserialize;
use serde_json::{Value, json};
use unimaps::mzk_state::{
    MZK_NOT_STARTED_MAX_FROM_FIRST_M, MZK_NOT_STARTED_REACHED_M, MzkLifecycleInput, MzkRowTiming, MzkRowTimingInput,
    clamp_planned_monotone, has_planned_dip, is_mzk_not_started, mzk_row_timing,
};

#[derive(Deserialize)]
struct LatLon {
    lat: f64,
    lon: f64,
}

fn ns(v: Value, first: Option<(f64, f64)>) -> bool {
    is_mzk_not_started(&MzkLifecycleInput::from_json(&v), first)
}

#[test]
fn real_ontime_records() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        label: String,
        expect_not_started: bool,
        record: Value,
    }
    let fixtures: Vec<Fixture> = serde_json::from_str(include_str!("../../test/fixtures/mzk-lifecycle.json")).unwrap();
    assert!(!fixtures.is_empty());
    for f in fixtures {
        let first: LatLon = serde_json::from_value(f.record["firstStop"].clone()).unwrap();
        assert_eq!(
            ns(f.record.clone(), Some((first.lat, first.lon))),
            f.expect_not_started,
            "{}",
            f.label
        );
        // the coordinate guard is a safety net only: without first-stop coords the flags decide
        assert_eq!(ns(f.record, None), f.expect_not_started, "{}", f.label);
    }
}

const FIRST: Option<(f64, f64)> = Some((49.8, 19.0));

#[test]
fn order_in_course_ge_1_is_running() {
    for order in [1, 2, 5, 22] {
        let v = json!({"orderInCourse": order, "lastStopOrderNo": null, "reachedMeters": 0, "latitude": 49.8, "longitude": 19.0});
        assert!(!ns(v, FIRST));
    }
}

#[test]
fn last_stop_ge_1_is_running() {
    let v = json!({"orderInCourse": 0, "lastStopOrderNo": 1, "reachedMeters": 0, "latitude": 49.8, "longitude": 19.0});
    assert!(!ns(v, FIRST));
}

#[test]
fn last_stop_0_only_while_not_moved() {
    let with = |reached: Value| {
        let mut v = json!({"orderInCourse": 0, "lastStopOrderNo": 0, "latitude": 49.8, "longitude": 19.0});
        if !reached.is_null() {
            v["reachedMeters"] = reached;
        }
        ns(v, FIRST)
    };
    assert!(with(json!(0)));
    assert!(with(json!(MZK_NOT_STARTED_REACHED_M - 1.0)));
    assert!(!with(json!(MZK_NOT_STARTED_REACHED_M)));
    assert!(!with(json!(464)));
    // reachedMeters missing -> treated as 0 (still parked)
    assert!(with(Value::Null));
}

#[test]
fn far_from_first_stop_has_left() {
    let far = 49.8 + (MZK_NOT_STARTED_MAX_FROM_FIRST_M + 50.0) / 111_320.0;
    let v = |lat: f64| json!({"orderInCourse": 0, "lastStopOrderNo": null, "reachedMeters": 0, "latitude": lat, "longitude": 19.0});
    assert!(!ns(v(far), FIRST));
    assert!(ns(v(far), None)); // no coordinates -> flags only
    assert!(ns(v(49.8 + 100.0 / 111_320.0), FIRST)); // 100 m: a layover pocket
}

#[test]
fn garbled_input_is_started() {
    let at = |mut v: Value| {
        v["latitude"] = json!(49.8);
        v["longitude"] = json!(19.0);
        v
    };
    assert!(!ns(json!({}), FIRST));
    // field absent (not an OnTime record): started; explicit null (OnTime: no stop confirmed yet): not started
    assert!(!ns(at(json!({"orderInCourse": 0})), FIRST));
    assert!(ns(at(json!({"orderInCourse": 0, "lastStopOrderNo": null})), FIRST));
    assert!(!ns(json!({"orderInCourse": "0"}), FIRST));
    assert!(!ns(json!({"orderInCourse": null}), FIRST));
    // a garbled order must not be rescued by a null lastStopOrderNo
    assert!(!ns(at(json!({"orderInCourse": null, "lastStopOrderNo": null})), FIRST));
    assert!(!ns(at(json!({"orderInCourse": -1, "lastStopOrderNo": null})), FIRST));
    assert!(!ns(at(json!({"lastStopOrderNo": null})), FIRST));
    // NaN cannot come from JSON; the struct still treats it as garbled
    let nan = MzkLifecycleInput {
        order_in_course: Some(f64::NAN),
        ..Default::default()
    };
    assert!(!is_mzk_not_started(&nan, FIRST));
}

const MIN: f64 = 60_000.0;
fn sec(h: f64, m: f64) -> f64 {
    h * 3600.0 + m * 60.0
}
fn ms(h: f64, m: f64) -> f64 {
    sec(h, m) * 1000.0
}
fn timing(time: &str, time_diff: f64, is_estimated: bool) -> MzkRowTiming {
    MzkRowTiming {
        time: time.into(),
        time_diff,
        is_estimated,
    }
}

#[test]
fn row_not_started_late_is_earliest_possible() {
    let r = mzk_row_timing(&MzkRowTimingInput {
        scheduled_departure_sec: sec(15.0, 12.0),
        scheduled_departure: ms(15.0, 12.0),
        real_departure: Some(ms(15.0, 12.0) + 16.0 * MIN),
        lack: false,
        not_started: true,
        first_scheduled_ms: Some(ms(15.0, 5.0)),
        now_ms: ms(15.0, 22.0),
    });
    assert_eq!(r, timing("15:29", 0.0, false));
}

#[test]
fn row_not_started_early_is_schedule() {
    let r = mzk_row_timing(&MzkRowTimingInput {
        scheduled_departure_sec: sec(23.0, 16.0),
        scheduled_departure: ms(23.0, 16.0),
        real_departure: Some(ms(23.0, 16.0) - MIN),
        lack: false,
        not_started: true,
        first_scheduled_ms: Some(ms(23.0, 15.0)),
        now_ms: ms(22.0, 55.0),
    });
    assert_eq!(r, timing("23:16", 0.0, false));
}

#[test]
fn row_running_is_estimate() {
    let r = mzk_row_timing(&MzkRowTimingInput {
        scheduled_departure_sec: sec(15.0, 17.0),
        scheduled_departure: ms(15.0, 17.0),
        real_departure: Some(ms(15.0, 17.0) + 6.0 * MIN),
        lack: false,
        not_started: false,
        first_scheduled_ms: None,
        now_ms: ms(15.0, 22.0),
    });
    assert_eq!(r, timing("15:23", 360.0, true));
}

#[test]
fn row_no_estimate_wraps_midnight() {
    let base = MzkRowTimingInput {
        scheduled_departure_sec: sec(0.0, 34.0),
        scheduled_departure: 0.0,
        real_departure: None,
        lack: true,
        not_started: false,
        first_scheduled_ms: None,
        now_ms: 0.0,
    };
    assert_eq!(mzk_row_timing(&base), timing("00:34", 0.0, false));
    // 00:00 scheduled but running 60 s early: used to print "-1:59"
    let early = MzkRowTimingInput {
        scheduled_departure_sec: 0.0,
        scheduled_departure: 1_000_000.0,
        real_departure: Some(1_000_000.0 - 60_000.0),
        lack: false,
        ..base
    };
    assert_eq!(mzk_row_timing(&early).time, "23:59");
}

fn some(xs: &[f64]) -> Vec<Option<f64>> {
    xs.iter().map(|&x| Some(x)).collect()
}

#[test]
fn planned_dip() {
    assert!(has_planned_dip(&some(&[10.0, 11.0, 13.0, 12.0, 14.0]), 0.0));
    assert!(!has_planned_dip(&some(&[10.0, 11.0, 12.0, 13.0]), 0.0));
    assert!(!has_planned_dip(&[Some(10.0), None, Some(12.0), None, Some(14.0)], 0.0));
    // dips among already-passed stops are actual times, not estimates: untouched
    assert!(!has_planned_dip(&some(&[10.0, 9.0, 8.0, 12.0, 13.0]), 2.0));
}

#[test]
fn clamp_monotone() {
    let t = |hh: f64, mm: f64| (hh * 60.0 + mm) * 60_000.0;
    let planned = some(&[
        t(15., 18.),
        t(15., 19.),
        t(15., 21.),
        t(15., 22.),
        t(15., 23.),
        t(15., 19.),
        t(15., 27.),
    ]);
    let want = some(&[
        t(15., 18.),
        t(15., 19.),
        t(15., 21.),
        t(15., 22.),
        t(15., 23.),
        t(15., 23.),
        t(15., 27.),
    ]);
    assert_eq!(clamp_planned_monotone(&planned, 0.0), want);
    let planned = [
        Some(100.0),
        None,
        Some(90.0),
        Some(80.0),
        Some(120.0),
        None,
        Some(110.0),
    ];
    let want = [
        Some(100.0),
        None,
        Some(90.0),
        Some(80.0),
        Some(120.0),
        None,
        Some(120.0),
    ];
    assert_eq!(clamp_planned_monotone(&planned, 3.0), want);
    let mono = some(&[1.0, 2.0, 2.0, 3.0, 5.0]);
    assert_eq!(clamp_planned_monotone(&mono, 0.0), mono);
    assert_eq!(
        clamp_planned_monotone(&[Some(f64::NAN), Some(f64::INFINITY)], 0.0),
        [None, None]
    );
}

#[derive(Deserialize)]
struct NotStartedCase {
    rec: Value,
    #[serde(rename = "firstStop")]
    first_stop: Option<LatLon>,
    out: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClampCase {
    planned: Vec<Option<f64>>,
    from_idx: f64,
    out: Vec<Option<f64>>,
    dip: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowIn {
    scheduled_departure_sec: f64,
    scheduled_departure: f64,
    real_departure: Option<f64>,
    #[serde(default)]
    lack: bool,
    not_started: bool,
    first_scheduled_ms: Option<f64>,
    now_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowOut {
    time: String,
    time_diff: f64,
    is_estimated: bool,
}

#[derive(Deserialize)]
struct RowCase {
    #[serde(rename = "in")]
    inp: RowIn,
    out: RowOut,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    not_started: Vec<NotStartedCase>,
    clamps: Vec<ClampCase>,
    rows: Vec<RowCase>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("vectors/mzk_state.json")).unwrap()
}

#[test]
fn golden_not_started() {
    let v = vectors();
    assert!(v.not_started.len() >= 2000 && v.not_started.iter().filter(|c| c.out).count() > 100);
    for c in &v.not_started {
        assert_eq!(
            ns(c.rec.clone(), c.first_stop.as_ref().map(|f| (f.lat, f.lon))),
            c.out,
            "{} {:?}",
            c.rec,
            c.first_stop.as_ref().map(|f| (f.lat, f.lon))
        );
    }
}

#[test]
fn golden_clamps() {
    let v = vectors();
    assert!(v.clamps.len() >= 800 && v.clamps.iter().filter(|c| c.dip).count() > 100);
    for c in &v.clamps {
        assert_eq!(
            clamp_planned_monotone(&c.planned, c.from_idx),
            c.out,
            "{:?} {}",
            c.planned,
            c.from_idx
        );
        assert_eq!(
            has_planned_dip(&c.planned, c.from_idx),
            c.dip,
            "{:?} {}",
            c.planned,
            c.from_idx
        );
    }
}

#[test]
fn golden_rows() {
    let v = vectors();
    assert!(v.rows.len() >= 1500);
    for c in &v.rows {
        let i = &c.inp;
        let got = mzk_row_timing(&MzkRowTimingInput {
            scheduled_departure_sec: i.scheduled_departure_sec,
            scheduled_departure: i.scheduled_departure,
            real_departure: i.real_departure,
            lack: i.lack,
            not_started: i.not_started,
            first_scheduled_ms: i.first_scheduled_ms,
            now_ms: i.now_ms,
        });
        assert_eq!(
            (got.time.as_str(), got.time_diff, got.is_estimated),
            (c.out.time.as_str(), c.out.time_diff, c.out.is_estimated),
            "{} {} {:?} {} {} {:?} {}",
            i.scheduled_departure_sec,
            i.scheduled_departure,
            i.real_departure,
            i.lack,
            i.not_started,
            i.first_scheduled_ms,
            i.now_ms
        );
    }
}
