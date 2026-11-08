//! server/api/announcements/route.ts for zbiorkom cities: GZM's scraped news (lib/announcements.ts gzm branch);
//! no other zbiorkom city has a news source (404).

use hyper::{Response, StatusCode};
use serde::Serialize;

use super::ApiRequest;
use crate::api_helpers::{not_found, upstream_error};
use crate::config::GZM_NEWS_URL;
use crate::gzm_news::{GzmNewsItem, fetch_gzm_news};
use crate::http::{Body, json};
use crate::js;
use crate::rate_limit::{allow_request, too_many_requests};

#[derive(Serialize)]
struct Announcements<'a> {
    announcements: &'a [GzmNewsItem],
    hash: String,
}

/// GET /api/announcements?city=<zbiorkom slug>; None = a BB request (Node answers it).
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
