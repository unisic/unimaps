//! test/api-helpers.test.ts, plus the Rust-only parsers pinned against Node: `URLSearchParams.get`, `parseCity`,
//! `etagMatches`.

use http_body_util::BodyExt;
use hyper::Response;
use hyper::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use unimaps::api_helpers::*;
use unimaps::http::Body;

#[test]
fn is_valid_id_accepts_real_designator_and_trip_id_shapes() {
    for v in ["19223", "19132:39688", "a.b_c-d", "A", &"x".repeat(64)] {
        assert!(is_valid_id(v), "{v}");
    }
}

#[test]
fn is_valid_id_rejects_empty_over_long_and_url_rewriting_values() {
    let long = "x".repeat(65);
    for v in [
        "", &long, "a/b", "../x", "a?b", "a#b", "a&b", "a%2fb", "a b", "a\nb", ".", "..", "ą",
    ] {
        assert!(!is_valid_id(v), "{v:?}");
    }
}

#[test]
fn is_valid_date_accepts_strict_real_days_only() {
    for v in ["2026-07-21", "1999-01-01", "2028-02-29", "0100-01-01", "9999-12-31"] {
        assert!(is_valid_date(v), "{v}");
    }
    for v in [
        "2026-7-21",
        "20260721",
        "2026-07-21T00",
        "2026-07-21 ",
        "",
        "2026-02-31",
        "2026-13-01",
        "2026-02-29",
        "2026-00-10",
        "0050-01-01",
        "2026-0७-21",
        "２026-07-21",
    ] {
        assert!(!is_valid_date(v), "{v:?}");
    }
}

#[test]
fn is_valid_shape_id_accepts_kb_mzk_and_zbiorkom_keys() {
    for v in [
        "kb:0123456789ab",
        "kb:0123456789ab.7b21c0",
        "mzk:13954",
        "mzk:13954.0c9e1f",
        "gzm:283_4285.ab12cd",
        "warsaw:L-1.x",
    ] {
        assert!(is_valid_shape_id(v), "{v}");
    }
    let long = format!("gzm:{}", "a".repeat(61));
    for v in [
        "kb:0123456789AB",
        "kb:0123",
        "mzk:abc",
        "kb:0123456789ab.7b21c",
        "kb:0123456789ab~7b21c0",
        "../etc",
        "",
        "gzm:",
        "gzm:a/b",
        "gzm:a:b",
        "bb:abc",
        &long,
    ] {
        assert!(!is_valid_shape_id(v), "{v:?}");
    }
}

#[test]
fn query_param_is_url_search_params_get() {
    for (q, want) in [
        ("city=gzm", Some("gzm")),
        ("?city=gzm", Some("gzm")),
        ("city=a+b", Some("a b")),
        ("city=%67zm", Some("gzm")),
        ("city=%zz", Some("%zz")),
        ("city=%e2%82", Some("\u{FFFD}")),
        ("c%69ty=x", Some("x")),
        ("&&city=1&city=2", Some("1")),
        ("city", Some("")),
        ("city==x", Some("=x")),
        ("x=1&city=%C5%82%C3%B3d%C5%BA", Some("łódź")),
        ("x=1", None),
        ("", None),
    ] {
        assert_eq!(query_param(q, "city").as_deref(), want, "{q}");
    }
}

#[test]
fn parse_city_absent_or_bb_is_bb_an_unknown_one_is_a_400() {
    assert_eq!(parse_city("").ok(), Some(City::Bb));
    assert_eq!(parse_city("?city=bb").ok(), Some(City::Bb));
    assert_eq!(parse_city("?city=gzm").ok(), Some(City::Zb("gzm")));
    assert_eq!(parse_city("?x=1&city=krakow").ok(), Some(City::Zb("krakow")));
    assert_eq!(
        parse_city("?city=atlantis").err().map(|r| r.status().as_u16()),
        Some(400)
    );
    assert_eq!(parse_city("?city=").err().map(|r| r.status().as_u16()), Some(400));
    assert_eq!(parse_city("?city=krk").err().map(|r| r.status().as_u16()), Some(400));
}

#[test]
fn etag_matches_is_a_weak_comparison_over_a_list() {
    let etag = "\"abc\"";
    for h in ["\"abc\"", "W/\"abc\"", "\"other\", \"abc\"", " * ", "\"x\",W/\"abc\" "] {
        assert!(etag_matches(Some(h), etag), "{h}");
    }
    for h in ["", "\"abcd\"", "abc", "w/\"abc\""] {
        assert!(!etag_matches(Some(h), etag), "{h}");
    }
    assert!(!etag_matches(None, etag));
    assert!(etag_matches(Some("\"abc\""), "W/\"abc\""));
}

fn etag_req(inm: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Some(v) = inm {
        h.insert("if-none-match", HeaderValue::from_str(v).unwrap());
    }
    h
}

fn etag_of(res: &Response<Body>) -> String {
    res.headers()
        .get("etag")
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default()
}

async fn text(res: Response<Body>) -> String {
    String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
}

#[tokio::test]
async fn json_with_etag_sends_the_body_with_a_content_etag_the_browser_must_revalidate() {
    let res = json_with_etag(&etag_req(None), &json!({ "vehicle": { "sideNumber": "208" } }));
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers().get("cache-control").unwrap(), "no-cache");
    let etag = etag_of(&res);
    let inner = etag.strip_prefix('"').and_then(|e| e.strip_suffix('"')).unwrap_or("");
    assert!(
        inner.len() == 22
            && inner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "{etag}"
    );
    let body: Value = serde_json::from_str(&text(res).await).unwrap();
    assert_eq!(body, json!({ "vehicle": { "sideNumber": "208" } }));
}

#[tokio::test]
async fn json_with_etag_answers_an_unchanged_body_with_an_empty_304_also_for_a_weakened_or_listed_validator() {
    let etag = etag_of(&json_with_etag(&etag_req(None), &json!({ "a": 1 })));
    for inm in [etag.clone(), format!("W/{etag}"), format!("\"other\", {etag}")] {
        let res = json_with_etag(&etag_req(Some(&inm)), &json!({ "a": 1 }));
        assert_eq!(res.status(), 304, "{inm}");
        assert_eq!(etag_of(&res), etag);
        assert_eq!(text(res).await, "");
    }
}

#[test]
fn json_with_etag_a_changed_body_gets_a_new_etag_and_the_full_response() {
    let etag = etag_of(&json_with_etag(&etag_req(None), &json!({ "a": 1 })));
    let res = json_with_etag(&etag_req(Some(&etag)), &json!({ "a": 2 }));
    assert_eq!(res.status(), 200);
    assert_ne!(etag_of(&res), etag);
}

/// server/api/vehicles/route.ts gzips each body once on Node's single thread; clients whose polls X-Next-Update
/// bunches onto the same body change must share that one gzip (and one build), not each compress their own.
#[tokio::test]
async fn prebuilt_json_builds_and_gzips_a_body_once_for_concurrent_first_requests() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    let mut seed = 0x2545_f491_u32;
    let mut raw = String::from("[");
    while raw.len() < 400_000 {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        raw.push_str(&format!("{seed},"));
    }
    raw.push_str("0]");
    let owner: Arc<str> = raw.into();
    let builds = AtomicUsize::new(0);
    let n = 16;
    let gate = Barrier::new(n);
    let mut req = HeaderMap::new();
    req.insert("accept-encoding", HeaderValue::from_static("gzip"));
    let responses: Vec<Response<Body>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..n)
            .map(|_| {
                s.spawn(|| {
                    gate.wait();
                    prebuilt_json(
                        &req,
                        &owner,
                        || {
                            builds.fetch_add(1, Ordering::SeqCst);
                            owner.to_string()
                        },
                        HeaderMap::new(),
                    )
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut bufs = Vec::new();
    for res in responses {
        assert_eq!(res.headers().get("content-encoding").unwrap(), "gzip");
        let frame = res.into_body().frame().await.unwrap().unwrap();
        bufs.push(frame.into_data().unwrap());
    }
    let first = bufs[0].as_ptr();
    assert!(
        bufs.iter().all(|b| b.as_ptr() == first),
        "each request gzipped its own copy"
    );
    assert_eq!(builds.load(Ordering::SeqCst), 1);
}
