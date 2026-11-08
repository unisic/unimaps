//! MZK variant geometry and stop indices, port of `lib/mzk-shape.ts`. Inputs are the operator's raw JSON.

use serde_json::Value;

use crate::js::value_to_string;
use crate::shared::polyline::{LatLng, prepare_polyline, project_stops_along};

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn arr(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MzkShape {
    pub pts: Vec<LatLng>,
    pub stops: Vec<Option<f64>>,
}

/// `mzkShapeFromCourseDetails`: road polyline + per-stop along distances of one variant (getTheoreticalCourseDetails).
pub fn mzk_shape_from_course_details(raw: &Value) -> Option<MzkShape> {
    let segs = arr(raw.get("segments"));
    let mut pts: Vec<LatLng> = Vec::new();
    let mut bounds: Vec<Option<LatLng>> = Vec::with_capacity(segs.len() + 1);
    for seg in segs {
        let mut first = None;
        for n in arr(seg.get("nodes")) {
            let (Some(lat), Some(lon)) = (num(n.get("latitude")), num(n.get("longitude"))) else {
                continue;
            };
            first.get_or_insert([lat, lon]);
            if pts.last() != Some(&[lat, lon]) {
                pts.push([lat, lon]);
            }
        }
        bounds.push(first);
    }
    if pts.len() >= 2 && !segs.is_empty() {
        bounds.push(pts.last().copied());
    }
    let pl = prepare_polyline(&pts)?;
    let sp = arr(raw.get("stopPoints"));
    // segments line up with stops (n stops, n-1 segments): the boundaries ARE the stops
    let refs: Vec<Option<LatLng>> = if !segs.is_empty() && sp.len() == segs.len() + 1 {
        bounds
    } else {
        sp.iter()
            .map(|s| match (num(s.get("latitude")), num(s.get("longitude"))) {
                (Some(lat), Some(lon)) => Some([lat, lon]),
                _ => None,
            })
            .collect()
    };
    let stops = project_stops_along(&pl, &refs, 80.0);
    Some(MzkShape { pts, stops })
}

/// `mzkRemapDist`: the operator's reachedMeters on our polyline metric, piecewise between stops. `seg_dist[k]` is the
/// operator's length of the segment ending at stop k (None = absent or not a number).
pub fn mzk_remap_dist(reached: f64, seg_dist: &[Option<f64>], stops: &[Option<f64>]) -> Option<f64> {
    if !reached.is_finite() || reached < 0.0 || stops.len() < 2 {
        return None;
    }
    let (mut op_cum, mut prev_op) = (0.0, 0.0);
    let mut prev_s = stops[0];
    for (k, &s_k) in stops.iter().enumerate().skip(1) {
        let d = seg_dist
            .get(k)
            .copied()
            .flatten()
            .filter(|d| d.is_finite() && *d >= 0.0)?;
        op_cum += d;
        if reached <= op_cum {
            let (p, s) = (prev_s?, s_k?);
            let frac = if op_cum > prev_op {
                (reached - prev_op) / (op_cum - prev_op)
            } else {
                0.0
            };
            return Some(p + frac * (s - p));
        }
        prev_op = op_cum;
        prev_s = s_k;
    }
    // past the last stop (terminus overshoot): clamp to the end
    stops[stops.len() - 1]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MzkStopIndices {
    /// the stop the vehicle is at
    pub served: Option<usize>,
    /// the next stop it will arrive at
    pub next: Option<usize>,
}

/// `mzkStopIndices` of a raw running-vehicle record (onStopPoint, nearestSymbolOrderNo, orderInCourse, stopPoints).
pub fn mzk_stop_indices(v: &Value) -> MzkStopIndices {
    let sp = arr(v.get("stopPoints"));
    let n = sp.len();
    if n == 0 {
        return MzkStopIndices {
            served: None,
            next: None,
        };
    }
    let ord = num(v.get("orderInCourse")).filter(|o| o.fract() == 0.0);
    let base = match ord {
        Some(o) if o >= 0.0 => o.min((n - 1) as f64) as usize,
        _ => 0,
    };
    let on = v.get("onStopPoint");
    if !matches!(on, None | Some(Value::Null) | Some(Value::Bool(false))) && on.and_then(Value::as_str) != Some("") {
        let sym = value_to_string(on);
        if let Some(k) = (base..n).find(|&k| value_to_string(sp[k].get("symbol")) == sym) {
            return MzkStopIndices {
                served: Some(k),
                next: (k + 1 < n).then_some(k + 1),
            };
        }
    }
    if let Some(near) = num(v.get("nearestSymbolOrderNo"))
        && near.fract() == 0.0
        && near >= 0.0
        && near < n as f64
        && ord.is_none_or(|o| near > o)
    {
        return MzkStopIndices {
            served: None,
            next: Some(near as usize),
        };
    }
    MzkStopIndices {
        served: None,
        next: (base + 1 < n).then_some(base + 1),
    }
}
