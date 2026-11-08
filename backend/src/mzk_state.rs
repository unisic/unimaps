//! Lifecycle of an MZK (OnTime) running-vehicle record, port of `lib/mzk-state.ts` (the reasoning and the
//! measurements behind every threshold live there).

use serde_json::Value;

use crate::geo::meters_between;
use crate::js;

/// Below this reachedMeters a bus flagged "left stop 0" (lastStopOrderNo 0) is still idling at the terminus.
pub const MZK_NOT_STARTED_REACHED_M: f64 = 30.0;

/// A bus this far from its first stop has demonstrably left it, whatever the OnTime flags say.
pub const MZK_NOT_STARTED_MAX_FROM_FIRST_M: f64 = 400.0;

/// The fields of a raw OnTime record `isMzkNotStarted` reads, with the JSON distinctions it makes.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MzkLifecycleInput {
    /// a JSON number, else None (absent, null, a string, ...)
    pub order_in_course: Option<f64>,
    /// None = field absent, Some(None) = null, Some(Some(NaN)) = any other non-number
    pub last_stop_order_no: Option<Option<f64>>,
    pub reached_meters: Option<f64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

impl MzkLifecycleInput {
    pub fn from_json(v: &Value) -> Self {
        let num = |k: &str| v.get(k).and_then(Value::as_f64);
        Self {
            order_in_course: num("orderInCourse"),
            last_stop_order_no: match v.get("lastStopOrderNo") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(x) => Some(Some(x.as_f64().unwrap_or(f64::NAN))),
            },
            reached_meters: num("reachedMeters"),
            latitude: num("latitude"),
            longitude: num("longitude"),
        }
    }
}

fn finite(x: Option<f64>) -> Option<f64> {
    x.filter(|v| v.is_finite())
}

/// `isMzkNotStarted`: true while the course has not begun. `first_stop` = (lat, lon) of its first stop when known.
/// Unknown or garbled input classifies as started, so a real delay is never hidden.
pub fn is_mzk_not_started(v: &MzkLifecycleInput, first_stop: Option<(f64, f64)>) -> bool {
    if v.order_in_course != Some(0.0) {
        return false;
    }
    let Some(last) = v.last_stop_order_no else {
        return false;
    };
    if let Some(last) = last {
        if last != 0.0 {
            return false;
        }
        if finite(v.reached_meters).unwrap_or(0.0) >= MZK_NOT_STARTED_REACHED_M {
            return false;
        }
    }
    if let (Some((flat, flon)), Some(lat), Some(lon)) = (first_stop, finite(v.latitude), finite(v.longitude))
        && meters_between(lat, lon, flat, flon) > MZK_NOT_STARTED_MAX_FROM_FIRST_M
    {
        return false;
    }
    true
}

/// `clampPlannedMonotone`: planned times after `from_idx` lifted to their predecessor where they dip; entries up to
/// `from_idx` (passed stops) untouched, non-finite = None.
pub fn clamp_planned_monotone(planned: &[Option<f64>], from_idx: f64) -> Vec<Option<f64>> {
    let mut out: Vec<Option<f64>> = planned.iter().map(|&p| finite(p)).collect();
    let mut floor = f64::NEG_INFINITY;
    for (i, slot) in out.iter_mut().enumerate() {
        let Some(p) = *slot else { continue };
        if i as f64 > from_idx {
            if p < floor {
                *slot = Some(floor);
            } else {
                floor = p;
            }
        } else {
            floor = floor.max(p);
        }
    }
    out
}

/// `hasPlannedDip`: `clamp_planned_monotone` would change something.
pub fn has_planned_dip(planned: &[Option<f64>], from_idx: f64) -> bool {
    clamp_planned_monotone(planned, from_idx)
        .iter()
        .zip(planned)
        .any(|(c, &p)| *c != finite(p))
}

fn hhmm_from_secs(secs: f64) -> String {
    let s = secs.floor().rem_euclid(86_400.0) as i64;
    format!("{:02}:{:02}", s / 3600, s % 3600 / 60)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MzkRowTimingInput {
    /// scheduled departure from this stop, seconds since local midnight
    pub scheduled_departure_sec: f64,
    /// scheduled / real departure from this stop, epoch ms (real None/0 = no estimate)
    pub scheduled_departure: f64,
    pub real_departure: Option<f64>,
    pub lack: bool,
    pub not_started: bool,
    /// running vehicle's stopPoints[0].scheduledDeparture, epoch ms
    pub first_scheduled_ms: Option<f64>,
    pub now_ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MzkRowTiming {
    pub time: String,
    pub time_diff: f64,
    pub is_estimated: bool,
}

/// `mzkRowTiming`: "HH:MM", timeDiff seconds and isEstimated of one departure-board row. A course that has not begun
/// shows its earliest possible time (schedule pushed back by the overstay), never OnTime's placeholder estimate.
pub fn mzk_row_timing(i: &MzkRowTimingInput) -> MzkRowTiming {
    if i.not_started {
        let overstay = finite(i.first_scheduled_ms).map_or(0.0, |f| js::round((i.now_ms - f) / 1000.0).max(0.0));
        return MzkRowTiming {
            time: hhmm_from_secs(i.scheduled_departure_sec + overstay),
            time_diff: 0.0,
            is_estimated: false,
        };
    }
    if let Some(real) = i.real_departure.filter(|r| *r != 0.0 && !r.is_nan())
        && !i.lack
    {
        let time_diff = js::round((real - i.scheduled_departure) / 1000.0);
        return MzkRowTiming {
            time: hhmm_from_secs(i.scheduled_departure_sec + time_diff),
            time_diff,
            is_estimated: true,
        };
    }
    MzkRowTiming {
        time: hhmm_from_secs(i.scheduled_departure_sec),
        time_diff: 0.0,
        is_estimated: false,
    }
}
