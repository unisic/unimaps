//! lib/stop-directions.ts: per-stop travel directions from the built feed. Each trip credits a stop with the road
//! tangent through it (previous -> next stop; first and last stops their outgoing / incoming leg), the bearings are
//! clustered and the dominant one is kept, plus an opposite one with enough trips. Bus stations get no arrows.
//! No feed = no arrows, never an error.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use indexmap::IndexMap;

use crate::config;
use crate::geo::bearing;
use crate::gtfs_csv::{FeedCache, col, field, read_text, table};
use crate::js::{self, is_space};

/// Smallest absolute angle between two compass bearings, degrees [0, 180].
fn angle_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

/// Running sums of one cluster: the TS re-sums the list in push order on every read, which is the same arithmetic.
#[derive(Default)]
struct Cluster {
    n: usize,
    sin: f64,
    cos: f64,
}

impl Cluster {
    fn push(&mut self, b: f64) {
        let r = b * std::f64::consts::PI / 180.0;
        self.n += 1;
        self.sin += r.sin();
        self.cos += r.cos();
    }

    /// `circularMean`, rounded to whole degrees (360 can come out of the rounding, as in the TS).
    fn mean(&self) -> f64 {
        js::round((self.sin.atan2(self.cos) * 180.0 / std::f64::consts::PI + 360.0) % 360.0)
    }
}

/// `clusterRoadDirections`: bearings within 75 degrees of a cluster mean join it; the biggest cluster is the
/// direction, a second one is kept only when it runs the opposite way (>= 100 degrees off) with >= 2 trips and >= 15 %
/// of the first one's.
fn cluster_road_directions(bearings: &[f64]) -> Vec<f64> {
    const MERGE_THRESHOLD: f64 = 75.0;
    let mut clusters: Vec<Cluster> = Vec::new();
    for &b in bearings {
        let mut best: Option<usize> = None;
        let mut best_diff = MERGE_THRESHOLD;
        for (i, c) in clusters.iter().enumerate() {
            let diff = angle_diff(b, c.mean());
            if diff < best_diff {
                best_diff = diff;
                best = Some(i);
            }
        }
        match best {
            Some(i) => clusters[i].push(b),
            None => {
                let mut c = Cluster::default();
                c.push(b);
                clusters.push(c);
            }
        }
    }
    clusters.sort_by_key(|c| std::cmp::Reverse(c.n));
    let Some(first) = clusters.first() else {
        return Vec::new();
    };
    let primary = first.mean();
    let mut out = vec![primary];
    let opposite = clusters[1..]
        .iter()
        .find(|c| angle_diff(primary, c.mean()) >= 100.0 && c.n >= 2 && c.n as f64 >= first.n as f64 * 0.15);
    out.extend(opposite.map(Cluster::mean));
    out
}

/// `/(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i`: a bus station by name. Only ASCII matches the
/// pattern's letters case-insensitively in a non-unicode JS regex, so the ASCII comparison is the same.
fn is_station_name(name: &str) -> bool {
    let starts = |s: &str, p: &str| s.get(..p.len()).is_some_and(|h| h.eq_ignore_ascii_case(p));
    let ends = |s: &str| s.chars().next().is_none_or(|c| is_space(c) || c == ')');
    let mut prev: Option<char> = None;
    for (i, c) in name.char_indices() {
        if prev.is_none_or(|p| is_space(p) || p == '(') {
            let s = &name[i..];
            if starts(s, "D.A") && (ends(&s[3..]) || s[3..].starts_with('.') && ends(&s[4..])) {
                return true;
            }
            if starts(s, "DWORZEC") {
                let rest = s[7..].trim_start_matches(is_space);
                if rest.len() < s.len() - 7 && starts(rest, "AUTOBUSOWY") && ends(&rest[10..]) {
                    return true;
                }
            }
        }
        prev = Some(c);
    }
    false
}

/// `readStopDirections`: stop_id -> one or two bearings (whole degrees) of the feed in `dir`; empty while its
/// stops.txt or stop_times.txt is missing.
pub fn read_stop_directions(dir: &Path) -> HashMap<String, Vec<f64>> {
    let (Some(stops_txt), Some(times_txt)) = (
        read_text(&dir.join("stops.txt")),
        read_text(&dir.join("stop_times.txt")),
    ) else {
        return HashMap::new();
    };

    let (h, rows) = table(&stops_txt);
    let [i_id, i_name, i_lat, i_lon, i_loc] =
        ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type"].map(|n| col(&h, n));
    let mut coords: HashMap<&str, [f64; 2]> = HashMap::new();
    let mut stations: HashSet<&str> = HashSet::new();
    for f in &rows {
        let (lat, lon) = (field(f, i_lat), field(f, i_lon));
        // an empty cell is no coordinate (Number("") is 0, a phantom stop at 0,0)
        let Some(id) = field(f, i_id).filter(|s| !s.is_empty()) else {
            continue;
        };
        if lat == Some("") || lon == Some("") {
            continue;
        }
        let (lat, lon) = (lat.map_or(f64::NAN, js::number), lon.map_or(f64::NAN, js::number));
        if lat.is_finite() && lon.is_finite() {
            coords.insert(id, [lat, lon]);
        }
        if field(f, i_loc) == Some("1") || is_station_name(field(f, i_name).unwrap_or("")) {
            stations.insert(id);
        }
    }

    let (h, rows) = table(&times_txt);
    let [i_trip, i_stop, i_seq] = ["trip_id", "stop_id", "stop_sequence"].map(|n| col(&h, n));
    // in first-seen trip order: each stop's bearing list (and so its clustering) follows the file
    let mut per_trip: IndexMap<&str, Vec<(f64, &str)>> = IndexMap::new();
    for f in &rows {
        let (Some(trip), Some(stop), Some(raw_seq)) = (field(f, i_trip), field(f, i_stop), field(f, i_seq)) else {
            continue;
        };
        let seq = js::number(raw_seq);
        // an empty seq cell is no stop_sequence 0
        if trip.is_empty() || stop.is_empty() || raw_seq.is_empty() || !seq.is_finite() {
            continue;
        }
        per_trip.entry(trip).or_default().push((seq, stop));
    }

    let mut acc: HashMap<&str, Vec<f64>> = HashMap::new();
    for calls in per_trip.values_mut() {
        calls.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (i, &(_, curr)) in calls.iter().enumerate() {
            if stations.contains(curr) {
                continue;
            }
            let Some(c) = coords.get(curr) else {
                continue;
            };
            let p = i.checked_sub(1).and_then(|j| coords.get(calls[j].1));
            let n = calls.get(i + 1).and_then(|x| coords.get(x.1));
            let brg = match (p, n) {
                (Some(p), Some(n)) => bearing(p[0], p[1], n[0], n[1]),
                (None, Some(n)) => bearing(c[0], c[1], n[0], n[1]),
                (Some(p), None) => bearing(p[0], p[1], c[0], c[1]),
                (None, None) => None,
            };
            if let Some(b) = brg {
                acc.entry(curr).or_default().push(b);
            }
        }
    }

    acc.into_iter()
        .map(|(id, bearings)| (id.to_string(), cluster_road_directions(&bearings)))
        .collect()
}

static CACHE: FeedCache<HashMap<String, Vec<f64>>> = FeedCache::new();

/// `getStopDirections`: the directions of `KB_GTFS_DIR`, computed once and kept until `invalidate_stop_directions`.
pub fn get_stop_directions() -> Arc<HashMap<String, Vec<f64>>> {
    CACHE.get(|| read_stop_directions(Path::new(config::GTFS_DIR.as_str())))
}

/// Drops the directions after a GTFS rebuild so the next read sees the new feed.
pub fn invalidate_stop_directions() {
    CACHE.invalidate();
}
