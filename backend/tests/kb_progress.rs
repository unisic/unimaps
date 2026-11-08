//! test/kb-progress.test.ts, plus vectors/kb_progress.json (stepKbProgress replayed in TS over the real captures in
//! test/fixtures/kb-delay and seeded variants, every output compared).

use serde::Deserialize;
use serde_json::Value;
use unimaps::kb_progress::*;
use unimaps::poller::{is_feed_stale, kb_next_stop_index};
use unimaps::shared::polyline::{LatLng, prepare_polyline};
use unimaps::vehicle::VehiclePos;

const fn at(h: i64, m: i64, s: i64) -> f64 {
    (h * 3600 + m * 60 + s) as f64
}

fn wrap(x: f64) -> f64 {
    if x > 43200.0 {
        x - 86400.0
    } else if x < -43200.0 {
        x + 86400.0
    } else {
        x
    }
}

fn some(xs: &[f64]) -> Vec<Option<f64>> {
    xs.iter().map(|&x| Some(x)).collect()
}

/* ------------------------------------------------------------------ pure helpers */

const STOPS: [f64; 4] = [0.0, 1000.0, 2000.0, 3000.0];
const PLAN: [f64; 4] = [at(10, 0, 0), at(10, 2, 0), at(10, 4, 0), at(10, 6, 0)];

#[test]
fn planned_at_interpolates_clamps_and_is_flat_on_a_shared_minute() {
    let (s, p) = (some(&STOPS), some(&PLAN));
    assert_eq!(planned_at(&s, &p, 500.0), Some(at(10, 1, 0)));
    assert_eq!(planned_at(&s, &p, -50.0), Some(PLAN[0]));
    assert_eq!(planned_at(&s, &p, 9999.0), Some(PLAN[3]));
    assert_eq!(
        planned_at(&some(&[0.0, 500.0, 1000.0]), &some(&[100.0, 160.0, 160.0]), 750.0),
        Some(160.0)
    );
    assert_eq!(
        planned_at(&[None, Some(500.0)], &[None, Some(160.0)], 100.0),
        Some(160.0)
    );
    assert_eq!(planned_at(&[], &[], 0.0), None);
}

#[test]
fn planned_at_unwraps_midnight() {
    let p = planned_at(&some(&[0.0, 1000.0]), &some(&[at(23, 58, 0), 60.0]), 500.0).unwrap();
    assert_eq!(wrap(p - at(23, 59, 30)), 0.0);
}

#[test]
fn schedule_delay_on_time_late_early_origin_midnight() {
    let (s, p) = (some(&STOPS), some(&PLAN));
    assert_eq!(schedule_delay(&s, &p, 1500.0, at(10, 3, 0)), Some(0.0));
    assert_eq!(schedule_delay(&s, &p, 1500.0, at(10, 3, 0) + 150.0), Some(150.0));
    assert_eq!(schedule_delay(&s, &p, 1500.0, at(10, 3, 0) - 120.0), Some(-120.0));
    assert_eq!(
        schedule_delay(&s, &p, 10.0, at(10, 0, 0) - 300.0),
        Some(0.0),
        "early at the origin is not early running"
    );
    let late = schedule_delay(&s, &p, 10.0, at(10, 0, 0) + 90.0).unwrap();
    assert!((late - 90.0).abs() < 2.0, "a late departure is counted");
    let d = schedule_delay(
        &some(&[0.0, 1000.0]),
        &some(&[at(23, 58, 0), at(0, 4, 0)]),
        500.0,
        at(0, 2, 0),
    );
    assert_eq!(d, Some(60.0));
    assert_eq!(schedule_delay(&[None], &[None], 0.0, 0.0), None);
}

#[test]
fn progress_at_passed_next_and_the_stale_threshold() {
    let s = some(&STOPS);
    assert_eq!(
        progress_at(&s, 1010.0, Some(1)),
        Progress {
            last_idx: 1,
            next_idx: Some(2),
            stale: false,
            past_m: Some(10.0)
        }
    );
    assert!(!progress_at(&s, 1119.0, Some(1)).stale);
    assert!(progress_at(&s, 1121.0, Some(1)).stale);
    assert_eq!(progress_at(&s, 2500.0, Some(1)).last_idx, 2);
    assert_eq!(progress_at(&s, 3050.0, Some(1)).next_idx, None, "past the last stop");
    assert!(
        !progress_at(&s, 1500.0, None).stale,
        "no upstream index, nothing to compare"
    );
    let gap = [Some(0.0), None, Some(2000.0)];
    assert_eq!(
        progress_at(&gap, 2010.0, Some(1)).last_idx,
        2,
        "unplaced stops are skipped"
    );
    assert_eq!(
        progress_at(&gap, 10.0, Some(0)).next_idx,
        Some(2),
        "the next stop is the next placed one"
    );
    let open_end = [Some(0.0), Some(1000.0), Some(2000.0), None];
    assert_eq!(
        progress_at(&open_end, 2000.0, Some(0)).next_idx,
        None,
        "terminus unresolved"
    );
}

#[test]
fn straight_geom_aligns_stops_and_tolerates_unresolved_ones() {
    let g = straight_geom(&[Some([49.8, 19.0]), None, Some([49.81, 19.0]), Some([49.82, 19.0])]).unwrap();
    assert_eq!(g.stops.len(), 4);
    assert_eq!(g.stops[1], None);
    assert!(g.stops[3].unwrap() > g.stops[2].unwrap());
    assert!(
        straight_geom(&[Some([49.8, 19.0]), None]).is_none(),
        "fewer than two stops"
    );
}

/* ------------------------------------------------------------------ trackAlong */

const LAT0: f64 = 49.8;
const LON0: f64 = 19.0;

fn kx() -> f64 {
    111_320.0 * (LAT0 * (std::f64::consts::PI / 180.0)).cos()
}

fn p(east: f64, north: f64) -> LatLng {
    [LAT0 + north / 111_320.0, LON0 + east / kx()]
}

fn geom(pts: &[LatLng], stops: &[f64]) -> ProgressGeom {
    ProgressGeom {
        pl: prepare_polyline(pts).unwrap(),
        stops: some(stops),
        max_off_m: 150.0,
        pts: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn track(
    g: &ProgressGeom,
    pt: LatLng,
    t: f64,
    local: f64,
    plan: &[f64],
    vti: i64,
    next: i64,
    prev: Option<Track>,
) -> Option<(f64, TrackMode)> {
    track_along(g, pt[0], pt[1], t, local, &some(plan), Some(vti), Some(next), prev)
}

#[test]
fn track_never_moves_backwards_on_jitter_and_refuses_a_teleport() {
    let g = geom(&[p(0.0, 0.0), p(1500.0, 0.0)], &[0.0, 1500.0]);
    let plan = [36000.0, 36600.0];
    let a = track(&g, p(500.0, 3.0), 1000.0, 36000.0, &plan, 0, 1, None).unwrap();
    assert_eq!(a.1, TrackMode::Init);
    let b = track(
        &g,
        p(495.0, 3.0),
        1010.0,
        36010.0,
        &plan,
        0,
        1,
        Some(Track { d: a.0, t: 1000.0 }),
    )
    .unwrap();
    assert!(b.0 >= a.0);
    let c = track(
        &g,
        p(1400.0, 3.0),
        1012.0,
        36012.0,
        &plan,
        0,
        1,
        Some(Track { d: b.0, t: 1010.0 }),
    )
    .unwrap();
    assert_eq!(c, (b.0, TrackMode::Hold), "900 m in 2 s is not a plausible move");
    assert_eq!(
        track(&g, p(500.0, 900.0), 1020.0, 36020.0, &plan, 0, 1, None),
        None,
        "off the route"
    );
}

/// out-and-back: 1 km east, back 10 m north of it; stops 0 / 500 / apex 1000 / 1510 / 2010
fn loop_geom() -> (ProgressGeom, [f64; 5]) {
    let g = geom(
        &[p(0.0, 0.0), p(1000.0, 0.0), p(1000.0, 10.0), p(0.0, 10.0)],
        &[0.0, 500.0, 1000.0, 1510.0, 2010.0],
    );
    (
        g,
        [at(10, 0, 0), at(10, 5, 0), at(10, 10, 0), at(10, 15, 0), at(10, 20, 0)],
    )
}

#[test]
fn upstreams_last_registered_stop_is_a_hard_lower_bound() {
    let (g, plan) = loop_geom();
    let back = track(&g, p(300.0, 10.0), 1000.0, at(10, 17, 0), &plan, 3, 4, None).unwrap();
    assert!((back.0 - 1710.0).abs() < 2.0, "got {}", back.0);
    let out = track(&g, p(300.0, 0.0), 1000.0, at(10, 3, 0), &plan, 0, 1, None).unwrap();
    assert!((out.0 - 300.0).abs() < 2.0, "got {}", out.0);
}

#[test]
fn cold_start_prefers_in_sync_unless_the_stale_candidate_fits_clearly_better() {
    let (g, plan) = loop_geom();
    let near = track(&g, p(300.0, 5.0), 1000.0, at(10, 3, 0), &plan, 0, 1, None).unwrap();
    assert!((near.0 - 300.0).abs() < 2.0, "10:03 fits the outbound pass");
    let late = track(&g, p(300.0, 5.0), 1000.0, at(10, 17, 0), &plan, 0, 1, None).unwrap();
    assert!((late.0 - 1710.0).abs() < 2.0, "10:17 fits the return pass far better");
}

#[test]
fn cold_start_candidate_clamped_to_the_stale_window_keeps_its_real_distance() {
    let g = geom(
        &[p(0.0, 0.0), p(1000.0, 0.0), p(2000.0, 0.0), p(3000.0, 0.0)],
        &[0.0, 1000.0, 2000.0, 3000.0],
    );
    let plan = [at(10, 0, 0), at(10, 1, 0), at(11, 0, 0), at(11, 30, 0)];
    let r = track(&g, p(900.0, 0.0), 1000.0, at(10, 8, 5), &plan, 0, 1, None).unwrap();
    assert!((r.0 - 900.0).abs() < 2.0, "got {}", r.0);
}

#[test]
fn warm_monotone_window_keeps_the_leg_with_a_stale_index() {
    let (g, plan) = loop_geom();
    let mut prev = Track { d: 0.0, t: 1000.0 };
    let path = [
        (200.0, 0.0),
        (400.0, 0.0),
        (600.0, 0.0),
        (800.0, 0.0),
        (1000.0, 5.0),
        (800.0, 10.0),
        (600.0, 10.0),
        (400.0, 10.0),
        (200.0, 10.0),
    ];
    let mut last = 0.0;
    for (i, (x, y)) in path.into_iter().enumerate() {
        let t = 1010.0 + i as f64 * 10.0;
        let r = track(&g, p(x, y), t, at(10, 1, 0) + i as f64 * 10.0, &plan, 0, 1, Some(prev)).unwrap();
        assert!(r.0 >= last, "D never decreases ({last} -> {})", r.0);
        assert_ne!(r.1, TrackMode::Hold);
        last = r.0;
        prev = Track { d: r.0, t };
    }
    assert!(last > 1500.0, "ended on the return leg, got {last}");
}

/* ------------------------------------------------------------------ stepKbProgress */

struct Machine {
    geom: ProgressGeom,
    plan: Vec<Option<f64>>,
}

impl Machine {
    fn new() -> Self {
        let k = kx();
        let pts: Vec<Option<LatLng>> = (0..4).map(|i| Some([LAT0, LON0 + i as f64 * 1000.0 / k])).collect();
        Machine {
            geom: straight_geom(&pts).unwrap(),
            plan: some(&PLAN),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn step_at(
        &self,
        geom: &ProgressGeom,
        (lat, lon): (f64, f64),
        t: f64,
        local: f64,
        vti: i64,
        next: i64,
        delay_up: Option<f64>,
        prev: Option<&KbProgState>,
    ) -> KbProgOut {
        let inp = KbProgIn {
            geom,
            plan: &self.plan,
            lat,
            lon,
            t_epoch: t,
            local_secs: local,
            vti: Some(vti),
            next_up: Some(next),
            delay_up,
        };
        step_kb_progress(&inp, prev)
    }

    fn step(
        &self,
        pos: (f64, f64),
        t: f64,
        local: f64,
        delay_up: Option<f64>,
        prev: Option<&KbProgState>,
    ) -> KbProgOut {
        self.step_at(&self.geom, pos, t, local, 0, 1, delay_up, prev)
    }
}

/// 3 m north of the straight east-west route
fn on(east: f64) -> (f64, f64) {
    (LAT0 + 3.0 / 111_320.0, LON0 + east / kx())
}

const OFF: (f64, f64) = (LAT0 + 0.05, LON0 + 0.05);

#[test]
fn in_sync_keeps_upstreams_value() {
    let m = Machine::new();
    let o = m.step(on(300.0), 100.0, at(10, 1, 0), Some(60.0), None);
    assert!(!o.stale);
    assert_eq!(o.src, DelaySrc::Est);
    assert_eq!(o.delay, Some(60.0));
    assert!((o.dev.unwrap() - 24.0).abs() < 1.0, "dev {:?}", o.dev);
}

#[test]
fn stale_index_gives_the_schedule_deviation() {
    let m = Machine::new();
    let o1 = m.step(on(1500.0), 100.0, at(10, 3, 0), Some(60.0), None);
    assert!(o1.stale);
    assert_eq!(o1.src, DelaySrc::Gps);
    assert!(o1.delay.unwrap().abs() < 1.0, "got {:?}", o1.delay);
    assert_eq!((o1.last_idx, o1.next_idx), (Some(1), Some(2)));
    let o2 = m.step(on(1700.0), 120.0, at(10, 3, 20), Some(80.0), o1.state.as_ref());
    assert_eq!(o2.src, DelaySrc::Gps);
    assert!((o2.delay.unwrap() + 4.0).abs() < 2.0, "got {:?}", o2.delay);
}

#[test]
fn unplaceable_stale_bus_holds_its_delay_then_has_none() {
    let m = Machine::new();
    let o1 = m.step(on(1500.0), 100.0, at(10, 3, 0), Some(60.0), None);
    let held = m.step(
        OFF,
        100.0 + HOLD_CARRY_S - 1.0,
        at(10, 4, 0),
        Some(120.0),
        o1.state.as_ref(),
    );
    assert_eq!(held.src, DelaySrc::GpsHeld);
    assert!(held.delay.unwrap().abs() < 1.0);
    let gone = m.step(
        OFF,
        100.0 + HOLD_CARRY_S + 1.0,
        at(10, 4, 0),
        Some(120.0),
        o1.state.as_ref(),
    );
    assert_eq!((gone.src, gone.delay), (DelaySrc::Unknown, None));
    let fresh = m.step(OFF, 100.0, at(10, 4, 0), Some(120.0), None);
    assert_eq!((fresh.src, fresh.delay), (DelaySrc::Est, Some(120.0)));
}

#[test]
fn a_bus_parked_at_its_last_stop_keeps_the_arrival_delay() {
    let m = Machine::new();
    let arrive = m.step(on(3000.0), 100.0, at(10, 7, 0), Some(300.0), None);
    assert_eq!((arrive.src, arrive.next_idx), (DelaySrc::Gps, None));
    assert!((arrive.delay.unwrap() - 60.0).abs() < 1.0, "got {:?}", arrive.delay);
    let parked = m.step(on(3000.0), 160.0, at(10, 12, 0), Some(600.0), arrive.state.as_ref());
    assert_eq!(parked.delay, arrive.delay, "frozen at the arrival delay");
}

#[test]
fn course_over_is_latched_after_a_warm_arrival() {
    let m = Machine::new();
    let warm = m.step(on(2900.0), 100.0, at(10, 6, 0), Some(300.0), None);
    assert!(!warm.finished);
    let arrive = m.step(on(3000.0), 110.0, at(10, 6, 10), Some(300.0), warm.state.as_ref());
    assert!(arrive.finished);
    let away = m.step(OFF, 400.0, at(10, 12, 0), None, arrive.state.as_ref());
    assert!(away.finished, "latched even after the 3-min cold-start gap");
    assert_eq!((away.src, away.delay), (DelaySrc::GpsHeld, arrive.delay));
    // chords overshoot D: D at the end of the polyline but the fix is 300 m from the last stop's own coordinates
    let k = kx();
    let mut far = m.geom.clone();
    far.pts = Some(vec![
        Some([LAT0, LON0]),
        Some([LAT0, LON0 + 1000.0 / k]),
        Some([LAT0, LON0 + 2000.0 / k]),
        Some([LAT0 + 300.0 / 110_540.0, LON0 + 3000.0 / k]),
    ]);
    let overshoot = m.step_at(
        &far,
        on(3000.0),
        110.0,
        at(10, 6, 10),
        0,
        1,
        Some(300.0),
        warm.state.as_ref(),
    );
    assert!(overshoot.stale);
    assert_eq!(overshoot.next_idx, None);
    assert!(!overshoot.finished, "not physically at the last stop yet");
    let cold = m.step(on(3000.0), 110.0, at(10, 6, 10), Some(300.0), None);
    assert!(!cold.finished, "a cold start at the last stop is not trusted");
    let sync = m.step_at(
        &m.geom,
        on(3000.0),
        110.0,
        at(10, 6, 0),
        3,
        4,
        Some(0.0),
        warm.state.as_ref(),
    );
    assert!(!sync.finished, "in sync: left to parsePosition's own rule");
}

#[test]
fn a_stale_bus_last_seen_at_the_terminus_and_now_off_route_has_left() {
    let m = Machine::new();
    let near = m.step(on(2950.0), 100.0, at(10, 6, 0), Some(300.0), None);
    assert!(near.stale);
    let gone = m.step(OFF, 130.0, at(10, 7, 0), Some(360.0), near.state.as_ref());
    assert!(gone.finished);
    assert_eq!(gone.src, DelaySrc::GpsHeld);
    let mid = m.step(on(1500.0), 100.0, at(10, 3, 0), Some(60.0), None);
    let lost = m.step(OFF, 130.0, at(10, 4, 0), Some(120.0), mid.state.as_ref());
    assert!(!lost.finished);
    assert_eq!(lost.src, DelaySrc::GpsHeld);
}

#[test]
fn an_implausible_gps_delay_is_not_trusted() {
    let m = Machine::new();
    let o = m.step(on(1500.0), 100.0, at(12, 0, 0), Some(60.0), None);
    assert!(!o.stale);
    assert_eq!((o.src, o.delay), (DelaySrc::Est, Some(60.0)));
}

/* ------------------------------------------------------------------ stepArrivals */

#[test]
fn step_arrivals_baselines_stamps_and_nulls() {
    let a = step_arrivals(None, 3, 1000.0, 1000.0);
    assert!(
        a.arrived.is_empty(),
        "stops passed before the first sighting stay unknown"
    );
    let a = step_arrivals(Some(&a), 3, 1010.0, 1008.0);
    assert!(a.arrived.is_empty());
    let a = step_arrivals(Some(&a), 4, 1020.0, 1015.0);
    assert_eq!(a.arrived, [None, None, None, None, Some(1015.0)]);
    let a = step_arrivals(Some(&a), 6, 1030.0, 1025.0);
    assert_eq!(
        a.arrived,
        [None, None, None, None, Some(1015.0), None, Some(1025.0)],
        "a jump stamps only the reached stop"
    );
    let a = step_arrivals(Some(&a), 5, 1040.0, 1040.0);
    assert_eq!(a.reached, 6, "never goes back");
    let a = step_arrivals(Some(&a), 7, 1200.0, 1190.0);
    assert_eq!(
        a.arrived[7], None,
        "reached at an unknown moment inside a long poll gap"
    );
    let a = step_arrivals(Some(&a), 12, 1210.0, 1205.0);
    assert_eq!(a.arrived[12], None, "a 5-stop jump in one poll is a resync");
    let a = step_arrivals(Some(&a), 13, 1220.0, 1215.0);
    assert_eq!(a.arrived[13], Some(1215.0));
}

/* ------------------------------------------------------------------ golden vectors */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct In {
    lat: f64,
    lon: f64,
    t_epoch: f64,
    local_secs: f64,
    vti: Option<i64>,
    next_up: Option<i64>,
    delay_up: Option<f64>,
}

#[derive(Deserialize)]
struct Step {
    #[serde(rename = "in")]
    inp: In,
    out: KbProgOut,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    pts: Vec<Option<LatLng>>,
    plan: Vec<Option<f64>>,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Helper {
    stops: Vec<Option<f64>>,
    plan: Vec<Option<f64>>,
    d: f64,
    next_up: Option<i64>,
    local_secs: f64,
    planned: Option<f64>,
    delay: Option<f64>,
    progress: Progress,
}

#[derive(Deserialize)]
struct PrevTrack {
    #[serde(rename = "D")]
    d: f64,
    t: f64,
}

#[derive(Deserialize)]
struct TrackOut {
    #[serde(rename = "D")]
    d: f64,
    mode: TrackMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackCase {
    pts: Vec<Option<LatLng>>,
    plan: Vec<Option<f64>>,
    lat: f64,
    lon: f64,
    t_epoch: f64,
    local_secs: f64,
    vti: Option<i64>,
    next_up: Option<i64>,
    prev: Option<PrevTrack>,
    out: Option<TrackOut>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArrivalStep {
    reached: i64,
    t: f64,
    fix_at: f64,
    out: KbArrivals,
}

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<Case>,
    helpers: Vec<Helper>,
    tracks: Vec<TrackCase>,
    arrivals: Vec<Vec<ArrivalStep>>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("vectors/kb_progress.json")).unwrap()
}

#[test]
fn golden_helpers() {
    let v = vectors();
    assert!(v.helpers.len() >= 800);
    for (i, h) in v.helpers.iter().enumerate() {
        assert_eq!(planned_at(&h.stops, &h.plan, h.d), h.planned, "#{i}");
        assert_eq!(schedule_delay(&h.stops, &h.plan, h.d, h.local_secs), h.delay, "#{i}");
        assert_eq!(progress_at(&h.stops, h.d, h.next_up), h.progress, "#{i}");
    }
}

#[test]
fn golden_track_along() {
    let v = vectors();
    assert!(v.tracks.len() >= 2000);
    for (i, c) in v.tracks.iter().enumerate() {
        let geom = straight_geom(&c.pts).unwrap();
        let prev = c.prev.as_ref().map(|p| Track { d: p.d, t: p.t });
        let got = track_along(
            &geom,
            c.lat,
            c.lon,
            c.t_epoch,
            c.local_secs,
            &c.plan,
            c.vti,
            c.next_up,
            prev,
        );
        assert_eq!(got, c.out.as_ref().map(|o| (o.d, o.mode)), "#{i}");
    }
}

#[test]
fn golden_step_arrivals() {
    let v = vectors();
    assert!(v.arrivals.len() >= 80);
    for (k, seq) in v.arrivals.iter().enumerate() {
        let mut st: Option<KbArrivals> = None;
        for (i, s) in seq.iter().enumerate() {
            let got = step_arrivals(st.as_ref(), s.reached, s.t, s.fix_at);
            assert_eq!(got, s.out, "#{k} step {i}");
            st = Some(got);
        }
    }
}

#[test]
fn golden_step_kb_progress() {
    let v = vectors();
    assert!(v.cases.len() >= 90);
    let mut n = 0;
    for c in &v.cases {
        let geom = straight_geom(&c.pts).unwrap();
        let mut st: Option<KbProgState> = None;
        for (i, s) in c.steps.iter().enumerate() {
            let inp = KbProgIn {
                geom: &geom,
                plan: &c.plan,
                lat: s.inp.lat,
                lon: s.inp.lon,
                t_epoch: s.inp.t_epoch,
                local_secs: s.inp.local_secs,
                vti: s.inp.vti,
                next_up: s.inp.next_up,
                delay_up: s.inp.delay_up,
            };
            let got = step_kb_progress(&inp, st.as_ref());
            assert_eq!(got, s.out, "{} step {i}", c.name);
            st = got.state;
            n += 1;
        }
    }
    assert!(n >= 3000);
}

/* ------------------------------------------------------------------ real captures (test/fixtures/kb-delay) */

#[derive(Deserialize, Clone)]
struct FxStop {
    lat: Option<f64>,
    lon: Option<f64>,
    plan: String,
}

#[derive(Deserialize, Clone)]
struct FxSample {
    t: f64,
    local: f64,
    lat: f64,
    lon: f64,
    vti: Option<i64>,
    ndi: Option<i64>,
    at: bool,
    est0: Option<String>,
}

#[derive(Deserialize, Clone)]
struct Fx {
    stops: Vec<FxStop>,
    samples: Vec<FxSample>,
}

fn load_fx(name: &str) -> Fx {
    let path = format!("{}/../test/fixtures/kb-delay/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn hhmm(s: Option<&str>) -> Option<f64> {
    let mut it = s
        .filter(|s| !s.is_empty())?
        .split(':')
        .map(|x| x.parse::<f64>().unwrap_or(f64::NAN));
    let h = it.next().unwrap_or(f64::NAN);
    let m = it.next().unwrap_or(f64::NAN);
    Some(h * 3600.0 + m * 60.0)
}

/// JS numeric coercion of a TS `x!` operand (null -> 0)
fn js0(x: Option<f64>) -> f64 {
    x.unwrap_or(0.0)
}

fn plan_of(fx: &Fx) -> Vec<Option<f64>> {
    fx.stops.iter().map(|s| hhmm(Some(&s.plan))).collect()
}

/// `plan[j] as number` / `cr[j] as number` with j from trueLast (-1 = undefined = NaN)
fn nth(xs: &[Option<f64>], j: i64) -> f64 {
    usize::try_from(j)
        .ok()
        .and_then(|j| xs.get(j).copied().flatten())
        .unwrap_or(f64::NAN)
}

/// parsePosition parity: trunc(estimates[0].arrival_abs - plan[ndi ?? vti])
fn parity_delay(s: &FxSample, plan: &[Option<f64>]) -> Option<f64> {
    let tgt = s.ndi.filter(|&n| n >= 0 && (n as usize) < plan.len()).or(s.vti);
    let arr = hhmm(s.est0.as_deref())?;
    let sched = plan.get(usize::try_from(tgt?).ok()?).copied().flatten()?;
    Some(wrap(arr - sched).trunc())
}

struct Replayed {
    s: FxSample,
    delay_up: Option<f64>,
    o: KbProgOut,
}

fn replay(fx: &Fx, samples: &[FxSample]) -> Vec<Replayed> {
    let stop_pts: Vec<Option<LatLng>> = fx
        .stops
        .iter()
        .map(|s| match (s.lat, s.lon) {
            (Some(lat), Some(lon)) => Some([lat, lon]),
            _ => None,
        })
        .collect();
    let geom = straight_geom(&stop_pts).expect("fixture has a usable geometry");
    let plan = plan_of(fx);
    let mut st: Option<KbProgState> = None;
    samples
        .iter()
        .map(|s| {
            let delay_up = parity_delay(s, &plan);
            let (vti, ndi) = (s.vti.map(Value::from), s.ndi.map(Value::from));
            let next_up = kb_next_stop_index(vti.as_ref(), ndi.as_ref(), s.at, plan.len());
            let inp = KbProgIn {
                geom: &geom,
                plan: &plan,
                lat: s.lat,
                lon: s.lon,
                t_epoch: s.t / 1000.0,
                local_secs: s.local,
                vti: s.vti,
                next_up,
                delay_up,
            };
            let o = step_kb_progress(&inp, st.as_ref());
            st = o.state;
            Replayed {
                s: s.clone(),
                delay_up,
                o,
            }
        })
        .collect()
}

/// what upstream does while its index is stuck: vti/ndi frozen, estimates[0] clamped to "now" (the current minute)
fn stuck_at(samples: &[FxSample], vti: i64, ndi: i64, from_local: f64) -> Vec<FxSample> {
    samples
        .iter()
        .map(|s| {
            if s.local < from_local {
                return s.clone();
            }
            let est0 = format!(
                "{:02}:{:02}",
                (s.local / 3600.0).floor() as i64 % 24,
                (s.local / 60.0).floor() as i64 % 60
            );
            FxSample {
                vti: Some(vti),
                ndi: Some(ndi),
                at: false,
                est0: Some(est0),
                ..s.clone()
            }
        })
        .collect()
}

/// Independent ground truth: time (epoch s) of the closest approach of the sampled track to each stop, taken in
/// stop order (the first run of segments within 80 m after the previous stop's pass).
fn crossings(fx: &Fx) -> Vec<Option<f64>> {
    let pts: Vec<(f64, f64, f64)> = fx.samples.iter().map(|s| (s.t / 1000.0, s.lat, s.lon)).collect();
    let mut out = Vec::new();
    let mut after = f64::NEG_INFINITY;
    for st in &fx.stops {
        let (Some(slat), Some(slon)) = (st.lat, st.lon) else {
            out.push(None);
            continue;
        };
        let kx = 111_320.0 * (slat * std::f64::consts::PI / 180.0).cos();
        let mut best: Option<(f64, f64)> = None;
        let mut in_run = false;
        for w in pts.windows(2) {
            let ((at_, alat, alon), (bt, blat, blon)) = (w[0], w[1]);
            if bt < after {
                continue;
            }
            let ax = (alon - slon) * kx;
            let ay = (alat - slat) * 110_540.0;
            let bx = (blon - slon) * kx;
            let by = (blat - slat) * 110_540.0;
            let (dx, dy) = (bx - ax, by - ay);
            let l2 = dx * dx + dy * dy;
            let u = if l2 == 0.0 {
                0.0
            } else {
                (-(ax * dx + ay * dy) / l2).clamp(0.0, 1.0)
            };
            let d = (ax + u * dx).hypot(ay + u * dy);
            if d < 80.0 {
                in_run = true;
                if best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, at_ + u * (bt - at_)));
                }
            } else if in_run {
                break;
            }
        }
        out.push(best.map(|b| b.1));
        if let Some((_, t)) = best {
            after = t;
        }
    }
    out
}

/// last stop passed at epoch-second t according to the independent crossings
fn true_last(cr: &[Option<f64>], t: f64) -> i64 {
    cr.iter()
        .rposition(|c| c.is_some_and(|c| c <= t))
        .map_or(-1, |i| i as i64)
}

/* stalled upstream stop index on a plain route (real capture, line 116, 22:49-22:57) */

fn stall_116() -> (Fx, Vec<Replayed>) {
    let fx = load_fx("stall-116");
    let rows = replay(&fx, &fx.samples);
    (fx, rows)
}

#[test]
fn upstreams_delay_inflates_1_min_min_5_11_min_while_the_bus_runs_on_time() {
    let (_, rows) = stall_116();
    let stalled: Vec<&Replayed> = rows
        .iter()
        .filter(|r| r.s.vti == Some(5) && r.s.ndi == Some(6))
        .collect();
    assert!(stalled.len() >= 25);
    assert!(js0(stalled[0].delay_up) >= 300.0 && js0(stalled[stalled.len() - 1].delay_up) >= 600.0);
}

#[test]
fn the_gps_delay_stays_within_90_s_flagged_stale_from_the_second_poll_on() {
    let (_, rows) = stall_116();
    let stalled: Vec<&Replayed> = rows
        .iter()
        .filter(|r| r.s.vti == Some(5) && r.s.ndi == Some(6) && r.s.local >= at(22, 49, 25))
        .collect();
    assert!(stalled.len() >= 25);
    for r in stalled {
        assert!(r.o.stale, "stale at {}", r.s.local);
        assert!(matches!(r.o.src, DelaySrc::Gps | DelaySrc::GpsHeld), "{:?}", r.o.src);
        assert!(
            js0(r.o.delay).abs() <= 90.0,
            "GPS delay {:?} at {}",
            r.o.delay,
            r.s.local
        );
    }
}

#[test]
fn matches_the_independent_closest_approach_delay_at_the_last_passed_stop_90_s() {
    let (fx, rows) = stall_116();
    let cr = crossings(&fx);
    let plan = plan_of(&fx);
    let mut n = 0;
    for r in &rows {
        if !r.o.stale || r.o.src != DelaySrc::Gps {
            continue;
        }
        let j = true_last(&cr, r.s.t / 1000.0);
        if j < 0 || nth(&cr, j).is_nan() {
            continue;
        }
        let cross_local = r.s.local - (r.s.t / 1000.0 - nth(&cr, j));
        let obs = wrap(cross_local - nth(&plan, j));
        assert!(
            (js0(r.o.delay) - obs).abs() <= 90.0,
            "GPS {:?} vs observed {obs} at {}",
            r.o.delay,
            r.s.local
        );
        n += 1;
    }
    assert!(n >= 20);
}

#[test]
fn after_upstream_resyncs_vti_15_it_is_in_sync_again_and_upstreams_value_is_used() {
    let (_, rows) = stall_116();
    let after: Vec<&Replayed> = rows
        .iter()
        .filter(|r| r.s.vti == Some(15) && r.s.local >= at(22, 56, 10))
        .collect();
    assert!(after.len() >= 3);
    for r in after {
        assert!(!r.o.stale);
        assert_eq!(r.o.delay, r.delay_up);
    }
}

#[test]
fn second_stall_vti_18_for_15_min_gps_delay_3_min_where_upstream_reaches_11() {
    let fx = load_fx("stall-116-b");
    let rb = replay(&fx, &fx.samples);
    let stalled: Vec<&Replayed> = rb
        .iter()
        .filter(|r| r.s.vti == Some(18) && r.s.ndi == Some(19) && r.s.local >= at(23, 2, 0))
        .collect();
    assert!(stalled.len() > 20);
    assert!(
        stalled
            .iter()
            .map(|r| r.delay_up.unwrap_or(0.0))
            .fold(f64::NEG_INFINITY, f64::max)
            >= 600.0
    );
    for r in &stalled {
        assert!(
            r.o.delay.is_none_or(|d| (-120.0..=180.0).contains(&d)),
            "GPS {:?} at {}",
            r.o.delay,
            r.s.local
        );
    }
    assert!(stalled.iter().filter(|r| r.o.src == DelaySrc::Gps).count() > 15);
}

/* midnight */

#[test]
fn a_trip_running_across_midnight_gives_exactly_the_same_result_as_the_same_trip_shifted_into_the_afternoon() {
    let fx = load_fx("stall-116");
    let shift = |secs: f64| -> Fx {
        let hm = |v: Option<&str>| -> Option<String> {
            let y = (hhmm(v)? + secs + 86400.0) % 86400.0;
            Some(format!(
                "{:02}:{:02}",
                (y / 3600.0).floor() as i64,
                (y / 60.0).floor() as i64 % 60
            ))
        };
        Fx {
            stops: fx
                .stops
                .iter()
                .map(|st| FxStop {
                    plan: hm(Some(&st.plan)).unwrap_or_default(),
                    ..st.clone()
                })
                .collect(),
            samples: fx
                .samples
                .iter()
                .map(|sm| FxSample {
                    local: (sm.local + secs + 86400.0) % 86400.0,
                    est0: hm(sm.est0.as_deref()),
                    ..sm.clone()
                })
                .collect(),
        }
    };
    let base = replay(&fx, &fx.samples);
    // 22:49 -> 00:09: the first stops are planned before and the rest after midnight
    let night_fx = shift(80.0 * 60.0);
    let night = replay(&night_fx, &night_fx.samples);
    // 22:49 -> 14:49 (no midnight in the trip at all)
    let noon_fx = shift(-8.0 * 3600.0);
    let noon = replay(&noon_fx, &noon_fx.samples);
    assert!(
        night.iter().all(|r| r.s.local < 3600.0),
        "polls are after midnight while the first stops are planned before it"
    );
    for (i, r) in base.iter().enumerate() {
        for other in [&night[i], &noon[i]] {
            assert_eq!(other.o.stale, r.o.stale);
            assert_eq!(other.o.last_idx, r.o.last_idx);
            assert_eq!(other.delay_up, r.delay_up);
            assert!(
                (other.o.delay.is_none() && r.o.delay.is_none()) || (js0(other.o.delay) - js0(r.o.delay)).abs() < 1e-6,
                "delay {:?} vs {:?} at sample {i}",
                other.o.delay,
                r.o.delay
            );
        }
    }
}

/* out-and-back spur: index stuck at the apex while the bus drives the return leg (real capture, line 136) */

fn spur_136() -> Vec<Replayed> {
    let fx = load_fx("spur-136");
    replay(&fx, &fx.samples)
}

#[test]
fn locks_onto_the_return_leg_from_the_first_poll_vti_is_a_lower_bound_and_flags_the_index_stale() {
    let rows = spur_136();
    assert_eq!(rows[0].s.vti, Some(23));
    let last = rows[0].o.last_idx;
    assert!(
        js0(last.map(|i| i as f64)) >= 25.0,
        "bus is past the return Centrum (25), got {last:?}"
    );
    assert!(rows[0].o.stale);
}

#[test]
fn shows_an_early_bus_where_upstreams_stale_estimate_says_it_is_late() {
    let rows = spur_136();
    let last = &rows[rows.len() - 1];
    assert!(js0(last.delay_up) > 60.0, "upstream {:?}", last.delay_up);
    assert!(js0(last.o.delay) < -90.0, "GPS {:?}", last.o.delay);
}

/* loop trip, upstream in sync (real capture, line 120, Szczyrk Biła loop) */

fn idx0(i: Option<i64>) -> f64 {
    js0(i.map(|i| i as f64))
}

#[test]
fn never_flags_stale_and_returns_exactly_upstreams_value_zero_behaviour_change() {
    let fx = load_fx("healthy-120-loop");
    let rows = replay(&fx, &fx.samples);
    assert!(rows.len() > 30);
    for r in &rows {
        assert!(
            !r.o.stale,
            "stale at {} last={:?} vti={:?}",
            r.s.local, r.o.last_idx, r.s.vti
        );
        assert_eq!(r.o.delay, r.delay_up);
    }
}

#[test]
fn tracks_the_bus_monotonically_through_the_loop_apex_and_passes_the_loop_stops_in_order() {
    let fx = load_fx("healthy-120-loop");
    let rows = replay(&fx, &fx.samples);
    let mut prev = -1.0;
    let mut max_last = -1.0_f64;
    for r in &rows {
        assert!(js0(r.o.d) >= prev - 1e-6);
        prev = js0(r.o.d);
        max_last = max_last.max(idx0(r.o.last_idx));
    }
    assert!(max_last >= 28.0, "reached the end of the loop, last={max_last}");
}

/* line 120 loop with a stalled index (the healthy capture, upstream frozen as observed on 116 / 136) */

fn check_stalled_loop(vti: i64, from_local: f64, first_sample: usize) {
    let fx = load_fx("healthy-120-loop");
    let cr = crossings(&fx);
    let plan = plan_of(&fx);
    let stuck = stuck_at(&fx.samples, vti, vti + 1, from_local);
    let rows = replay(&fx, stuck.get(first_sample..).unwrap_or_default());
    let mut flagged = 0;
    let mut prev_last = -1.0;
    for r in &rows {
        if r.s.local < from_local || !r.o.stale {
            continue;
        }
        flagged += 1;
        let j = true_last(&cr, r.s.t / 1000.0);
        // the stops around the apex (22..25) are only ~190 m apart and the straight chords cut the real road,
        // so the index may run up to two stops ahead there for a poll or two
        let tol = if (21..=25).contains(&j) { 2.0 } else { 1.0 };
        let last = idx0(r.o.last_idx);
        assert!(
            (last - j as f64).abs() <= tol,
            "last {:?} vs true {j} at {}",
            r.o.last_idx,
            r.s.local
        );
        assert!(last >= prev_last, "progress never goes backwards");
        prev_last = last;
        let cross_local = r.s.local - (r.s.t / 1000.0 - nth(&cr, j));
        let obs = wrap(cross_local - nth(&plan, j));
        if r.o.src == DelaySrc::Gps {
            assert!(
                (js0(r.o.delay) - obs).abs() <= 120.0,
                "GPS {:?} vs observed {obs} at {}",
                r.o.delay,
                r.s.local
            );
        }
    }
    assert!(flagged >= 15, "stale detected for {flagged} polls");
    let last_row = &rows[rows.len() - 1];
    assert!(
        js0(last_row.delay_up) >= 240.0,
        "upstream would show {:?}",
        last_row.delay_up
    );
    assert!(js0(last_row.o.delay).abs() <= 120.0, "GPS {:?}", last_row.o.delay);
    assert!(idx0(last_row.o.last_idx) >= 28.0);
}

/// stuck right after the apex (Biła -> Beskid Arena): the state of the screenshot (bus past Nowy Kościół, header +5 min)
#[test]
fn index_stuck_at_the_apex_vti_23_ndi_24_gps_progress_follows_the_bus_through_the_return_leg_delay_stays_within_2_min()
{
    check_stalled_loop(23, at(23, 3, 40), 0);
}

/// stuck BEFORE the loop: neither the outbound loop stops nor the return leg are ever registered
#[test]
fn index_stuck_at_szczyrk_centrum_vti_19_ndi_20_gps_progress_follows_the_bus_through_the_return_leg_delay_stays_within_2_min()
 {
    check_stalled_loop(19, at(22, 58, 0), 0);
}

/// cold start (server restart) in the middle of the return leg
#[test]
fn cold_start_on_the_return_leg_index_stuck_at_the_apex_gps_progress_follows_the_bus_through_the_return_leg_delay_stays_within_2_min()
 {
    check_stalled_loop(23, at(23, 3, 40), 30);
}

/* poller glue */

#[test]
fn a_gps_replaced_delay_must_not_hide_a_frozen_feed_from_the_ghost_filter() {
    let v = |delay: Option<f64>, delay_up: Option<Option<f64>>, last_moved_at: f64| VehiclePos {
        delay,
        delay_up,
        last_moved_at,
        ..Default::default()
    };
    assert!(is_feed_stale(&v(Some(30.0), Some(None), 0.0), 1000.0, 300.0));
    assert!(!is_feed_stale(&v(Some(30.0), Some(Some(30.0)), 0.0), 1000.0, 300.0));
    assert!(
        is_feed_stale(&v(None, None, 0.0), 1000.0, 300.0),
        "MZK-style vehicle without delayUp"
    );
    assert!(
        !is_feed_stale(&v(None, Some(None), 900.0), 1000.0, 300.0),
        "moved recently"
    );
}
