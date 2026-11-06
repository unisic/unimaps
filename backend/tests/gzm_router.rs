//! test/gzm-router.test.ts (gzmStopKey so far; the router cases follow with the router port)

use unimaps::shared::gzm_stop_key::gzm_stop_key;

#[test]
fn gzm_stop_key_drops_the_post_number_in_every_form_the_feed_uses() {
    assert_eq!(gzm_stop_key("Pszczelnik Park 02"), "Pszczelnik Park");
    assert_eq!(
        gzm_stop_key("Chorzów Stadion Śląski Pętla Zach. 1t"),
        "Chorzów Stadion Śląski Pętla Zach."
    );
    assert_eq!(gzm_stop_key("Katowice Sądowa 1A"), "Katowice Sądowa");
    assert_eq!(gzm_stop_key("Urbanowice II 01"), "Urbanowice II");
}

#[test]
fn gzm_stop_key_matches_the_regexp_on_edge_cases() {
    // the expectations are what `name.replace(/\s\d{1,2}[a-z]?$/i, "")` returns in Node
    for (name, want) in [
        ("Rynek 123", "Rynek 123"),
        ("Rynek12", "Rynek12"),
        ("Rynek 1ab", "Rynek 1ab"),
        ("Rynek\u{A0}3", "Rynek"),
        ("Rynek\u{85}3", "Rynek\u{85}3"),
        ("Rynek\u{FEFF}3b", "Rynek"),
        (" 7", ""),
        ("7", "7"),
        ("", ""),
        ("Ząb 2Ż", "Ząb 2Ż"),
    ] {
        assert_eq!(gzm_stop_key(name), want, "{name:?}");
    }
}
