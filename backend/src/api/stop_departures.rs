//! server/api/stop/[designator]/departures/route.ts: a zbiorkom pole's board (with `all=1` the whole stop's) from
//! the city's local feed plus the live join, never an upstream call; a BB stop's merged KB + MZK board behind the
//! 4 s micro-cache (`crate::stop_board`).

use std::sync::Arc;

use hyper::Response;
use hyper::header::{HeaderValue, PRAGMA};
use serde::Serialize;

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{bad_request, is_valid_id, not_found, query_param, upstream_error, warming, zb_enabled};
use crate::departures_board_cache::BoardLeg;
use crate::fleet_tracker::blocking_io;
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::js::JsNum;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;
use crate::stop_board::{group_board, stop_board, stop_group};

/// `Response.json(data, { headers: { "Cache-Control": "no-store, ...", Pragma: "no-cache" } })` of the live routes.
pub(super) fn json_no_store(data: &impl Serialize) -> Response<Body> {
    let mut res = json_cached(data, "no-store, no-cache, must-revalidate, max-age=0");
    res.headers_mut().insert(PRAGMA, HeaderValue::from_static("no-cache"));
    res
}

/// GET /api/stop/<zbiorkom designator>/departures[?all=1]; None = not a zbiorkom stop (`get_bb`).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The rate-limit gate, the designator and `?all=` checks every branch makes first; Ok = `all=1`.
fn checked(req: &ApiRequest) -> Result<bool, Response<Body>> {
    if !allow_request(&req.ip(), 1.0) {
        return Err(too_many_requests());
    }
    if !is_valid_id(&req.param) {
        return Err(bad_request("Invalid stop designator"));
    }
    match query_param(&req.query, "all").as_deref() {
        None => Ok(false),
        Some("1") => Ok(true),
        Some(_) => Err(bad_request("Invalid all")),
    }
}

/// The route with the city's live layer from `live` (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let slug = zb_city_of(&req.param)?;
    let all = match checked(req) {
        Ok(all) => all,
        Err(res) => return Some(res),
    };
    if !zb_enabled(slug) {
        return Some(not_found("Not found"));
    }
    Some(match live(slug).departures(&req.param, all) {
        Lookup::Loading => warming(),
        Lookup::Unknown => not_found("Unknown stop"),
        Lookup::Found(board) => json_no_store(&board),
    })
}

#[derive(Serialize)]
struct BbDepartures<'a> {
    rows: &'a [serde_json::Map<String, serde_json::Value>],
    server_ts: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    poles: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<&'a [BoardLeg]>,
}

/// GET /api/stop/<BB designator>/departures[?all=1]: the pole's board, or with `all=1` every same-name pole's (one
/// rate-limit token per pole); 502 when every upstream leg failed.
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    let all = match checked(req) {
        Ok(all) => all,
        Err(res) => return res,
    };
    if let Err(err) = bb.start_poller().await {
        return upstream_error("departures", err);
    }
    // a changed stop list re-merges (Hungarian assignment) and a first read loads the GTFS directions
    let group = blocking_io(|| stop_group(bb, &req.param));
    let whole = all && group.len() > 1;
    if whole && !allow_request(&req.ip(), (group.len() - 1) as f64) {
        return too_many_requests();
    }
    let board = if whole {
        Arc::new(group_board(bb, &group).await)
    } else {
        stop_board(bb, &req.param).await
    };
    if board.failed_legs >= board.legs {
        let failed = board
            .failed
            .iter()
            .map(|leg| match leg {
                BoardLeg::Kb => "kb",
                BoardLeg::Mzk => "mzk",
            })
            .collect::<Vec<_>>()
            .join(",");
        return upstream_error(
            "departures",
            format_args!("all {} upstream leg(s) failed ({failed})", board.legs),
        );
    }
    json_no_store(&BbDepartures {
        rows: &board.rows,
        server_ts: JsNum(bb.now_ms() as f64 / 1000.0),
        poles: (group.len() > 1).then_some(group.len()),
        warnings: (!board.failed.is_empty()).then_some(&board.failed),
    })
}
