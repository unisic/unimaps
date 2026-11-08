//! server/api/announcements/route.ts: GZM's scraped news for a zbiorkom request (no other zbiorkom city has a news
//! source: 404), BB's KB + MZK announcements (`crate::announcements::fetch_announcements`) for a BB one.

use hyper::{Response, StatusCode};
use serde::Serialize;

use super::ApiRequest;
use crate::announcements::fetch_announcements;
use crate::api_helpers::{not_found, upstream_error};
use crate::config::GZM_NEWS_URL;
use crate::gzm_news::{GzmNewsItem, fetch_gzm_news};
use crate::http::{Body, json};
use crate::js;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};

#[derive(Serialize)]
struct Announcements<'a> {
    announcements: &'a [GzmNewsItem],
    hash: String,
}

/// GET /api/announcements?city=<zbiorkom slug>; None = a BB request (`get_bb`).
pub async fn get(req: &ApiRequest) -> Option<Response<Body>> {
    let slug = match req.zb_city() {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    if slug != "gzm" || GZM_NEWS_URL.is_none() {
        return Some(not_found("Not found"));
    }
    if !allow_request(&req.ip(), 1.0) {
        return Some(too_many_requests());
    }
    let items = match fetch_gzm_news().await {
        Ok(items) => items,
        Err(err) => return Some(upstream_error("announcements", err)),
    };
    let hash = items
        .iter()
        .map(|a| format!("{}:{}", js::number_to_string(a.id.0), a.rev))
        .collect::<Vec<_>>()
        .join("|");
    Some(
        match serde_json::to_string(&Announcements {
            announcements: &items,
            hash,
        }) {
            Ok(body) => json(StatusCode::OK, body),
            Err(err) => upstream_error("announcements", err),
        },
    )
}

/// GET /api/announcements of BB (parseCity already said BB).
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    if !allow_request(&req.ip(), 1.0) {
        return too_many_requests();
    }
    let list = match fetch_announcements(bb, "bb").await {
        Ok(list) => list,
        Err(err) => return upstream_error("announcements", message_of(&err)),
    };
    match serde_json::to_string(&list) {
        Ok(body) => json(StatusCode::OK, body),
        Err(err) => upstream_error("announcements", err),
    }
}

/// upstreamError's log text, `err.message` of the thrown Error: `String(err)` without its class name.
pub(super) fn message_of(err: &str) -> &str {
    ["Error: ", "TypeError: ", "TimeoutError: ", "SyntaxError: "]
        .iter()
        .find_map(|class| err.strip_prefix(class))
        .unwrap_or(err)
}
