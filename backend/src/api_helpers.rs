//! lib/api-helpers.ts: validation of values that get forwarded into upstream URLs, `?city=`, and error responses
//! that never leak internals. `readJsonBody`, `prebuiltJson` and `jsonWithEtag` come with the first route using them.

use std::fmt::Display;

use hyper::header::{HeaderValue, RETRY_AFTER};
use hyper::{Response, StatusCode};

use crate::config::{GZM_ENABLED, ZB_ENABLED};
use crate::http::{Body, json};
use crate::js;
use crate::logger;
use crate::shared::cities::{zb_city_of, zb_slug};

/// Upstream-safe id: 1-64 of letters, digits and ':' '.' '_' '-', so the value can never smuggle a '/', '?', '#',
/// '&' or '%' that would rewrite the upstream URL. "." and ".." are dot segments a URL would normalise away.
pub fn is_valid_id(v: &str) -> bool {
    (1..=64).contains(&v.len())
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || b":._-".contains(&b))
        && v != "."
        && v != ".."
}

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Road-shape wire id: "kb:<12 hex>" or "mzk:<1-10 digits>", optionally ".<rev6>", or "<zbiorkom slug>:<1-60 of
/// [A-Za-z0-9_.-]>".
pub fn is_valid_shape_id(v: &str) -> bool {
    let (head, rev) = v.split_once('.').map_or((v, None), |(h, r)| (h, Some(r)));
    let bb = rev.is_none_or(|r| lower_hex(r, 6))
        && match (head.strip_prefix("kb:"), head.strip_prefix("mzk:")) {
            (Some(k), _) => lower_hex(k, 12),
            (_, Some(m)) => (1..=10).contains(&m.len()) && m.bytes().all(|b| b.is_ascii_digit()),
            _ => false,
        };
    bb || zb_city_of(v).is_some_and(|slug| {
        let rest = &v[slug.len() + 1..];
        (1..=60).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    })
}

/// A real calendar day as "YYYY-MM-DD": 2026-02-31 would reach KB verbatim while MZK rolls it into March. Years
/// below 100 fail like in the TS, where `Date.UTC` reads them as 19xx.
pub fn is_valid_date(v: &str) -> bool {
    let b = v.as_bytes();
    if b.len() != 10
        || !b.iter().enumerate().all(|(i, &c)| {
            if i == 4 || i == 7 {
                c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (v[..4].parse::<i16>(), v[5..7].parse::<i8>(), v[8..].parse::<i8>()) else {
        return false;
    };
    y >= 100 && jiff::civil::Date::new(y, m, d).is_ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum City {
    Bb,
    Zb(&'static str),
}

/// True when a zbiorkom city is served: GZM follows KB_GZM, every other slug KB_ZB.
pub fn zb_enabled(slug: &str) -> bool {
    if slug == "gzm" { *GZM_ENABLED } else { *ZB_ENABLED }
}

/// `?city=` of a query string (with or without its '?'): absent or "bb" = BB, a registry slug while that city is
/// enabled; any other value is a 400, a disabled city a 404.
pub fn parse_city(query: &str) -> Result<City, Response<Body>> {
    match query_param(query, "city").as_deref() {
        None | Some("bb") => Ok(City::Bb),
        Some(v) => match zb_slug(v) {
            None => Err(bad_request("Unknown city")),
            Some(s) if zb_enabled(s) => Ok(City::Zb(s)),
            Some(_) => Err(not_found("Not found")),
        },
    }
}

/// `URLSearchParams.get`: the first `name`, '+' read as a space, %XX decoded (a malformed escape stays as is),
/// invalid UTF-8 replaced.
pub fn query_param(query: &str, name: &str) -> Option<String> {
    let query = query.strip_prefix('?').unwrap_or(query);
    query.split('&').filter(|p| !p.is_empty()).find_map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (form_decode(k) == name).then(|| form_decode(v))
    })
}

fn form_decode(s: &str) -> String {
    let hex = |c: u8| char::from(c).to_digit(16);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (
            b[i],
            b.get(i + 1).copied().and_then(hex),
            b.get(i + 2).copied().and_then(hex),
        ) {
            (b'+', ..) => out.push(b' '),
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 2;
            }
            (c, ..) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn error(status: StatusCode, message: &str) -> Response<Body> {
    json(status, serde_json::json!({ "error": message }).to_string())
}

pub fn not_found(message: &str) -> Response<Body> {
    error(StatusCode::NOT_FOUND, message)
}

/// 503 while a city's data is still loading (a feed parses for a few seconds after a start).
pub fn warming() -> Response<Body> {
    let mut r = error(StatusCode::SERVICE_UNAVAILABLE, "Data is loading");
    r.headers_mut().insert(RETRY_AFTER, HeaderValue::from_static("10"));
    r
}

/// 500 for a failure inside our own code: logs the real error, answers a generic message.
pub fn internal_error(tag: &str, err: impl Display) -> Response<Body> {
    logger::error(tag, err);
    error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}

/// 400 for a malformed path or query value.
pub fn bad_request(message: &str) -> Response<Body> {
    error(StatusCode::BAD_REQUEST, message)
}

/// 502 that logs the real error but answers a generic message: never the upstream URL or the raw error text.
pub fn upstream_error(tag: &str, err: impl Display) -> Response<Body> {
    logger::error(tag, err);
    error(StatusCode::BAD_GATEWAY, "Upstream request failed")
}

/// RFC 9110 weak comparison of an If-None-Match value (`http::header_str`): any listed tag, W/ ignored, or "*".
pub fn etag_matches(header: Option<&str>, etag: &str) -> bool {
    fn weak(t: &str) -> &str {
        t.strip_prefix("W/").unwrap_or(t)
    }
    let want = weak(etag);
    header.is_some_and(|h| {
        !h.is_empty()
            && h.split(',').any(|t| {
                let v = t.trim_matches(js::is_space);
                v == "*" || weak(v) == want
            })
    })
}
