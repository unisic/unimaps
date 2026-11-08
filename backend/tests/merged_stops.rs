//! test/merged-stops.test.ts

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use unimaps::js::JsNum;
use unimaps::merged_stops::{
    MergedInput, MergedStopsCache, MergedSummary, format_kb_stops, format_mzk_stops, snap_dirs,
};
use unimaps::mzk_stop_dirs::{MzkStopDirs, StopCoord, cluster_bearings};
use unimaps::stop_merge::Operator;
use unimaps::types::Stop;

fn kb_stop(internal_id: i64, url_id: &str, name: &str, lat: f64, lon: f64) -> Stop {
    Stop {
        url_id: url_id.into(),
        internal_id,
        name: name.into(),
        lat,
        lon,
        stop_id: internal_id.to_string(),
        ..Default::default()
    }
}

fn mzk_stop(symbol: &str, name: &str, lat: f64, lon: f64) -> Stop {
    Stop {
        url_id: format!("mzk:{symbol}"),
        internal_id: symbol.parse::<i64>().unwrap_or(0) + 1000,
        name: name.into(),
        lat,
        lon,
        stop_id: format!("mzk:{symbol}"),
        operator: Some(Operator::MZK),
        symbol: Some(symbol.into()),
        ..Default::default()
    }
}

/// node's deepStrictEqual compares numbers with SameValue, so 0 and -0 differ
fn assert_same(got: &[f64], want: &[f64]) {
    assert_eq!(got, want);
    assert!(
        got.iter().zip(want).all(|(g, w)| g.to_bits() == w.to_bits()),
        "{got:?} vs {want:?} (sign of zero)"
    );
}

fn nums(v: Option<&Vec<JsNum>>) -> Vec<f64> {
    v.map(|v| v.iter().map(|n| n.0).collect()).unwrap_or_default()
}

// formatKbStops / formatMzkStops (shared by every route)

#[test]
fn stations_name_or_show_platforms_never_get_direction_arrows_the_upstream_is_station_flag_is_not_used() {
    let dirs: HashMap<String, Vec<f64>> = [("10000", 1.0), ("28301", 2.0), ("10302", 218.0)]
        .into_iter()
        .map(|(k, b)| (k.to_string(), vec![b]))
        .collect();
    let out = format_kb_stops(
        &[
            Stop {
                is_station: true,
                show_platforms: true,
                ..kb_stop(10000, "1", "BIELSKO-BIAŁA D.A.", 49.83, 19.04)
            },
            // loop/terminus flag, not a station
            Stop {
                is_station: true,
                ..kb_stop(28301, "2", "BUKOWIEC NA POTOKU", 49.7, 19.0)
            },
            kb_stop(10302, "3", "BIELSKO-BIAŁA PIASTOWSKA LUBERTOWICZA", 49.827, 19.036),
        ],
        &dirs,
    );
    assert_eq!(out[0].is_station, Some(true));
    assert_eq!(out[0].dirs, None);
    assert_eq!(out[1].is_station, None);
    assert_same(&nums(out[1].dirs.as_ref()), &[2.0]);
    assert_same(&nums(out[2].dirs.as_ref()), &[218.0]);
}

#[test]
fn a_kb_name_ending_in_nz_is_a_request_stop_kb_has_no_flag_nz_inside_a_word_is_not() {
    let out = format_kb_stops(
        &[
            kb_stop(1, "1", "KĘTY PODLESIE NŻ", 49.88, 19.22),
            kb_stop(2, "2", "KĘTY NŻARY", 49.88, 19.22),
        ],
        &HashMap::new(),
    );
    assert_eq!(out[0].on_request, Some(true));
    assert_eq!(out[1].on_request, None);
}

#[test]
fn mzk_stops_carry_symbol_flags_and_learned_dirs_a_station_none() {
    let out = format_mzk_stops(
        &[
            Stop {
                on_request: Some(true),
                ..mzk_stop("265", "Piastowska Lubertowicza", 49.827, 19.036)
            },
            mzk_stop("266", "Piastowska", 49.828, 19.037),
            Stop {
                is_station: true,
                ..mzk_stop("343", "Dworzec", 49.83, 19.04)
            },
        ],
        &HashMap::from([
            ("265".to_string(), vec![JsNum(218.0)]),
            ("343".to_string(), vec![JsNum(90.0)]),
        ]),
    );
    let m = &out[0];
    assert_eq!(m.symbol.as_deref(), Some("265"));
    assert_eq!(m.on_request, Some(true));
    assert_eq!(m.dirs, Some(vec![JsNum(218.0)]));
    assert_eq!(out[1].dirs, None);
    assert_eq!(out[2].dirs, None);
}

// createMergedStopsCache

struct Base {
    kb: Arc<Vec<Stop>>,
    mzk: Arc<Vec<Stop>>,
    no_dirs: Arc<HashMap<String, Vec<f64>>>,
    no_mzk_dirs: Arc<HashMap<String, Vec<JsNum>>>,
    no_road: Arc<Vec<[f64; 3]>>,
}

impl Base {
    fn new() -> Self {
        Base {
            kb: Arc::new(vec![kb_stop(
                10302,
                "19146:39714",
                "BIELSKO-BIAŁA PIASTOWSKA LUBERTOWICZA",
                49.827047,
                19.036152,
            )]),
            mzk: Arc::new(vec![mzk_stop("265", "Piastowska Lubertowicza", 49.827047, 19.036152)]),
            no_dirs: Arc::new(HashMap::new()),
            no_mzk_dirs: Arc::new(HashMap::new()),
            no_road: Arc::new(Vec::new()),
        }
    }

    fn input(&self) -> MergedInput {
        MergedInput {
            kb: self.kb.clone(),
            mzk: self.mzk.clone(),
            kb_dirs: self.no_dirs.clone(),
            mzk_dirs: self.no_mzk_dirs.clone(),
            road: self.no_road.clone(),
        }
    }
}

fn mzk_dirs_265() -> Arc<HashMap<String, Vec<JsNum>>> {
    Arc::new(HashMap::from([("265".to_string(), vec![JsNum(218.0)])]))
}

fn body_json(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or(Value::Null)
}

#[test]
fn is_memoized_on_input_identity_and_re_merges_when_the_mzk_list_arrives_late_the_stale_registry_bug() {
    let b = Base::new();
    let get = MergedStopsCache::new();
    // MZK upstream was down at start: the poller's `stops` is an empty array
    let none: Arc<Vec<Stop>> = Arc::new(Vec::new());
    let early = get.get(&MergedInput {
        mzk: none.clone(),
        ..b.input()
    });
    assert!(early.partial);
    // the client re-fetches a partial list soon
    assert_eq!(body_json(&early.body)["partial"], json!(true));
    assert_eq!(early.lookup("19146:39714").and_then(|s| s.operator), Some(Operator::KB));
    // unchanged inputs -> same view object
    assert!(Arc::ptr_eq(
        &get.get(&MergedInput {
            mzk: none.clone(),
            ..b.input()
        }),
        &early
    ));
    // MZK stops loaded (new array identity)
    let late = get.get(&b.input());
    assert!(!late.partial);
    assert!(
        body_json(&late.body)
            .as_object()
            .is_some_and(|o| !o.contains_key("partial"))
    );
    assert_eq!(
        late.lookup("19146:39714").and_then(|s| s.operator),
        Some(Operator::BOTH)
    );
    assert_eq!(late.lookup("mzk:265").map(|s| s.id.as_str()), Some("10302"));
    assert_eq!(late.lookup("265").map(|s| s.id.as_str()), Some("10302"));
    assert_ne!(late.etag, early.etag);
}

#[test]
fn returns_the_identical_view_while_nothing_changed_a_new_one_when_a_learned_direction_changed() {
    let b = Base::new();
    let get = MergedStopsCache::new();
    let a = get.get(&b.input());
    assert!(Arc::ptr_eq(&get.get(&b.input()), &a));
    let changed = get.get(&MergedInput {
        mzk_dirs: mzk_dirs_265(),
        ..b.input()
    });
    assert!(!Arc::ptr_eq(&changed, &a));
}

#[test]
fn summary_counts_the_merge_and_its_inputs_for_api_health() {
    let b = Base::new();
    let v = MergedStopsCache::new()
        .with_now(Arc::new(|| 1_790_000_000_000))
        .get(&MergedInput {
            mzk_dirs: mzk_dirs_265(),
            ..b.input()
        });
    assert_eq!(
        v.summary,
        MergedSummary {
            both: 1,
            kb: 0,
            mzk: 0,
            kb_stops: 1,
            mzk_stops: 1,
            mzk_dir_stops: 1,
            built_at: 1_790_000_000,
        }
    );
    assert!(!v.partial);
}

#[test]
fn etag_is_a_stable_content_hash() {
    let b = Base::new();
    let e1 = MergedStopsCache::new().get(&b.input()).etag.clone();
    let e2 = MergedStopsCache::new().get(&b.input()).etag.clone();
    assert_eq!(e1, e2);
    // /^"[A-Za-z0-9_-]{22}"$/
    let inner = e1.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or("");
    assert!(
        inner.len() == 22 && inner.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
        "{e1}"
    );
}

// MzkStopDirs (direction learned from the stop order of running courses)

fn p(lat: f64, lon: f64, symbol: &str) -> (&str, Option<StopCoord>) {
    (symbol, Some(StopCoord { lat, lon }))
}

fn coords(entries: &[(&'static str, f64, f64)]) -> HashMap<&'static str, StopCoord> {
    entries
        .iter()
        .map(|&(s, lat, lon)| (s, StopCoord { lat, lon }))
        .collect()
}

#[test]
fn credits_the_prev_next_tangent_to_each_stop_once_per_variant() {
    let mut d = MzkStopDirs::default();
    // three stops heading due north
    let stops = [p(49.80, 19.0, "A"), p(49.81, 19.0, "B"), p(49.82, 19.0, "C")];
    assert!(d.learn(11.0, &stops));
    // same variant again: ignored
    assert!(!d.learn(11.0, &stops));
    let m = d.dirs();
    assert_same(&nums(m.get("B")), &[0.0]);
    // first stop: outgoing
    assert_same(&nums(m.get("A")), &[0.0]);
    // last stop: incoming
    assert_same(&nums(m.get("C")), &[0.0]);
    assert_eq!(d.variants(), 1);
}

#[test]
fn dirs_keeps_its_identity_until_a_bearing_actually_changes_consumers_memoize_on_it() {
    let mut d = MzkStopDirs::default();
    let north = [p(49.80, 19.0, "A"), p(49.81, 19.0, "B")];
    d.learn(1.0, &north);
    let first = d.dirs();
    assert!(Arc::ptr_eq(&d.dirs(), &first));
    // a second variant with the same bearings: nothing changes
    d.learn(2.0, &north);
    assert!(Arc::ptr_eq(&d.dirs(), &first));
    // a new stop appears
    d.learn(3.0, &[p(49.80, 19.0, "A"), p(49.80, 19.01, "Z")]);
    assert!(!Arc::ptr_eq(&d.dirs(), &first));
    assert_same(&nums(d.dirs().get("Z")), &[90.0]);
}

#[test]
fn reconcile_drops_everything_learned_when_a_stop_moved_or_vanished_keeps_it_otherwise() {
    let mut d = MzkStopDirs::default();
    d.learn(1.0, &[p(49.80, 19.0, "A"), p(49.81, 19.0, "B"), p(49.82, 19.0, "C")]);
    let same = coords(&[("A", 49.80, 19.0), ("B", 49.81, 19.0), ("C", 49.82, 19.0)]);
    let with_b = |lat: f64, lon: f64| {
        let mut m = same.clone();
        m.insert("B", StopCoord { lat, lon });
        m
    };
    assert!(!d.reconcile(|s| same.get(s).copied()));
    // 2 m: noise
    let noise = with_b(49.81, 19.00003);
    assert!(!d.reconcile(|s| noise.get(s).copied()));
    // 55 m: re-surveyed
    let moved = with_b(49.8105, 19.0);
    assert!(d.reconcile(|s| moved.get(s).copied()));
    assert_eq!(d.size(), 0);
    // variant ids are relearned too
    assert!(d.learn(1.0, &[p(49.80, 19.0, "A"), p(49.81, 19.0, "B")]));
    d.reconcile(|s| same.get(s).copied());
    // B vanished
    let only_a = coords(&[("A", 49.80, 19.0)]);
    assert!(d.reconcile(|s| only_a.get(s).copied()));
}

#[test]
fn keeps_two_opposite_bearings_for_a_stop_served_both_ways_unknown_stops_are_skipped() {
    let mut d = MzkStopDirs::default();
    let north = [p(49.80, 19.0, "A"), p(49.81, 19.0, "X"), p(49.82, 19.0, "C")];
    let south = [p(49.82, 19.0, "C"), p(49.81, 19.0, "X"), p(49.80, 19.0, "A")];
    for i in 0..3 {
        d.learn(f64::from(100 + i), &north);
        d.learn(f64::from(200 + i), &south);
    }
    d.learn(300.0, &[("00", None), p(49.80, 19.0, "A"), p(49.81, 19.0, "X")]);
    let mut x = nums(d.dirs().get("X"));
    x.sort_by(f64::total_cmp);
    assert_same(&x, &[0.0, 180.0]);
    assert!(!d.dirs().contains_key("00"));
}

#[test]
fn snapshot_restore_round_trips_and_ignores_garbage() {
    let mut d = MzkStopDirs::default();
    d.learn(5.0, &[p(49.80, 19.0, "A"), p(49.81, 19.0, "B")]);
    let snap: Value = serde_json::to_string(&d.snapshot())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    assert_eq!(snap["v"].as_f64(), Some(2.0));
    // positions the bearings were derived from
    let at_a: Vec<f64> = snap["at"]["A"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    assert_same(&at_a, &[49.80, 19.0]);
    let mut r = MzkStopDirs::restore(&snap);
    assert_eq!(r.dirs().get("A"), d.dirs().get("A"));
    let cur = coords(&[("A", 49.80, 19.0), ("B", 49.81, 19.0)]);
    assert!(!r.reconcile(|s| cur.get(s).copied()));
    // variant remembered
    assert!(!r.learn(5.0, &[p(49.80, 19.0, "A"), p(49.81, 19.0, "B")]));
    assert_eq!(MzkStopDirs::restore(&json!({ "nonsense": true })).size(), 0);
    assert_eq!(MzkStopDirs::restore(&Value::Null).size(), 0);
}

#[test]
fn cluster_bearings_merges_nearby_bearings_and_keeps_an_opposite_cluster_only_with_support() {
    assert_same(&cluster_bearings(&[10.0, 20.0, 350.0]), &[7.0]);
    let mut two = cluster_bearings(&[90.0, 92.0, 88.0, 270.0, 268.0]);
    two.sort_by(f64::total_cmp);
    assert_same(&two, &[90.0, 269.0]);
    // single stray sample is noise
    assert_same(&cluster_bearings(&[90.0, 92.0, 88.0, 91.0, 89.0, 90.0, 270.0]), &[90.0]);
}

#[test]
fn an_arrow_turns_to_the_nearest_road_bearing_within_30_m_and_60_degrees() {
    let (lat, lon) = (49.827, 19.036);
    let m = 1.0 / 111_000.0;
    let road = [
        [lat - 25.0 * m, lon, 172.4], // the stop's own road, 25 m away
        [lat + 10.0 * m, lon, 268.0], // a crossing street, nearer but 85 deg off
        [lat + 12.0 * m, lon, 352.0], // the opposite carriageway, for the other arrow
        [lat + 40.0 * m, lon, 150.0], // beyond 30 m
    ];
    let snap = |d: &[f64]| -> Vec<f64> {
        let d: Vec<JsNum> = d.iter().map(|&x| JsNum(x)).collect();
        snap_dirs(lat, lon, &d, &road).iter().map(|x| x.0).collect()
    };
    assert_eq!(snap(&[150.0, 330.0]), [172.0, 352.0]);
    // nothing within 60 deg: unchanged
    assert_eq!(snap(&[60.0]), [60.0]);
    // two arrows landing on one bearing: one arrow
    assert_eq!(snap(&[150.0, 200.0]), [172.0]);
    assert_eq!(snap_dirs(lat, lon, &[JsNum(150.0)], &[]), [JsNum(150.0)]);
}
