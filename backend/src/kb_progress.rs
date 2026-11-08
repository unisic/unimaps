//! lib/kb-progress.ts: GPS progress tracking for KB vehicles, "is upstream's stop index stale?".
//!
//! Upstream registers a stop only when one of its GPS samples (6-18 s apart) lands in the stop zone. A bus that
//! drives past a stop without slowing down is never registered, `vehicle_trip_index` / `next_departure_index`
//! stall, and upstream clamps `estimates[0]` to "now" for the stale stop, so the delay `parsePosition` derives grows
//! by one minute per minute. This module places the bus on the trip's route from its GPS fix (monotonically, with
//! the stop upstream last registered as a hard lower bound) and, only when the bus is clearly beyond the stop
//! upstream calls "next", replaces the delay by the schedule deviation at the real position.
//!
//! Geometry is the straight stop-to-stop polyline of the trip's own stops, so the result never depends on the OSRM
//! shape store being warm. Indices are `trip.times` positions; `vti` / `next_up` stay i64 because upstream's index
//! is only range-checked here, never trusted.

use serde::Deserialize;

use crate::geo::RAD;
use crate::js;
use crate::shared::polyline::{
    LatLng, Polyline, prepare_polyline, project_on_polyline, project_stops_along, seg_meters,
};

/// A stop counts as passed when the bus is within this many metres before it.
pub const PASS_TOL_M: f64 = 25.0;
/// The bus is "stale-indexed" once it is this far beyond the stop upstream calls next.
pub const STALE_PAST_M: f64 = 120.0;
/// Upstream registered stop `vti`: the bus is not further than this before it (observed >= -100 m).
pub const LOWER_BOUND_TOL_M: f64 = 150.0;
/// A fix this far from the straight polyline is "off the route" (chords cut corners).
pub const STRAIGHT_MAX_OFF_M: f64 = 150.0;
/// Plausible bus speed bound for the monotone window (m/s).
const V_MAX: f64 = 30.0;
/// Among projection candidates within this many metres of the best one, the one nearest the hint wins.
const SLACK_M: f64 = 25.0;
/// Previous placement older than this: cold start.
const WARM_MAX_GAP_S: f64 = 180.0;
/// A stale-flagged bus we cannot place keeps its last GPS delay for this long, then it is "unknown".
pub const HOLD_CARRY_S: f64 = 180.0;
/// Cold start: the stale-index candidate wins only when it fits the timetable this much better.
const COLD_MARGIN_S: f64 = 240.0;
/// Still waiting at the origin: only lateness counts.
const ORIGIN_TOL_M: f64 = 40.0;
/// A GPS delay beyond this is a mis-placement, not a delay: keep upstream's value.
pub const DEV_MAX_S: f64 = 2700.0;
/// A stale-indexed bus last placed this close to the final stop that is now off the route has left it.
const END_LEFT_M: f64 = 100.0;
/// ...and "reached the last stop" additionally needs the fix itself this close to the stop (chords overshoot D).
const END_NEAR_M: f64 = 120.0;

const M_PER_DEG: f64 = 111_320.0;

#[derive(Debug, Clone)]
pub struct ProgressGeom {
    pub pl: Polyline,
    /// along-route metres per `trip.times` index (None = unplaced), non-decreasing
    pub stops: Vec<Option<f64>>,
    /// perpendicular distance (m) up to which a fix still counts as "on the route"
    pub max_off_m: f64,
    /// coordinates per `trip.times` index, used to confirm the bus is physically at its last stop
    pub pts: Option<Vec<Option<LatLng>>>,
}

/// Straight stop-to-stop polyline of a trip's stops (index-aligned with `trip.times`); None if < 2 stops resolve.
pub fn straight_geom(stop_pts: &[Option<LatLng>]) -> Option<ProgressGeom> {
    let pts: Vec<LatLng> = stop_pts.iter().flatten().copied().collect();
    let pl = prepare_polyline(&pts)?;
    let stops = project_stops_along(&pl, stop_pts, STRAIGHT_MAX_OFF_M);
    Some(ProgressGeom {
        pl,
        stops,
        max_off_m: STRAIGHT_MAX_OFF_M,
        pts: Some(stop_pts.to_vec()),
    })
}

fn wrap_secs(x: f64) -> f64 {
    if x > 43200.0 {
        x - 86400.0
    } else if x < -43200.0 {
        x + 86400.0
    } else {
        x
    }
}

fn at<T: Copy>(xs: &[Option<T>], i: usize) -> Option<T> {
    xs.get(i).copied().flatten()
}

/// Is the fix within `r` metres of the last placed stop's own coordinates? (true when the coordinates are unknown)
fn near_last_stop(geom: &ProgressGeom, lat: f64, lon: f64, r: f64) -> bool {
    let Some(pts) = &geom.pts else { return true };
    let Some(i) = geom.stops.iter().rposition(Option::is_some) else {
        return true;
    };
    at(pts, i).is_none_or(|p| seg_meters(lat, lon, p[0], p[1]) <= r)
}

fn finite_at_or_before(stops: &[Option<f64>], i: i64) -> Option<f64> {
    let hi = i.min(stops.len() as i64 - 1);
    if hi < 0 {
        return None;
    }
    stops[..=hi as usize].iter().rev().find_map(|s| *s)
}

fn finite_at_or_after(stops: &[Option<f64>], i: i64) -> Option<f64> {
    stops.iter().skip(i.max(0) as usize).find_map(|s| *s)
}

/// Timetable time (seconds of the agency day) at along-route distance `d`: linear between consecutive placed stops,
/// clamped at both ends. Plan times are "HH:MM", so a drop of more than 12 h between stops means the next day.
pub fn planned_at(stops: &[Option<f64>], plan: &[Option<f64>], d: f64) -> Option<f64> {
    let mut prev: Option<(f64, f64)> = None;
    for (i, s) in stops.iter().enumerate() {
        let (Some(s), Some(p)) = (*s, at(plan, i)) else {
            continue;
        };
        let Some((ps, pp_prev)) = prev else {
            if d <= s {
                return Some(p);
            }
            prev = Some((s, p));
            continue;
        };
        let mut pp = p;
        while pp < pp_prev - 43200.0 {
            pp += 86400.0;
        }
        if d <= s {
            if d <= ps {
                return Some(pp_prev);
            }
            if s == ps {
                return Some(pp);
            }
            return Some(pp_prev + ((d - ps) / (s - ps)) * (pp - pp_prev));
        }
        prev = Some((s, pp));
    }
    prev.map(|(_, p)| p)
}

/// Schedule deviation in seconds (+ = late) of a fix taken at agency-local `local_secs` while the bus is at
/// along-route distance `d`. A bus still standing at the origin before its departure time is not "early".
pub fn schedule_delay(stops: &[Option<f64>], plan: &[Option<f64>], d: f64, local_secs: f64) -> Option<f64> {
    let first_idx = stops.iter().position(Option::is_some)?;
    at(plan, first_idx)?;
    let first = stops[first_idx]?;
    let t = planned_at(stops, plan, d)?;
    let mut dev = wrap_secs(local_secs - t);
    if d <= first + ORIGIN_TOL_M && dev < 0.0 {
        dev = 0.0;
    }
    Some(dev)
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// last stop the bus has passed (-1 = before the first)
    pub last_idx: i64,
    /// next stop by GPS (None = past the last placed stop)
    pub next_idx: Option<usize>,
    /// upstream's next stop is behind the bus by more than STALE_PAST_M
    pub stale: bool,
    /// metres the bus is beyond upstream's next stop (None = unknown)
    pub past_m: Option<f64>,
}

pub fn progress_at(stops: &[Option<f64>], d: f64, next_up: Option<i64>) -> Progress {
    let last = stops.iter().rposition(|s| s.is_some_and(|s| s <= d + PASS_TOL_M));
    let from = last.map_or(0, |l| l + 1);
    let next_idx = (from..stops.len()).find(|&i| stops[i].is_some());
    let past_m = next_up.and_then(|n| finite_at_or_after(stops, n)).map(|s| d - s);
    Progress {
        last_idx: last.map_or(-1, |l| l as i64),
        next_idx,
        stale: past_m.is_some_and(|p| p > STALE_PAST_M),
        past_m,
    }
}

#[derive(Debug, Clone, Copy)]
struct Candidate {
    s: f64,
    d: f64,
}

/// One candidate per local distance minimum (= per distinct pass of the same road) within `slack` of the best.
fn collect_candidates(pl: &Polyline, lat: f64, lon: f64, s_min: f64, s_max: f64, slack: f64) -> Vec<Candidate> {
    let mut raw = Vec::new();
    let mut best_d = f64::INFINITY;
    for i in 0..pl.n() - 1 {
        if pl.cum[i + 1] < s_min || pl.cum[i] > s_max {
            continue;
        }
        let (a_lat, a_lon) = (pl.lat[i], pl.lon[i]);
        let kx = M_PER_DEG * (((a_lat + pl.lat[i + 1]) / 2.0) * RAD).cos();
        let dx = (pl.lon[i + 1] - a_lon) * kx;
        let dy = (pl.lat[i + 1] - a_lat) * M_PER_DEG;
        let px = (lon - a_lon) * kx;
        let py = (lat - a_lat) * M_PER_DEG;
        let len2 = dx * dx + dy * dy;
        let mut t = if len2 > 0.0 { (px * dx + py * dy) / len2 } else { 0.0 };
        t = t.clamp(0.0, 1.0);
        let seg_len = pl.cum[i + 1] - pl.cum[i];
        let s = (pl.cum[i] + t * seg_len).max(s_min).min(s_max);
        // distance from the clamped point, not the unclamped foot (else a window edge looks closer than it is)
        if seg_len > 0.0 {
            t = (s - pl.cum[i]) / seg_len;
        }
        let d = js::hypot(px - t * dx, py - t * dy);
        best_d = best_d.min(d);
        raw.push(Candidate { s, d });
    }
    let mut out: Vec<Candidate> = Vec::new();
    for c in raw {
        if c.d > best_d + slack {
            continue;
        }
        match out.last_mut() {
            Some(last) if (last.s - c.s).abs() < 60.0 => {
                if c.d < last.d {
                    *last = c;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Track {
    pub d: f64,
    /// epoch secs of the fix `d` belongs to
    pub t: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackMode {
    Cont,
    Init,
    Hold,
    /// the fix is not on the route (only ever a `KbProgOut` mode)
    Off,
}

/// Places a fix on the route. None when the fix is not on the route at all; `Hold` when it cannot be placed
/// confidently (keep the previous D: never jump, never go backwards).
///
///  - `vti` (upstream's last registered stop) is a hard lower bound: this removes the outbound leg of a loop.
///  - Occam first: look for the bus where upstream says it should be (up to a little beyond its "next" stop); only
///    when it is clearly beyond, accept the "upstream index is stale" hypothesis and search further along.
///  - Warm (previous D <= 3 min old): monotone window `[D-40, D + v*dt + 150]`.
///  - Cold: both hypotheses are scored; the stale-index candidate must fit the timetable COLD_MARGIN_S better.
#[allow(clippy::too_many_arguments)]
pub fn track_along(
    geom: &ProgressGeom,
    lat: f64,
    lon: f64,
    t_epoch: f64,
    local_secs: f64,
    plan: &[Option<f64>],
    vti: Option<i64>,
    next_up: Option<i64>,
    prev: Option<Track>,
) -> Option<(f64, TrackMode)> {
    let pl = &geom.pl;
    let st = &geom.stops[..];
    let max_off = geom.max_off_m;
    let lb_stop = vti.filter(|&v| v >= 0).and_then(|v| finite_at_or_before(st, v));
    let lb = lb_stop.map_or(0.0, |s| (s - LOWER_BOUND_TOL_M).max(0.0));
    let next_stop = next_up.filter(|&n| n >= 0).and_then(|n| finite_at_or_after(st, n));
    let in_sync_hi = next_stop.unwrap_or(lb_stop.map_or(f64::INFINITY, |s| s + 1500.0)) + STALE_PAST_M;

    if let Some(prev) = prev
        && t_epoch - prev.t <= WARM_MAX_GAP_S
    {
        let dt = (t_epoch - prev.t).max(1.0);
        let hi_all = prev.d + V_MAX * dt + 150.0;
        // upstream has registered a stop our track has not reached yet: the track is wrong, re-init below
        if lb <= hi_all {
            let lo = lb.max(prev.d - 40.0);
            let hi = hi_all.min(in_sync_hi);
            if lo <= hi
                && let Some(p) = project_on_polyline(pl, lat, lon, lo, hi, Some(prev.d), SLACK_M)
                && p.d <= max_off
            {
                return Some((prev.d.max(js::round1(p.s)), TrackMode::Cont));
            }
            let lo2 = lo.max(in_sync_hi);
            if lo2 < hi_all
                && let Some(p2) = project_on_polyline(pl, lat, lon, lo2, hi_all, Some(prev.d), SLACK_M)
                && p2.d <= max_off
            {
                return Some((prev.d.max(js::round1(p2.s)), TrackMode::Cont));
            }
            return Some((prev.d, TrackMode::Hold));
        }
    }

    // cold start / long gap / track behind upstream's registered stop
    let in_sync = project_on_polyline(pl, lat, lon, lb, in_sync_hi, None, SLACK_M).filter(|p| p.d <= max_off);
    let beyond = collect_candidates(pl, lat, lon, in_sync_hi, f64::INFINITY, SLACK_M);
    let mut alt: Option<Candidate> = None;
    let best = beyond.iter().map(|c| c.d).fold(f64::INFINITY, f64::min);
    if best <= max_off {
        let mut pick_score = f64::INFINITY;
        for c in &beyond {
            if c.d > best + SLACK_M {
                continue;
            }
            // schedule consistency; tie-break by distance
            let dev = planned_at(st, plan, c.s).map_or(0.0, |t| wrap_secs(local_secs - t).abs());
            let score = dev + c.d * 0.5;
            if score < pick_score {
                pick_score = score;
                alt = Some(*c);
            }
        }
    }
    let s = match (in_sync, alt) {
        (Some(p), None) => p.s,
        (None, Some(a)) => a.s,
        (None, None) => return None,
        (Some(p), Some(a)) => {
            let dev = |s: f64| planned_at(st, plan, s).map_or(0.0, |t| wrap_secs(local_secs - t).abs());
            if dev(a.s) + COLD_MARGIN_S < dev(p.s) { a.s } else { p.s }
        }
    };
    Some((js::round1(s), TrackMode::Init))
}

/* ------------------------------------------------------------------ stateful step */

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbProgState {
    /// along-route metres (straight geometry), monotone
    #[serde(rename = "D")]
    pub d: f64,
    /// epoch secs of the last placed fix
    pub t: f64,
    /// upstream `vti` at which staleness was detected (None = in sync)
    pub stale_vti: Option<i64>,
    /// last GPS delay (secs) while stale-flagged, and when it was computed
    pub robust: Option<f64>,
    pub robust_at: f64,
    /// delay frozen when the bus reached its last stop (a parked bus is not "getting later")
    pub end_delay: Option<f64>,
    /// the bus reached (or left right after) its last stop while upstream's index was stale: course over
    pub ended: bool,
}

pub struct KbProgIn<'a> {
    pub geom: &'a ProgressGeom,
    /// planned seconds-of-day per `trip.times` index (None = unknown)
    pub plan: &'a [Option<f64>],
    pub lat: f64,
    pub lon: f64,
    /// epoch secs of this poll
    pub t_epoch: f64,
    /// agency-local seconds of the day of this poll
    pub local_secs: f64,
    /// upstream vehicle_trip_index
    pub vti: Option<i64>,
    /// index of the stop upstream says comes next (kbNextStopIndex)
    pub next_up: Option<i64>,
    /// parsePosition's delay, the value to keep while upstream's index is trustworthy
    pub delay_up: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelaySrc {
    /// keep upstream's value
    Est,
    /// schedule deviation now
    Gps,
    /// the last one (bus momentarily unplaceable)
    GpsHeld,
    /// upstream is known stale and the bus cannot be placed any more: no delay at all
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbProgOut {
    pub state: Option<KbProgState>,
    pub mode: TrackMode,
    #[serde(rename = "D")]
    pub d: Option<f64>,
    pub last_idx: Option<i64>,
    pub next_idx: Option<usize>,
    pub stale: bool,
    pub src: DelaySrc,
    /// secs; for `Est` it is `delay_up` unchanged, for `Unknown` None
    pub delay: Option<f64>,
    /// a stale-indexed bus has reached its last stop (upstream never registers it): hide it like parsePosition's own
    /// "sitting at the last stop" rule does. Only ever true after warm tracking, never from a cold start.
    pub finished: bool,
    /// schedule deviation at the GPS position whenever the bus was placed (diagnostics); None when unplaced
    pub dev: Option<f64>,
}

pub fn step_kb_progress(inp: &KbProgIn, prev: Option<&KbProgState>) -> KbProgOut {
    let st = &inp.geom.stops[..];
    let plan = inp.plan;
    let was_stale = prev.is_some_and(|p| p.stale_vti.is_some() && p.stale_vti == inp.vti);

    // course over (latched): the bus reached its last stop while upstream's index was stale
    if let Some(p) = prev
        && was_stale
        && p.ended
    {
        let pg = progress_at(st, p.d, inp.next_up);
        return KbProgOut {
            state: Some(*p),
            mode: TrackMode::Hold,
            d: Some(p.d),
            last_idx: Some(pg.last_idx),
            next_idx: None,
            stale: true,
            src: DelaySrc::GpsHeld,
            delay: p.end_delay.or(p.robust),
            finished: true,
            dev: None,
        };
    }

    let tr = track_along(
        inp.geom,
        inp.lat,
        inp.lon,
        inp.t_epoch,
        inp.local_secs,
        plan,
        inp.vti,
        inp.next_up,
        prev.map(|p| Track { d: p.d, t: p.t }),
    );
    let Some((d, mode)) = tr.filter(|t| t.1 != TrackMode::Hold) else {
        let pg = prev.map(|p| progress_at(st, p.d, inp.next_up));
        let base = KbProgOut {
            state: prev.copied(),
            mode: if tr.is_none() { TrackMode::Off } else { TrackMode::Hold },
            d: prev.map(|p| p.d),
            last_idx: pg.map(|g| g.last_idx),
            next_idx: pg.and_then(|g| g.next_idx),
            stale: false,
            src: DelaySrc::Est,
            delay: inp.delay_up,
            finished: false,
            dev: None,
        };
        let Some(p) = prev.filter(|_| was_stale) else {
            return base;
        };
        // last placed right at the final stop and off the route now: the bus left after its terminus
        if let Some(last_stop) = finite_at_or_before(st, st.len() as i64 - 1)
            && p.d >= last_stop - END_LEFT_M
        {
            let delay = p.end_delay.or(p.robust);
            let state = KbProgState {
                end_delay: delay,
                ended: true,
                ..*p
            };
            return KbProgOut {
                state: Some(state),
                stale: true,
                src: DelaySrc::GpsHeld,
                delay,
                finished: true,
                ..base
            };
        }
        if p.robust.is_some() && inp.t_epoch - p.robust_at <= HOLD_CARRY_S {
            return KbProgOut {
                stale: true,
                src: DelaySrc::GpsHeld,
                delay: p.robust,
                ..base
            };
        }
        return KbProgOut {
            stale: true,
            src: DelaySrc::Unknown,
            delay: None,
            ..base
        };
    };

    let pg = progress_at(st, d, inp.next_up);
    let dev = schedule_delay(st, plan, d, inp.local_secs);
    if pg.stale
        && let Some(dev) = dev.filter(|v| v.abs() <= DEV_MAX_S)
    {
        let mut delay = dev;
        let mut end_delay = None;
        let mut ended = false;
        if pg.next_idx.is_none() {
            // at/after the last stop: freeze the arrival delay instead of letting a parked bus get "later"
            let e = prev.and_then(|p| p.end_delay).unwrap_or(dev);
            end_delay = Some(e);
            delay = e;
            ended = mode == TrackMode::Cont && near_last_stop(inp.geom, inp.lat, inp.lon, END_NEAR_M);
        }
        let state = KbProgState {
            d,
            t: inp.t_epoch,
            stale_vti: inp.vti,
            robust: Some(delay),
            robust_at: inp.t_epoch,
            end_delay,
            ended,
        };
        return KbProgOut {
            state: Some(state),
            mode,
            d: Some(d),
            last_idx: Some(pg.last_idx),
            next_idx: pg.next_idx,
            stale: true,
            src: DelaySrc::Gps,
            delay: Some(delay),
            finished: ended,
            dev: Some(dev),
        };
    }
    let state = KbProgState {
        d,
        t: inp.t_epoch,
        stale_vti: None,
        robust: None,
        robust_at: 0.0,
        end_delay: None,
        ended: false,
    };
    KbProgOut {
        state: Some(state),
        mode,
        d: Some(d),
        last_idx: Some(pg.last_idx),
        next_idx: pg.next_idx,
        stale: false,
        src: DelaySrc::Est,
        delay: inp.delay_up,
        finished: false,
        dev,
    }
}

/// Arrival log of one KB execution: `arrived[i]` = epoch secs the bus was first seen at/past times[i] (array
/// position, like vti); `reached` = highest index seen; `t` = poll time of the last step.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct KbArrivals {
    pub arrived: Vec<Option<f64>>,
    pub reached: i64,
    pub t: f64,
}

/// Longest poll gap whose newly reached stop is still stamped.
const ARRIVAL_GAP_S: f64 = 60.0;
/// Most stops a bus passes between two polls; a longer jump is a resync, not an arrival seen now.
const ARRIVAL_MAX_STEP: i64 = 2;

/// Upstream drops the times of passed KB stops, so the poller records them itself. The first sighting is only a
/// baseline (stops passed before it stay unknown, never "now"); afterwards the newly reached stop gets `fix_at`.
/// Stops skipped in one step get None: a jump means upstream registered them late or not at all. Callers bound
/// `reached` by the trip's stop count.
pub fn step_arrivals(prev: Option<&KbArrivals>, reached: i64, t: f64, fix_at: f64) -> KbArrivals {
    let Some(prev) = prev else {
        return KbArrivals {
            arrived: Vec::new(),
            reached,
            t,
        };
    };
    // every caller keeps reached >= -1; `reached < 0` only guards the usize cast
    if reached <= prev.reached || reached < 0 {
        return KbArrivals { t, ..prev.clone() };
    }
    let r = reached as usize;
    let mut arrived = prev.arrived.clone();
    if arrived.len() <= r {
        arrived.resize(r + 1, None);
    }
    let seen = t - prev.t <= ARRIVAL_GAP_S && reached - prev.reached <= ARRIVAL_MAX_STEP;
    arrived[r] = seen.then_some(fix_at);
    KbArrivals { arrived, reached, t }
}
