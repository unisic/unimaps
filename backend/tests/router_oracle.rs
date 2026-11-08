//! test/router-oracle.test.ts and its brute-force reference test/support/connection-oracle.ts: the router against
//! a profile recomputed from the raw feed files, without the router's data structures. Every trip instance of
//! D-1/D/D+1 is scanned in every round, and the earliest arrival is recomputed from scratch per departure time.
//! Same rules as the router: a transfer at one pole takes `change` secs, a walk to a pole <= 350 m away takes
//! max(change, walk + 90 s) (poles < 4 m apart: no walk), no walking at either end.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use indexmap::IndexMap;
use jiff::ToSpan;
use jiff::civil::Date;
use serde_json::Value;
use unimaps::gtfs_csv::{col, field, read_text, table};
use unimaps::router::{ConnectionItinerary, RouteQuery, RouterIndex, clean_text, find_connections, load_index_from};

const GTFS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/gtfs");
const MZK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/mzk-timetable.v1.json");
const DATE: &str = "2026-09-30";
/// `Number.MAX_SAFE_INTEGER`
const INF: i64 = (1 << 53) - 1;
const RIDES: usize = 5;
const CHANGE: i64 = 180;

static IDX: LazyLock<RouterIndex> = LazyLock::new(|| load_index_from(Path::new(GTFS), Path::new(MZK)).unwrap());
static NET: LazyLock<OracleNet> = LazyLock::new(|| load_oracle_net(Path::new(GTFS), Path::new(MZK), DATE));

struct Instance {
    trip_id: String,
    stops: Vec<usize>,
    arr: Vec<i64>,
    dep: Vec<i64>,
}

struct Foot {
    to: usize,
    secs: i64,
}

#[derive(Default)]
struct OracleNet {
    ids: Vec<String>,
    num: HashMap<String, usize>,
    names: Vec<String>,
    coords: Vec<(f64, f64)>,
    instances: Vec<Instance>,
    foot: Vec<Vec<Foot>>,
}

#[derive(Debug, PartialEq)]
struct ProfileEntry {
    dep: i64,
    arr: i64,
    transfers: i64,
}

impl OracleNet {
    fn id(&mut self, s: &str) -> usize {
        if let Some(&n) = self.num.get(s) {
            return n;
        }
        let n = self.ids.len();
        self.ids.push(s.to_string());
        self.num.insert(s.to_string(), n);
        self.names.push(s.to_string());
        self.coords.push((0.0, 0.0));
        n
    }

    fn add(&mut self, trip_id: &str, stops: &[String], times: &[(i64, i64)], off: i64) {
        if stops.len() < 2 {
            return;
        }
        let fixed = fix_times(times);
        let stops = stops.iter().map(|s| self.id(s)).collect();
        self.instances.push(Instance {
            trip_id: trip_id.to_string(),
            stops,
            arr: fixed.iter().map(|&(a, _)| a + off).collect(),
            dep: fixed.iter().map(|&(_, d)| d + off).collect(),
        });
    }
}

/// Rows keyed by header name, like `Object.fromEntries(hdr.map((h) => [h, f[col(hdr, h)] ?? ""]))`.
fn csv(file: &Path) -> Vec<HashMap<String, String>> {
    let (hdr, rows) = table(&read_text(file).unwrap());
    rows.iter()
        .map(|f| {
            hdr.iter()
                .map(|h| (h.clone(), field(f, col(&hdr, h)).unwrap_or("").to_string()))
                .collect()
        })
        .collect()
}

/// `Number(x) || 0`
fn js_num(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().ok().filter(|v| !v.is_nan()).unwrap_or(0.0)
}

fn secs(hms: &str) -> i64 {
    let mut it = hms.split(':').map(|p| js_num(p) as i64);
    let (h, m, s) = (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0));
    h * 3600 + m * 60 + s
}

fn fix_times(times: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut wrap = 0;
    let mut prev = -INF;
    times
        .iter()
        .map(|&(a, d)| {
            let mut arr = a + wrap;
            if arr < prev - 43_200 {
                wrap += 86_400;
                arr += 86_400;
            }
            arr = arr.max(prev);
            prev = (d + wrap).max(arr);
            (arr, prev)
        })
        .collect()
}

/// The network of service day `date`: trip instances of the day before (times -24 h), the day and the day after
/// (+24 h).
fn load_oracle_net(gtfs: &Path, mzk_file: &Path, date: &str) -> OracleNet {
    let mut net = OracleNet::default();
    for s in csv(&gtfs.join("stops.txt")) {
        let n = net.id(&s["stop_id"]);
        net.names[n] = s["stop_name"].clone();
        net.coords[n] = (js_num(&s["stop_lat"]), js_num(&s["stop_lon"]));
    }
    // ponytail: file order of the MZK stop symbols, where Object.entries puts integer keys first; it only moves
    // MZK ids, and nothing below depends on their order
    let mzk: Value = serde_json::from_str(&read_text(mzk_file).unwrap()).unwrap();
    for (sym, v) in mzk["stops"].as_object().unwrap() {
        let n = net.id(&format!("mzk:{sym}"));
        net.names[n] = v[0].as_str().unwrap().to_string();
        net.coords[n] = (v[1].as_f64().unwrap(), v[2].as_f64().unwrap());
    }

    const WEEKDAYS: [&str; 7] = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ];
    let calendar: HashMap<String, HashMap<String, String>> = csv(&gtfs.join("calendar.txt"))
        .into_iter()
        .map(|c| (c["service_id"].clone(), c))
        .collect();
    let service: HashMap<String, String> = csv(&gtfs.join("trips.txt"))
        .into_iter()
        .map(|t| (t["trip_id"].clone(), t["service_id"].clone()))
        .collect();
    let mut kb: IndexMap<String, Vec<(f64, String, i64, i64)>> = IndexMap::new();
    for st in csv(&gtfs.join("stop_times.txt")) {
        if !service.contains_key(&st["trip_id"]) {
            continue;
        }
        let arr = if st["arrival_time"].is_empty() {
            &st["departure_time"]
        } else {
            &st["arrival_time"]
        };
        kb.entry(st["trip_id"].clone()).or_default().push((
            js_num(&st["stop_sequence"]),
            st["stop_id"].clone(),
            secs(arr),
            secs(&st["departure_time"]),
        ));
    }
    for list in kb.values_mut() {
        list.sort_by(|a, b| a.0.total_cmp(&b.0));
    }

    let base: Date = date.parse().unwrap();
    for o in -1i64..=1 {
        let day = base.checked_add(o.days()).unwrap();
        let weekday = WEEKDAYS[day.weekday().to_monday_zero_offset() as usize];
        for (trip_id, list) in &kb {
            let cal = calendar.get(service.get(trip_id).map_or("", String::as_str));
            if cal.is_some_and(|c| c.get(weekday).map(String::as_str) != Some("1")) {
                continue;
            }
            let stops: Vec<String> = list.iter().map(|s| s.1.clone()).collect();
            let times: Vec<(i64, i64)> = list.iter().map(|s| (s.2, s.3)).collect();
            net.add(trip_id, &stops, &times, o * 86_400);
        }
        let day_type = &mzk["calendar"][day.to_string()];
        for t in mzk["trips"].as_array().unwrap() {
            if *day_type != t["dayType"] {
                continue;
            }
            let calls = t["calls"].as_array().unwrap();
            let stops: Vec<String> = calls
                .iter()
                .map(|c| format!("mzk:{}", c[0].as_str().unwrap()))
                .collect();
            let times: Vec<(i64, i64)> = calls
                .iter()
                .map(|c| {
                    let s = c[1].as_i64().unwrap();
                    (s, s)
                })
                .collect();
            net.add(t["id"].as_str().unwrap(), &stops, &times, o * 86_400);
        }
    }

    let n = net.ids.len();
    net.foot = (0..n).map(|_| Vec::new()).collect();
    for a in 0..n {
        for b in 0..n {
            let (la, oa) = net.coords[a];
            let (lb, ob) = net.coords[b];
            if a == b || la == 0.0 || oa == 0.0 || lb == 0.0 || ob == 0.0 {
                continue;
            }
            let dy = (lb - la) * 111_320.0;
            let dx = (ob - oa) * 111_320.0 * (((la + lb) / 2.0) * (std::f64::consts::PI / 180.0)).cos();
            let d = (dx * dx + dy * dy).sqrt();
            if d <= 350.0 {
                let secs = if d < 4.0 {
                    0
                } else {
                    60 * 1i64.max((d / 1.1 / 60.0).ceil() as i64)
                };
                net.foot[a].push(Foot { to: b, secs });
            }
        }
    }
    net
}

/// Earliest arrival at every stop (`[k][stop]`) with at most k rides, leaving the origins at or after `tau`.
fn earliest_all(net: &OracleNet, origins: &[usize], tau: i64) -> Vec<Vec<i64>> {
    let n = net.ids.len();
    let mut ready = vec![INF; n];
    let mut best = vec![INF; n];
    for &o in origins {
        ready[o] = tau;
    }
    let mut out = vec![best.clone()];
    for _ in 1..=RIDES {
        let mut arr = best.clone();
        for inst in &net.instances {
            let mut on = false;
            for p in 0..inst.stops.len() {
                let s = inst.stops[p];
                if on && inst.arr[p] < arr[s] {
                    arr[s] = inst.arr[p];
                }
                if p < inst.stops.len() - 1 && ready[s] <= inst.dep[p] {
                    on = true;
                }
            }
        }
        let mut next = ready.clone();
        for s in 0..n {
            if arr[s] >= INF {
                continue;
            }
            next[s] = next[s].min(arr[s] + CHANGE);
            for f in &net.foot[s] {
                next[f.to] = next[f.to].min(arr[s] + CHANGE.max(f.secs + 90));
            }
        }
        best = arr;
        ready = next;
        out.push(best.clone());
    }
    out
}

/// Departures from the origin poles in [after, after + 24 h), ascending, closed by after + 24 h itself.
fn departures(net: &OracleNet, origins: &[usize], after: i64) -> Vec<i64> {
    let is_origin: HashSet<usize> = origins.iter().copied().collect();
    let mut taus = BTreeSet::new();
    for inst in &net.instances {
        for p in 0..inst.stops.len() - 1 {
            if is_origin.contains(&inst.stops[p]) && inst.dep[p] >= after && inst.dep[p] < after + 86_400 {
                taus.insert(inst.dep[p]);
            }
        }
    }
    taus.into_iter().chain([after + 86_400]).collect()
}

/// Pareto entries leaving at `tau`, from the best arrivals per ride count at `tau` (`cur`) and at the next
/// departure (`next`).
fn entries_at(tau: i64, cur: &[i64], next: &[i64]) -> Vec<ProfileEntry> {
    let mut here: Vec<ProfileEntry> = (1..=RIDES)
        .filter(|&k| cur[k] < INF && cur[k] < cur[k - 1] && cur[k] < next[k])
        .map(|k| ProfileEntry {
            dep: tau,
            arr: cur[k],
            transfers: k as i64 - 1,
        })
        .collect();
    here.sort_by_key(|e| e.arr);
    here
}

/// Stop numbers of every pole sharing the cleaned name of one of `ids` (the router's pole resolution for stop ids).
fn poles_of(net: &OracleNet, ids: &[&str]) -> Vec<usize> {
    let keys: HashSet<String> = ids
        .iter()
        .map(|&s| clean_text(net.num.get(s).map_or(s, |&n| net.names[n].as_str())))
        .collect();
    (0..net.ids.len())
        .filter(|&i| keys.contains(&clean_text(&net.names[i])))
        .collect()
}

/// The first `limit` Pareto-optimal (later departure, earlier arrival, fewer transfers) journeys leaving in
/// [after, after + 24 h), ordered like the router (departure, arrival, transfers).
fn oracle_profile(
    net: &OracleNet,
    origins: &[usize],
    targets: &[usize],
    after: i64,
    limit: usize,
) -> Vec<ProfileEntry> {
    let taus = departures(net, origins, after);
    let at_targets = |tau: i64| -> Vec<i64> {
        earliest_all(net, origins, tau)
            .iter()
            .map(|arr| targets.iter().map(|&t| arr[t]).min().unwrap_or(INF))
            .collect()
    };
    let mut out = Vec::new();
    let mut cur = if taus.len() > 1 {
        at_targets(taus[0])
    } else {
        Vec::new()
    };
    let mut i = 0;
    while i + 1 < taus.len() && out.len() < limit {
        let next = at_targets(taus[i + 1]);
        out.extend(entries_at(taus[i], &cur, &next));
        cur = next;
        i += 1;
    }
    out.truncate(limit);
    out
}

/// Why `it` is not a journey of `net` from `origins` to `targets` leaving at or after `after`, or None when it is
/// one.
fn infeasible(
    net: &OracleNet,
    it: &ConnectionItinerary,
    origins: &[usize],
    targets: &[usize],
    after: i64,
) -> Option<String> {
    if i64::from(it.departure_secs) < after {
        return Some(format!("leaves {} before {after}", it.departure_secs));
    }
    if it.legs.len() as i32 != it.transfers_count + 1 {
        return Some("legs != transfers + 1".into());
    }
    for (i, leg) in it.legs.iter().enumerate() {
        let from = net.num.get(&leg.from_stop_id).copied();
        let to = net.num.get(&leg.to_stop_id).copied();
        let (dep, arr) = (i64::from(leg.departure_secs), i64::from(leg.arrival_secs));
        let ride = net.instances.iter().any(|inst| {
            inst.trip_id == leg.trip_id
                && (0..inst.stops.len()).any(|b| {
                    Some(inst.stops[b]) == from
                        && inst.dep[b] == dep
                        && (b + 1..inst.stops.len()).any(|a| {
                            Some(inst.stops[a]) == to && inst.arr[a] == arr && (a - b) as i32 == leg.stops_count
                        })
                })
        });
        if !ride {
            return Some(format!(
                "leg {i} ({} {} {}->{}) is no ride of the timetable",
                leg.line, leg.trip_id, leg.from_stop_id, leg.to_stop_id
            ));
        }
        let (from, to) = (from.unwrap(), to.unwrap());
        if i == 0 && !origins.contains(&from) {
            return Some("first leg does not start at an origin pole".into());
        }
        if i == it.legs.len() - 1 && !targets.contains(&to) {
            return Some("last leg does not end at a target pole".into());
        }
        if i == 0 {
            continue;
        }
        let prev = &it.legs[i - 1];
        let at = net.num.get(&prev.to_stop_id).copied();
        let walk = if at == Some(from) {
            Some(0)
        } else {
            at.and_then(|at| net.foot[at].iter().find(|f| f.to == from).map(|f| f.secs))
        };
        let Some(walk) = walk else {
            return Some(format!(
                "transfer {i}: {} -> {} is not walkable",
                prev.to_stop_id, leg.from_stop_id
            ));
        };
        let need = if walk == 0 { CHANGE } else { CHANGE.max(walk + 90) };
        let gap = dep - i64::from(prev.arrival_secs);
        if gap < need {
            return Some(format!("transfer {i}: {gap} s < {need} s"));
        }
    }
    None
}

fn check(from: &str, to: &str, after: i64, limit: usize) {
    let (from_ids, to_ids) = ([from.to_string()], [to.to_string()]);
    let q = RouteQuery {
        from,
        to,
        from_ids: &from_ids,
        to_ids: &to_ids,
        date: Some(DATE),
        after_secs: Some(after as i32),
        limit: Some(limit as i32),
        ..Default::default()
    };
    let res = find_connections(&q, Some(&IDX));
    let net = &*NET;
    let origins = poles_of(net, &[from]);
    let targets = poles_of(net, &[to]);
    for it in &res {
        assert_eq!(
            infeasible(net, it, &origins, &targets, after),
            None,
            "{from} -> {to} {}",
            it.departure_time
        );
    }
    let got: Vec<ProfileEntry> = res
        .iter()
        .map(|it| ProfileEntry {
            dep: it.departure_secs.into(),
            arr: it.arrival_secs.into(),
            transfers: it.transfers_count.into(),
        })
        .collect();
    assert_eq!(
        got,
        oracle_profile(net, &origins, &targets, after, limit),
        "{from} -> {to} after {after}"
    );
}

#[test]
fn matches_on_the_corridors_of_the_router_tests_direct_transfers_walking_across_midnight() {
    check("10000", "21141", 10 * 3600, 5);
    check("10431", "21141", 8 * 3600, 5);
    check("21031", "40000", 11 * 3600, 5);
    check("25461", "40000", 15 * 3600, 5);
    check("10000", "40000", 22 * 3600 + 30 * 60, 5);
}

#[test]
fn matches_a_kb_to_mzk_journey_with_a_walk_between_operators() {
    check("22191", "mzk:456", 21 * 3600, 3);
}

#[test]
fn matches_on_12_seeded_random_pairs_of_stops() {
    // JS number arithmetic: seed * 1103515245 passes 2^53 and rounds, so the LCG runs in f64 like the TS
    let mut seed = 7.0_f64;
    let mut rnd = |n: usize| -> usize {
        seed = (seed * 1_103_515_245.0 + 12_345.0) % 2_147_483_648.0;
        (seed % n as f64) as usize
    };
    let kb: Vec<&str> = NET
        .ids
        .iter()
        .filter(|id| !id.starts_with("mzk:"))
        .map(String::as_str)
        .collect();
    for _ in 0..12 {
        let from = kb[rnd(kb.len())];
        let to = kb[rnd(kb.len())];
        check(from, to, 4 * 3600 + rnd(18) as i64 * 3600, 5);
    }
}
