//! server/api/lines/route.ts, zbiorkom branch: the feed's line catalog.

use std::sync::Arc;

use hyper::Response;
use serde::Serialize;

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::warming;
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::Body;

#[derive(Serialize)]
struct Line<'a> {
    id: &'a str,
    name: &'a str,
    terminus: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    /// the zbiorkom dialect for every such city; the client labels it from the registry
    operator: &'static str,
}

#[derive(Serialize)]
struct Lines<'a> {
    count: usize,
    lines: Vec<Line<'a>>,
}

/// GET /api/lines?city=<zbiorkom slug>; None = a BB request (Node answers it).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let slug = match req.zb_city() {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    let Some(feed) = live(slug).current_feed() else {
        return Some(warming());
    };
    let lines: Vec<Line> = feed
        .lines
        .iter()
        .map(|l| Line {
            id: &l.id,
            name: &l.name,
            terminus: &l.terminus,
            kind: &l.kind,
            operator: "GZM",
        })
        .collect();
    Some(json_cached(
        &Lines {
            count: lines.len(),
            lines,
        },
        "public, max-age=3600",
    ))
}
