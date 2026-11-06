//! shared::departures against lib/shared/departures.ts: preSortRows on 100 random boards and hhmm across both DST
//! switches (vectors from scripts/dump-vectors.ts), plus the "same printed minute" case of test/departures.test.ts.

use serde::Deserialize;
use unimaps::shared::departures::{BoardRow, TimingRow, gzm_row_key, hhmm, pre_sort_rows};

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
            line: r.line_name.as_deref(),
            row_key: &r.row_key,
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
