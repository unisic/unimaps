//! lib/geo.ts: server-side geometry.

/// `Math.PI / 180`, multiplied and divided the way the TS does (`to_degrees` multiplies by 180/PI: another rounding)
pub const RAD: f64 = std::f64::consts::PI / 180.0;

/// Approximate metres between two nearby points (planar, fine at city scale).
pub fn meters_between(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1) * 111_320.0;
    let d_lon = (lon2 - lon1) * 111_320.0 * (((lat1 + lat2) / 2.0) * RAD).cos();
    d_lat.hypot(d_lon)
}

/// The items of `all` within `max_m` of `from`, nearest first (ties keep their order), at most `max`. O(n log n).
pub fn nearest_within<T>(
    from: (f64, f64),
    all: impl IntoIterator<Item = T>,
    pos: impl Fn(&T) -> (f64, f64),
    max_m: f64,
    max: usize,
) -> Vec<T> {
    let mut near: Vec<(T, f64)> = all
        .into_iter()
        .filter_map(|p| {
            let (lat, lon) = pos(&p);
            let d = meters_between(from.0, from.1, lat, lon);
            (d <= max_m).then_some((p, d))
        })
        .collect();
    near.sort_by(|a, b| a.1.total_cmp(&b.1));
    near.truncate(max);
    near.into_iter().map(|(p, _)| p).collect()
}

/// Initial great-circle bearing from point 1 to point 2, degrees [0, 360).
pub fn bearing(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> Option<f64> {
    if lat1 == lat2 && lon1 == lon2 {
        return None;
    }
    let (phi1, phi2) = (lat1 * RAD, lat2 * RAD);
    let dlon = (lon2 - lon1) * RAD;
    let x = dlon.sin() * phi2.cos();
    let y = phi1.cos() * phi2.sin() - phi1.sin() * phi2.cos() * dlon.cos();
    Some((x.atan2(y) / RAD + 360.0) % 360.0)
}
