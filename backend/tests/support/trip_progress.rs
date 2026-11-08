//! lib/shared/trip-progress.ts stopsAtChainage, the client code the server-chain tests read dist_m with (the
//! oracle, not a server module).

const ZONE_BEFORE_M: f64 = 90.0;
const ZONE_AFTER_M: f64 = 90.0;

/// stopsAtChainage as (index, at), for the `{ vti, atStop }` hint these tests always pass; the no-at_stop
/// pole-zone branch never runs here.
pub fn stops_at_chainage(along: &[Option<f64>], s: f64, vti: i64, at_stop: bool) -> Option<(usize, bool)> {
    if !s.is_finite() {
        return None;
    }
    let placed: Vec<usize> = (0..along.len())
        .filter(|&i| along.get(i).copied().flatten().is_some_and(f64::is_finite))
        .collect();
    if placed.len() < 2 {
        return None;
    }
    let a = |i: usize| along.get(i).copied().flatten().unwrap_or(f64::NAN);
    let vti = usize::try_from(vti)
        .ok()
        .filter(|&v| along.get(v).copied().flatten().is_some());
    if let Some(v) = vti
        && at_stop
        && s >= a(v) - ZONE_BEFORE_M
        && s <= a(v) + ZONE_AFTER_M
    {
        return Some((v, true));
    }
    match placed.iter().copied().find(|&i| a(i) > s) {
        // past the last stop: upstream's explicit "not at stop" keeps it approaching the terminus
        None => placed.last().map(|&last| (last, at_stop)),
        Some(nx) => Some((nx, false)),
    }
}
