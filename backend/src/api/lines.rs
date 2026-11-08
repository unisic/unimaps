//! server/api/lines/route.ts: a zbiorkom feed's line catalog, or BB's GTFS catalog (crate::lines) followed by the
//! MZK poller's lines.

use std::sync::Arc;

use hyper::Response;
use serde::Serialize;

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{internal_error, warming};
use crate::fleet_tracker::blocking_io;
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::Body;
use crate::lines::get_lines;
use crate::poller_singleton::{Bb, BbKinds};

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
struct Lines<L> {
    count: usize,
    lines: Vec<L>,
}

/// GET /api/lines?city=<zbiorkom slug>; None = a BB request (`get_bb`).
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

/// GET /api/lines of BB: the KB entries as `{id, name, terminus, operator: "KB"}`, then MZK's.
pub async fn get_bb<T: BbKinds>(bb: &'static Bb<T>) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return internal_error("lines", err);
    }
    // the first read after a (re)build parses routes.txt
    let kb = blocking_io(get_lines);
    let kb_lines = kb
        .iter()
        .map(|l| serde_json::json!({ "id": l.id, "name": l.name, "terminus": l.terminus, "operator": "KB" }))
        .collect();
    let lines = bb.combined_lines(kb_lines);
    json_cached(
        &Lines {
            count: lines.len(),
            lines,
        },
        "public, max-age=3600",
    )
}
