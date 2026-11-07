//! lib/shared/polyline.ts: polyline math shared with the client motion engine. Both sides MUST measure with the
//! same metric (`seg_meters`), or the server's `dist_m` drifts from the client's own `cum`.

use crate::geo::RAD;
use crate::js;

pub type LatLng = [f64; 2];

/// South, west, north, east edges in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LatLonBox {
    pub s: f64,
    pub w: f64,
    pub n: f64,
    pub e: f64,
}

const M_PER_DEG: f64 = 111_320.0;

/// Planar metres between two nearby points, identical to `geo::meters_between`.
pub fn seg_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    crate::geo::meters_between(lat1, lon1, lat2, lon2)
}

/// Planar compass bearing (deg, [0, 360)) from point 1 to point 2; None if identical.
pub fn planar_bearing(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> Option<f64> {
    let dy = lat2 - lat1;
    let dx = (lon2 - lon1) * (((lat1 + lat2) / 2.0) * RAD).cos();
    if dx == 0.0 && dy == 0.0 {
        return None;
    }
    Some((dx.atan2(dy) / RAD + 360.0) % 360.0)
}

/* ---------------------------------------------------------------- encoding */

/// Google encoded polyline (precision 6 is the app-wide wire format).
pub fn encode_polyline(pts: &[LatLng], precision: i32) -> String {
    let f = 10f64.powi(precision);
    let mut out = String::new();
    let (mut p_lat, mut p_lon) = (0i64, 0i64);
    for &[lat, lon] in pts {
        let (i_lat, i_lon) = (js::round(lat * f) as i64, js::round(lon * f) as i64);
        encode_signed(i_lat - p_lat, &mut out);
        encode_signed(i_lon - p_lon, &mut out);
        (p_lat, p_lon) = (i_lat, i_lon);
    }
    out
}

fn encode_signed(v: i64, out: &mut String) {
    let mut s = if v < 0 { !(v * 2) } else { v * 2 };
    while s >= 0x20 {
        out.push(char::from(((0x20 | (s & 0x1f)) + 63) as u8));
        s /= 32;
    }
    out.push(char::from((s + 63) as u8));
}

/// Inverse of `encode_polyline`. Malformed input yields the points decoded so far.
pub fn decode_polyline(s: &str, precision: i32) -> Vec<LatLng> {
    let f = 10f64.powi(precision);
    let b = s.as_bytes();
    let mut i = 0;
    // f64 like the JS numbers: a long run of continuation bytes loses precision instead of overflowing
    let mut next = || -> Option<f64> {
        let (mut result, mut mul) = (0.0f64, 1.0f64);
        loop {
            let c = *b.get(i)? as i32 - 63;
            i += 1;
            if !(0..=63).contains(&c) {
                return None;
            }
            result += f64::from(c & 0x1f) * mul;
            mul *= 32.0;
            if c < 0x20 {
                break;
            }
        }
        Some(if result % 2.0 == 1.0 {
            -(result + 1.0) / 2.0
        } else {
            result / 2.0
        })
    };
    let mut out = Vec::new();
    let (mut lat, mut lon) = (0.0, 0.0);
    while let (Some(d_lat), Some(d_lon)) = (next(), next()) {
        lat += d_lat;
        lon += d_lon;
        out.push([lat / f, lon / f]);
    }
    out
}

/* ---------------------------------------------------------------- prepared */

/// Polyline with cumulative along-route metres, ready for projection and sampling.
#[derive(Debug, Clone)]
pub struct Polyline {
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    /// cum[i] = metres from the start to vertex i (`seg_meters` sum)
    pub cum: Vec<f64>,
    pub length: f64,
}

impl Polyline {
    pub fn n(&self) -> usize {
        self.lat.len()
    }
}

/// Drops non-finite points and consecutive near-duplicates; None if < 2 remain.
pub fn prepare_polyline(pts: &[LatLng]) -> Option<Polyline> {
    let (mut lat, mut lon) = (Vec::with_capacity(pts.len()), Vec::with_capacity(pts.len()));
    for &[a, b] in pts {
        if !a.is_finite() || !b.is_finite() {
            continue;
        }
        if let (Some(&pa), Some(&pb)) = (lat.last(), lon.last())
            && seg_meters(pa, pb, a, b) < 0.05
        {
            continue;
        }
        lat.push(a);
        lon.push(b);
    }
    let n = lat.len();
    if n < 2 {
        return None;
    }
    let mut cum = vec![0.0; n];
    for i in 1..n {
        cum[i] = cum[i - 1] + seg_meters(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    }
    let length = cum[n - 1];
    Some(Polyline { lat, lon, cum, length })
}

/// Index of the segment containing along-distance s (clamped to [0, n-2]).
pub fn segment_at(pl: &Polyline, s: f64, hint: Option<usize>) -> usize {
    let last = pl.n() - 2;
    if let Some(h) = hint
        && h <= last
        && pl.cum[h] <= s
        && s <= pl.cum[h + 1]
    {
        return h;
    }
    if s <= 0.0 {
        return 0;
    }
    if s >= pl.length {
        return last;
    }
    let (mut lo, mut hi) = (0, last);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if pl.cum[mid] <= s {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointAt {
    pub lat: f64,
    pub lon: f64,
    pub seg: usize,
}

/// Point at along-distance s (clamped to the polyline).
pub fn point_at(pl: &Polyline, s: f64, hint: Option<usize>) -> PointAt {
    let i = segment_at(pl, s, hint);
    let seg_len = pl.cum[i + 1] - pl.cum[i];
    let t = if seg_len > 0.0 {
        ((s - pl.cum[i]) / seg_len).clamp(0.0, 1.0)
    } else {
        0.0
    };
    PointAt {
        lat: pl.lat[i] + (pl.lat[i + 1] - pl.lat[i]) * t,
        lon: pl.lon[i] + (pl.lon[i + 1] - pl.lon[i]) * t,
        seg: i,
    }
}

/// Travel direction at s, measured over [s-back, s+ahead] so OSRM micro-segments don't flip the heading arrow
/// (TS defaults: back 5, ahead 15).
pub fn tangent_bearing(pl: &Polyline, s: f64, back: f64, ahead: f64) -> Option<f64> {
    let a = point_at(pl, s - back, None);
    let b = point_at(pl, s + ahead, None);
    planar_bearing(a.lat, a.lon, b.lat, b.lon)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Projection {
    /// along-route metres of the projected point
    pub s: f64,
    /// perpendicular distance from the query point, metres
    pub d: f64,
    pub seg: usize,
}

/// Projects (lat, lon) onto the part of the polyline with s in [s_min, s_max]. Among candidates within `slack_m`
/// (TS default 15) of the best distance, the one closest to `hint` wins (keeps the opposite leg of an
/// out-and-back from stealing the fix).
pub fn project_on_polyline(
    pl: &Polyline,
    lat: f64,
    lon: f64,
    s_min: f64,
    s_max: f64,
    hint: Option<f64>,
    slack_m: f64,
) -> Option<Projection> {
    // JS `Math.max(0, NaN)` is NaN and `!(hi >= lo)` then rejects it; `f64::max` would drop the NaN instead
    if s_min.is_nan() || s_max.is_nan() {
        return None;
    }
    let lo = s_min.max(0.0);
    let hi = s_max.min(pl.length);
    if hi < lo {
        return None;
    }
    let mut best_d = f64::INFINITY;
    let mut cand: Vec<Projection> = Vec::new();
    let mut i = segment_at(pl, lo, None);
    while i < pl.n() - 1 && pl.cum[i] <= hi {
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
        let mut s = pl.cum[i] + t * seg_len;
        if s < lo || s > hi {
            s = s.max(lo).min(hi);
            t = if seg_len > 0.0 { (s - pl.cum[i]) / seg_len } else { 0.0 };
        }
        let d = js::hypot(px - t * dx, py - t * dy);
        if d < best_d {
            best_d = d;
        }
        if d <= best_d + slack_m {
            cand.push(Projection { s, d, seg: i });
        }
        i += 1;
    }
    let mut best: Option<Projection> = None;
    for c in cand {
        if c.d > best_d + slack_m {
            continue;
        }
        best = match best {
            None => Some(c),
            Some(b) => Some(match hint {
                Some(h) if (c.s - h).abs() < (b.s - h).abs() => c,
                None if c.d < b.d => c,
                _ => b,
            }),
        };
    }
    best
}

/// Along-route distances of an ordered stop list (None allowed). Monotone: each stop is searched from the previous
/// stop's distance onwards and the EARLIEST good candidate wins, so a loop whose first and last stop coincide gets
/// ~0 and ~length. A stop further than `max_off_m` (TS default 80) from the route yields None.
pub fn project_stops_along(pl: &Polyline, stops: &[Option<LatLng>], max_off_m: f64) -> Vec<Option<f64>> {
    let mut out = Vec::with_capacity(stops.len());
    let mut s_prev = 0.0f64;
    for st in stops {
        let Some([lat, lon]) = st.filter(|p| p[0].is_finite() && p[1].is_finite()) else {
            out.push(None);
            continue;
        };
        let lo = (s_prev - 20.0).max(0.0);
        let mut best_d = f64::INFINITY;
        let mut cands: Vec<(f64, f64)> = Vec::new();
        for i in segment_at(pl, lo, None)..pl.n() - 1 {
            let (s, d) = project_segment(pl, i, lat, lon);
            if s < lo {
                continue;
            }
            if d < best_d {
                best_d = d;
            }
            cands.push((s, d));
        }
        let limit = (best_d + 15.0).min(max_off_m);
        match cands.iter().find(|c| c.1 <= limit) {
            Some(&(pick, _)) => {
                let s = s_prev.max(pick);
                out.push(Some(s));
                s_prev = s;
            }
            None => out.push(None),
        }
    }
    out
}

fn project_segment(pl: &Polyline, i: usize, lat: f64, lon: f64) -> (f64, f64) {
    let (a_lat, a_lon) = (pl.lat[i], pl.lon[i]);
    let kx = M_PER_DEG * (((a_lat + pl.lat[i + 1]) / 2.0) * RAD).cos();
    let dx = (pl.lon[i + 1] - a_lon) * kx;
    let dy = (pl.lat[i + 1] - a_lat) * M_PER_DEG;
    let px = (lon - a_lon) * kx;
    let py = (lat - a_lat) * M_PER_DEG;
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        ((px * dx + py * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (
        pl.cum[i] + t * (pl.cum[i + 1] - pl.cum[i]),
        js::hypot(px - t * dx, py - t * dy),
    )
}

/// Part of the polyline between along-distances s0 < s1 (endpoints interpolated).
pub fn slice_polyline(pl: &Polyline, s0: f64, s1: f64) -> Vec<LatLng> {
    let a = s0.min(s1).max(0.0);
    let b = s0.max(s1).min(pl.length);
    let p0 = point_at(pl, a, None);
    let p1 = point_at(pl, b, None);
    let mut out = vec![[p0.lat, p0.lon]];
    for i in p0.seg + 1..=p1.seg {
        out.push([pl.lat[i], pl.lon[i]]);
    }
    out.push([p1.lat, p1.lon]);
    out
}

/* ---------------------------------------------------------------- cleanup */

/// Douglas-Peucker in local planar metres (TS default tolerance 2 m); endpoints always kept.
pub fn simplify_polyline(pts: &[LatLng], tol_m: f64) -> Vec<LatLng> {
    let n = pts.len();
    if n <= 2 {
        return pts.to_vec();
    }
    let lat_sum: f64 = pts.iter().map(|p| p[0]).sum();
    let kx = M_PER_DEG * ((lat_sum / n as f64) * RAD).cos();
    let x = |i: usize| pts[i][1] * kx;
    let y = |i: usize| pts[i][0] * M_PER_DEG;
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let (ax, ay) = (x(a), y(a));
        let (dx, dy) = (x(b) - ax, y(b) - ay);
        let len2 = dx * dx + dy * dy;
        let (mut max_d, mut idx) = (-1.0, None);
        for i in a + 1..b {
            let (px, py) = (x(i) - ax, y(i) - ay);
            let t = if len2 > 0.0 {
                ((px * dx + py * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let d = js::hypot(px - t * dx, py - t * dy);
            if d > max_d {
                max_d = d;
                idx = Some(i);
            }
        }
        if let Some(i) = idx
            && max_d > tol_m
        {
            keep[i] = true;
            stack.push((a, i));
            stack.push((i, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// Removes short out-and-back stubs (a stop snapped to the wrong carriageway makes OSRM drive past it and U-turn
/// back): a detour of <= `max_len_m` (TS default 150) whose return stays within `tol_m` (10) of the outbound path.
/// A stub whose far end is near a `protect` point (a real stop, e.g. a dead-end terminus) is kept.
pub fn prune_spurs(pts: &[LatLng], protect: &[LatLng], max_len_m: f64, tol_m: f64) -> Vec<LatLng> {
    let mut cur = pts.to_vec();
    for _ in 0..50 {
        let Some((a, b)) = find_spur(&cur, protect, max_len_m, tol_m) else {
            break;
        };
        cur.drain(a + 1..b);
    }
    cur
}

fn find_spur(pts: &[LatLng], protect: &[LatLng], max_len_m: f64, tol_m: f64) -> Option<(usize, usize)> {
    let n = pts.len();
    for a in 0..n.saturating_sub(2) {
        let (mut path, mut far, mut far_d) = (0.0, a, 0.0);
        for b in a + 1..n {
            path += seg_meters(pts[b - 1][0], pts[b - 1][1], pts[b][0], pts[b][1]);
            if path > 2.0 * max_len_m + 2.0 * tol_m {
                break;
            }
            let d_from_a = seg_meters(pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
            if d_from_a > far_d {
                far_d = d_from_a;
                far = b;
            }
            if b - a < 2 || far_d < 3.0 * tol_m || far_d > max_len_m || d_from_a > tol_m {
                continue;
            }
            // b is back near a after going out to `far`: does the return hug the outbound?
            if (far + 1..b).any(|k| dist_to_path(pts, a, far, pts[k]) > tol_m) {
                continue;
            }
            let fp = pts[far];
            if protect.iter().any(|p| seg_meters(p[0], p[1], fp[0], fp[1]) < 25.0) {
                continue;
            }
            return Some((a, b));
        }
    }
    None
}

fn dist_to_path(pts: &[LatLng], from: usize, to: usize, q: LatLng) -> f64 {
    let mut best = f64::INFINITY;
    for i in from..to {
        let (a_lat, a_lon) = (pts[i][0], pts[i][1]);
        let kx = M_PER_DEG * (((a_lat + pts[i + 1][0]) / 2.0) * RAD).cos();
        let dx = (pts[i + 1][1] - a_lon) * kx;
        let dy = (pts[i + 1][0] - a_lat) * M_PER_DEG;
        let px = (q[1] - a_lon) * kx;
        let py = (q[0] - a_lat) * M_PER_DEG;
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 {
            ((px * dx + py * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        best = best.min(js::hypot(px - t * dx, py - t * dy));
    }
    best
}
