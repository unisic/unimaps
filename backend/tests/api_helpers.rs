//! test/api-helpers.test.ts (jsonWithEtag comes with its first route), plus the Rust-only parsers pinned against
//! Node: `URLSearchParams.get`, `parseCity`, `etagMatches`.

use unimaps::api_helpers::*;

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
