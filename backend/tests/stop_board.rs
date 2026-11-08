//! The cases of test/stops-routes.test.ts that read nothing but the board (`stop_board`): the departures route
//! answers `board.rows` as `rows` and `board.failed` as `warnings` (when non-empty). The stops-routes cases that
//! assert a status code, a header or `warnings` are in tests/stops_routes.rs, test/mzk-not-started-routes.test.ts is
//! tests/mzk_not_started_routes.rs. Every service is a fake (support/stops_fake.rs): the TS installs a started
//! singleton, here a `Bb` over fakes whose start loads the fixture data and touches no file.

#[allow(dead_code)]
#[path = "support/stops_fake.rs"]
mod rig;

use rig::{kb_row, mzk_dep, mzk_stops, set_mzk_stops, sorted, stop, stops_bb};
use serde_json::{Value, json};
use unimaps::departures_board_cache::Board;
use unimaps::stop_board::stop_board;

fn operators(b: &Board) -> Vec<String> {
    b.rows
        .iter()
        .map(|r| r.get("operator").and_then(Value::as_str).unwrap_or_default().to_owned())
        .collect()
}

// --- test/stops-routes.test.ts ---

#[tokio::test]
async fn both_stop_mzk_kb_rows_piastowska_lubertowicza() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows
            .insert("265".into(), vec![mzk_dep(1, "6", 54000), mzk_dep(2, "15", 54300)]);
        s.kb_rows.insert("19146:39714".into(), vec![kb_row()]);
    });
    let board = stop_board(&bb, "19146:39714").await;
    assert_eq!(sorted(operators(&board)), ["KB", "MZK", "MZK"]);
    assert_eq!(fake.with(|s| s.mzk_calls.clone()), ["265"]);
    stop(&bb).await;
}

#[tokio::test]
async fn regression_mzk_stops_that_load_after_the_first_departures_request_are_used_without_any_api_stops_call() {
    let (fake, bb, _serial) = stops_bb().await;
    set_mzk_stops(&bb, Vec::new()); // MZK upstream was down when the first request arrived
    fake.with(|s| {
        s.mzk_rows.insert("265".into(), vec![mzk_dep(1, "6", 54000)]);
        s.kb_rows.insert("19146:39714".into(), vec![kb_row()]);
    });
    let first = stop_board(&bb, "19146:39714").await;
    assert_eq!(operators(&first), ["KB"]);
    set_mzk_stops(&bb, mzk_stops()); // loaded in the background; nobody calls /api/stops
    let second = stop_board(&bb, "19146:39714").await;
    assert_eq!(sorted(operators(&second)), ["KB", "MZK"]);
    stop(&bb).await;
}

#[tokio::test]
async fn station_hub_fans_out_to_every_mzk_symbol_and_keeps_a_course_that_calls_at_two_of_them_only_once() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows
            .insert("2366".into(), vec![mzk_dep(11, "50", 54060), mzk_dep(12, "50", 54120)]);
        // course 12 calls at both
        s.mzk_rows
            .insert("2367".into(), vec![mzk_dep(12, "50", 54180), mzk_dep(13, "50", 54240)]);
    });
    let board = stop_board(&bb, "19185").await;
    assert_eq!(sorted(fake.with(|s| s.mzk_calls.clone())), ["2366", "2367"]);
    let mzk_rows: Vec<_> = board
        .rows
        .iter()
        .filter(|r| r.get("operator") == Some(&json!("MZK")))
        .collect();
    assert_eq!(mzk_rows.len(), 3);
    let ids: std::collections::HashSet<String> = mzk_rows
        .iter()
        .map(|r| r.get("trip_execution_id").map(Value::to_string).unwrap_or_default())
        .collect();
    assert_eq!(ids.len(), 3);
    stop(&bb).await;
}

#[tokio::test]
async fn a_hub_s_extra_mzk_symbol_has_no_stop_of_its_own_mzk_2367_opens_the_station_board() {
    let (fake, bb, _serial) = stops_bb().await;
    stop_board(&bb, "mzk:2367").await;
    assert_eq!(sorted(fake.with(|s| s.mzk_calls.clone())), ["2366", "2367"]);
    stop(&bb).await;
}

#[tokio::test]
async fn bielsko_biala_d_a_is_a_kb_station_its_board_never_asks_mzk() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows.insert("343".into(), vec![mzk_dep(10, "31", 54000)]);
        s.kb_rows.insert("184900".into(), vec![kb_row()]);
    });
    let board = stop_board(&bb, "184900").await;
    assert_eq!(fake.with(|s| s.mzk_calls.clone()), Vec::<String>::new());
    assert_eq!(operators(&board), ["KB"]);
    stop(&bb).await;
}

#[tokio::test]
async fn opening_the_mzk_only_entry_of_a_street_stop_at_d_a_queries_just_that_symbol() {
    let (fake, bb, _serial) = stops_bb().await;
    fake.with(|s| {
        s.mzk_rows.insert("341".into(), vec![mzk_dep(11, "8", 54060)]);
    });
    let board = stop_board(&bb, "mzk:341").await;
    assert_eq!(fake.with(|s| s.mzk_calls.clone()), ["341"]);
    assert_eq!(operators(&board), ["MZK"]);
    stop(&bb).await;
}
