//! test/gzm-news.test.ts describe "parseGzmNews" over the captured page test/fixtures/gzm-news.html.

use std::collections::HashSet;

use unimaps::gzm_news::{GzmNewsItem, NEWS_BASE, parse_gzm_news};
use unimaps::js::{JsNum, number_to_string};

const HTML: &str = include_str!("../../test/fixtures/gzm-news.html");

/// TS `parseGzmNews(html)` (default base)
fn parse(html: &str) -> Vec<GzmNewsItem> {
    parse_gzm_news(html, NEWS_BASE).unwrap_or_else(|e| panic!("parse failed: {e}"))
}

#[test]
fn reads_id_title_update_stamp_and_lead_of_every_panel_captured_page_plus_one_synthetic() {
    let items = parse(HTML);
    assert_eq!(items.len(), 4);
    let first = &items[0];
    assert_eq!(first.id, JsNum(3224.0));
    assert_eq!(first.operator, "GZM");
    assert_eq!(first.url, "https://rj.transportgzm.pl/v2/news/i/3224/");
    let lead = "**[GZM] Komunikat o bieżących utrudnieniach w funkcjonowaniu komunikacji miejskiej.**\n\n\
                Aktualizacja: 30.10.2026 06:05\n\nW komunikacie prezentowane";
    assert!(first.content_markdown.starts_with(lead), "{:?}", first.content_markdown);
    assert!(first.rev > 0);
    // `new Set(ids)`: SameValueZero, which the shortest round-trip string of a number keys exactly
    let ids: HashSet<String> = items.iter().map(|i| number_to_string(i.id.0)).collect();
    assert_eq!(ids.len(), 4);
}

#[test]
fn decodes_entities_tolerates_a_missing_time_and_lead() {
    let last = &parse(HTML)[3];
    assert_eq!(last.id, JsNum(99.0));
    assert_eq!(
        last.content_markdown,
        "**[GZM] Objazd \"Centrum\" & zmiana tras**\n\nAktualizacja: 01.11.2026"
    );
}

#[test]
fn rev_follows_the_content_not_the_position() {
    let a = parse(HTML);
    let b = parse(&HTML.replacen("06:05", "07:05", 1));
    assert_ne!(a[0].rev, b[0].rev);
    assert_eq!(a[1].rev, b[1].rev);
}

#[test]
fn an_unrelated_page_yields_nothing() {
    let items = parse("<html><body><div class=\"panel panel-default\">no link</div></body></html>");
    assert_eq!(items, []);
}
