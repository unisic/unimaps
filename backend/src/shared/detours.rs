//! lib/shared/detours.ts: known detours and stop-pole routing tweaks, read from the same lib/shared/detours.json.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::js::is_space;
use crate::shared::polyline::LatLng;

/// The fields routing reads; title and description are the client's banner.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineDetour {
    pub id: String,
    pub lines: Vec<String>,
    /// direction substring filter if direction-specific
    pub direction_contains: Option<String>,
    /// [minLat, minLon, maxLat, maxLon]
    pub trigger_area: Option<[f64; 4]>,
    /// in travel order
    pub via_waypoints: Vec<LatLng>,
    /// only trips crossing the area in waypoint order detour
    #[serde(default)]
    pub one_way: bool,
}

#[derive(Deserialize)]
struct Adjustment {
    at: LatLng,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    detours: Vec<LineDetour>,
    stop_adjustments: HashMap<String, Adjustment>,
}

static DATA: LazyLock<Data> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../lib/shared/detours.json")).expect("lib/shared/detours.json")
});

pub fn known_detours() -> &'static [LineDetour] {
    &DATA.detours
}

fn line_detours<'a>(line: &'a str, direction: Option<&'a str>) -> impl Iterator<Item = &'static LineDetour> + 'a {
    let clean = line.trim_matches(is_space);
    DATA.detours.iter().filter(move |d| {
        !line.is_empty()
            && d.lines.iter().any(|l| l == clean)
            && match (d.direction_contains.as_deref(), direction) {
                (Some(dc), Some(dir)) if !dc.is_empty() && !dir.is_empty() => {
                    dir.to_uppercase().contains(&dc.to_uppercase())
                }
                _ => true,
            }
    })
}

/// `getLineDetour`
pub fn get_line_detour(line: &str, direction: Option<&str>) -> Option<&'static LineDetour> {
    line_detours(line, direction).next()
}

fn approx_m(p: LatLng, q: LatLng) -> f64 {
    let d_lat = (p[0] - q[0]) * 111_000.0;
    let d_lon = (p[1] - q[1]) * 72_000.0;
    (d_lat * d_lat + d_lon * d_lon).sqrt()
}

enum Applied {
    /// the detour only needs a banner (the same array in the TS)
    Same,
    New(Vec<LatLng>),
}

/// `applyDetour`, None when the detour does not apply. The TS has the reasoning per step.
fn apply_detour(points: &[LatLng], d: &LineDetour) -> Option<Applied> {
    let Some([min_lat, min_lon, max_lat, max_lon]) = d.trigger_area else {
        return Some(Applied::Same);
    };
    let wps = &d.via_waypoints;
    if !wps.is_empty() && wps.iter().all(|wp| points.iter().any(|pt| approx_m(*pt, *wp) < 380.0)) {
        return Some(Applied::Same);
    }
    let mut segs = Vec::new();
    let mut cur = None;
    for (i, &[lat, lon]) in points.iter().enumerate() {
        let inside = lat >= min_lat && lat <= max_lat && lon >= min_lon && lon <= max_lon;
        match (inside, cur) {
            (true, None) => cur = Some(i),
            (false, Some(s)) => {
                segs.push((s, i - 1));
                cur = None;
            }
            _ => {}
        }
    }
    if let Some(s) = cur {
        segs.push((s, points.len() - 1));
    }
    let (Some(&first), Some(&last)) = (wps.first(), wps.last()) else {
        return (!segs.is_empty()).then_some(Applied::Same);
    };
    for (start, end) in segs {
        if start == end {
            continue;
        }
        let (a, b) = (points[start], points[end]);
        let forward = approx_m(a, first) + approx_m(last, b) <= approx_m(a, last) + approx_m(first, b);
        if !forward && d.one_way {
            continue;
        }
        let mut out = points[..=start].to_vec();
        if forward {
            out.extend_from_slice(wps);
        } else {
            out.extend(wps.iter().rev());
        }
        out.extend_from_slice(&points[end..]);
        return Some(Applied::New(out));
    }
    None
}

/// `injectDetourPoints`: the points with every detour of the line applied where the trip enters its area (None =
/// the input unchanged) and the first detour that applied.
pub fn inject_detour_points(
    points: &[LatLng],
    line: Option<&str>,
    direction: Option<&str>,
) -> (Option<Vec<LatLng>>, Option<&'static LineDetour>) {
    let Some(line) = line.filter(|l| !l.is_empty() && points.len() >= 2) else {
        return (None, None);
    };
    let mut out: Option<Vec<LatLng>> = None;
    let mut hit = None;
    for d in line_detours(line, direction) {
        let Some(res) = apply_detour(out.as_deref().unwrap_or(points), d) else {
            continue;
        };
        let new = matches!(res, Applied::New(_));
        if hit.is_none() || (out.is_none() && new) {
            hit = Some(d);
        }
        if let Applied::New(v) = res {
            out = Some(v);
        }
    }
    (out, hit)
}

/// `adjustStopRoutePoint`
pub fn adjust_stop_route_point(stop_id: Option<&str>, pt: LatLng) -> LatLng {
    stop_id
        .and_then(|id| DATA.stop_adjustments.get(id))
        .map_or(pt, |a| a.at)
}
