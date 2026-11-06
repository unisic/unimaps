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
}
