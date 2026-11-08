//! server/api/line/route.ts: a line's stop patterns on a date from a zbiorkom feed's own router index or the BB one.

use std::sync::Arc;

use hyper::Response;
use serde::Serialize;

use super::{ApiRequest, json_cached, zb_live};
use crate::api_helpers::{bad_request, is_valid_date, is_valid_id, query_param, warming};
use crate::fleet_tracker::blocking_io;
use crate::gzm::{GzmLive, ZbTransport};
use crate::http::Body;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::router::{LineStop, get_index, line_timetable};
use crate::time::today_local;

/// A LineVariant without its trip id, plus the pattern's road shape (wire id, null = none).
#[derive(Serialize)]
struct Variant {
    headsign: String,
    stops: Vec<LineStop>,
    times: Vec<Vec<i32>>,
    shape: Option<String>,
}

#[derive(Serialize)]
struct LineBody<'a> {
    line: &'a str,
    operator: &'a str,
    date: &'a str,
    variants: Vec<Variant>,
}

/// GET /api/line?name=<line>[&date=YYYY-MM-DD]&city=<zbiorkom slug>; None = a BB request (`get_bb`, Node in proxy
/// mode).
pub fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, zb_live)
}

/// The route with the city's live layer from `live`, called only once the request passed the rate limit and the
/// checks (the started registry entry in `get`, a rigged one in a test).
pub fn handle<T: ZbTransport>(
    req: &ApiRequest,
    live: impl FnOnce(&'static str) -> Arc<GzmLive<T>>,
) -> Option<Response<Body>> {
    let slug = match req.zb_city() {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    if !allow_request(&req.ip(), 1.0) {
        return Some(too_many_requests());
    }
    let name = query_param(&req.query, "name").unwrap_or_default();
    let date = query_param(&req.query, "date")
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| today_local().to_string());
    if !is_valid_id(&name) {
        return Some(bad_request("Invalid 'name'"));
    }
    if !is_valid_date(&date) {
        return Some(bad_request("Invalid 'date' (expected YYYY-MM-DD)"));
    }
    let Some(feed) = live(slug).current_feed() else {
        return Some(warming());
    };
    // an O(trips) scan of the city's index (Warsaw: the largest)
    let found = blocking_io(|| line_timetable(&name, "GZM", &date, Some(&feed.router)));
    let variants = found
        .unwrap_or_default()
        .into_iter()
        .map(|v| {
            let shape = feed
                .trip(&v.trip_id)
                .and_then(|t| t.x.shape_id.as_deref())
                .filter(|k| !k.is_empty())
                .and_then(|k| feed.shapes.wire_id(k));
            Variant {
                headsign: v.headsign,
                stops: v.stops,
                times: v.times,
                shape,
            }
        })
        .collect();
    Some(json_cached(
        &LineBody {
            line: &name,
            operator: "GZM",
            date: &date,
            variants,
        },
        "public, max-age=3600",
    ))
}

/// GET /api/line?name=<line>[&op=KB|MZK][&date=YYYY-MM-DD] without a zbiorkom city: the KB + MZK router index, each
/// pattern's shape from the BB store. No GTFS feed built yet (a fresh volume builds it at start) = warming.
pub async fn get_bb<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    if !allow_request(&req.ip(), 1.0) {
        return too_many_requests();
    }
    let name = query_param(&req.query, "name").unwrap_or_default();
    let op = query_param(&req.query, "op").unwrap_or_else(|| "KB".to_owned());
    let date = query_param(&req.query, "date")
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| today_local().to_string());
    if !is_valid_id(&name) {
        return bad_request("Invalid 'name'");
    }
    if !matches!(op.as_str(), "KB" | "MZK" | "GZM") {
        return bad_request("Invalid 'op' (KB or MZK)");
    }
    if !is_valid_date(&date) {
        return bad_request("Invalid 'date' (expected YYYY-MM-DD)");
    }
    // an O(trips) scan, the index loaded from disk on first use
    let Some(found) = blocking_io(|| line_timetable(&name, &op, &date, get_index().as_deref())) else {
        return warming();
    };
    let variants = found
        .into_iter()
        .map(|v| {
            let ids: Vec<String> = v.stops.iter().map(|s| s.id.clone()).collect();
            Variant {
                shape: bb.line_shape_ref(&v.trip_id, &ids, &name, &v.headsign),
                headsign: v.headsign,
                stops: v.stops,
                times: v.times,
            }
        })
        .collect();
    json_cached(
        &LineBody {
            line: &name,
            operator: &op,
            date: &date,
            variants,
        },
        "public, max-age=3600",
    )
}
