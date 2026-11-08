//! lib/api-helpers.ts: validation of values that get forwarded into upstream URLs, `?city=`, and error responses
//! that never leak internals, and the two cached JSON answers (`prebuilt_json`, `json_with_etag`). `readJsonBody`
//! comes with the first route using it.

use std::collections::HashMap;
use std::fmt::Display;
use std::io::Write;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, PoisonError};

use bytes::Bytes;
use flate2::Compression;
use flate2::write::GzEncoder;
use hyper::header::{CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE, ETAG, HeaderMap, HeaderValue, RETRY_AFTER, VARY};
use hyper::{Response, StatusCode};
use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::config::{GZM_ENABLED, ZB_ENABLED};
use crate::fleet_tracker::blocking_io;
use crate::http::{Body, full, header_str, json};
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

/// readJsonBody: a JSON object or array body of at most `max` bytes. None when Content-Length is not a positive
/// integer <= `max` (a chunked body is refused unread), the text is not JSON, or it is a JSON primitive.
pub fn read_json_body(headers: &HeaderMap, body: Option<&[u8]>, max: usize) -> Option<serde_json::Value> {
    let len = header_str(headers, "content-length").map_or(0.0, |v| js::number(&v));
    if len.fract() != 0.0 || len <= 0.0 || len > max as f64 {
        return None;
    }
    // req.text(): UTF-8 with replacement characters, a leading BOM dropped
    let text = String::from_utf8_lossy(body.unwrap_or_default());
    let v = js::json_parse(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()?;
    (v.is_object() || v.is_array()).then_some(v)
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

struct Prebuilt {
    /// the owner still exists (its Weak also pins the address, so a key never names two owners)
    alive: Box<dyn Fn() -> bool + Send>,
    slot: Arc<Slot>,
}

/// filled once outside the map lock; a concurrent first request waits for the running build or gzip
#[derive(Default)]
struct Slot {
    body: OnceLock<Bytes>,
    gz: OnceLock<Bytes>,
}

/// prebuilt bodies by owner address; a dead owner's entry goes on the next insert
static PREBUILT: LazyLock<Mutex<HashMap<usize, Prebuilt>>> = LazyLock::new(Default::default);

fn prebuilt() -> MutexGuard<'static, HashMap<usize, Prebuilt>> {
    PREBUILT.lock().unwrap_or_else(PoisonError::into_inner)
}

fn gzip(body: &[u8]) -> Bytes {
    let mut enc = GzEncoder::new(Vec::with_capacity(body.len() / 4), Compression::default());
    // writing into a Vec cannot fail
    let _ = enc.write_all(body);
    Bytes::from(enc.finish().unwrap_or_default())
}

/// JSON built once per `owner` (an Arc never mutated after it is built: a feed, a vehicles body) and gzipped once
/// when a client accepts it, so a request is a buffer clone; `headers` go out beside Content-Type and Vary. The
/// gzip of a ~400 KB body, and every wait for it, runs through `block_in_place`, outside the map lock.
pub fn prebuilt_json<T: ?Sized + Send + Sync + 'static>(
    req: &HeaderMap,
    owner: &Arc<T>,
    build: impl FnOnce() -> String,
    mut headers: HeaderMap,
) -> Response<Body> {
    let key = Arc::as_ptr(owner).cast::<()>() as usize;
    let slot = {
        let mut m = prebuilt();
        match m.get(&key) {
            Some(e) => e.slot.clone(),
            None => {
                m.retain(|_, e| (e.alive)());
                let weak = Arc::downgrade(owner);
                let slot = Arc::<Slot>::default();
                m.insert(
                    key,
                    Prebuilt {
                        alive: Box::new(move || weak.strong_count() > 0),
                        slot: slot.clone(),
                    },
                );
                slot
            }
        }
    };
    // ponytail: a waiter blocks its worker for the build, a copy of an already serialized body (~0.1 ms)
    let body = slot.body.get_or_init(|| Bytes::from(build())).clone();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(VARY, HeaderValue::from_static("Accept-Encoding"));
    // ponytail: substring test, a client sending "gzip;q=0" still gets gzip; every browser accepts it
    let out = if header_str(req, "accept-encoding").unwrap_or_default().contains("gzip") {
        headers.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        match slot.gz.get() {
            Some(gz) => gz.clone(),
            None => blocking_io(|| slot.gz.get_or_init(|| gzip(&body)).clone()),
        }
    } else {
        body
    };
    let mut res = Response::new(full(out));
    *res.headers_mut() = headers;
    res
}

/// JSON with a content ETag (22 chars of the body's base64url sha1), for data a page polls although it often has
/// not changed: `no-cache` makes the browser revalidate, and an unchanged body is a bodiless 304.
pub fn json_with_etag(req: &HeaderMap, data: &impl Serialize) -> Response<Body> {
    let body = match serde_json::to_string(data) {
        Ok(b) => b,
        Err(e) => return internal_error("http", e),
    };
    let mut tag = js::to_base64url(&Sha1::digest(body.as_bytes()));
    tag.truncate(22);
    let etag = format!("\"{tag}\"");
    let (status, body) = if etag_matches(header_str(req, "if-none-match").as_deref(), &etag) {
        (StatusCode::NOT_MODIFIED, String::new())
    } else {
        (StatusCode::OK, body)
    };
    let mut res = json(status, body);
    let h = res.headers_mut();
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(ETAG, v);
    }
    res
}

#[cfg(test)]
mod tests {
    use hyper::header::{HeaderMap, HeaderValue};
    use serde_json::json;

    use super::read_json_body;

    fn with_len(len: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            "content-length",
            HeaderValue::from_str(len).unwrap_or(HeaderValue::from_static("x")),
        );
        h
    }

    #[test]
    fn read_json_body_takes_only_a_sized_object_or_array() {
        let body = "\u{feff}{\"a\":1}".as_bytes();
        assert_eq!(
            read_json_body(&with_len("10"), Some(body), 4096),
            Some(json!({ "a": 1 }))
        );
        assert_eq!(read_json_body(&with_len(" 2 "), Some(b"[]"), 4096), Some(json!([])));
        assert_eq!(read_json_body(&HeaderMap::new(), Some(b"{}"), 4096), None);
        for len in ["0", "1.5", "-2", "4097", "abc"] {
            assert_eq!(read_json_body(&with_len(len), Some(b"{}"), 4096), None, "{len}");
        }
        assert_eq!(read_json_body(&with_len("1"), Some(b"7"), 4096), None);
        assert_eq!(read_json_body(&with_len("3"), Some(b"{x}"), 4096), None);
        assert_eq!(read_json_body(&with_len("2"), None, 4096), None);
    }

    /// JSON.parse takes a number past the f64 range (Infinity, written back as null) and any nesting depth, so a
    /// valid body with such an extra field still parses.
    #[test]
    fn read_json_body_takes_what_json_parse_takes() {
        let pad = |p: &str| format!(r#"{{"subscription":{{"endpoint":"e"}},"pad":{p}}}"#);
        let parse = |s: &str| read_json_body(&with_len(&s.len().to_string()), Some(s.as_bytes()), 4096);
        for p in ["1e400", "-1e400", "[1e400]"] {
            let v = parse(&pad(p));
            assert_eq!(
                v.as_ref().map(|v| &v["subscription"]),
                Some(&json!({ "endpoint": "e" })),
                "{p}"
            );
        }
        assert_eq!(parse(&pad("-1e400")).map(|v| v["pad"].clone()), Some(json!(null)));
        let deep = pad(&format!("{}1{}", "[".repeat(2000), "]".repeat(2000)));
        let v = parse(&deep);
        assert_eq!(
            v.as_ref().map(|v| &v["subscription"]),
            Some(&json!({ "endpoint": "e" }))
        );
        assert_eq!(
            v.as_ref().and_then(|v| v["pad"][0][0].as_array()).map(Vec::len),
            Some(1)
        );
        let shallow = pad(&format!("{}1{}", "[".repeat(100), "]".repeat(100)));
        let mut inner = parse(&shallow).map(|v| v["pad"].clone());
        for _ in 0..99 {
            inner = inner.and_then(|v| v.get(0).cloned());
        }
        assert_eq!(inner, Some(json!([1])));
        for bad in ["1e", "[01]", "[1,]", "\"\u{1}\""] {
            assert_eq!(parse(&pad(bad)), None, "{bad}");
            let nested = pad(&format!("{}{bad}{}", "[".repeat(200), "]".repeat(200)));
            assert_eq!(parse(&nested), None, "nested {bad}");
        }
    }
}
