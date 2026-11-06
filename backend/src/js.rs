//! JavaScript semantics the ported code depends on, where Rust's own differ.

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
