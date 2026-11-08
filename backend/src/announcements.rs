//! lib/announcements.ts: one announcements list per city for /api/announcements and the push ticker: BB = KB's
//! feed + MZK's messages (one failed leg drops that leg, never the other), GZM = the scraped news page. `hash`
//! changes with the set (the client's unread dot).

use serde::Serialize;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};

use crate::fetch::string_err;
use crate::gzm_news::fetch_gzm_news;
use crate::js::{self, value_to_string};
use crate::kb_api::{KbSource, py_truthy};
use crate::mzk_api::MzkSource;
use crate::poller_singleton::{Bb, BbKinds};

/// One item as the wire carries it: id, rev, content_markdown, operator, url? (a KB entry keeps every upstream
/// field).
pub type AnnouncementItem = Map<String, Value>;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Announcements {
    pub announcements: Vec<AnnouncementItem>,
    pub hash: String,
}

/// `announcementKey`: `${operator}:${id}:${rev}`.
pub fn announcement_key(a: &AnnouncementItem) -> String {
    let s = |k: &str| value_to_string(a.get(k));
    format!("{}:{}:{}", s("operator"), s("id"), s("rev"))
}

/// `announcementTitle`: the first bold run of the item, else its first line, without U+FEFF, trimmed, at most 120
/// UTF-16 units (the push body).
// ponytail: a missing content_markdown reads as "" (the TS throws a TypeError out of the push tick)
pub fn announcement_title(a: &AnnouncementItem) -> String {
    let md = a.get("content_markdown").and_then(Value::as_str).unwrap_or_default();
    let head = first_bold(md).unwrap_or_else(|| md.split('\n').next().unwrap_or_default());
    let clean = head.replace('\u{feff}', "");
    js::utf16_prefix(clean.trim_matches(js::is_space), 120).to_owned()
}

/// `/\*\*([\s\S]+?)\*\*/` group 1. Without a closing `**` after the first opening one there is none after any
/// later one either.
fn first_bold(s: &str) -> Option<&str> {
    let open = s.find("**")? + 2;
    let rest = s.get(open..)?;
    let first = rest.chars().next()?.len_utf8();
    let close = rest.get(first..)?.find("**")? + first;
    rest.get(..close)
}

/// `fetchAnnouncements`: BB or GZM; another city has no source and answers an empty list. Err = `String(err)` of
/// a failed poller start, the GZM scrape or a null MZK message.
pub async fn fetch_announcements<T: BbKinds>(bb: &Bb<T>, city: &str) -> Result<Announcements, String> {
    let items = match city {
        "gzm" => fetch_gzm_news()
            .await?
            .iter()
            .filter_map(|n| match serde_json::to_value(n) {
                Ok(Value::Object(m)) => Some(m),
                _ => None,
            })
            .collect(),
        "bb" => fetch_bb(bb).await?,
        _ => Vec::new(),
    };
    let hash = items
        .iter()
        .map(|a| format!("{}:{}", value_to_string(a.get("id")), value_to_string(a.get("rev"))))
        .collect::<Vec<_>>()
        .join("|");
    Ok(Announcements {
        announcements: items,
        hash,
    })
}

async fn fetch_bb<T: BbKinds>(bb: &Bb<T>) -> Result<Vec<AnnouncementItem>, String> {
    bb.start_poller().await.map_err(string_err)?;
    let (kb, mzk) = tokio::join!(bb.api().fetch_announcements(None), bb.mzk_api().fetch_messages());
    let kb_raw = kb
        .ok()
        .filter(|v| py_truthy(Some(v)))
        .and_then(|v| v.get("announcements").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    // one malformed KB entry must not 502 the whole list (and drop the MZK messages with it)
    let mut items: Vec<AnnouncementItem> = kb_raw
        .into_iter()
        .filter_map(|a| {
            let mut m = match a {
                Value::Object(m) => m,
                Value::Array(xs) => xs.into_iter().enumerate().map(|(i, x)| (i.to_string(), x)).collect(),
                _ => return None,
            };
            m.insert("operator".into(), "KB".into());
            Some(m)
        })
        .collect();
    for m in mzk.unwrap_or_default() {
        items.push(mzk_item(&m)?);
    }
    Ok(items)
}

/// An OnTime message as an item. OnTime has no revision: `rev` hashes title + intro, so an in-place edit still
/// changes the hash (the unread badge).
fn mzk_item(m: &Value) -> Result<AnnouncementItem, String> {
    if m.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'loid')".to_owned());
    }
    let title = value_to_string(m.get("title"));
    let intro = value_to_string(m.get("intro"));
    let digest = Sha1::digest(format!("{title}\n{intro}").as_bytes());
    // parseInt(hex.slice(0, 8), 16) = the first four bytes, big-endian
    let rev = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let mut out = Map::new();
    if let Some(id) = m.get("loid") {
        out.insert("id".into(), id.clone());
    }
    out.insert("rev".into(), rev.into());
    out.insert(
        "content_markdown".into(),
        format!("**[MZK Bielsko-Biała] {title}**\n\n{intro}").into(),
    );
    out.insert("operator".into(), "MZK".into());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_bold_matches_the_lazy_regex() {
        assert_eq!(first_bold("a **b** c **d**"), Some("b"));
        assert_eq!(first_bold("***a**"), Some("*a"));
        assert_eq!(first_bold("****x"), None);
        assert_eq!(first_bold("**ż\n**"), Some("ż\n"));
        assert_eq!(first_bold("** no close"), None);
    }
}
