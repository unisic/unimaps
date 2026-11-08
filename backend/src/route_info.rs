//! Per-vehicle route math the pollers attach to positions for the client motion engine, port of the pure part of
//! `lib/route-info.ts`.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::js::{num_value, round, round1};
use crate::kb_progress::DelaySrc;
use crate::shape_patterns::KbPattern;
use crate::shape_store::{ShapeGeometry, ShapePrio, ShapeSrc};
use crate::shared::polyline::project_on_polyline;
use crate::vehicle::VehiclePos;

/// What the KB poller needs from the shape store (kept narrow for tests).
pub trait KbShapeSink: Send + Sync {
    fn touch_kb(&self, p: &KbPattern, prio: ShapePrio);
    fn geometry(&self, key: &str) -> Option<Arc<ShapeGeometry>>;
}

/// The previous fix of a vehicle as `estimate_fix_at` reads it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrevFix {
    pub fix_at: Option<f64>,
    pub updated_at: f64,
}

/// `estimateFixAt`: when the current position first appeared upstream. A change seen at poll `updated_at` happened
/// somewhere since the previous poll, so the midpoint of that window (gap capped at `cap_sec`).
pub fn estimate_fix_at(prev: Option<PrevFix>, updated_at: f64, moved: bool, cap_sec: f64) -> f64 {
    let Some(prev) = prev else { return updated_at };
    if !moved {
        return prev.fix_at.unwrap_or(prev.updated_at);
    }
    let gap = (updated_at - prev.updated_at).max(0.0).min(cap_sec);
    updated_at - gap / 2.0
}

const MOVING_M: f64 = 20.0;
const SPEED_MAX: f64 = 25.0;
const SPEED_REJECT: f64 = 33.0;
const SPEED_TAU_S: f64 = 20.0;

/// `nextSpeed`: cruise-speed EMA update from one pair of distinct fixes, None when the pair is not a moving pair
/// (see the TS for the rules). `prev_move_ds` None = the first-ever fix.
pub fn next_speed(
    prev_speed: Option<f64>,
    prev_move_ds: Option<f64>,
    ds: f64,
    dt: f64,
    prev_held_sec: f64,
    in_stop_zone: bool,
) -> Option<f64> {
    if in_stop_zone || !prev_move_ds.is_some_and(|m| m >= MOVING_M) {
        return None;
    }
    if !(MOVING_M..).contains(&ds) || !(3.0..=45.0).contains(&dt) || prev_held_sec > 30.0 {
        return None;
    }
    let sample = ds / dt;
    if sample > SPEED_REJECT {
        return None;
    }
    let v = sample.min(SPEED_MAX);
    let Some(prev) = prev_speed.filter(|p| p.is_finite()) else {
        return Some(v);
    };
    let a = 1.0 - (-dt / SPEED_TAU_S).exp();
    Some(prev + a * (v - prev))
}

fn finite_at(stops: &[Option<f64>], from: i64, step: i64) -> Option<f64> {
    let mut i = from;
    while i >= 0 && (i as usize) < stops.len() {
        if let Some(s) = stops[i as usize] {
            return Some(s);
        }
        i += step;
    }
    None
}

/// `kbAheadM`: forward window of the continuity step after `gap_s` seconds without a poll, 500..2000 m.
pub fn kb_ahead_m(gap_s: f64) -> f64 {
    let g = if gap_s.is_finite() { gap_s.clamp(0.0, 90.0) } else { 0.0 };
    (30.0 * g + 150.0).clamp(500.0, 2000.0)
}

/// `kbDistAlong`: metres along the shape for a fix, None when off-route. Continuity from `hint` first, then
/// upstream's stop window (`vti`..`next_seq`), then a strict whole-line search; the TS has the reasoning.
pub fn kb_dist_along(
    geom: &ShapeGeometry,
    lat: f64,
    lon: f64,
    vti: Option<i64>,
    next_seq: Option<i64>,
    hint: Option<f64>,
    ahead_m: Option<f64>,
) -> Option<f64> {
    let pl = &geom.pl;
    let max_off: f64 = if geom.src == ShapeSrc::Straight { 150.0 } else { 60.0 };
    if let Some(h) = hint.filter(|h| h.is_finite()) {
        let hi = h + ahead_m.unwrap_or(500.0);
        let mut c = project_on_polyline(pl, lat, lon, h - 60.0, hi, Some(h), 15.0);
        // behind by more than jitter while a twin leg ahead fits about as well: the bus is on the leg ahead
        if let Some(cc) = c
            && cc.s < h - 15.0
            && let Some(f) = project_on_polyline(pl, lat, lon, h, hi, None, 15.0)
            && f.d <= max_off.min(cc.d + 15.0)
        {
            c = Some(f);
        }
        if let Some(c) = c
            && c.d <= max_off
        {
            return Some(round1(c.s));
        }
    }
    if let Some(vti) = vti.filter(|v| *v >= 0) {
        let lo = finite_at(&geom.stops, vti.min(geom.stops.len() as i64 - 1), -1);
        let hi_idx = match next_seq {
            Some(n) if n > vti => n,
            _ => vti + 1,
        };
        let hi = finite_at(&geom.stops, hi_idx, 1);
        let p = project_on_polyline(
            pl,
            lat,
            lon,
            lo.unwrap_or(0.0) - 100.0,
            hi.unwrap_or(pl.length) + 100.0,
            hint,
            15.0,
        );
        if let Some(p) = p
            && p.d <= max_off
        {
            return Some(round1(p.s));
        }
    }
    project_on_polyline(pl, lat, lon, 0.0, f64::INFINITY, hint, 15.0)
        .filter(|p| p.d <= 40.0)
        .map(|p| round1(p.s))
}

/// Scheduled runs shorter than this are widened: timetable times are whole minutes.
const SCHED_MIN_S: f64 = 120.0;

/// `schedSpeed`: timetable pace (m/s) at chainage `d` between the timed stops either side of it, widened a stop at
/// a time (forward first) to span SCHED_MIN_S. `times` in seconds aligned with `stops`, a drop of more than 12 h is
/// the next day. None outside the trip or when the timetable says nothing. O(stops).
pub fn sched_speed(stops: &[Option<f64>], times: &[Option<f64>], d: f64) -> Option<f64> {
    let n = stops.len().min(times.len());
    let at = |k: usize| stops[k].zip(times[k]);
    let (mut i, mut j) = (None, None);
    for k in 0..n {
        if j.is_some() {
            break;
        }
        let Some((s, _)) = at(k) else { continue };
        if s <= d {
            i = Some(k);
        } else {
            j = Some(k);
        }
    }
    let (Some(mut i), Some(mut j)) = (i, j) else {
        return None;
    };
    let span = |i: usize, j: usize| {
        let dt = at(j).unwrap().1 - at(i).unwrap().1;
        if dt < -43_200.0 { dt + 86_400.0 } else { dt }
    };
    while span(i, j) < SCHED_MIN_S {
        if let Some(k) = (j + 1..n).find(|&k| at(k).is_some()) {
            j = k;
            continue;
        }
        i = (0..i).rev().find(|&k| at(k).is_some())?;
    }
    let v = (at(j).unwrap().0 - at(i).unwrap().0) / span(i, j);
    (v > 0.0 && v <= 30.0).then_some(v)
}

/// Maps a shape key to its wire id (`<key>.<rev6>`).
pub type WireIdFn<'a> = dyn Fn(&str) -> Option<String> + 'a;

/// `vehicleExtras`: the route-info wire fields appended to `vehicle_to_json`, keys in its order. Never panics: a
/// failing `wire_id` drops every extra (the TS try/catch returning `{}`), never the vehicle.
pub fn vehicle_extras(v: &VehiclePos, wire_id: Option<&WireIdFn>, now_epoch: f64) -> Map<String, Value> {
    catch_unwind(AssertUnwindSafe(|| extras(v, wire_id, now_epoch))).unwrap_or_default()
}

fn extras(v: &VehiclePos, wire_id: Option<&WireIdFn>, now_epoch: f64) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(f) = v.fix_at.filter(|f| f.is_finite()) {
        out.insert("fix_at".into(), num_value(round1(f)));
    }
    if let Some(s) = v.next_stop_seq {
        out.insert("next_stop_seq".into(), s.into());
    }
    let src = match v.delay_src {
        Some(DelaySrc::Gps) => Some("gps"),
        Some(DelaySrc::GpsHeld) => Some("gps-held"),
        Some(DelaySrc::Unknown) => Some("unknown"),
        Some(DelaySrc::Est) | None => None,
    };
    if let Some(s) = src {
        out.insert("delay_src".into(), s.into());
    }
    if let Some(g) = v.geo_last_seq.filter(|&g| g >= 0) {
        out.insert("geo_seq".into(), g.into());
    }
    if v.not_started {
        out.insert("not_started".into(), true.into());
    }
    if let Some(s) = v.sched_trip_id.as_ref().filter(|s| !s.is_empty()) {
        out.insert("sched_trip_id".into(), s.clone().into());
    }
    if let Some(a) = v.agency.as_ref().filter(|a| !a.is_empty()) {
        out.insert("agency".into(), a.clone().into());
    }
    if v.scheduled {
        out.insert("scheduled".into(), true.into());
    }
    // a course not begun is not on its shape yet (a layover, the run from the depot): no along-route motion
    if v.not_started {
        return out;
    }
    if let (Some(s), Some(at)) = (v.speed.filter(|s| s.is_finite()), v.speed_at)
        && now_epoch - at <= 90.0
    {
        out.insert("speed".into(), num_value(round1(s)));
    }
    if let Some(s) = v.sched_speed.filter(|s| s.is_finite()) {
        out.insert("sched_speed".into(), num_value(round1(s)));
    }
    if let (Some(wire_id), Some(key)) = (wire_id, v.shape_key.as_deref().filter(|k| !k.is_empty()))
        && let Some(id) = wire_id(key).filter(|id| !id.is_empty())
    {
        // `id.slice(-6)`: the rev is ASCII hex
        let tail = id.char_indices().rev().nth(5).map_or(id.as_str(), |(i, _)| &id[i..]);
        let dist = v
            .dist_m
            .filter(|d| d.is_finite() && v.dist_rev.as_deref() == Some(tail));
        out.insert("shape".into(), id.into());
        if let Some(d) = dist {
            out.insert("dist_m".into(), num_value(round(d)));
        }
    }
    out
}
