//! js::compare_pl* against Node's ICU on 922 line names (16 zbiorkom feeds + edge cases), vectors from
//! scripts/dump-vectors.ts. Both sorts are stable, so equal names ("01", "1") keep the fixture's order on both sides.

use std::cmp::Ordering;

use serde::Deserialize;
use unimaps::js::{compare_pl, compare_pl_numeric};

#[derive(Deserialize)]
struct Vectors {
    pl: Vec<String>,
    pl_numeric: Vec<String>,
}

fn fixture() -> Vec<String> {
    serde_json::from_str(include_str!("../../test/fixtures/line-names.json")).unwrap()
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("vectors/collation.json")).unwrap()
}

fn sorted(cmp: fn(&str, &str) -> Ordering) -> Vec<String> {
    let mut v = fixture();
    v.sort_by(|a, b| cmp(a, b));
    v
}

#[test]
fn locale_compare_pl_sorts_like_node() {
    assert_eq!(sorted(compare_pl), vectors().pl);
}

#[test]
fn numeric_pl_collator_sorts_like_node() {
    assert_eq!(sorted(compare_pl_numeric), vectors().pl_numeric);
}

#[test]
fn numeric_collator_ignores_leading_zeros_and_case_only_at_the_tertiary_level() {
    assert_eq!(compare_pl_numeric("01", "1"), Ordering::Equal);
    assert_eq!(compare_pl_numeric("2", "10"), Ordering::Less);
    assert_eq!(compare_pl_numeric("a", "A"), Ordering::Less);
    assert_eq!(compare_pl("2", "10"), Ordering::Greater);
}
