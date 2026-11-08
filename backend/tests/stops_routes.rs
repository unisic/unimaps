//! The route-level cases of test/stops-routes.test.ts: status codes, cache headers, ETag / 304, `warnings`, the
//! 502 of a board whose every leg failed, timetable cacheability and the health stop-list counters, driven through
//! the real handlers over a `Bb` of fakes (support/stops_fake.rs). The cases that read nothing but the board are in
//! tests/stop_board.rs.

#[allow(dead_code)]
#[path = "support/stops_fake.rs"]
mod rig;

use http_body_util::BodyExt;
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Response, StatusCode};
use rig::{Fake, Fakes, kb_row, mzk_dep, mzk_stops, set_mzk_stops, sorted, stop, stops_bb};
use serde_json::{Value, json};
use unimaps::api::{ApiRequest, health, stop_departures, stop_timetable, stops};
use unimaps::departures_board_cache::DEPARTURES_BOARD_CACHE;
use unimaps::http::Body;
use unimaps::poller_singleton::Bb;

/// `beforeEach` with the singleton leaked for the handlers' `&'static`.
async fn setup() -> (Fake, &'static Bb<Fakes>, tokio::sync::MutexGuard<'static, ()>) {
    let (fake, bb, guard) = stops_bb().await;
    (fake, Box::leak(Box::new(bb)), guard)
}

fn if_none_match(etag: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("if-none-match", HeaderValue::from_str(etag).expect("header value"));
    h
}

fn header(res: &Response<Body>, name: &str) -> Option<String> {
    res.headers()
        .get(name)
        .map(|v| v.to_str().expect("ascii header").to_owned())
}

async fn json_of(res: Response<Body>) -> Value {
    let bytes = res.into_body().collect().await.expect("body").to_bytes();
    serde_json::from_slice(&bytes).expect("json body")
}

async fn get_stops(bb: &'static Bb<Fakes>, headers: HeaderMap) -> Response<Body> {
    stops::get_bb(
        &ApiRequest {
            headers,
            ..Default::default()
        },
        bb,
    )
    .await
}

async fn get_departures(bb: &'static Bb<Fakes>, designator: &str) -> Response<Body> {
    stop_departures::get_bb(
        &ApiRequest {
            param: designator.to_owned(),
            ..Default::default()
        },
        bb,
    )
    .await
}

/// the TS `timetable()` helper: the answer's cache-control and its body
async fn timetable(bb: &'static Bb<Fakes>, designator: &str) -> (Option<String>, Value) {
    let res = stop_timetable::get_bb(
        &ApiRequest {
            param: designator.to_owned(),
            query: "?date=2026-10-02".to_owned(),
            ..Default::default()
        },
        bb,
    )
    .await;
    (header(&res, "cache-control"), json_of(res).await)
}

fn operator_of(body: &Value, id: &str) -> Option<String> {
    body["stops"]
        .as_array()?
        .iter()
        .find(|s| s["id"] == id)
        .and_then(|s| s["operator"].as_str())
        .map(str::to_owned)
}

fn field(rows: &Value, key: &str) -> Vec<String> {
    rows.as_array()
        .map(|a| {
            a.iter()
                .map(|r| r[key].as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_str().unwrap_or_default().to_owned()).collect())
        .unwrap_or_default()
}

// --- GET /api/stops ---

#[tokio::test]
async fn serves_the_merged_list_with_an_etag_answers_if_none_match_with_304() {
    let (_fake, bb, _serial) = setup().await;
    let res = get_stops(bb, HeaderMap::new()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(header(&res, "cache-control").as_deref(), Some("public, max-age=60"));
    let etag = header(&res, "etag").expect("etag");
    let body = json_of(res).await;
    assert_eq!(operator_of(&body, "10302").as_deref(), Some("BOTH"));
    let again = get_stops(bb, if_none_match(&etag)).await;
    assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
    stop(bb).await;
}

#[tokio::test]
async fn a_list_still_missing_the_mzk_stops_is_flagged_partial_revalidated_every_time_and_heals_when_they_arrive() {
    let (_fake, bb, _serial) = setup().await;
    set_mzk_stops(bb, Vec::new());
    let early = get_stops(bb, HeaderMap::new()).await;
    // stored, but never reused without asking the server
    assert_eq!(header(&early, "cache-control").as_deref(), Some("no-cache"));
    let early_etag = header(&early, "etag").expect("etag");
    let e = json_of(early).await;
    assert_eq!(e.get("partial"), Some(&json!(true)));
    assert_eq!(operator_of(&e, "10302").as_deref(), Some("KB"));
    let again = get_stops(bb, if_none_match(&early_etag)).await;
    // polling a partial list every 20 s costs a 304, not 300 KB
    assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
    // MZK getStops finally loaded (the poller swaps in a new array)
    set_mzk_stops(bb, mzk_stops());
    let late = get_stops(bb, if_none_match(&early_etag)).await;
    assert_eq!(late.status(), StatusCode::OK);
    assert_eq!(header(&late, "cache-control").as_deref(), Some("public, max-age=60"));
    let late_etag = header(&late, "etag");
    let l = json_of(late).await;
    assert_eq!(l.get("partial"), None);
    assert_eq!(operator_of(&l, "10302").as_deref(), Some("BOTH"));
    assert_ne!(Some(early_etag), late_etag);
    stop(bb).await;
}

// --- GET /api/stop/[designator]/departures ---

#[tokio::test]
async fn hub_kb_down_one_of_two_mzk_symbols_down_still_serves_the_other_symbol_s_rows_not_a_502() {
    let (fake, bb, _serial) = setup().await;
    fake.with(|s| {
        s.kb_fail = true;
        s.mzk_fail_syms = vec!["2367".into()];
        s.mzk_rows
            .insert("2366".into(), vec![mzk_dep(11, "50", 54060), mzk_dep(12, "50", 54120)]);
    });
    let res = get_departures(bb, "19185").await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = json_of(res).await;
    assert_eq!(body["rows"].as_array().map(Vec::len), Some(2));
    assert_eq!(sorted(strings(&body["warnings"])), ["kb", "mzk"]);
    fake.with(|s| s.mzk_fail_syms = vec!["2366".into(), "2367".into()]);
    DEPARTURES_BOARD_CACHE.clear();
    let all = get_departures(bb, "19185").await;
    // every leg failed
    assert_eq!(all.status(), StatusCode::BAD_GATEWAY);
    stop(bb).await;
}

#[tokio::test]
async fn a_failed_mzk_fetch_is_reported_as_a_warning_instead_of_looking_like_no_mzk_departures() {
    let (fake, bb, _serial) = setup().await;
    fake.with(|s| {
        s.mzk_fail = true;
        s.kb_rows.insert("19146:39714".into(), vec![kb_row()]);
    });
    let res = json_of(get_departures(bb, "19146:39714").await).await;
    assert_eq!(field(&res["rows"], "operator"), ["KB"]);
    assert_eq!(res["warnings"], json!(["mzk"]));
    fake.with(|s| s.mzk_fail = false);
    assert_eq!(
        json_of(get_departures(bb, "19146:39714").await).await.get("warnings"),
        None
    );
    stop(bb).await;
}

#[tokio::test]
async fn a_failed_kb_fetch_is_reported_too_the_both_panel_would_show_mzk_rows_only() {
    let (fake, bb, _serial) = setup().await;
    fake.with(|s| {
        s.kb_fail = true;
        s.mzk_rows.insert("265".into(), vec![mzk_dep(1, "6", 54000)]);
    });
    let res = json_of(get_departures(bb, "19146:39714").await).await;
    assert_eq!(field(&res["rows"], "operator"), ["MZK"]);
    assert_eq!(res["warnings"], json!(["kb"]));
    stop(bb).await;
}

// --- GET /api/stops conditional requests ---

#[tokio::test]
async fn answers_a_weakened_or_listed_validator_a_proxy_may_turn_our_strong_etag_into_w() {
    let (_fake, bb, _serial) = setup().await;
    let etag = header(&get_stops(bb, HeaderMap::new()).await, "etag").expect("etag");
    for h in [format!("W/{etag}"), format!("\"zzz\", {etag}"), "*".to_owned()] {
        let res = get_stops(bb, if_none_match(&h)).await;
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED, "{h}");
    }
    let other = get_stops(bb, if_none_match("\"nope\"")).await;
    assert_eq!(other.status(), StatusCode::OK);
    stop(bb).await;
}

// --- GET /api/stop/[designator]/timetable ---

fn pairs(body: &Value) -> Vec<(String, String)> {
    body["departures"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|d| {
                    let s = |k: &str| d[k].as_str().unwrap_or_default().to_owned();
                    (s("operator"), s("trip_id"))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn both_stop_both_operators_cacheable_for_15_min() {
    let (_fake, bb, _serial) = setup().await;
    let (cache, body) = timetable(bb, "19146:39714").await;
    // the route merges MZK first, then must sort by time: KB 15:00 before MZK 15:01
    assert_eq!(
        pairs(&body),
        [
            ("KB".to_owned(), "kbt1".to_owned()),
            ("MZK".to_owned(), "mzk:1:1".to_owned())
        ]
    );
    assert_eq!(body.get("warnings"), None);
    assert_eq!(cache.as_deref(), Some("public, max-age=900"));
    stop(bb).await;
}

#[tokio::test]
async fn a_failed_mzk_schedule_is_a_warning_and_is_not_cacheable_it_used_to_be_a_200_pinned_for_15_min_as_no_mzk_buses()
{
    let (fake, bb, _serial) = setup().await;
    fake.with(|s| s.sched_fail = true);
    let (cache, body) = timetable(bb, "19146:39714").await;
    assert_eq!(field(&body["departures"], "operator"), ["KB"]);
    assert_eq!(body.get("warnings"), Some(&json!(["mzk"])));
    assert_eq!(cache.as_deref(), Some("no-store"));
    stop(bb).await;
}

#[tokio::test]
async fn while_the_mzk_stop_list_is_still_missing_the_kb_only_answer_is_not_cacheable() {
    let (_fake, bb, _serial) = setup().await;
    set_mzk_stops(bb, Vec::new());
    let (cache, body) = timetable(bb, "19146:39714").await;
    assert_eq!(field(&body["departures"], "operator"), ["KB"]);
    assert_eq!(cache.as_deref(), Some("no-store"));
    stop(bb).await;
}

#[tokio::test]
async fn an_mzk_only_stop_that_fails_answers_the_same_way() {
    let (fake, bb, _serial) = setup().await;
    fake.with(|s| s.sched_fail = true);
    let (cache, body) = timetable(bb, "mzk:341").await;
    assert_eq!(body.get("departures"), Some(&json!([])));
    assert_eq!(body.get("warnings"), Some(&json!(["mzk"])));
    assert_eq!(cache.as_deref(), Some("no-store"));
    stop(bb).await;
}

// --- GET /api/health (stop-list counters) ---

#[tokio::test]
async fn reports_the_mzk_list_and_the_merge_informational_never_degrades() {
    let (_fake, bb, _serial) = setup().await;
    let res = health::get_owned(bb).await;
    assert_eq!(res.status(), StatusCode::OK);
    let h = json_of(res).await;
    assert_eq!(h["mzk_stops"].as_u64(), Some(mzk_stops().len() as u64));
    // Piastowska Lubertowicza + the Czechowice-Dz. D.A. hub (Bielsko D.A. is KB-only)
    assert_eq!(h["merged_stops"]["both"].as_u64(), Some(2));
    assert_eq!(h["merged_stops"]["partial"], json!(false));
    set_mzk_stops(bb, Vec::new());
    let early = json_of(health::get_owned(bb).await).await;
    assert_eq!(early["merged_stops"]["partial"], json!(true));
    assert_eq!(early["status"], json!("ok"));
    stop(bb).await;
}
