//! lib/client/geo.ts findActiveStop, the client code a GPS stop index is fed to (the oracle, not a server module).

fn haversine(a_lat: f64, a_lon: f64, b_lat: f64, b_lon: f64) -> f64 {
    let rad = std::f64::consts::PI / 180.0;
    let d_lat = (b_lat - a_lat) * rad;
    let d_lon = (b_lon - a_lon) * rad;
    let s = (d_lat / 2.0).sin().powi(2) + (a_lat * rad).cos() * (b_lat * rad).cos() * (d_lon / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * s.sqrt().atan2((1.0 - s).sqrt())
}

pub struct Vehicle {
    pub lat: f64,
    pub lon: f64,
    pub at_stop: Option<bool>,
    pub current_stop_sequence: Option<i64>,
}

struct Cand {
    seg: usize,
    dist: f64,
    progress: f64,
    raw_t: f64,
}

fn between_then_dist(a: &Cand, b: &Cand) -> std::cmp::Ordering {
    let rank = |c: &Cand| u8::from(!(0.0..=1.0).contains(&c.raw_t));
    rank(a).cmp(&rank(b)).then(a.dist.total_cmp(&b.dist))
}

/// findActiveStop as (index, isAtStop); progress is left out.
pub fn find_active_stop(stops: &[Option<(f64, f64)>], v: &Vehicle, vti_hint: Option<i64>) -> (usize, bool) {
    let n = stops.len();
    if n == 0 {
        return (0, false);
    }
    if n == 1 {
        return (0, true);
    }
    let hint = vti_hint.filter(|&h| h >= 0 && (h as usize) < n).map(|h| h as usize);
    if !v.lat.is_finite() || !v.lon.is_finite() {
        return (vti_hint.unwrap_or(0).clamp(0, n as i64 - 1) as usize, false);
    }
    let pt = |i: usize| stops[i].filter(|p| p.0.is_finite() && p.1.is_finite());
    if v.at_stop == Some(true)
        && let Some(h) = hint
        && let Some(p) = pt(h)
        && haversine(v.lat, v.lon, p.0, p.1) <= 90.0
    {
        return (h, true);
    }
    let mut closest = 0;
    let mut min_stop = f64::INFINITY;
    let mut near: Vec<(usize, f64)> = Vec::new();
    for i in 0..n {
        let Some(p) = pt(i) else { continue };
        let d = haversine(v.lat, v.lon, p.0, p.1);
        if d < min_stop {
            min_stop = d;
            closest = i;
        }
        if d <= 55.0 {
            near.push((i, d));
        }
    }
    if near.len() > 1
        && let Some(h) = hint
    {
        let mut cands: Vec<(usize, f64)> = near.into_iter().filter(|c| c.1 <= min_stop + 30.0).collect();
        cands.sort_by(|a, b| a.0.abs_diff(h).cmp(&b.0.abs_diff(h)).then(a.1.total_cmp(&b.1)));
        (closest, min_stop) = cands[0];
    }
    if min_stop <= 55.0 && (v.at_stop == Some(true) || (v.at_stop != Some(false) && min_stop <= 35.0)) {
        return (closest, true);
    }
    let rad = std::f64::consts::PI / 180.0;
    let mut cands: Vec<Cand> = Vec::new();
    for i in 0..n - 1 {
        let (Some(a), Some(b)) = (stops[i], stops[i + 1]) else {
            continue;
        };
        if !a.0.is_finite() || !b.0.is_finite() {
            continue;
        }
        let cos_lat = ((a.0 + b.0) / 2.0 * rad).cos();
        let dx = (b.1 - a.1) * cos_lat;
        let dy = b.0 - a.0;
        let l2 = dx * dx + dy * dy;
        if l2 < 1e-12 {
            continue;
        }
        let t = ((v.lon - a.1) * cos_lat * dx + (v.lat - a.0) * dy) / l2;
        let ct = t.clamp(0.0, 1.0);
        let dist = haversine(v.lat, v.lon, a.0 + ct * dy, a.1 + ct * dx / cos_lat);
        cands.push(Cand {
            seg: i,
            dist,
            progress: ct,
            raw_t: t,
        });
    }
    if cands.is_empty() {
        return (closest, min_stop <= 55.0);
    }
    let min_seg = cands.iter().map(|c| c.dist).fold(f64::INFINITY, f64::min);
    let threshold = (min_seg + 70.0).max(min_seg * 1.6);
    let mut plausible: Vec<Cand> = cands.into_iter().filter(|c| c.dist <= threshold).collect();
    if v.at_stop == Some(false)
        && let Some(seq) = v.current_stop_sequence
        && let Some(m) = plausible.iter().find(|c| c.seg as i64 == seq)
    {
        return ((m.seg + 1).min(n - 1), false);
    }
    if plausible.len() > 1 {
        let mut near_hint: Vec<&Cand> = match hint {
            Some(h) => plausible
                .iter()
                .filter(|c| (c.seg + 1).abs_diff(h) <= 2 || c.seg.abs_diff(h) <= 2)
                .collect(),
            None => Vec::new(),
        };
        if near_hint.is_empty() {
            plausible.sort_by(between_then_dist);
        } else {
            near_hint.sort_by(|a, b| a.dist.total_cmp(&b.dist));
            let seg = near_hint[0].seg;
            plausible.retain(|c| c.seg == seg);
        }
    }
    let best = &plausible[0];
    if best.seg == n - 2 && best.raw_t > 1.0 {
        return (n - 1, true);
    }
    if best.seg + 1 == n - 1 && best.progress >= 0.98 {
        return (n - 1, min_stop <= 55.0);
    }
    (best.seg + 1, false)
}
