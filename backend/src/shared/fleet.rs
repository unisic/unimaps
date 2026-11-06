//! lib/shared/fleet.ts: the server half (punctuality classes, text folding, line order). `matchesFleetQuery` and
//! the wire types come with the fleet tracker.

use std::cmp::Ordering;

use icu_normalizer::DecomposingNormalizerBorrowed;

use crate::js;

pub const TIMELINE_SLOT_SECS: i64 = 300;

/// On time = at most 1 min early and at most 3 min late (the usual Polish operator rule).
pub const ON_TIME_MIN_SEC: i64 = -60;
pub const ON_TIME_MAX_SEC: i64 = 180;
pub const VERY_LATE_SEC: i64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelayClass {
    Early,
    OnTime,
    Late,
    VeryLate,
}

pub fn classify_delay(delay_sec: i64) -> DelayClass {
    if delay_sec < ON_TIME_MIN_SEC {
        DelayClass::Early
    } else if delay_sec <= ON_TIME_MAX_SEC {
        DelayClass::OnTime
    } else if delay_sec <= VERY_LATE_SEC {
        DelayClass::Late
    } else {
        DelayClass::VeryLate
    }
}

pub fn is_on_time(delay_sec: i64) -> bool {
    classify_delay(delay_sec) == DelayClass::OnTime
}

pub fn median(values: &[i64]) -> Option<f64> {
    let mut s = values.to_vec();
    s.sort_unstable();
    let mid = s.len() / 2;
    match s.len() {
        0 => None,
        n if n % 2 == 1 => Some(s[mid] as f64),
        _ => Some((s[mid - 1] + s[mid]) as f64 / 2.0),
    }
}

/// Lowercase, diacritics folded (ł included, which NFD leaves alone): "Żywiec" ~ "zywiec".
pub fn fold_text(s: &str) -> String {
    let lower = s.to_lowercase().replace('ł', "l");
    DecomposingNormalizerBorrowed::new_nfd()
        .normalize(&lower)
        .chars()
        .filter(|c| !('\u{300}'..='\u{36F}').contains(c))
        .collect()
}

/// `Number.parseInt(s, 10)`: leading whitespace, a sign, then the leading digits; NaN without a digit.
fn parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(js::is_space);
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

/// Numeric lines first in numeric order ("2" < "10"), then the rest alphabetically.
pub fn compare_line_names(a: &str, b: &str) -> Ordering {
    let (na, nb) = (parse_int(a), parse_int(b));
    let (fa, fb) = (na.is_finite(), nb.is_finite());
    if fa && fb && na != nb {
        return na.total_cmp(&nb);
    }
    if fa != fb {
        return if fa { Ordering::Less } else { Ordering::Greater };
    }
    js::compare_pl(a, b)
}
