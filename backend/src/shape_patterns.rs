//! lib/shape-patterns.ts: KB stop patterns, the unit the road-shape store routes and caches. A pattern is a trip's
//! ordered stop list plus the deterministic routing tweaks applied to it (stop-pole adjustments, known detours), so
//! every trip, live execution and GTFS seed with the same stops shares one road geometry.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};
use sha1::{Digest as _, Sha1};

use crate::gtfs_csv::{col, parse_csv_line, split_lines};
use crate::js::{self, num_value, number_to_string, to_fixed};
use crate::shared::detours::{adjust_stop_route_point, inject_detour_points};
use crate::shared::polyline::LatLng;

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedStop {
    /// String(internalId), the GTFS stop_id
    pub id: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KbPattern {
    /// "kb:" + 12 hex: stable while the stop ids and applied detour stay the same
    pub key: String,
    /// resolved stop per trip.times index (None = unresolved)
    pub stop_pts: Vec<Option<LatLng>>,
    /// routing waypoints (adjusted stops + injected detour via-points)
    pub waypoints: Vec<LatLng>,
    /// hash of the waypoint coordinates: changes when a stop moves or a detour is edited
    pub wp_sig: String,
    pub line: String,
    pub dir: String,
}

fn sha1_12(s: &str) -> String {
    Sha1::digest(s)[..6]
        .iter()
        .fold(String::with_capacity(12), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// `buildKbPattern` for one trip's `times` array. `resolve` maps a times entry (an object; the TS also hands it an
/// array) to its physical stop like the poller's stopCoords. None when fewer than two stops resolve.
pub fn build_kb_pattern(
    times: &[Value],
    line: &str,
    dir: &str,
    mut resolve: impl FnMut(&Value) -> Option<ResolvedStop>,
) -> Option<KbPattern> {
    let mut ids: Vec<String> = Vec::with_capacity(times.len());
    let mut stop_pts = Vec::with_capacity(times.len());
    let mut route_pts = Vec::with_capacity(times.len());
    for t in times {
        let s = match t {
            Value::Object(_) | Value::Array(_) => resolve(t),
            _ => None,
        };
        let Some(s) = s else {
            ids.push("?".into());
            stop_pts.push(None);
            continue;
        };
        stop_pts.push(Some([s.lat, s.lon]));
        route_pts.push(adjust_stop_route_point(Some(&s.id), [s.lat, s.lon]));
        ids.push(s.id);
    }
    if route_pts.len() < 2 {
        return None;
    }
    let (detoured, detour) = inject_detour_points(&route_pts, Some(line), Some(dir));
    let applied = match (&detoured, detour) {
        (Some(_), Some(d)) => d.id.as_str(),
        _ => "",
    };
    let key = format!("kb:{}", sha1_12(&format!("{}|{applied}", ids.join(","))));
    let waypoints = detoured.unwrap_or(route_pts);
    let sig = waypoints
        .iter()
        .map(|p| format!("{},{}", to_fixed(p[0], 5), to_fixed(p[1], 5)))
        .collect::<Vec<_>>()
        .join(";");
    Some(KbPattern {
        key,
        stop_pts,
        waypoints,
        wp_sig: sha1_12(&sig),
        line: line.into(),
        dir: dir.into(),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct GtfsSeed {
    pub raw_trip_ids: Vec<String>,
    pub line: String,
    pub dir: String,
    /// synthetic times entries ({designator} per stop_sequence, {} for gaps)
    pub times: Vec<Value>,
}

/// `rawTripId`: GTFS trip_id -> upstream trip id (multi-service trips carry a `_<service>` suffix).
pub fn raw_trip_id(gtfs_trip_id: &str) -> &str {
    match gtfs_trip_id.find('_') {
        Some(i) if i > 0 => &gtfs_trip_id[..i],
        _ => gtfs_trip_id,
    }
}

/// `f[i]` of a parsed row: None for a missing column or a short row (undefined in the TS).
fn field(f: &[String], i: Option<usize>) -> Option<&str> {
    f.get(i?).map(String::as_str)
}

/// One parsed table: the header and every non-empty row.
fn table(text: &str) -> (Vec<String>, Vec<Vec<String>>) {
    let lines = split_lines(text);
    let header = parse_csv_line(lines.first().copied().unwrap_or(""));
    let rows = lines
        .iter()
        .skip(1)
        .filter(|l| !l.is_empty())
        .map(|l| parse_csv_line(l))
        .collect();
    (header, rows)
}

/// `readGtfsPatternSeeds`: distinct stop patterns of a built GTFS feed (grouped by line, headsign and stop
/// sequence), in first-seen stop_times order. Missing files yield []. Reads the three files whole (BB stop_times is
/// a few MB) and holds one row list per trip until grouped.
pub fn read_gtfs_pattern_seeds(gtfs_dir: &Path) -> Vec<GtfsSeed> {
    let read = |name: &str| fs::read(gtfs_dir.join(name)).map(|b| String::from_utf8_lossy(&b).into_owned());
    let (Ok(trips_txt), Ok(times_txt), Ok(routes_txt)) =
        (read("trips.txt"), read("stop_times.txt"), read("routes.txt"))
    else {
        return Vec::new();
    };

    let (h, rows) = table(&routes_txt);
    let (i_id, i_name) = (col(&h, "route_id"), col(&h, "route_short_name"));
    let mut route_name: HashMap<Option<&str>, &str> = HashMap::new();
    for f in &rows {
        route_name.insert(field(f, i_id), field(f, i_name).unwrap_or(""));
    }

    let (h, rows) = table(&trips_txt);
    let (i_route, i_trip, i_head) = (col(&h, "route_id"), col(&h, "trip_id"), col(&h, "trip_headsign"));
    let mut trip_meta: HashMap<&str, (&str, &str)> = HashMap::new();
    for f in &rows {
        let raw = raw_trip_id(field(f, i_trip).unwrap_or(""));
        if raw.is_empty() || trip_meta.contains_key(raw) {
            continue;
        }
        let line = route_name.get(&field(f, i_route)).copied().unwrap_or("");
        trip_meta.insert(raw, (line, field(f, i_head).unwrap_or("")));
    }

    let (h, rows) = table(&times_txt);
    let (i_trip, i_stop, i_seq) = (col(&h, "trip_id"), col(&h, "stop_id"), col(&h, "stop_sequence"));
    let mut seqs: IndexMap<&str, Vec<(usize, &str)>> = IndexMap::new();
    for f in &rows {
        let raw = raw_trip_id(field(f, i_trip).unwrap_or(""));
        let seq = field(f, i_seq).map_or(f64::NAN, js::number);
        if raw.is_empty() || seq.fract() != 0.0 || !(0.0..=500.0).contains(&seq) {
            continue;
        }
        seqs.entry(raw)
            .or_default()
            .push((seq as usize, field(f, i_stop).unwrap_or("")));
    }

    let mut groups: IndexMap<String, GtfsSeed> = IndexMap::new();
    for (raw, mut rows) in seqs {
        let Some(&(line, dir)) = trip_meta.get(raw) else {
            continue;
        };
        rows.sort_by_key(|r| r.0);
        let n = rows.last().map_or(0, |r| r.0 + 1);
        let mut times = vec![Value::Object(Map::new()); n];
        for &(seq, stop_id) in &rows {
            let d = js::number(stop_id);
            if d.fract() == 0.0 {
                times[seq] = Value::Object(Map::from_iter([("designator".into(), num_value(d))]));
            }
        }
        let designators = times.iter().map(|t| match t["designator"].as_f64() {
            Some(d) => number_to_string(d),
            None => "?".into(),
        });
        let sig = format!("{line}\u{1}{dir}\u{1}{}", designators.collect::<Vec<_>>().join(","));
        match groups.get_mut(&sig) {
            Some(g) => g.raw_trip_ids.push(raw.into()),
            None => {
                groups.insert(
                    sig,
                    GtfsSeed {
                        raw_trip_ids: vec![raw.into()],
                        line: line.into(),
                        dir: dir.into(),
                        times,
                    },
                );
            }
        }
    }
    groups.into_values().collect()
}
