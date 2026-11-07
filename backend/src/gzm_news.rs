//! lib/gzm-news.ts: GZM has no announcements API, so the "Utrudnienia" list for GZM is scraped from the news page
//! (KB_GZM_NEWS_URL, server-rendered HTML: one `panel panel-default` per item with the article link, "Ostatnia
//! aktualizacja" and a lead paragraph). Fetched at most every REFRESH, a failed fetch keeps the last list. The
//! parser is pure; the TS regexes are hand-rolled scans that match the same spans.

use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::config::{GZM_NEWS_URL, USER_AGENT};
use crate::fetch::{client, fetch_error};
use crate::js::{self, JsNum};
use crate::logger;
use crate::micro_cache::MicroCache;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GzmNewsItem {
    pub id: JsNum,
    /// changes when the title, update stamp or lead changes (the unread badge, push)
    pub rev: u32,
    pub content_markdown: String,
    /// always "GZM"
    pub operator: &'static str,
    pub url: String,
}

/// the TS default `base` of parseGzmNews
pub const NEWS_BASE: &str = "https://rj.transportgzm.pl";
const REFRESH: Duration = Duration::from_secs(15 * 60);
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ITEMS: usize = 50;
/// the page is ~100 KB; anything past this (UTF-16 units) is not the list
const MAX_HTML: usize = 2_000_000;
/// a UTF-16 unit takes at most 3 UTF-8 bytes: this many bytes (plus a BOM) always decode the first MAX_HTML units
const MAX_BYTES: usize = 3 * MAX_HTML + 3;
const PANEL: &str = "<div class=\"panel panel-default\">";

/// `s.slice(0, max)` in UTF-16 units, cut before a pair the TS would split.
fn utf16_prefix(s: &str, max: usize) -> &str {
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

/// `/<[^>]+>/g` replaced by a space.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        let (head, after) = rest.split_at(i + 1);
        match after.find('>') {
            None => break,
            // "<>": no match at this "<"
            Some(0) => out.push_str(head),
            Some(j) => {
                out.push_str(&head[..i]);
                out.push(' ');
                rest = &after[j + 1..];
                continue;
            }
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// The entity after a "&" (`/&(#\d+|#x[\da-f]+|[a-z]+);/i`): (bytes consumed after the "&", replacement).
/// Err = the TS `String.fromCodePoint` RangeError.
fn entity(after: &str) -> Result<Option<(usize, String)>, String> {
    let b = after.as_bytes();
    let run = |from: usize, ok: fn(&u8) -> bool| b.iter().skip(from).take_while(|c| ok(c)).count();
    let closed = |end: usize| b.get(end) == Some(&b';');
    let code = |digits: &str, radix: u32| -> Result<String, String> {
        // ponytail: digits accumulate in a double, exact below 2^53 (parseInt rounds longer runs once); a lone
        // surrogate (Rust strings cannot hold one) becomes U+FFFD, also a pair written as two entities
        let n = digits
            .chars()
            .filter_map(|c| c.to_digit(radix))
            .fold(0.0, |n, d| n * f64::from(radix) + f64::from(d));
        if n > f64::from(0x10_ffff) {
            return Err(format!("RangeError: Invalid code point {}", js::number_to_string(n)));
        }
        Ok(char::from_u32(n as u32).unwrap_or('\u{fffd}').to_string())
    };
    if b.first() == Some(&b'#') {
        let dec = run(1, u8::is_ascii_digit);
        if dec > 0 {
            return Ok(if closed(1 + dec) {
                Some((dec + 2, code(&after[1..1 + dec], 10)?))
            } else {
                None
            });
        }
        if matches!(b.get(1), Some(b'x' | b'X')) {
            let hex = run(2, u8::is_ascii_hexdigit);
            if hex > 0 && closed(2 + hex) {
                return Ok(Some((hex + 3, code(&after[2..2 + hex], 16)?)));
            }
        }
        return Ok(None);
    }
    let name = run(0, u8::is_ascii_alphabetic);
    if name == 0 || !closed(name) {
        return Ok(None);
    }
    let rep = match after[..name].to_ascii_lowercase().as_str() {
        "amp" => "&".to_owned(),
        "lt" => "<".to_owned(),
        "gt" => ">".to_owned(),
        "quot" => "\"".to_owned(),
        "apos" => "'".to_owned(),
        "nbsp" => " ".to_owned(),
        // the TS lookup is a plain object: its inherited `constructor` answers
        "constructor" => "function Object() { [native code] }".to_owned(),
        _ => format!("&{};", &after[..name]),
    };
    Ok(Some((name + 1, rep)))
}

/// Visible text of an HTML fragment: tags to spaces, entities decoded, whitespace collapsed and trimmed.
fn text(html: &str) -> Result<String, String> {
    let stripped = strip_tags(html);
    let mut decoded = String::with_capacity(stripped.len());
    let mut rest = stripped.as_str();
    while let Some(i) = rest.find('&') {
        decoded.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match entity(after)? {
            Some((len, rep)) => {
                decoded.push_str(&rep);
                rest = &after[len..];
            }
            None => {
                decoded.push('&');
                rest = after;
            }
        }
    }
    decoded.push_str(rest);
    let mut out = String::with_capacity(decoded.len());
    let mut gap = false;
    for c in decoded.chars() {
        if js::is_space(c) {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    Ok(out)
}

/// The first `/<a href="\/v2\/news\/i\/(\d+)\/"\s*>([\s\S]*?)<\/a>/` match: (id digits, inner HTML).
fn link(panel: &str) -> Option<(&str, &str)> {
    const HEAD: &str = "<a href=\"/v2/news/i/";
    let mut from = 0;
    while let Some(p) = panel.get(from..)?.find(HEAD) {
        let rest = &panel[from + p + HEAD.len()..];
        let n = rest.bytes().take_while(u8::is_ascii_digit).count();
        if let Some(open) = rest[n..].strip_prefix("/\"").filter(|_| n > 0)
            && let Some(body) = open.trim_start_matches(js::is_space).strip_prefix('>')
        {
            return body.find("</a>").map(|e| (&rest[..n], &body[..e]));
        }
        from += p + 1;
    }
    None
}

/// `s` is `pat` with `d` = any ASCII digit.
fn shaped(s: &str, pat: &str) -> bool {
    s.len() == pat.len()
        && s.bytes()
            .zip(pat.bytes())
            .all(|(c, p)| if p == b'd' { c.is_ascii_digit() } else { c == p })
}

/// The first `/Ostatnia aktualizacja:\s*(\d{2}\.\d{2}\.\d{4})\s*(\d{2}:\d{2})?/` match: (date, time).
fn stamp(panel: &str) -> Option<(&str, Option<&str>)> {
    const HEAD: &str = "Ostatnia aktualizacja:";
    let mut from = 0;
    while let Some(p) = panel.get(from..)?.find(HEAD) {
        let rest = panel[from + p + HEAD.len()..].trim_start_matches(js::is_space);
        if let Some(date) = rest.get(..10).filter(|d| shaped(d, "dd.dd.dddd")) {
            let time = rest[10..]
                .trim_start_matches(js::is_space)
                .get(..5)
                .filter(|t| shaped(t, "dd:dd"));
            return Some((date, time));
        }
        from += p + 1;
    }
    None
}

/// The first `/<p class="lead list_lead">([\s\S]*?)<\/p>/` match.
fn lead(panel: &str) -> Option<&str> {
    const OPEN: &str = "<p class=\"lead list_lead\">";
    let rest = &panel[panel.find(OPEN)? + OPEN.len()..];
    rest.find("</p>").map(|e| &rest[..e])
}

/// The news list from the page's HTML (`base` = the site origin, TS default NEWS_BASE); a panel without a link or
/// title is skipped. Err = `String(err)` of what the TS throws (an entity past U+10FFFF).
pub fn parse_gzm_news(html: &str, base: &str) -> Result<Vec<GzmNewsItem>, String> {
    let mut out = Vec::new();
    // a chunk runs to the next panel opener: the first link, stamp and lead in it are this panel's
    for panel in utf16_prefix(html, MAX_HTML).split(PANEL).skip(1) {
        let Some((id, raw_title)) = link(panel) else {
            continue;
        };
        let title = text(raw_title)?;
        if title.is_empty() {
            continue;
        }
        let when = stamp(panel).map_or_else(String::new, |(d, t)| {
            t.map_or_else(|| d.to_owned(), |t| format!("{d} {t}"))
        });
        let lead = text(lead(panel).unwrap_or(""))?;
        let mut body = format!("**[GZM] {title}**");
        if !when.is_empty() {
            body.push_str(&format!("\n\nAktualizacja: {when}"));
        }
        if !lead.is_empty() {
            body.push_str(&format!("\n\n{lead}"));
        }
        let d = Sha1::digest(format!("{title}\n{when}\n{lead}").as_bytes());
        out.push(GzmNewsItem {
            id: JsNum(js::number(id)),
            rev: u32::from_be_bytes([d[0], d[1], d[2], d[3]]),
            content_markdown: body,
            operator: "GZM",
            url: format!("{base}/v2/news/i/{id}/"),
        });
        if out.len() == MAX_ITEMS {
            break;
        }
    }
    Ok(out)
}

type Items = Arc<Vec<GzmNewsItem>>;

static MEMO: LazyLock<MicroCache<Items, String>> = LazyLock::new(|| MicroCache::new(REFRESH, 1, |_| true));
/// the last good list (TS `cache`): what a failed refresh keeps serving
static LAST: Mutex<Option<Items>> = Mutex::new(None);

/// The page as `res.text()` reads it, up to MAX_BYTES.
/// ponytail: stops reading after MAX_BYTES where the TS reads the whole body; the parse sees the same first MAX_HTML
/// units, and only a body that breaks off past that point fails the TS alone.
async fn load(url: &str) -> Result<Vec<GzmNewsItem>, String> {
    let mut res = client()
        .get(url)
        .header("User-Agent", USER_AGENT.as_str())
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| fetch_error(&e, "TypeError: fetch failed"))?;
    if !res.status().is_success() {
        return Err(format!("Error: HTTP {}", res.status().as_u16()));
    }
    let mut buf = Vec::new();
    while buf.len() < MAX_BYTES {
        match res
            .chunk()
            .await
            .map_err(|e| fetch_error(&e, "TypeError: terminated"))?
        {
            Some(c) => buf.extend_from_slice(&c),
            None => break,
        }
    }
    let html = String::from_utf8_lossy(&buf);
    let base = url::Url::parse(url)
        .map_err(|_| "TypeError: Invalid URL".to_owned())?
        .origin()
        .ascii_serialization();
    parse_gzm_news(html.strip_prefix('\u{feff}').unwrap_or(&html), &base)
}

async fn refresh(url: &str) -> Result<Items, String> {
    let last = LAST.lock().unwrap_or_else(PoisonError::into_inner).clone();
    let res = match load(url).await {
        // an empty parse is a changed page layout, not "no news": keep what we had
        Ok(items) if items.is_empty() && last.is_some() => Err("Error: no panels parsed".to_owned()),
        r => r,
    };
    match (res, last) {
        (Ok(items), _) => {
            let items = Arc::new(items);
            *LAST.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&items));
            Ok(items)
        }
        (Err(err), None) => Err(err),
        (Err(err), Some(last)) => {
            logger::warn(
                "gzm-news",
                format_args!("refresh failed, keeping {} items: {err}", last.len()),
            );
            Ok(last)
        }
    }
}

/// The current GZM list (memo 15 min, in-flight deduped); Err (`String(err)` of the TS) only when nothing was ever
/// fetched or KB_GZM_NEWS_URL is off.
pub async fn fetch_gzm_news() -> Result<Items, String> {
    let Some(url) = GZM_NEWS_URL.as_deref() else {
        return Err("Error: GZM news off".to_owned());
    };
    MEMO.get("", || refresh(url)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hand-rolled scans against the TS regexes: expected values are lib/gzm-news.ts's output for this input.
    #[test]
    fn scans_match_the_ts_regexes() {
        let p = PANEL;
        let html = format!(
            "head{p}<a href=\"/v2/news/i/x/\">no</a><a href=\"/v2/news/i/0012/\" \n>T&amp;<b>x</b>&#65;&#X42; &foo; \
             &constructor; &#; a<>b</a>Ostatnia aktualizacja: 1.02.2026 Ostatnia aktualizacja:\u{a0}01.02.2026 \n 13:45\
             <p class=\"lead list_lead\"> L1 &nbsp;\u{3000}<i>it</i> </p>{p}<a href=\"/v2/news/i/7/\"><span> </span></a>\
             {p}<a href=\"/v2/news/i/8/\">Only</a>Ostatnia aktualizacja: 03.04.2025 1:2"
        );
        let items = parse_gzm_news(&html, "https://e.x").map(|v| serde_json::to_string(&v).unwrap_or_default());
        let want = r#"[{"id":12,"rev":3047438993,"content_markdown":"**[GZM] T& x AB &foo; function Object() { [native code] } &#; a<>b**\n\nAktualizacja: 01.02.2026 13:45\n\nL1 it","operator":"GZM","url":"https://e.x/v2/news/i/0012/"},{"id":8,"rev":2035167562,"content_markdown":"**[GZM] Only**\n\nAktualizacja: 03.04.2025","operator":"GZM","url":"https://e.x/v2/news/i/8/"}]"#;
        assert_eq!(items.as_deref(), Ok(want));
        let bad = format!("{p}<a href=\"/v2/news/i/1/\">&#1114112;</a>");
        assert_eq!(
            parse_gzm_news(&bad, NEWS_BASE),
            Err("RangeError: Invalid code point 1114112".to_owned())
        );
    }
}
