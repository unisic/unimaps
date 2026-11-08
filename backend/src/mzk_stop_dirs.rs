//! Travel direction of every MZK stop, learned from the stop ORDER of the running courses
//! (lib/mzk-stop-dirs.ts): per variant the tangent prev -> next is credited to each stop and clustered into 1-2
//! opposite bearings, which the KB/MZK stop merge uses to pair the two carriageways. Pure and persistable.

use std::collections::HashMap;
use std::f64::consts::PI;
use std::path::Path;
use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::Value;

use crate::geo::{bearing, meters_between};
use crate::js::{self, JsNum};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StopCoord {
    pub lat: f64,
    pub lon: f64,
}

const MERGE_THRESHOLD: f64 = 75.0;
const MAX_SAMPLES: usize = 64;
/// A stop that moved further than this since it was learned (upstream re-versioned its data) drops all learning.
const RECONCILE_M: f64 = 15.0;

fn angle_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

fn circular_mean(bs: &[f64]) -> f64 {
    let (mut sin, mut cos) = (0.0_f64, 0.0_f64);
    for b in bs {
        let r = (b * PI) / 180.0;
        sin += r.sin();
        cos += r.cos();
    }
    js::round(((sin.atan2(cos) * 180.0) / PI + 360.0) % 360.0)
}

/// `clusterBearings`: 1 bearing, or 2 when the stop is served in both (opposite) directions.
pub fn cluster_bearings(bearings: &[f64]) -> Vec<f64> {
    let mut clusters: Vec<Vec<f64>> = Vec::new();
    for &b in bearings {
        let mut best = None;
        let mut best_diff = MERGE_THRESHOLD;
        for (i, c) in clusters.iter().enumerate() {
            let d = angle_diff(b, circular_mean(c));
            if d < best_diff {
                best_diff = d;
                best = Some(i);
            }
        }
        match best.and_then(|i| clusters.get_mut(i)) {
            Some(c) => c.push(b),
            None => clusters.push(vec![b]),
        }
    }
    clusters.sort_by_key(|c| std::cmp::Reverse(c.len()));
    let Some((first, rest)) = clusters.split_first() else {
        return Vec::new();
    };
    let primary = circular_mean(first);
    let mut out = vec![primary];
    for c in rest {
        let mean = circular_mean(c);
        if angle_diff(primary, mean) >= 100.0 && c.len() >= 2 && c.len() as f64 >= first.len() as f64 * 0.15 {
            out.push(mean);
            break;
        }
    }
    out
}

/// `MzkStopDirsState`, the file body: fields in the TS literal order, object keys in `Object.fromEntries` order.
#[derive(Clone, Debug, Serialize)]
pub struct MzkStopDirsState {
    pub v: u8,
    pub variants: Vec<JsNum>,
    pub samples: IndexMap<String, Vec<JsNum>>,
    /// coordinates each symbol had when its samples were taken: a stop that moved/vanished invalidates them
    pub at: IndexMap<String, [JsNum; 2]>,
}

/// The learner. Plain data: the poller keeps it inside its own state lock.
#[derive(Debug, Default)]
pub struct MzkStopDirs {
    samples: IndexMap<String, Vec<f64>>,
    at: IndexMap<String, [f64; 2]>,
    /// variant ids as f64 bits, -0 folded into 0 (a JS Set compares SameValueZero)
    seen: IndexSet<u64>,
    current: Arc<HashMap<String, Vec<JsNum>>>,
    dirty: bool,
}

fn variant_key(id: f64) -> u64 {
    (id + 0.0).to_bits()
}

impl MzkStopDirs {
    /// Learns from one variant's ordered stops (`(symbol, None)` = unknown stop, e.g. the depot "00"). A variant
    /// counts once it taught something (one whose stops are all still unknown is retried). True when it learned.
    pub fn learn(&mut self, variant_id: f64, stops: &[(&str, Option<StopCoord>)]) -> bool {
        if !variant_id.is_finite() || variant_id <= 0.0 || self.seen.contains(&variant_key(variant_id)) {
            return false;
        }
        let mut added = false;
        for (i, (sym, cur)) in stops.iter().enumerate() {
            let Some(cur) = cur else { continue };
            let prev = i.checked_sub(1).and_then(|j| stops.get(j)).and_then(|s| s.1);
            let next = stops.get(i + 1).and_then(|s| s.1);
            let b = match (prev, next) {
                (Some(p), Some(n)) => bearing(p.lat, p.lon, n.lat, n.lon),
                (None, Some(n)) => bearing(cur.lat, cur.lon, n.lat, n.lon),
                (Some(p), None) => bearing(p.lat, p.lon, cur.lat, cur.lon),
                (None, None) => None,
            };
            let Some(b) = b else { continue };
            let arr = self.samples.entry((*sym).to_owned()).or_default();
            if arr.len() < MAX_SAMPLES {
                arr.push(js::round(b));
            }
            self.at.entry((*sym).to_owned()).or_insert([cur.lat, cur.lon]);
            added = true;
        }
        if added {
            self.seen.insert(variant_key(variant_id));
            self.dirty = true;
        }
        added
    }

    /// symbol -> 1-2 bearings. The SAME Arc comes back until some stop's bearings actually change, so consumers
    /// memoize on `Arc::ptr_eq`.
    pub fn dirs(&mut self) -> Arc<HashMap<String, Vec<JsNum>>> {
        if self.dirty {
            let next: HashMap<String, Vec<JsNum>> = self
                .samples
                .iter()
                .filter_map(|(sym, bs)| {
                    let c = cluster_bearings(bs);
                    (!c.is_empty()).then(|| (sym.clone(), c.into_iter().map(JsNum).collect()))
                })
                .collect();
            if *self.current != next {
                self.current = Arc::new(next);
            }
            self.dirty = false;
        }
        Arc::clone(&self.current)
    }

    /// Stops with samples.
    pub fn size(&self) -> usize {
        self.samples.len()
    }

    /// Distinct course variants learned from.
    pub fn variants(&self) -> usize {
        self.seen.len()
    }

    /// Checks the learned stops against the CURRENT stop list (`lookup` = symbol -> its position, after every
    /// getStops load): a symbol that vanished or moved more than 15 m resets all learning. True when reset.
    pub fn reconcile(&mut self, lookup: impl Fn(&str) -> Option<StopCoord>) -> bool {
        let mut reset = false;
        for sym in self.samples.keys() {
            let Some(cur) = lookup(sym) else {
                reset = true;
                break;
            };
            match self.at.get(sym) {
                Some(rec) if meters_between(rec[0], rec[1], cur.lat, cur.lon) > RECONCILE_M => {
                    reset = true;
                    break;
                }
                Some(_) => {}
                // older state file: adopt the current position
                None => {
                    self.at.insert(sym.clone(), [cur.lat, cur.lon]);
                }
            }
        }
        if reset {
            self.samples.clear();
            self.at.clear();
            self.seen.clear();
            self.dirty = true;
        }
        reset
    }

    pub fn snapshot(&self) -> MzkStopDirsState {
        let mut samples: IndexMap<String, Vec<JsNum>> = self
            .samples
            .iter()
            .map(|(k, bs)| (k.clone(), bs.iter().copied().map(JsNum).collect()))
            .collect();
        js::sort_object_keys(&mut samples);
        let mut at: IndexMap<String, [JsNum; 2]> = self
            .at
            .iter()
            .map(|(k, p)| (k.clone(), [JsNum(p[0]), JsNum(p[1])]))
            .collect();
        js::sort_object_keys(&mut at);
        MzkStopDirsState {
            v: 2,
            variants: self.seen.iter().map(|b| JsNum(f64::from_bits(*b))).collect(),
            samples,
            at,
        }
    }

    /// `MzkStopDirs.restore` of a parsed file (v 1 or 2; anything else is a fresh learner).
    pub fn restore(data: &Value) -> Self {
        let mut inst = Self::default();
        let Some(d) = data.as_object() else { return inst };
        if !matches!(d.get("v").and_then(Value::as_f64), Some(v) if v == 1.0 || v == 2.0) {
            return inst;
        }
        for v in d.get("variants").and_then(Value::as_array).into_iter().flatten() {
            if let Some(x) = v.as_f64() {
                inst.seen.insert(variant_key(x));
            }
        }
        for (sym, bs) in entries(d.get("samples")) {
            let clean: Vec<f64> = bs
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_f64)
                .take(MAX_SAMPLES)
                .collect();
            if !clean.is_empty() {
                inst.samples.insert(sym, clean);
            }
        }
        for (sym, p) in entries(d.get("at")) {
            let coords: Option<Vec<f64>> = p.as_array().and_then(|a| a.iter().map(Value::as_f64).collect());
            if let Some([lat, lon]) = coords.as_deref()
                && inst.samples.contains_key(&sym)
            {
                inst.at.insert(sym, [*lat, *lon]);
            }
        }
        inst.dirty = !inst.samples.is_empty();
        inst
    }
}

/// `Object.entries(v ?? {})` of a parsed JSON value: an object in `Object.keys` order, an array by index (a string's
/// entries are characters, never arrays, so they teach nothing and are skipped).
fn entries(v: Option<&Value>) -> Vec<(String, &Value)> {
    match v {
        Some(Value::Object(m)) => {
            let mut keyed: IndexMap<String, &Value> = m.iter().map(|(k, v)| (k.clone(), v)).collect();
            js::sort_object_keys(&mut keyed);
            keyed.into_iter().collect()
        }
        Some(Value::Array(a)) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    }
}

/// `loadMzkStopDirs`: the learner saved in `file`, a fresh one when it is missing or unreadable (never fails).
pub fn load_mzk_stop_dirs(file: &Path) -> MzkStopDirs {
    std::fs::read(file)
        .ok()
        .and_then(|b| crate::js::json_parse(&String::from_utf8_lossy(&b)).ok())
        .map(|v| MzkStopDirs::restore(&v))
        .unwrap_or_default()
}

/// `saveMzkStopDirs`: `<file>.<pid>.tmp` then rename over `file`, as the TS (no fsync, no .bak). False on failure.
pub fn save_mzk_stop_dirs(file: &Path, inst: &MzkStopDirs) -> bool {
    let write = || -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let body = serde_json::to_vec(&inst.snapshot()).map_err(std::io::Error::other)?;
        let mut tmp = file.as_os_str().to_owned();
        tmp.push(format!(".{}.tmp", std::process::id()));
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, file)
    };
    write().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_round_trip_keeps_js_key_order() {
        let mut dirs = MzkStopDirs::default();
        let at = |lat: f64| Some(StopCoord { lat, lon: 19.0 });
        assert!(dirs.learn(7.0, &[("b", at(49.80)), ("10", at(49.81)), ("2", at(49.82))]));
        assert!(!dirs.learn(7.0, &[("x", at(49.0)), ("y", at(49.1))]));
        let text = serde_json::to_string(&dirs.snapshot()).unwrap();
        assert_eq!(
            text,
            r#"{"v":2,"variants":[7],"samples":{"2":[0],"10":[0],"b":[0]},"at":{"2":[49.82,19],"10":[49.81,19],"b":[49.8,19]}}"#
        );
        let back = MzkStopDirs::restore(&serde_json::from_str(&text).unwrap());
        assert_eq!(serde_json::to_string(&back.snapshot()).unwrap(), text);
        assert_eq!((back.size(), back.variants()), (3, 1));
    }

    #[test]
    fn restore_filters_like_the_ts() {
        let raw = serde_json::json!({
            "v": 1,
            "variants": [3, "4", -0.0, 0],
            "samples": {"5": [90, "x", 91], "6": [], "7": "abc"},
            "at": {"5": [49.8, 19.0], "6": [1, 2], "8": [1, 2]}
        });
        let mut d = MzkStopDirs::restore(&raw);
        let snap = serde_json::to_value(d.snapshot()).unwrap();
        assert_eq!(
            snap,
            serde_json::json!({"v": 2, "variants": [3, 0], "samples": {"5": [90, 91]}, "at": {"5": [49.8, 19]}})
        );
        let first = d.dirs();
        assert_eq!(first.get("5").map(Vec::len), Some(1));
        assert!(Arc::ptr_eq(&first, &d.dirs()));
        assert!(d.reconcile(|_| None));
        assert_eq!(d.size(), 0);
    }
}
