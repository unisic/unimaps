//! lib/merged-stops.ts: the ONE place that turns the pollers' KB + MZK stop lists into the merged stop list, its
//! JSON body and the alias lookup, for GET /api/stops and the departures / timetable routes, so they can never
//! disagree about which stops are BOTH. Memoized on the identity of its inputs: the pollers swap their `stops`
//! lists atomically on every reload, so a recompute happens exactly when something changed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};

use crate::gzm::NowFn;
use crate::js::{self, JsNum};
use crate::stop_merge::{Operator, WireStop, index_merged_stops, merge_stops};
use crate::types::Stop;

/// `STATION_NAME_RE` `/(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i`: a bus station by name (KB and MZK
/// classify with the same rule, see MERGE_HUB_M). Without the `u` flag `/i` folds ASCII letters only.
pub fn is_station_name(name: &str) -> bool {
    let c: Vec<char> = name.chars().collect();
    let lit = |at: usize, s: &str| {
        s.chars()
            .enumerate()
            .all(|(i, e)| c.get(at + i).is_some_and(|x| x.eq_ignore_ascii_case(&e)))
    };
    let end = |at: usize| c.get(at).is_none_or(|&x| js::is_space(x) || x == ')');
    (0..c.len()).any(|p| {
        if p > 0 && !c.get(p - 1).is_some_and(|&x| js::is_space(x) || x == '(') {
            return false;
        }
        if lit(p, "D.A") && (end(p + 3) || (c.get(p + 3) == Some(&'.') && end(p + 4))) {
            return true;
        }
        if !lit(p, "DWORZEC") {
            return false;
        }
        let ws = c.iter().skip(p + 7).take_while(|&&x| js::is_space(x)).count();
        ws > 0 && lit(p + 7 + ws, "AUTOBUSOWY") && end(p + 17 + ws)
    })
}

/// `REQUEST_NAME_RE` `/\sNŻ$/iu`: KB has no request-stop flag, its names end in "NŻ" ("na żądanie") instead.
fn is_request_name(name: &str) -> bool {
    let mut r = name.chars().rev();
    matches!(
        (r.next(), r.next(), r.next()),
        (Some('ż' | 'Ż'), Some('n' | 'N'), Some(s)) if js::is_space(s)
    )
}

fn js_nums(v: &[f64]) -> Vec<JsNum> {
    v.iter().copied().map(JsNum).collect()
}

pub fn format_kb_stops(stops: &[Stop], dirs: &HashMap<String, Vec<f64>>) -> Vec<WireStop> {
    stops
        .iter()
        .map(|s| {
            let is_stn = s.show_platforms || is_station_name(&s.name);
            let d = if is_stn { None } else { dirs.get(&s.stop_id) };
            WireStop {
                id: s.stop_id.clone(),
                designator: s.url_id.clone(),
                name: s.name.clone(),
                lat: JsNum(s.lat),
                lon: JsNum(s.lon),
                operator: Some(Operator::KB),
                dirs: d.filter(|d| !d.is_empty()).map(|d| js_nums(d)),
                is_station: is_stn.then_some(true),
                show_platforms: s.show_platforms.then_some(true),
                on_request: is_request_name(&s.name).then_some(true),
                ..WireStop::default()
            }
        })
        .collect()
}

/// MZK stops carry NO `dirs` on the wire (arrows stay a KB/GTFS feature); learned bearings only steer the pairing.
pub fn format_mzk_stops(stops: &[Stop]) -> Vec<WireStop> {
    stops
        .iter()
        .map(|s| WireStop {
            id: s.stop_id.clone(),
            designator: s.url_id.clone(),
            name: s.name.clone(),
            lat: JsNum(s.lat),
            lon: JsNum(s.lon),
            operator: Some(Operator::MZK),
            symbol: s.symbol.clone(),
            is_station: s.is_station.then_some(true),
            on_request: (s.on_request == Some(true)).then_some(true),
            getting_out: (s.getting_out == Some(true)).then_some(true),
            ..WireStop::default()
        })
        .collect()
}

const KB_ORDER: &[&str] = &[
    "id",
    "designator",
    "name",
    "lat",
    "lon",
    "operator",
    "dirs",
    "isStation",
    "showPlatforms",
    "onRequest",
    "operators",
    "kbId",
    "kbDesignator",
];
const MZK_ORDER: &[&str] = &[
    "id",
    "designator",
    "name",
    "lat",
    "lon",
    "operator",
    "symbol",
    "isStation",
    "onRequest",
    "gettingOut",
    "operators",
    "mzkId",
    "mzkDesignator",
    "mzkSymbol",
];
const BOTH_ORDER: &[&str] = &[
    "id",
    "designator",
    "name",
    "lat",
    "lon",
    "operator",
    "operators",
    "kbId",
    "mzkId",
    "kbDesignator",
    "mzkDesignator",
    "mzkSymbol",
    "symbol",
    "mzkSymbols",
    "dirs",
    "isStation",
    "showPlatforms",
    "onRequest",
    "gettingOut",
];

/// A merged stop as `JSON.stringify` writes the object `mergeStops` built: the key order of its object literal (an
/// unmatched stop is the formatted literal spread, then the merge fields). Keys the literal does not name follow
/// in `WireStop` order.
pub fn merged_stop_json(s: &WireStop) -> Value {
    let Ok(Value::Object(mut m)) = serde_json::to_value(s) else {
        return Value::Null;
    };
    let order = match s.operator {
        Some(Operator::BOTH) => BOTH_ORDER,
        Some(Operator::MZK) => MZK_ORDER,
        _ => KB_ORDER,
    };
    let mut out = Map::new();
    for &k in order {
        if let Some(v) = m.shift_remove(k) {
            out.insert(k.to_string(), v);
        }
    }
    out.extend(m);
    Value::Object(out)
}

/// The inputs of one merge; identity (`Arc::ptr_eq`) is the memo key.
#[derive(Clone)]
pub struct MergedInput {
    pub kb: Arc<Vec<Stop>>,
    pub mzk: Arc<Vec<Stop>>,
    /// KB GTFS-derived bearings by stopId (`get_stop_directions()`)
    pub kb_dirs: Arc<HashMap<String, Vec<f64>>>,
    /// MZK learned bearings by symbol: `MzkStopDirs::dirs()`, which keeps its identity until a bearing changes
    pub mzk_dirs: Arc<HashMap<String, Vec<JsNum>>>,
}

impl MergedInput {
    fn same(&self, o: &MergedInput) -> bool {
        Arc::ptr_eq(&self.kb, &o.kb)
            && Arc::ptr_eq(&self.mzk, &o.mzk)
            && Arc::ptr_eq(&self.kb_dirs, &o.kb_dirs)
            && Arc::ptr_eq(&self.mzk_dirs, &o.mzk_dirs)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedSummary {
    pub both: usize,
    pub kb: usize,
    pub mzk: usize,
    /// inputs behind this merge
    pub kb_stops: usize,
    pub mzk_stops: usize,
    pub mzk_dir_stops: usize,
    /// epoch s
    pub built_at: i64,
}

pub struct MergedView {
    pub stops: Vec<WireStop>,
    /// `JSON.stringify(StopsResponse)`
    pub body: String,
    pub etag: String,
    /// true while one operator's list is still missing: clients must revalidate it every time and re-fetch soon
    pub partial: bool,
    pub summary: MergedSummary,
    index: HashMap<String, usize>,
}

impl MergedView {
    /// By KB designator / id, "mzk:<symbol>", bare MZK symbol (the primary symbol of a station hub).
    pub fn lookup(&self, key: &str) -> Option<&WireStop> {
        self.index.get(key).and_then(|&i| self.stops.get(i))
    }
}

fn build_view(input: &MergedInput, now_ms: i64) -> MergedView {
    let stops = merge_stops(
        &format_kb_stops(&input.kb, &input.kb_dirs),
        &format_mzk_stops(&input.mzk),
        Some(&input.mzk_dirs),
    );
    let partial = input.kb.is_empty() || input.mzk.is_empty();
    let mut response = Map::new();
    response.insert("count".into(), stops.len().into());
    response.insert("stops".into(), stops.iter().map(merged_stop_json).collect());
    if partial {
        response.insert("partial".into(), true.into());
    }
    let body = Value::Object(response).to_string();
    let mut tag = js::to_base64url(&Sha1::digest(body.as_bytes()));
    tag.truncate(22);
    let count = |op: Operator| stops.iter().filter(|s| s.operator == Some(op)).count();
    let summary = MergedSummary {
        both: count(Operator::BOTH),
        kb: count(Operator::KB),
        mzk: count(Operator::MZK),
        kb_stops: input.kb.len(),
        mzk_stops: input.mzk.len(),
        mzk_dir_stops: input.mzk_dirs.len(),
        built_at: now_ms.div_euclid(1000),
    };
    MergedView {
        index: index_merged_stops(&stops),
        stops,
        body,
        etag: format!("\"{tag}\""),
        partial,
        summary,
    }
}

/// `createMergedStopsCache`: the last view, rebuilt when any input changed identity.
pub struct MergedStopsCache {
    now: NowFn,
    last: Mutex<Option<(MergedInput, Arc<MergedView>)>>,
}

impl Default for MergedStopsCache {
    fn default() -> Self {
        Self {
            now: Arc::new(|| jiff::Timestamp::now().as_millisecond()),
            last: Mutex::new(None),
        }
    }
}

impl MergedStopsCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_now(mut self, now: NowFn) -> Self {
        self.now = now;
        self
    }

    /// The view of `input`; the merge runs under the lock, so concurrent callers of one new input merge once.
    pub fn get(&self, input: &MergedInput) -> Arc<MergedView> {
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((prev, view)) = last.as_ref()
            && prev.same(input)
        {
            return view.clone();
        }
        let view = Arc::new(build_view(input, (self.now)()));
        *last = Some((input.clone(), view.clone()));
        view
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn station_name_matches_the_ts_regex() {
        for yes in [
            "D.A.",
            "Czechowice-Dz. D.A.",
            "Bielsko-Biała D.A",
            "x (d.a.)",
            "Dworzec  Autobusowy",
            "DWORZEC\u{A0}AUTOBUSOWY 2",
            "(dworzec autobusowy)",
        ] {
            assert!(is_station_name(yes), "{yes}");
        }
        for no in [
            "D.A.X",
            "XD.A.",
            "Dworzec",
            "DWORZECAUTOBUSOWY",
            "Dworzec Autobusowyx",
            "D.A..",
            "DWORZEC AUTOBU\u{17F}OWY",
        ] {
            assert!(!is_station_name(no), "{no}");
        }
    }

    #[test]
    fn request_name_matches_the_ts_regex() {
        assert!(is_request_name("Szczyrk Biła NŻ"));
        assert!(is_request_name("Kozy x\u{FEFF}nż"));
        assert!(!is_request_name("NŻ"));
        assert!(!is_request_name("Kozy NŻ "));
        assert!(!is_request_name("KozyNŻ"));
    }

    #[test]
    fn merged_stop_keys_follow_the_ts_literal() {
        let s = WireStop {
            id: "1".into(),
            operator: Some(Operator::KB),
            operators: Some(vec![Operator::KB]),
            kb_id: Some("1".into()),
            kb_designator: Some("d".into()),
            on_request: Some(true),
            ..WireStop::default()
        };
        let Value::Object(m) = merged_stop_json(&s) else {
            panic!("not an object");
        };
        let keys: Vec<&str> = m.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "id",
                "designator",
                "name",
                "lat",
                "lon",
                "operator",
                "onRequest",
                "operators",
                "kbId",
                "kbDesignator"
            ]
        );
    }
}
