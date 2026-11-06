//! JavaScript semantics the ported code depends on, where Rust's own differ.

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

#[cfg(test)]
mod tests {
    use super::*;

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
