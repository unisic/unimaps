//! shared::departures and shared::alerts against lib/shared/departures.ts and lib/shared/alerts.ts: preSortRows on
//! 100 random boards, hhmm across both DST switches, the KB/MZK row normalisers and the alert rule (vectors from
//! scripts/dump-vectors.ts), plus the "same printed minute" case of test/departures.test.ts.

use serde::Deserialize;
use serde_json::Value;
use unimaps::shared::alerts::{Alert, AlertAction, alert_action, alert_message};
use unimaps::shared::departures::{
    BoardRow, TimingRow, enrich_kb_row, gzm_row_key, hhmm, kb_anchor_ts, mzk_wire_fields, parse_clock_near,
    parse_rel_minutes, pre_sort_rows,
};

#[derive(Deserialize)]
struct Row {
    line_name: Option<String>,
    plan_ts: Option<f64>,
    eta_ts: Option<f64>,
    at_stop: bool,
    canceled: bool,
    not_started: bool,
    row_key: String,
}

struct Indexed(usize, Row);

impl BoardRow for Indexed {
    fn timing_row(&self) -> TimingRow<'_> {
        let r = &self.1;
        TimingRow {
            line: r.line_name.as_deref().unwrap_or("").into(),
            row_key: r.row_key.as_str().into(),
            plan_ts: r.plan_ts,
            eta_ts: r.eta_ts,
            at_stop: r.at_stop,
            canceled: r.canceled,
            not_started: r.not_started,
        }
    }
}

#[derive(Deserialize)]
struct Board {
    rows: Vec<Row>,
    order: Vec<usize>,
}

#[derive(Deserialize)]
struct Vectors {
    now: f64,
    boards: Vec<Board>,
    hhmm: Vec<(f64, String)>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("vectors/departures.json")).unwrap()
}

#[test]
fn pre_sort_rows_orders_boards_like_node() {
    let v = vectors();
    for (n, b) in v.boards.into_iter().enumerate() {
        let sorted = pre_sort_rows(
            b.rows.into_iter().enumerate().map(|(i, r)| Indexed(i, r)).collect(),
            v.now,
        );
        assert_eq!(sorted.iter().map(|r| r.0).collect::<Vec<_>>(), b.order, "board {n}");
    }
}

#[test]
fn hhmm_prints_the_warsaw_wall_clock_like_node() {
    for (t, want) in vectors().hhmm {
        assert_eq!(hhmm(t), want, "{t}");
    }
}

#[test]
fn same_printed_minute_orders_by_line_number_then_plan_then_key() {
    const NOW: f64 = 1_791_000_000.0;
    let mk = |line: &str, secs: f64, key: &str, plan_min: f64| Row {
        line_name: Some(line.into()),
        plan_ts: Some(NOW + plan_min * 60.0),
        eta_ts: Some(NOW + secs),
        at_stop: false,
        canceled: false,
        not_started: false,
        row_key: key.into(),
    };
    let keys = |rows: Vec<Row>| -> Vec<String> {
        let sorted = pre_sort_rows(rows.into_iter().map(|r| Indexed(0, r)).collect(), NOW);
        sorted.into_iter().map(|r| r.1.row_key).collect()
    };
    // 301 s and 329 s both print "5 min"; 17 < 119 numerically although "119" < "17" as text
    assert_eq!(
        keys(vec![mk("119", 301.0, "a", 5.0), mk("17", 329.0, "b", 5.0)]),
        ["b", "a"]
    );
    assert_eq!(
        keys(vec![mk("119", 329.0, "a", 5.0), mk("17", 301.0, "b", 5.0)]),
        ["b", "a"]
    );
    assert_eq!(
        keys(vec![mk("17", 310.0, "c", 6.0), mk("17", 310.0, "d", 4.0)]),
        ["d", "c"]
    );
    assert_eq!(
        keys(vec![mk("17", 310.0, "f", 5.0), mk("17", 310.0, "e", 5.0)]),
        ["e", "f"]
    );
}

#[test]
fn gzm_row_key_is_the_raw_trip_id_and_stop_sequence() {
    assert_eq!(gzm_row_key("12_345", 7), "gzm:12_345#7");
}

#[test]
fn pre_sort_rows_orders_json_rows_like_node() {
    let v: Value = serde_json::from_str(include_str!("vectors/departures.json")).unwrap();
    let now = v["now"].as_f64().unwrap();
    for (n, b) in v["boards"].as_array().unwrap().iter().enumerate() {
        let rows: Vec<(usize, Value)> = b["rows"].as_array().unwrap().iter().cloned().enumerate().collect();
        struct R((usize, Value));
        impl BoardRow for R {
            fn timing_row(&self) -> TimingRow<'_> {
                self.0.1.timing_row()
            }
        }
        let sorted = pre_sort_rows(rows.into_iter().map(R).collect(), now);
        let order: Vec<Value> = sorted.iter().map(|r| r.0.0.into()).collect();
        assert_eq!(&Value::from(order), &b["order"], "board {n}");
    }
}

fn board_rows() -> Value {
    serde_json::from_str(include_str!("vectors/board_rows.json")).unwrap()
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().unwrap()
}

/// Key order is part of the contract (the TS spread), so compare the serialized text, not the maps.
fn same_json(a: &impl serde::Serialize, b: &Value) -> bool {
    serde_json::to_string(a).unwrap() == serde_json::to_string(b).unwrap()
}

#[test]
fn golden_parse_rel_minutes_and_clock_near() {
    let v = board_rows();
    for c in arr(&v["rel"]) {
        assert_eq!(parse_rel_minutes(Some(&c[0])), c[1].as_f64(), "{}", c[0]);
    }
    assert!(arr(&v["clock"]).len() > 400);
    for c in arr(&v["clock"]) {
        let got = parse_clock_near(Some(&c[0]), c[1].as_f64().unwrap());
        assert_eq!(got, c[2].as_f64(), "{} at {}", c[0], c[1]);
    }
    assert_eq!(parse_rel_minutes(None), None);
    assert_eq!(parse_clock_near(None, 0.0), None);
}

#[test]
fn golden_enrich_kb_row() {
    let v = board_rows();
    for (n, c) in arr(&v["kb"]).iter().enumerate() {
        let out = enrich_kb_row(
            c["row"].as_object().unwrap(),
            c.get("directions"),
            c["anchor"].as_f64().unwrap(),
        );
        assert!(same_json(&out, &c["out"]), "row {n}: {}", Value::from(out));
    }
    for c in arr(&v["anchor"]) {
        let b = Some(&c[0]).filter(|b| !b.is_null());
        assert_eq!(kb_anchor_ts(b, c[1].as_f64().unwrap()), c[2].as_f64().unwrap(), "{c}");
    }
}

#[test]
fn golden_mzk_wire_fields() {
    for (n, c) in arr(&board_rows()["mzk"]).iter().enumerate() {
        let out = mzk_wire_fields(&c["d"]);
        assert!(same_json(&out, &c["out"]), "row {n}: {}", Value::from(out));
    }
}

#[test]
fn golden_row_key_fallback() {
    for c in arr(&board_rows()["keys"]) {
        assert_eq!(c[0].timing_row().row_key, c[1].as_str().unwrap(), "{c}");
    }
}

#[test]
fn golden_alert_action_and_message() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("vectors/alerts.json")).unwrap();
    assert!(cases.len() >= 200);
    for (n, c) in cases.iter().enumerate() {
        let a: Alert = serde_json::from_value(c["alert"].clone()).unwrap();
        let act = alert_action(&a, arr(&c["rows"]), c["now"].as_f64().unwrap());
        let want = &c["action"];
        let got = match act {
            AlertAction::Wait => serde_json::json!({ "act": "wait" }),
            AlertAction::Cancelled => serde_json::json!({ "act": "cancelled" }),
            AlertAction::Expired => serde_json::json!({ "act": "expired" }),
            AlertAction::Fire { mins } => serde_json::json!({ "act": "fire", "mins": mins }),
        };
        assert_eq!(got["act"], want["act"], "case {n}");
        assert_eq!(got["mins"].as_f64(), want["mins"].as_f64(), "case {n}");
        assert!(same_json(&alert_message(&a, act), &c["message"]), "case {n}");
    }
}
