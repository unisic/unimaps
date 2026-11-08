//! JavaScript semantics the ported code depends on, where Rust's own differ.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};

/// `Math.round`: halves go up (`-2.5` -> `-2`), where `f64::round` goes away from zero.
pub fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `Math.round(x * 10) / 10`
pub fn round1(x: f64) -> f64 {
    round(x * 10.0) / 10.0
}

// ponytail: cos, sin, exp, ln and atan2 stay Rust's libm. V8 differs from it in the last bit for 4-14 % of inputs
// (measured 2026-11-07 against V8 12.4; V8 carries its own fdlibm and glibc-derived copies). Every wire value built
// on them is rounded first (dist_m, speed, sched_speed, shape stops, len), so only an exact rounding boundary could
// show it; the golden tests compare unrounded floats within 1e-12. Bit-exact path needed: the `libm` crate matches
// V8's exp and atan2 exactly, sin/cos/ln would need V8's own sources.

/// `Math.hypot(a, b)` as V8 computes it: scaled to the larger value, squares summed with Kahan compensation.
/// `f64::hypot` (libm) differs in the last bit, which shifts polyline chainages and every value derived from them.
pub fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = a.max(b);
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0_f64, 0.0_f64);
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * max
}

/// `String(x)` of a number: the shortest round-trip digits, positional for exponents -7 < e < 21, else `1.5e-7` /
/// `1e+21`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    if x.is_infinite() {
        return "Infinity".into();
    }
    // `{:e}` writes the shortest round-trip digits: "1.2345e3"
    let sci = format!("{x:e}");
    let (mant, exp) = sci.split_once('e').expect("{:e} has an exponent");
    let mut digits = mant.replace('.', "");
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("{:e} exponent") + 1;
    if let Some(even) = even_tie(x, &digits, n - 1) {
        digits = even;
    }
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(-n as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        match digits.split_at(1) {
            (d, "") => format!("{d}e{sign}{}", e.abs()),
            (d, rest) => format!("{d}.{rest}e{sign}{}", e.abs()),
        }
    }
}

/// Two shortest digit strings can sit exactly as far from `x` (x is the midpoint between them): ECMAScript takes
/// the even one, Rust the upper one. Returns the even one when it differs from `digits`.
fn even_tie(x: f64, digits: &str, exp: i32) -> Option<String> {
    let k = digits.len();
    // a tie needs the exact expansion to be `<k digits>5000...`: a short check first, the full expansion (a double
    // has at most 767 significant digits) only for the rare candidate
    let probe = format!("{:.*e}", k + 2, x);
    let (pm, pe) = probe.split_once('e')?;
    let pd = pm.replace('.', "");
    if pe.parse::<i32>().ok()? != exp || &pd[k..] != "500" {
        return None;
    }
    let full = format!("{x:.780e}");
    let fd = full.split_once('e')?.0.replace('.', "");
    if fd.as_bytes()[k] != b'5' || !fd[k + 1..].bytes().all(|b| b == b'0') {
        return None;
    }
    let lo = &fd[..k];
    if lo.as_bytes()[k - 1] % 2 == 0 && lo != digits {
        let alt = lo.to_owned();
        let mant = format!("{}.{}e{exp}", &alt[..1], &alt[1..]);
        return (mant.parse::<f64>().ok()? == x).then_some(alt);
    }
    None
}

/// `Buffer.from(s, "base64url")` (Node reads both alphabets for either name): each UTF-16 unit counts as its low
/// byte, bytes outside the alphabet are skipped, the first `=` ends the input, leftover bits are dropped.
pub fn buffer_from_base64(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for u in s.encode_utf16() {
        let c = u as u8;
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6 | u32::from(v)) & 0x3fff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// `buf.toString("base64url")`: no padding.
pub fn to_base64url(b: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = c
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &x)| n | u32::from(x) << (16 - 8 * i));
        for k in 0..=c.len() {
            out.push(ABC[(n >> (18 - 6 * k) & 63) as usize] as char);
        }
    }
    out
}

/// `String(v)` of a parsed JSON value (`None` = undefined).
pub fn value_to_string(v: Option<&serde_json::Value>) -> String {
    use serde_json::Value;
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.join: null and undefined elements are empty
        Some(Value::Array(a)) => a
            .iter()
            .map(|e| {
                if e.is_null() {
                    String::new()
                } else {
                    value_to_string(Some(e))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `\s` of a JS regular expression (WhiteSpace + LineTerminator). `char::is_whitespace` differs: it takes U+0085
/// and not U+FEFF.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

fn pl_collator(numeric: bool) -> CollatorBorrowed<'static> {
    let mut prefs = CollatorPreferences::from(&icu_locale_core::langid!("pl"));
    prefs.numeric_ordering = Some(if numeric {
        CollationNumericOrdering::True
    } else {
        CollationNumericOrdering::False
    });
    Collator::try_new(prefs, CollatorOptions::default()).expect("compiled pl collation data")
}

static PL: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| pl_collator(false));
static PL_NUMERIC: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| pl_collator(true));

/// `a.localeCompare(b, "pl")`
pub fn compare_pl(a: &str, b: &str) -> Ordering {
    PL.compare(a, b)
}

/// `new Intl.Collator("pl", { numeric: true }).compare`: digit runs by value ("2" < "10", "01" == "1").
pub fn compare_pl_numeric(a: &str, b: &str) -> Ordering {
    PL_NUMERIC.compare(a, b)
}

/// `Number(s)` of a string: trimmed, "" = 0, `0x`/`0o`/`0b` without a sign, "Infinity", else a decimal literal or
/// NaN. A radix literal past u128 is NaN here (JS rounds it to a huge number).
pub fn number(s: &str) -> f64 {
    let t = s.trim_matches(is_space);
    let radix = match t.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 0,
    };
    if radix != 0 {
        let digits = &t[2..];
        // from_str_radix takes a sign, Number does not
        return match digits.bytes().all(|b| b.is_ascii_alphanumeric()) {
            true => u128::from_str_radix(digits, radix).map_or(f64::NAN, |v| v as f64),
            false => f64::NAN,
        };
    }
    match t {
        "" => 0.0,
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        // Rust also reads "inf" and "nan", Number does not
        _ if t
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) =>
        {
            t.parse().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}

/// `x.toFixed(digits)`: the exact binary value rounded to `digits` places, an exact tie to the larger magnitude
/// (Rust's `{:.N}` breaks it to even: 2.5 -> "2", toFixed "3"), -0 as "0", |x| >= 1e21 and non-finite as `String(x)`.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    let x = x + 0.0;
    let s = format!("{x:.digits$}");
    // a tie shows a 5 one place further; 1100 places spell out every f64 in full
    if !format!("{x:.p$}", p = digits + 1).ends_with('5') {
        return s;
    }
    let exact = format!("{x:.1100}");
    let dot = exact.find('.').unwrap_or(exact.len());
    let (head, tail) = exact.split_at(dot + 1 + digits);
    // at or past half: up in magnitude, the same as `s` except on an exact tie
    if !tail.starts_with('5') {
        return s;
    }
    let mut out = head.trim_end_matches('.').as_bytes().to_vec();
    let mut i = out.len();
    loop {
        if i == 0 || !out[i - 1].is_ascii_digit() && out[i - 1] != b'.' {
            out.insert(i, b'1');
            break;
        }
        i -= 1;
        match out[i] {
            b'.' => {}
            b'9' => out[i] = b'0',
            _ => {
                out[i] += 1;
                break;
            }
        }
    }
    String::from_utf8(out).unwrap_or(s)
}

/// ToInt32 (an `Int32Array` store, `x | 0`): truncated, wrapped mod 2^32, NaN and infinities 0.
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4_294_967_296.0) as u32 as i32
}

/// `Object.entries` / `Object.keys` order of a parsed JSON object: array-index keys ("0", "17", up to 2^32 - 2)
/// ascending first, then the other keys in insertion order.
pub fn sort_object_keys<V>(map: &mut indexmap::IndexMap<String, V>) {
    fn index(k: &str) -> Option<u32> {
        let canonical = k == "0" || (!k.starts_with('0') && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()));
        k.parse().ok().filter(|&n: &u32| canonical && n != u32::MAX)
    }
    map.sort_by(|a, _, b, _| match (index(a), index(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    });
}

/// A number as `JSON.stringify` writes it: an integral value goes out without the `.0` serde_json adds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct JsNum(pub f64);

impl serde::Serialize for JsNum {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let x = self.0;
        if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
            s.serialize_i64(x as i64)
        } else {
            s.serialize_f64(x)
        }
    }
}

impl<'de> serde::Deserialize<'de> for JsNum {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        f64::deserialize(d).map(JsNum)
    }
}

/// A number as a JSON value that serializes like `JSON.stringify` (see [`JsNum`]); NaN and infinities are `null`.
pub fn num_value(x: f64) -> serde_json::Value {
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        (x as i64).into()
    } else {
        x.into()
    }
}

/// `Number.parseInt(s, 10)`: leading whitespace, a sign, then the leading digits; NaN without a digit.
pub fn parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(is_space);
    let (neg, t) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits = &t[..t.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(t.len())];
    let v = if digits.is_empty() {
        f64::NAN
    } else {
        digits.parse().unwrap_or(f64::NAN)
    };
    if neg { -v } else { v }
}

/// JS truthiness of a parsed JSON value (`None` = undefined).
pub fn truthy(v: Option<&serde_json::Value>) -> bool {
    use serde_json::Value;
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `s.slice(0, max)` in UTF-16 units, cut before a pair the TS would split.
pub fn utf16_prefix(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return s.get(..i).unwrap_or(s);
        }
    }
    s
}

/// `encodeURIComponent` (a Rust string has no lone surrogate, so it never throws).
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `JSON.parse`: it takes a lone UTF-16 surrogate escape (`JSON.stringify` writes one for a string holding it),
/// where serde_json refuses the whole document. A Rust string cannot hold a lone surrogate, so each such escape
/// parses as U+FFFD. It also takes a number past the f64 range and any nesting depth (`tame`).
pub fn json_parse(text: &str) -> serde_json::Result<serde_json::Value> {
    let text = lone_surrogates_to_fffd(text);
    serde_json::from_str(&text).or_else(|e| {
        // serde_json skips an ignored value iteratively, with no depth limit and no number conversion: the
        // syntax check JSON.parse makes
        serde_json::from_str::<serde::de::IgnoredAny>(&text).map_err(|_| e)?;
        serde_json::from_str(&tame(&text))
    })
}

/// A valid JSON document rewritten so serde_json takes it: a number past the f64 range (Infinity, which
/// `JSON.stringify` writes as null) becomes null, and so does a container nested past serde_json's limit.
// ponytail: a container more than 127 levels deep parses as null where JSON.parse keeps it; no caller reads that deep
fn tame(s: &str) -> String {
    const MAX_DEPTH: usize = 127;
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let (mut i, mut depth, mut cut) = (0, 0usize, None);
    while let Some(&c) = b.get(i) {
        let start = i;
        i += 1;
        match c {
            b'"' => {
                while let Some(&c) = b.get(i) {
                    i += if c == b'\\' { 2 } else { 1 };
                    if c == b'"' {
                        break;
                    }
                }
            }
            b'[' | b'{' => {
                depth += 1;
                if cut.is_none() && depth > MAX_DEPTH {
                    cut = Some(depth);
                    out.push_str("null");
                }
            }
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                if cut == Some(depth + 1) {
                    cut = None;
                    continue;
                }
            }
            b'-' | b'0'..=b'9' => {
                while matches!(b.get(i), Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')) {
                    i += 1;
                }
                if cut.is_none()
                    && s.get(start..i)
                        .is_some_and(|n| n.parse::<f64>().is_ok_and(f64::is_infinite))
                {
                    out.push_str("null");
                    continue;
                }
            }
            _ => {}
        }
        if cut.is_none() {
            out.push_str(s.get(start..i).unwrap_or(""));
        }
    }
    out
}

fn lone_surrogates_to_fffd(s: &str) -> Cow<'_, str> {
    let unit = |i: usize| {
        s.get(i..i + 6)
            .and_then(|e| e.strip_prefix("\\u"))
            .and_then(|h| u16::from_str_radix(h, 16).ok())
    };
    let b = s.as_bytes();
    let (mut out, mut last, mut i) = (String::new(), 0, 0);
    while i < b.len() {
        if b.get(i) != Some(&b'\\') {
            i += 1;
            continue;
        }
        match unit(i) {
            Some(0xD800..=0xDBFF) if matches!(unit(i + 6), Some(0xDC00..=0xDFFF)) => i += 12,
            Some(0xD800..=0xDFFF) => {
                out.push_str(s.get(last..i).unwrap_or(""));
                out.push_str("\\ufffd");
                i += 6;
                last = i;
            }
            // any other escape, `\\` included, is two bytes
            _ => i += 2,
        }
    }
    if out.is_empty() {
        return Cow::Borrowed(s);
    }
    out.push_str(s.get(last..).unwrap_or(""));
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_parse_takes_lone_surrogates_as_node_does() {
        let v = json_parse(r#"["\ud800","a\\ud800\udc00\ud83d\ude00\ud800\u0041","\udbff\udbff\udfff"]"#).unwrap();
        assert_eq!(
            v,
            serde_json::json!(["\u{fffd}", "a\\ud800\u{fffd}\u{1f600}\u{fffd}A", "\u{fffd}\u{10ffff}"])
        );
        assert!(matches!(
            lone_surrogates_to_fffd(r#"{"k":"\ud83d\ude00\\ud800"}"#),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn base64_matches_node_buffer() {
        // Buffer.from(s, "base64url").toString("hex") in Node 24
        for (s, hex) in [
            ("AB=CD", "00"),
            ("A B C D", "001083"),
            ("AAAAA", "000000"),
            ("+/+/", "fbffbf"),
            ("-_-_", "fbffbf"),
            ("AA==AA", "00"),
            ("A*AAA", "000000"),
            ("QQ", "41"),
            ("QQ==", "41"),
            ("QR", "41"),
            ("QQ=Q", "41"),
            ("Q", ""),
            ("", ""),
            ("QUJD\nREVG", "414243444546"),
            ("QUJD.REVG", "414243444546"),
            ("a\u{e9}bc", "69b7"),
            ("\u{141}\u{141}\u{141}\u{141}", "000000"),
            ("QUJD\u{141}REVG", "414243011115"),
            ("\u{c1}AAA", "0000"),
            ("QUJD\u{1F600}REVG", "414243"),
            ("QUJD\0REVG", "414243444546"),
        ] {
            let got: String = buffer_from_base64(s).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(got, hex, "{s:?}");
        }
        for len in 0..40u8 {
            let b: Vec<u8> = (0..len).map(|i| i.wrapping_mul(97) ^ 0xa5).collect();
            assert_eq!(buffer_from_base64(&to_base64url(&b)), b);
        }
        assert_eq!(to_base64url(b"\xfb\xff\xbf\x41"), "-_-_QQ");
    }

    #[test]
    fn round_matches_math_round() {
        for (x, want) in [
            (2.5, 3.0),
            (-2.5, -2.0),
            (-0.5, 0.0),
            (0.49999999999999994, 0.0),
            (1.4999999999999998, 1.0),
            (-1.5000000000000002, -2.0),
            (4503599627370495.5, 4503599627370496.0),
            (9007199254740993.0, 9007199254740992.0),
        ] {
            assert_eq!(round(x), want, "{x}");
        }
        assert!(round(f64::NAN).is_nan());
        assert_eq!(round(f64::INFINITY), f64::INFINITY);
    }

    /// values from node 22, each pair one where `sqrt(a*a + b*b)` misses V8's last bit
    #[test]
    fn hypot_matches_math_hypot() {
        for (a, b, want) in [
            (970.5605571952469, -2007.3521123301946, 2229.6749310291043),
            (422.9199911574466, 4870.918993778024, 4889.244641339615),
            (1721.8542130300095, 292.0293832626331, 1746.4429826415599),
            (4240.134958755289, 3095.7877673654766, 5250.013939888964),
            (2412.2369323914118, -4362.870454491522, 4985.331044240511),
            (-2961.0133161586773, 3923.189942223574, 4915.182517591103),
            (0.0, -0.0, 0.0),
            (-3.0, 4.0, 5.0),
            (1e300, 1e300, 1.4142135623730952e300),
        ] {
            assert_eq!(hypot(a, b), want, "{a} {b}");
        }
        assert_eq!(hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
        assert!(hypot(f64::NAN, 1.0).is_nan());
    }

    // expectations from Node
    #[test]
    fn number_to_string_matches_js_string() {
        for (x, want) in [
            (0.0, "0"),
            (-0.0, "0"),
            (-1.0, "-1"),
            (247.0, "247"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (0.1 + 0.2, "0.30000000000000004"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (-1.5e-10, "-1.5e-10"),
            (123.456, "123.456"),
            (9007199254740994.0, "9007199254740994"),
            (-2.5e21, "-2.5e+21"),
            (1234.5, "1234.5"),
            // exact midpoints between two shortest candidates: the even one
            (106690415307569.0 + 0.625, "106690415307569.62"),
            (-2215280473948473.0 - 0.25, "-2215280473948473.2"),
            (169414688911108.0 + 0.125, "169414688911108.12"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(number_to_string(x), want, "{x}");
        }
        let v: serde_json::Value = serde_json::from_str(r#"[1,null,"a",[2,3],true]"#).unwrap();
        assert_eq!(value_to_string(Some(&v)), "1,,a,2,3,true");
        assert_eq!(value_to_string(Some(&serde_json::json!({}))), "[object Object]");
        assert_eq!(value_to_string(None), "undefined");
    }

    #[test]
    fn space_is_the_regexp_class() {
        assert!(is_space('\u{FEFF}') && is_space('\u{A0}') && is_space('\u{2007}'));
        assert!(!is_space('\u{85}') && !is_space('\u{200B}') && !is_space('x'));
    }

    // expectations from Node
    #[test]
    fn number_matches_js_number() {
        for (s, want) in [
            ("", 0.0),
            ("  \u{FEFF}12\n", 12.0),
            ("1.", 1.0),
            (".5", 0.5),
            ("-1e3", -1000.0),
            ("+2E-1", 0.2),
            ("0x1F", 31.0),
            ("0o17", 15.0),
            ("0B101", 5.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("007", 7.0),
        ] {
            assert_eq!(number(s), want, "{s:?}");
        }
        for s in [
            "inf", "nan", "NaN", "infinity", "1e", ".", "-0x10", "0x", "0x-1", "1_000", "12abc", "1 2", "+-1",
        ] {
            assert!(number(s).is_nan(), "{s:?}");
        }
        assert!(number("-0").is_sign_negative());
    }

    #[test]
    fn to_int32_wraps_like_an_int32_array() {
        for (x, want) in [
            (1.9, 1),
            (-1.9, -1),
            (2_147_483_648.0, -2_147_483_648),
            (4_294_967_296.0 + 5.5, 5),
            (-2_147_483_649.0, 2_147_483_647),
            (f64::NAN, 0),
            (f64::INFINITY, 0),
            (-0.0, 0),
        ] {
            assert_eq!(to_int32(x), want, "{x}");
        }
    }

    #[test]
    fn object_keys_put_array_indices_first() {
        let mut m: indexmap::IndexMap<String, ()> =
            ["329", "b", "02", "4294967295", "2", "a", "4294967294", "0", "-1", "1.5"]
                .map(|k| (k.to_owned(), ()))
                .into_iter()
                .collect();
        sort_object_keys(&mut m);
        let keys: Vec<&str> = m.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["0", "2", "329", "4294967294", "b", "02", "4294967295", "a", "-1", "1.5"]
        );
    }
}
