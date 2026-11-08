//! lib/stop-merge.ts: one stop list out of KB's and MZK's, the same physical stop merged into one entry. The wire
//! keys follow the struct order, not the TS object spreads (JSON readers do not care; the ETag changes once).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::js::JsNum;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Operator {
    KB,
    MZK,
    GZM,
    BOTH,
}

/// lib/types.ts `WireStop` (`FormattedStop`)
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireStop {
    pub id: String,
    pub designator: String,
    pub name: String,
    pub lat: JsNum,
    pub lon: JsNum,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirs: Option<Vec<JsNum>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_station: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_platforms: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<Operator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operators: Option<Vec<Operator>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_request: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub getting_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kb_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mzk_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kb_designator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mzk_designator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mzk_symbol: Option<String>,
    /// station hub (D.A.) only: every MZK symbol whose departures the station panel lists, primary first
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mzk_symbols: Option<Vec<String>>,
}

const CITY_PREFIXES: [&str; 11] = [
    "BIELSKO-BIAŁA",
    "BIELSKO BIAŁA",
    "CZECHOWICE-DZIEDZICE",
    "BYSTRA",
    "WILKOWICE",
    "KOZY",
    "JASIENICA",
    "JAWORZE",
    "SZCZYRK",
    "PORĄBKA",
    "BESTWINA",
];

/// Name for fuzzy cross-operator matching: upper case, known city prefix dropped (KB names carry it, MZK's don't),
/// "D.A." / "DWORZEC AUTOBUSOWY" as "DWORZEC", only letters and digits kept.
pub fn clean_stop_name(name: &str) -> String {
    let up = name.to_uppercase();
    let mut n = up.trim_matches(crate::js::is_space);
    for p in CITY_PREFIXES {
        if let Some(rest) = n.strip_prefix(p)
            && rest.starts_with(crate::js::is_space)
        {
            n = rest.trim_start_matches(crate::js::is_space);
            break;
        }
    }
    let station = |stem: &str| stem.is_empty() || stem.ends_with(crate::js::is_space);
    let mut tail = "";
    if let Some(stem) = n.strip_suffix("D.A.").or_else(|| n.strip_suffix("D.A"))
        && station(stem)
    {
        (n, tail) = (stem, "DWORZEC");
    } else if let Some(stem) = n.strip_suffix("AUTOBUSOWY")
        && stem.ends_with(crate::js::is_space)
        && let Some(stem) = stem.trim_end_matches(crate::js::is_space).strip_suffix("DWORZEC")
        && station(stem)
    {
        (n, tail) = (stem, "DWORZEC");
    }
    let keep = |c: &char| c.is_ascii_uppercase() || c.is_ascii_digit() || "ĄĆĘŁŃÓŚŹŻ".contains(*c);
    n.chars().chain(tail.chars()).filter(keep).collect()
}

/// Planar distance approximation in metres between two coordinates.
pub fn stop_distance_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat2 - lat1) * 111_139.0;
    let dlon = (lon2 - lon1) * 111_139.0 * (((lat1 + lat2) / 2.0) * crate::geo::RAD).cos();
    crate::js::hypot(dlat, dlon)
}

/// Alias -> index into `stops`: every id / designator / MZK symbol (bare and "mzk:"-prefixed) of every stop, a
/// station hub's extra symbols included. A later stop wins a shared key.
pub fn index_merged_stops(stops: &[WireStop]) -> HashMap<String, usize> {
    let mut index = HashMap::new();
    for (i, s) in stops.iter().enumerate() {
        let ids = [
            Some(&s.designator),
            Some(&s.id),
            s.kb_designator.as_ref(),
            s.mzk_designator.as_ref(),
            s.kb_id.as_ref(),
            s.mzk_id.as_ref(),
        ];
        for key in ids.into_iter().flatten().filter(|k| !k.is_empty()) {
            index.insert(key.clone(), i);
        }
        let syms = [s.mzk_symbol.as_ref(), s.symbol.as_ref()]
            .into_iter()
            .flatten()
            .chain(s.mzk_symbols.iter().flatten());
        for sym in syms.filter(|k| !k.is_empty()) {
            index.insert(sym.clone(), i);
            index.insert(format!("mzk:{sym}"), i);
        }
    }
    index
}

/// Proximity alone is enough to call two stops the same place.
pub const MERGE_NEAR_M: f64 = 35.0;
/// Same-name stops this close are the same place (different poles / staggered stops).
pub const MERGE_NAME_M: f64 = 120.0;
/// A pair whose travel directions are opposite only merges when it is practically one pole.
pub const MERGE_SAME_POLE_M: f64 = 12.0;
/// A bus station pairs and fans out only to MZK stops on its premises: its cleaned name is the bare "DWORZEC",
/// which matches every "<street> Dworzec" around it (Bielsko-Biała D.A. is KB-only).
pub const MERGE_HUB_M: f64 = MERGE_NEAR_M;
/// Max MZK symbols a station hub fans out to (primary included).
pub const MERGE_MAX_MZK: usize = 6;

const OPPOSITE_DEG: f64 = 120.0;
const SAME_DIR_DEG: f64 = 60.0;
/// cost bumps (metres-equivalent): unnamed pair, roughly-perpendicular pair, opposite pair
const COST_NAME_MISS: f64 = 25.0;
const COST_DIR_AMBIGUOUS: f64 = 40.0;
const COST_DIR_OPPOSITE: f64 = 400.0;
/// a row may stay unmatched at this cost, far above any real edge, so cardinality wins first
const UNMATCHED: f64 = 5_000.0;
const FORBIDDEN: f64 = 1e9;

fn angle_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

/// Smallest angle (0..180) between any bearing of `a` and any of `b`; None when either side has none.
pub fn direction_diff(a: Option<&[JsNum]>, b: Option<&[JsNum]>) -> Option<f64> {
    let (a, b) = (a.filter(|a| !a.is_empty())?, b.filter(|b| !b.is_empty())?);
    let mut best = 180.0_f64;
    for x in a {
        for y in b {
            best = best.min(angle_diff(x.0, y.0));
        }
    }
    Some(best)
}

/// Arrows of a merged stop: KB's bearings first, then MZK's not within 45° of one already there; at most two.
fn union_dirs(lists: [Option<&Vec<JsNum>>; 2]) -> Option<Vec<JsNum>> {
    let mut out: Vec<JsNum> = Vec::new();
    for d in lists.into_iter().flatten().flatten() {
        if out.len() < 2 && out.iter().all(|x| angle_diff(x.0, d.0) >= 45.0) {
            out.push(*d);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn names_match(a: &str, b: &str) -> bool {
    a.chars().count() > 2 && b.chars().count() > 2 && (a.contains(b) || b.contains(a))
}

struct Candidate {
    k: usize,
    m: usize,
    cost: f64,
    dd: Option<f64>,
}

/// Min-cost assignment of rows to columns (Hungarian / Kuhn-Munkres); rows <= cols. Row -> column.
fn hungarian(rows: usize, cols: usize, cost: impl Fn(usize, usize) -> f64) -> Vec<Option<usize>> {
    let mut u = vec![0.0; rows + 1];
    let mut v = vec![0.0; cols + 1];
    let mut p = vec![0usize; cols + 1];
    let mut way = vec![0usize; cols + 1];
    for i in 1..=rows {
        p[0] = i;
        let mut j0 = 0;
        let mut minv = vec![f64::INFINITY; cols + 1];
        let mut used = vec![false; cols + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = f64::INFINITY;
            let mut j1 = 0;
            for j in 1..=cols {
                if used[j] {
                    continue;
                }
                let cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
                if cur < minv[j] {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if minv[j] < delta {
                    delta = minv[j];
                    j1 = j;
                }
            }
            for j in 0..=cols {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut row_to_col = vec![None; rows];
    for j in 1..=cols {
        if p[j] != 0 {
            row_to_col[p[j] - 1] = Some(j - 1);
        }
    }
    row_to_col
}

fn find(parent: &mut [usize], mut x: usize) -> usize {
    let mut r = x;
    while parent[r] != r {
        r = parent[r];
    }
    while parent[x] != r {
        (parent[x], x) = (r, parent[x]);
    }
    r
}

/// m -> k assignment per connected component, max cardinality first, then min cost.
fn assign(cands: &[Candidate], kb_len: usize, mzk_len: usize) -> HashMap<usize, usize> {
    // nodes: KB stops 0..kb_len, MZK stops after them
    let mut parent: Vec<usize> = (0..kb_len + mzk_len).collect();
    for c in cands {
        let (a, b) = (find(&mut parent, c.k), find(&mut parent, kb_len + c.m));
        parent[a] = b;
    }
    let mut comps: HashMap<usize, Vec<&Candidate>> = HashMap::new();
    for c in cands {
        comps.entry(find(&mut parent, c.k)).or_default().push(c);
    }
    let mut out = HashMap::new();
    for comp in comps.values() {
        let mut ms: Vec<usize> = comp.iter().map(|c| c.m).collect();
        let mut ks: Vec<usize> = comp.iter().map(|c| c.k).collect();
        ms.sort_unstable();
        ms.dedup();
        ks.sort_unstable();
        ks.dedup();
        let cell: HashMap<(usize, usize), f64> = comp.iter().map(|c| ((c.m, c.k), c.cost)).collect();
        let cols = ks.len() + ms.len(); // + one "stay unmatched" column per row
        let row_to_col = hungarian(ms.len(), cols, |r, col| {
            if col >= ks.len() {
                UNMATCHED
            } else {
                cell.get(&(ms[r], ks[col])).copied().unwrap_or(FORBIDDEN)
            }
        });
        for (r, col) in row_to_col.into_iter().enumerate() {
            if let Some(col) = col
                && col < ks.len()
                && cell.contains_key(&(ms[r], ks[col]))
            {
                out.insert(ms[r], ks[col]);
            }
        }
    }
    out
}

/// Merges KB and MZK stops that are the same physical stop.
///
/// - eligible: <= MERGE_NEAR_M, or <= MERGE_NAME_M with matching cleaned names; a pair with opposite travel
///   directions only <= MERGE_SAME_POLE_M (the other carriageway is another stop);
/// - the pairing is a global min-cost assignment, independent of the order of either list;
/// - a bus station also fans out to the other unmatched same-name MZK stops within MERGE_HUB_M (`mzkSymbols`),
///   which are folded into it.
///
/// `mzk_dirs` (learned bearings by MZK symbol) stands in for an MZK stop's missing `dirs` in the pairing only (a bus
/// station: `format_mzk_stops` sends no arrows for one); the merged stops' arrows come from the stops' own `dirs`.
pub fn merge_stops(kb: &[WireStop], mzk: &[WireStop], mzk_dirs: Option<&HashMap<String, Vec<JsNum>>>) -> Vec<WireStop> {
    let kc: Vec<String> = kb.iter().map(|k| clean_stop_name(&k.name)).collect();
    let mc: Vec<String> = mzk.iter().map(|m| clean_stop_name(&m.name)).collect();
    let is_station = |k: usize| kb[k].is_station == Some(true);
    let mzk_bearings = |m: usize| -> Option<&[JsNum]> {
        let s = &mzk[m];
        match &s.dirs {
            Some(d) => Some(d),
            None => s
                .symbol
                .as_ref()
                .filter(|s| !s.is_empty())
                .and_then(|s| mzk_dirs?.get(s))
                .map(|d| d.as_slice()),
        }
    };

    let mut cands = Vec::new();
    for (m, ms) in mzk.iter().enumerate() {
        let m_dirs = mzk_bearings(m);
        for (k, ks) in kb.iter().enumerate() {
            let d = stop_distance_meters(ms.lat.0, ms.lon.0, ks.lat.0, ks.lon.0);
            let max_d = if is_station(k) { MERGE_HUB_M } else { MERGE_NAME_M };
            // also drops NaN: a stop without coordinates is never a partner
            if d.is_nan() || d > max_d {
                continue;
            }
            let name = names_match(&mc[m], &kc[k]);
            let near = d <= MERGE_NEAR_M;
            let hub_ok = is_station(k) && name;
            if !(near || (name && d <= MERGE_NAME_M) || hub_ok) {
                continue;
            }
            let dd = direction_diff(ks.dirs.as_deref(), m_dirs);
            if dd.is_some_and(|dd| dd >= OPPOSITE_DEG) && d > MERGE_SAME_POLE_M {
                continue;
            }
            let mut cost = d + if name { 0.0 } else { COST_NAME_MISS };
            if let Some(dd) = dd {
                cost += if dd <= SAME_DIR_DEG {
                    0.0
                } else if dd < OPPOSITE_DEG {
                    COST_DIR_AMBIGUOUS
                } else {
                    COST_DIR_OPPOSITE
                };
            }
            cands.push(Candidate { k, m, cost, dd });
        }
    }

    let primary = assign(&cands, kb.len(), mzk.len()); // m -> k
    let primary_of: HashMap<usize, usize> = primary.iter().map(|(&m, &k)| (k, m)).collect();

    // station hubs: the other same-name MZK stops the station panel also lists (never the opposite carriageway)
    let mut extras_of: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut by_cost: Vec<&Candidate> = cands.iter().collect();
    by_cost.sort_by(|a, b| a.cost.total_cmp(&b.cost).then(a.m.cmp(&b.m)));
    for c in by_cost {
        if primary.contains_key(&c.m) || !primary_of.contains_key(&c.k) || !is_station(c.k) {
            continue;
        }
        if c.dd.is_some_and(|dd| dd >= OPPOSITE_DEG) || !names_match(&mc[c.m], &kc[c.k]) {
            continue;
        }
        let list = extras_of.entry(c.k).or_default();
        if list.len() + 1 < MERGE_MAX_MZK && !list.contains(&c.m) {
            list.push(c.m);
        }
    }

    let mut merged = Vec::with_capacity(kb.len() + mzk.len());
    for (k, bk) in kb.iter().enumerate() {
        let Some(&pm) = primary_of.get(&k) else { continue };
        let m = &mzk[pm];
        let extras = extras_of.get(&k).filter(|e| !e.is_empty());
        merged.push(WireStop {
            id: bk.id.clone(),
            designator: bk.designator.clone(),
            name: bk.name.clone(),
            lat: bk.lat,
            lon: bk.lon,
            operator: Some(Operator::BOTH),
            operators: Some(vec![Operator::KB, Operator::MZK]),
            kb_id: Some(bk.id.clone()),
            mzk_id: Some(m.id.clone()),
            kb_designator: Some(bk.designator.clone()),
            mzk_designator: Some(m.designator.clone()),
            mzk_symbol: m.symbol.clone(),
            // a hub has several symbols: no single "(343)" label in the UI
            symbol: if extras.is_some() { None } else { m.symbol.clone() },
            mzk_symbols: extras.map(|e| {
                (std::iter::once(&pm).chain(e))
                    .filter_map(|&x| mzk[x].symbol.clone().filter(|s| !s.is_empty()))
                    .collect()
            }),
            dirs: union_dirs([bk.dirs.as_ref(), m.dirs.as_ref()]),
            is_station: Some(bk.is_station == Some(true) || m.is_station == Some(true)),
            show_platforms: bk.show_platforms,
            on_request: Some(bk.on_request == Some(true) || m.on_request == Some(true)),
            getting_out: Some(bk.getting_out == Some(true) || m.getting_out == Some(true)),
        });
    }

    // unmatched KB, then unmatched MZK (original order; hub extras are folded into their hub)
    let folded: HashSet<usize> = extras_of.values().flatten().copied().collect();
    for s in kb
        .iter()
        .enumerate()
        .filter(|(k, _)| !primary_of.contains_key(k))
        .map(|(_, s)| s)
    {
        merged.push(WireStop {
            operator: Some(Operator::KB),
            operators: Some(vec![Operator::KB]),
            kb_id: Some(s.id.clone()),
            kb_designator: Some(s.designator.clone()),
            ..s.clone()
        });
    }
    for (m, s) in mzk.iter().enumerate() {
        if primary.contains_key(&m) || folded.contains(&m) {
            continue;
        }
        merged.push(WireStop {
            operator: Some(Operator::MZK),
            operators: Some(vec![Operator::MZK]),
            mzk_id: Some(s.id.clone()),
            mzk_designator: Some(s.designator.clone()),
            mzk_symbol: s.symbol.clone(),
            ..s.clone()
        });
    }
    merged
}
