//! test/fleet-tracker.test.ts "shared fleet helpers" (matchesFleetQuery comes with the tracker), plus edge cases
//! whose expectations are what lib/shared/fleet.ts returns in Node.

use unimaps::shared::fleet::{DelayClass, classify_delay, compare_line_names, fold_text, is_on_time, median};

#[test]
fn classifies_delays_minus_1_to_plus_3_min_on_time_over_10_min_very_late() {
    assert_eq!(classify_delay(-61), DelayClass::Early);
    assert_eq!(classify_delay(-60), DelayClass::OnTime);
    assert_eq!(classify_delay(180), DelayClass::OnTime);
    assert_eq!(classify_delay(181), DelayClass::Late);
    assert_eq!(classify_delay(600), DelayClass::Late);
    assert_eq!(classify_delay(601), DelayClass::VeryLate);
    assert!(is_on_time(0) && !is_on_time(181));
}

#[test]
fn median_handles_empty_odd_and_even_inputs_without_mutating_them() {
    let xs = [5, 1, 3, 2];
    assert_eq!(median(&[]), None);
    assert_eq!(median(&[4, 1, 9]), Some(4.0));
    assert_eq!(median(&xs), Some(2.5));
    assert_eq!(xs, [5, 1, 3, 2]);
    assert_eq!(median(&[-3, -2]), Some(-2.5));
}

#[test]
fn folds_polish_diacritics_including_l_stroke() {
    assert_eq!(fold_text("Łódź Żywiec Ćwiklice"), "lodz zywiec cwiklice");
    for (s, want) in [
        ("ŁAŃCUT", "lancut"),
        ("İstanbul", "istanbul"),
        ("Ǆ", "ǆ"),
        ("ﬁ", "ﬁ"),
        ("Ångström", "angstrom"),
        ("naïve café", "naive cafe"),
        ("ΟΔΟΣ", "\u{3bf}\u{3b4}\u{3bf}\u{3c2}"),
        ("e\u{301}", "e"),
        ("ß", "ß"),
    ] {
        assert_eq!(fold_text(s), want, "{s}");
    }
}

#[test]
fn orders_line_names_numerically_then_alphabetically() {
    let mut v = ["10", "A", "2", "1", "N1"];
    v.sort_by(|a, b| compare_line_names(a, b));
    assert_eq!(v, ["1", "2", "10", "A", "N1"]);
}

#[test]
fn line_order_follows_parse_int_on_edge_cases() {
    let long = "9".repeat(400);
    let mut v = vec![
        "10", "A", "2", "1", "N1", " 7", "+5", "-3", "12abc", "0x10", "", "1e3", "١٢", &long, "07", "7", "Ż", "Z",
        "-0", "0", "\u{a0}8",
    ];
    v.sort_by(|a, b| compare_line_names(a, b));
    let want = [
        "-3", "-0", "0", "0x10", "1", "1e3", "2", "+5", " 7", "07", "7", "\u{a0}8", "10", "12abc", "", "١٢", &long,
        "A", "N1", "Z", "Ż",
    ];
    assert_eq!(v, want);
}
