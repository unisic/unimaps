//! test/stop-merge.test.ts (the tripTimeMatchesStop cases are client code and stay in TS) and the golden vectors:
//! the whole merged list on the captured fixture and on seeded clusters, plus cleanStopName.

use std::collections::{BTreeMap, HashMap};
use std::f64::consts::PI;

use serde::Deserialize;
use serde_json::Value;
use unimaps::js::JsNum;
use unimaps::stop_merge::{
    Operator, WireStop, clean_stop_name, direction_diff, index_merged_stops, merge_stops, stop_distance_meters,
};

const L0: f64 = 49.8;
const O0: f64 = 19.0;

/// metres -> degrees at ~49.8 N (1 deg lat ~ 111 139 m)
fn d_lat(m: f64) -> f64 {
    m / 111_139.0
}
fn d_lon(m: f64) -> f64 {
    m / (111_139.0 * (49.8 * PI / 180.0).cos())
}

fn dirs(d: &[f64]) -> Option<Vec<JsNum>> {
    Some(d.iter().map(|&x| JsNum(x)).collect())
}

fn kb(id: &str, name: &str, lat: f64, lon: f64) -> WireStop {
    WireStop {
        id: id.into(),
        designator: format!("d{id}"),
        name: name.into(),
        lat: JsNum(lat),
        lon: JsNum(lon),
        operator: Some(Operator::KB),
        ..Default::default()
    }
}

fn mzk(sym: &str, name: &str, lat: f64, lon: f64) -> WireStop {
    WireStop {
        id: format!("mzk:{sym}"),
        designator: format!("mzk:{sym}"),
        name: name.into(),
        lat: JsNum(lat),
        lon: JsNum(lon),
        operator: Some(Operator::MZK),
        symbol: Some(sym.into()),
        ..Default::default()
    }
}

fn merge(kb: &[WireStop], mzk: &[WireStop]) -> Vec<WireStop> {
    merge_stops(kb, mzk, None)
}

/// kbId -> the MZK symbols it was merged with, sorted
fn pairing(merged: &[WireStop]) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    for s in merged.iter().filter(|s| s.operator == Some(Operator::BOTH)) {
        let mut syms = s
            .mzk_symbols
            .clone()
            .unwrap_or_else(|| s.mzk_symbol.clone().into_iter().collect());
        syms.sort();
        out.insert(s.kb_id.clone().unwrap(), syms);
    }
    out
}

fn pairs(list: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
    list.iter()
        .map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect()))
        .collect()
}

fn by_id<'a>(out: &'a [WireStop], id: &str) -> Option<&'a WireStop> {
    out.iter().find(|s| s.id == id)
}

fn no_merge(out: &[WireStop]) -> bool {
    out.iter().all(|s| s.operator != Some(Operator::BOTH))
}

#[test]
fn clean_stop_name_strips_city_prefixes() {
    assert_eq!(clean_stop_name("BIELSKO-BIAŁA 3 MAJA DWORZEC"), "3MAJADWORZEC");
    assert_eq!(clean_stop_name("BIELSKO BIAŁA CIESZYŃSKA HULANKA"), "CIESZYŃSKAHULANKA");
    assert_eq!(clean_stop_name("BYSTRA SZKOŁA"), "SZKOŁA");
    assert_eq!(clean_stop_name("CZECHOWICE-DZIEDZICE DWORZEC"), "DWORZEC");
}

#[test]
fn clean_stop_name_normalizes_stations() {
    assert_eq!(clean_stop_name("BIELSKO-BIAŁA D.A."), "DWORZEC");
    assert_eq!(clean_stop_name("BIELSKO-BIAŁA DWORZEC AUTOBUSOWY"), "DWORZEC");
}

#[test]
fn clean_stop_name_strips_punctuation() {
    assert_eq!(clean_stop_name("Cieszyńska (Lotnisko)"), "CIESZYŃSKALOTNISKO");
    assert_eq!(clean_stop_name("Plac Żwirki i Wigury"), "PLACŻWIRKIIWIGURY");
}

#[test]
fn stop_distance() {
    let d = stop_distance_meters(49.827, 19.044, 49.8271, 19.044);
    assert!(d > 10.0 && d < 12.0, "expected ~11 m, got {d}");
    assert_eq!(stop_distance_meters(49.82, 19.04, 49.82, 19.04), 0.0);
}

fn sample() -> (Vec<WireStop>, Vec<WireStop>) {
    let kbs = vec![
        WireStop {
            designator: "10021".into(),
            dirs: dirs(&[90.0]),
            is_station: Some(true),
            show_platforms: Some(true),
            ..kb("10021", "BIELSKO-BIAŁA 3 MAJA DWORZEC", 49.82777, 19.04484)
        },
        WireStop {
            designator: "50011".into(),
            is_station: Some(false),
            show_platforms: Some(false),
            ..kb("50011", "ANDRYCHÓW 1 MAJA", 49.853, 19.338)
        },
    ];
    let mzks = vec![
        WireStop {
            is_station: Some(false),
            show_platforms: Some(false),
            ..mzk("2", "3 Maja Dworzec", 49.8278, 19.0449)
        },
        WireStop {
            is_station: Some(false),
            show_platforms: Some(false),
            ..mzk("999", "Szyndzielnia Dolna Stacja", 49.773, 19.025)
        },
    ];
    (kbs, mzks)
}

#[test]
fn merges_the_same_physical_stop() {
    let (k, m) = sample();
    let merged = merge(&k, &m);
    assert_eq!(merged.len(), 3);
    let s = by_id(&merged, "10021").expect("merged 3 Maja");
    assert_eq!(s.operator, Some(Operator::BOTH));
    assert_eq!(s.operators, Some(vec![Operator::KB, Operator::MZK]));
    assert_eq!(s.kb_id.as_deref(), Some("10021"));
    assert_eq!(s.mzk_id.as_deref(), Some("mzk:2"));
    assert_eq!(s.kb_designator.as_deref(), Some("10021"));
    assert_eq!(s.mzk_designator.as_deref(), Some("mzk:2"));
    assert_eq!(s.mzk_symbol.as_deref(), Some("2"));
    assert_eq!(s.symbol.as_deref(), Some("2"));
    assert_eq!(s.is_station, Some(true));
}

#[test]
fn unmatched_stops_keep_their_operator() {
    let (k, m) = sample();
    let merged = merge(&k, &m);
    let a = by_id(&merged, "50011").unwrap();
    assert_eq!(
        (a.operator, a.operators.clone()),
        (Some(Operator::KB), Some(vec![Operator::KB]))
    );
    let s = by_id(&merged, "mzk:999").unwrap();
    assert_eq!(
        (s.operator, s.operators.clone()),
        (Some(Operator::MZK), Some(vec![Operator::MZK]))
    );
}

#[test]
fn index_resolves_every_id() {
    let (k, m) = sample();
    let merged = merge(&k, &m);
    let index = index_merged_stops(&merged);
    for key in ["10021", "mzk:2", "2"] {
        assert_eq!(merged[index[key]].id, "10021", "{key}");
    }
}

#[test]
fn direction_diff_cases() {
    let d = |a: &[f64], b: &[f64]| direction_diff(dirs(a).as_deref(), dirs(b).as_deref());
    assert_eq!(direction_diff(None, dirs(&[90.0]).as_deref()), None);
    assert_eq!(d(&[], &[90.0]), None);
    assert_eq!(d(&[350.0], &[10.0]), Some(20.0));
    assert_eq!(d(&[0.0, 180.0], &[170.0]), Some(10.0)); // best pair wins (stop served both ways)
    assert_eq!(d(&[2.0], &[181.0]), Some(179.0));
}

fn twins() -> (Vec<WireStop>, WireStop, WireStop) {
    let kbs = vec![
        WireStop {
            dirs: dirs(&[90.0]),
            ..kb("1", "BIELSKO-BIAŁA TESTOWA", L0, O0)
        },
        WireStop {
            dirs: dirs(&[270.0]),
            ..kb("2", "BIELSKO-BIAŁA TESTOWA", L0 + d_lat(20.0), O0 + d_lon(80.0))
        },
    ];
    let a = mzk("A", "Testowa", L0 + d_lat(1.0), O0 + d_lon(2.0)); // sits on KB 1
    let b = mzk("B", "Testowa", L0 + d_lat(20.0), O0 + d_lon(79.0)); // sits on KB 2
    (kbs, a, b)
}

#[test]
fn pairing_is_independent_of_the_mzk_order() {
    let (kbs, a, b) = twins();
    let p1 = pairing(&merge(&kbs, &[a.clone(), b.clone()]));
    assert_eq!(p1, pairs(&[("1", &["A"]), ("2", &["B"])]));
    assert_eq!(pairing(&merge(&kbs, &[b, a])), p1);
}

#[test]
fn pairing_is_independent_of_the_kb_order() {
    let (mut kbs, a, b) = twins();
    kbs.reverse();
    assert_eq!(pairing(&merge(&kbs, &[a, b])), pairs(&[("1", &["A"]), ("2", &["B"])]));
}

#[test]
fn a_farther_same_name_stop_does_not_steal_the_partner() {
    let kbs = [
        kb("1", "BIELSKO-BIAŁA STREFA", L0, O0),
        kb("2", "BIELSKO-BIAŁA STREFA", L0 + d_lat(111.0), O0 - d_lon(2.0)),
    ];
    let a = mzk("A", "Strefa", L0 + d_lat(111.0), O0 - d_lon(4.0));
    let b = mzk("B", "Strefa", L0 + d_lat(82.0), O0 - d_lon(14.0));
    let want = pairs(&[("1", &["B"]), ("2", &["A"])]);
    assert_eq!(pairing(&merge(&kbs, &[a.clone(), b.clone()])), want);
    assert_eq!(pairing(&merge(&kbs, &[b, a])), want);
}

fn stagger(with_dirs: bool) -> (Vec<WireStop>, WireStop, WireStop) {
    let d = |b: f64| if with_dirs { dirs(&[b]) } else { None };
    let kbs = vec![
        WireStop {
            dirs: d(77.0),
            ..kb("E", "BIELSKO-BIAŁA STAGGER", L0, O0)
        },
        WireStop {
            dirs: d(257.0),
            ..kb("W", "BIELSKO-BIAŁA STAGGER", L0 + d_lat(23.0), O0 - d_lon(81.0))
        },
    ];
    let m_e = WireStop {
        dirs: d(84.0),
        ..mzk("mE", "Stagger", L0 + d_lat(4.0), O0 - d_lon(73.0))
    }; // 73 m from KB E
    let m_w = WireStop {
        dirs: d(263.0),
        ..mzk("mW", "Stagger", L0 + d_lat(25.0), O0 - d_lon(26.0))
    }; // 36 m from KB E
    (kbs, m_e, m_w)
}

#[test]
fn pairs_by_direction_even_when_the_opposite_stop_is_closer() {
    let (kbs, m_e, m_w) = stagger(true);
    for order in [[m_e.clone(), m_w.clone()], [m_w, m_e]] {
        assert_eq!(pairing(&merge(&kbs, &order)), pairs(&[("E", &["mE"]), ("W", &["mW"])]));
    }
}

#[test]
fn without_direction_data_it_falls_back_to_distance() {
    let (kbs, m_e, m_w) = stagger(false);
    let p1 = pairing(&merge(&kbs, &[m_e.clone(), m_w.clone()]));
    assert_eq!(p1, pairs(&[("E", &["mW"]), ("W", &["mE"])])); // 36 m + 21 m beat 73 m + 55 m
    assert_eq!(pairing(&merge(&kbs, &[m_w, m_e])), p1);
}

#[test]
fn the_opposite_carriageway_is_not_merged() {
    let k = WireStop {
        dirs: dirs(&[90.0]),
        ..kb("K", "BIELSKO-BIAŁA OPP", L0, O0)
    };
    let m = WireStop {
        dirs: dirs(&[270.0]),
        ..mzk("M", "Opp", L0 + d_lat(10.0), O0 + d_lon(34.0))
    };
    let out = merge(&[k], &[m]);
    assert_eq!(out.len(), 2);
    assert!(no_merge(&out));
}

#[test]
fn the_same_pole_with_disagreeing_directions_still_merges() {
    let k = WireStop {
        dirs: dirs(&[197.0]),
        ..kb("K", "BIELSKO-BIAŁA POLE", L0, O0)
    };
    let m = WireStop {
        dirs: dirs(&[18.0]),
        ..mzk("M", "Pole", L0 + d_lat(2.0), O0 + d_lon(2.0))
    };
    assert_eq!(pairing(&merge(&[k], &[m])), pairs(&[("K", &["M"])]));
}

/// MERGE_SAME_POLE_M (12 m) on both sides; the expectations come from running the TS
#[test]
fn opposite_directions_merge_only_up_to_12_m() {
    let k = WireStop {
        dirs: dirs(&[90.0]),
        ..kb("K", "BIELSKO-BIAŁA POLE", L0, O0)
    };
    let at = |m: f64| {
        merge(
            std::slice::from_ref(&k),
            &[WireStop {
                dirs: dirs(&[270.0]),
                ..mzk("M", "Pole", L0 + d_lat(m), O0)
            }],
        )
    };
    assert_eq!(pairing(&at(11.0)), pairs(&[("K", &["M"])]));
    assert!(no_merge(&at(13.0)));
}

/// an opposite pole at 5 m (cost 5 + 25 + 400) loses to a same-name stop of unclear direction at 105 m (105 + 40)
#[test]
fn an_opposite_pole_loses_to_a_plausible_farther_stop() {
    let kbs = [
        WireStop {
            dirs: dirs(&[90.0]),
            ..kb("K1", "BIELSKO-BIAŁA ALFA", L0, O0)
        },
        WireStop {
            dirs: dirs(&[0.0]),
            ..kb("K2", "BIELSKO-BIAŁA BETA", L0 + d_lat(110.0), O0)
        },
    ];
    let m = WireStop {
        dirs: dirs(&[270.0]),
        ..mzk("M", "Beta", L0 + d_lat(5.0), O0)
    };
    assert_eq!(pairing(&merge(&kbs, &[m])), pairs(&[("K2", &["M"])]));
}

#[test]
fn the_orphaned_same_direction_stop_wins_over_a_closer_opposite_one() {
    let k = WireStop {
        dirs: dirs(&[218.0]),
        ..kb("K", "BIELSKO-BIAŁA GRUNWALDZKA SZPITAL", L0, O0)
    };
    let wrong = WireStop {
        dirs: dirs(&[23.0]),
        ..mzk("112", "Grunwaldzka Szpital", L0 + d_lat(10.0), O0 + d_lon(11.0))
    };
    let right = WireStop {
        dirs: dirs(&[235.0]),
        ..mzk("113", "Grunwaldzka Szpital", L0 + d_lat(2.0), O0 + d_lon(2.0))
    };
    let out = merge(&[k], &[wrong, right]);
    assert_eq!(pairing(&out), pairs(&[("K", &["113"])]));
    assert_eq!(by_id(&out, "mzk:112").unwrap().operator, Some(Operator::MZK));
}

#[test]
fn thresholds() {
    let far = merge(
        &[kb("1", "BIELSKO-BIAŁA FAR", L0, O0)],
        &[mzk("A", "Far", L0, O0 + d_lon(130.0))],
    );
    assert!(no_merge(&far), "same name beyond 120 m");
    let other = merge(
        &[kb("1", "BIELSKO-BIAŁA ALFA", L0, O0)],
        &[mzk("A", "Beta", L0, O0 + d_lon(60.0))],
    );
    assert!(no_merge(&other), "different names beyond 35 m");
    let pole = merge(
        &[kb("1", "BIELSKO-BIAŁA ALFA", L0, O0)],
        &[mzk("A", "Beta", L0, O0 + d_lon(20.0))],
    );
    assert_eq!(pairing(&pole), pairs(&[("1", &["A"])]), "different names within 35 m");
    let short = merge(
        &[kb("1", "BIELSKO-BIAŁA AB", L0, O0)],
        &[mzk("A", "AB", L0, O0 + d_lon(80.0))],
    );
    assert!(no_merge(&short), "cleaned names must be > 2 chars");
}

#[test]
fn arrows_of_a_merged_stop() {
    let one = |k: &[f64], m: &[f64]| {
        let kd = (!k.is_empty()).then(|| dirs(k)).flatten();
        let out = merge(
            &[WireStop {
                dirs: kd,
                ..kb("1", "BIELSKO-BIAŁA A", L0, O0)
            }],
            &[WireStop {
                dirs: dirs(m),
                ..mzk("A", "A", L0, O0)
            }],
        );
        out[0].dirs.clone()
    };
    assert_eq!(
        one(&[218.0], &[220.0]),
        dirs(&[218.0]),
        "near-identical bearings collapse to one arrow"
    );
    assert_eq!(
        one(&[10.0, 190.0], &[100.0, 280.0]),
        dirs(&[10.0, 190.0]),
        "never more than two"
    );
    assert_eq!(
        one(&[], &[77.0]),
        dirs(&[77.0]),
        "MZK supplies the arrow when KB has none"
    );
}

fn station(id: &str, name: &str) -> WireStop {
    WireStop {
        is_station: Some(true),
        ..kb(id, name, L0, O0)
    }
}

fn street_stops() -> Vec<WireStop> {
    vec![
        mzk("343", "Warszawska Dworzec", L0 + d_lat(60.0), O0 + d_lon(60.0)), // 85 m
        mzk("341", "Warszawska Dworzec", L0 - d_lat(100.0), O0 + d_lon(110.0)), // 149 m
        mzk("264", "Piastowska Dworzec", L0 - d_lat(140.0), O0 - d_lon(40.0)), // 146 m
    ]
}

fn czechowice() -> (WireStop, Vec<WireStop>) {
    let poles = vec![
        mzk("2366", "Czechowice-Dz. Dworzec", L0 + d_lat(10.0), O0), // line 50 one way
        mzk("2367", "Czechowice-Dz. Dworzec", L0 - d_lat(13.0), O0), // line 50 the other way
    ];
    (station("CZ", "CZECHOWICE-DZIEDZICE D.A."), poles)
}

#[test]
fn a_station_never_takes_in_stops_beyond_the_hub_radius() {
    let da = WireStop {
        show_platforms: Some(true),
        ..station("DA", "BIELSKO-BIAŁA D.A.")
    };
    let mut mzks = street_stops();
    mzks.push(mzk("2", "3 Maja Dworzec", L0 + d_lat(300.0), O0 + d_lon(250.0))); // 390 m, another station
    let out = merge(&[da], &mzks);
    assert!(pairing(&out).is_empty());
    assert_eq!(by_id(&out, "DA").unwrap().operator, Some(Operator::KB));
    let index = index_merged_stops(&out);
    for sym in ["343", "341", "264", "2"] {
        let key = format!("mzk:{sym}");
        assert_eq!(out[index[&key]].id, key);
    }
}

#[test]
fn a_station_lists_its_poles_and_folds_them_in() {
    let (cz, poles) = czechowice();
    let out = merge(&[cz], &poles);
    let s = out.iter().find(|x| x.operator == Some(Operator::BOTH)).unwrap();
    assert_eq!(s.kb_id.as_deref(), Some("CZ"));
    assert_eq!(s.mzk_symbol.as_deref(), Some("2366")); // nearest = primary
    assert_eq!(s.mzk_symbols, Some(vec!["2366".to_string(), "2367".to_string()]));
    assert_eq!(s.symbol, None); // no single "(2366)" label for a hub
    assert!(by_id(&out, "mzk:2366").is_none() && by_id(&out, "mzk:2367").is_none());
    assert_eq!(out.len(), 1);
}

#[test]
fn a_hub_is_order_independent_and_indexed_by_every_symbol() {
    let (cz, mut poles) = czechowice();
    let a = merge(std::slice::from_ref(&cz), &poles);
    poles.reverse();
    assert_eq!(pairing(&a), pairing(&merge(&[cz], &poles)));
    let index = index_merged_stops(&a);
    for key in ["2366", "mzk:2366", "2367", "mzk:2367"] {
        assert_eq!(a[index[key]].id, "CZ", "{key}");
    }
}

#[test]
fn a_plain_stop_never_fans_out() {
    let out = merge(&[kb("P", "BIELSKO-BIAŁA WARSZAWSKA DWORZEC", L0, O0)], &street_stops());
    let both: Vec<_> = out.iter().filter(|s| s.operator == Some(Operator::BOTH)).collect();
    assert_eq!(both.len(), 1);
    assert_eq!(both[0].mzk_symbols, None);
    assert_eq!(out.iter().filter(|s| s.operator == Some(Operator::MZK)).count(), 2);
}

#[test]
fn a_hub_never_lists_the_opposite_direction() {
    let st = WireStop {
        dirs: dirs(&[90.0]),
        ..station("S", "BIELSKO-BIAŁA D.A.")
    };
    let near = WireStop {
        dirs: dirs(&[92.0]),
        ..mzk("A", "Dworzec", L0 + d_lat(20.0), O0)
    };
    let opp = WireStop {
        dirs: dirs(&[272.0]),
        ..mzk("B", "Dworzec", L0 - d_lat(20.0), O0)
    };
    let out = merge(&[st], &[near, opp]);
    let s = out.iter().find(|x| x.operator == Some(Operator::BOTH)).unwrap();
    assert_eq!(s.mzk_symbol.as_deref(), Some("A"));
    assert_eq!(s.mzk_symbols, None);
}

#[test]
fn stops_without_coordinates_never_merge() {
    let st = WireStop {
        is_station: Some(true),
        ..kb("S", "BIELSKO-BIAŁA D.A.", f64::NAN, O0)
    };
    let ok = kb("K", "BIELSKO-BIAŁA OKOLICA", L0, O0);
    let out = merge(
        &[st, ok],
        &[mzk("1", "Dworzec", L0, O0), mzk("2", "Okolica", L0, O0 + d_lon(3.0))],
    );
    assert_eq!(pairing(&out), pairs(&[("K", &["2"])]));
    assert_eq!(out.len(), 3);
}

fn learned() -> HashMap<String, Vec<JsNum>> {
    [("mE", 84.0), ("mW", 263.0)]
        .into_iter()
        .map(|(s, d)| (s.to_string(), vec![JsNum(d)]))
        .collect()
}

#[test]
fn learned_bearings_steer_the_pairing() {
    let (mut kbs, m_e, m_w) = stagger(false);
    (kbs[0].dirs, kbs[1].dirs) = (dirs(&[77.0]), dirs(&[257.0]));
    let l = learned();
    for order in [[m_e.clone(), m_w.clone()], [m_w.clone(), m_e.clone()]] {
        assert_eq!(
            pairing(&merge_stops(&kbs, &order, Some(&l))),
            pairs(&[("E", &["mE"]), ("W", &["mW"])])
        );
    }
    let p1 = pairing(&merge(&kbs, &[m_e.clone(), m_w.clone()]));
    assert_eq!(p1, pairs(&[("E", &["mW"]), ("W", &["mE"])]));
    assert_eq!(pairing(&merge(&kbs, &[m_w, m_e])), p1);
}

#[test]
fn learned_bearings_never_reach_the_wire() {
    let (mut kbs, m_e, m_w) = stagger(false);
    (kbs[0].dirs, kbs[1].dirs) = (dirs(&[77.0]), dirs(&[257.0]));
    let mut l = learned();
    l.insert("lone".into(), vec![JsNum(10.0)]);
    let out = merge_stops(&kbs, &[m_e, m_w, mzk("lone", "Alone", L0 + d_lat(900.0), O0)], Some(&l));
    for s in &out {
        match s.operator {
            Some(Operator::BOTH) => {
                let want = if s.kb_id.as_deref() == Some("E") { 77.0 } else { 257.0 };
                assert_eq!(s.dirs, dirs(&[want]));
            }
            Some(Operator::MZK) => assert_eq!(s.dirs, None),
            _ => {}
        }
    }
}

#[derive(Deserialize)]
struct Fixture {
    kb: Vec<WireStop>,
    mzk: Vec<WireStop>,
}

fn captured() -> (Vec<WireStop>, Vec<WireStop>) {
    let fx: Fixture = serde_json::from_str(include_str!("../../test/fixtures/stop-merge-live.json")).unwrap();
    let kb = fx
        .kb
        .into_iter()
        .map(|s| WireStop {
            operator: Some(Operator::KB),
            ..s
        })
        .collect();
    let mzk = fx
        .mzk
        .into_iter()
        .map(|s| WireStop {
            operator: Some(Operator::MZK),
            ..s
        })
        .collect();
    (kb, mzk)
}

fn captured_want() -> BTreeMap<String, Vec<String>> {
    pairs(&[
        ("10091", &["36"]),
        ("10092", &["35"]),
        ("10431", &["57"]),
        ("10432", &["66"]),
        ("21601", &["2045"]),
        ("21602", &["2044"]),
        ("11072", &["113"]),
        ("10342", &["63"]),
        ("10881", &["220"]),
        ("10302", &["265"]),
        ("10021", &["2"]),
        ("29021", &["2374"]),
        ("29022", &["2376"]),
        ("10291", &["64"]),
    ])
}

#[test]
fn captured_data_pairs_the_same_direction_everywhere() {
    let (kb, mzk) = captured();
    let out = merge(&kb, &mzk);
    assert_eq!(pairing(&out), captured_want());
    assert_eq!(by_id(&out, "mzk:441").unwrap().operator, Some(Operator::MZK)); // Lotnisko 137 m away: another place
}

#[test]
fn captured_data_through_learned_bearings() {
    let (kb, mzk) = captured();
    let learned: HashMap<String, Vec<JsNum>> = mzk
        .iter()
        .filter_map(|m| Some((m.symbol.clone()?, m.dirs.clone().filter(|d| !d.is_empty())?)))
        .collect();
    let bare: Vec<WireStop> = mzk.into_iter().map(|m| WireStop { dirs: None, ..m }).collect();
    assert_eq!(pairing(&merge_stops(&kb, &bare, Some(&learned))), captured_want());
}

#[test]
fn captured_data_is_order_independent() {
    let (kb, mzk) = captured();
    let base = pairing(&merge(&kb, &mzk));
    let rev = |v: &[WireStop]| v.iter().rev().cloned().collect::<Vec<_>>();
    assert_eq!(pairing(&merge(&rev(&kb), &rev(&mzk))), base);
    for n in (1..mzk.len()).step_by(5) {
        let (mut k, mut m) = (kb.clone(), mzk.clone());
        k.rotate_left(n % kb.len());
        m.rotate_left(n);
        assert_eq!(pairing(&merge(&k, &m)), base, "rotation {n}");
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    kb: Vec<WireStop>,
    mzk: Vec<WireStop>,
    mzk_dirs: Option<HashMap<String, Vec<JsNum>>>,
    result: Value,
}

#[derive(Deserialize)]
struct Vectors {
    clean: Vec<(String, String)>,
    cases: Vec<Case>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("vectors/stop_merge.json")).unwrap()
}

#[test]
fn golden_clean_stop_name() {
    for (name, want) in vectors().clean {
        assert_eq!(clean_stop_name(&name), want, "{name:?}");
    }
}

/// The whole list: order, every field and its presence. Keys compare as a map (the wire order is the struct's).
#[test]
fn golden_merge_stops() {
    for (i, c) in vectors().cases.iter().enumerate() {
        let got = serde_json::to_value(merge_stops(&c.kb, &c.mzk, c.mzk_dirs.as_ref())).unwrap();
        assert!(got == c.result, "case {i}\n got: {got}\nwant: {}", c.result);
    }
}
