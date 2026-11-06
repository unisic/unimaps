//! test/zb-cities.test.ts (the colour test stays TS-only: colours are client data)

use unimaps::shared::cities::*;

#[test]
fn every_slug_is_a_safe_path_segment_with_a_name() {
    assert!(ZB_CITIES.len() >= 50);
    assert_eq!(ZB_CITIES[0].0, "gzm");
    let mut seen = std::collections::HashSet::new();
    for (slug, city) in ZB_CITIES.iter() {
        assert!(
            !slug.is_empty() && slug.bytes().all(|b| b.is_ascii_alphabetic()),
            "{slug}"
        );
        assert!(!city.name.is_empty(), "{slug}");
        assert!(seen.insert(slug), "{slug}");
    }
}

#[test]
fn is_zb_slug_own_slugs_only() {
    assert!(is_zb_slug("warsaw"));
    assert!(!is_zb_slug("bb"));
    assert!(!is_zb_slug("constructor"));
    assert!(!is_zb_slug("__proto__"));
}

#[test]
fn zb_city_of_is_the_prefix_before_the_first_colon_when_it_is_a_slug() {
    assert_eq!(zb_city_of("gzm:283_4285"), Some("gzm"));
    assert_eq!(zb_city_of("warsaw:3_1234"), Some("warsaw"));
    assert_eq!(zb_city_of("lodz:trip:with:colons"), Some("lodz"));
    assert_eq!(zb_city_of("mzk:13954"), None);
    assert_eq!(zb_city_of("kb:0123"), None);
    assert_eq!(zb_city_of("warsaw"), None);
    assert_eq!(zb_city_of("gzm1"), None);
}
