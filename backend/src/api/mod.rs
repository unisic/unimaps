//! server/routes.ts and the route half of server/http.ts: `match_route`, `methods` and `dispatch_owned` answer every
//! API request.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, HeaderMap, HeaderValue};
use hyper::{Method, Response, StatusCode};
use indexmap::IndexSet;
use serde::Serialize;

use crate::api_helpers::{City, internal_error, parse_city};
use crate::fleet_tracker::get_fleet_tracker;
use crate::gzm::{GzmLive, get_zb, start_zb};
use crate::http::{Body, full, json};
use crate::js;
use crate::rate_limit::client_ip;

pub mod announcements;
pub mod connections;
pub mod fleet;
pub mod fleet_history;
pub mod fleet_timeline;
pub mod fleet_vehicle;
pub mod geocode;
pub mod gtfs_rt;
pub mod health;
pub mod line;
pub mod lines;
pub mod push;
pub mod push_news;
pub mod shapes;
pub mod status;
pub mod stop_departures;
pub mod stop_timetable;
pub mod stops;
pub mod traffic;
pub mod trip;
pub mod trip_execution;
pub mod trips;
pub mod vehicles;

/// The API routes, one per server/api module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Announcements,
    Connections,
    Fleet,
    FleetTimeline,
    FleetVehicle,
    FleetHistory,
    Geocode,
    GtfsRt,
    Health,
    Line,
    Lines,
    Push,
    PushNews,
    Shapes,
    Status,
    StopDepartures,
    StopTimetable,
    Stops,
    Trip,
    TripExecution,
    Traffic,
    Trips,
    Vehicles,
}

/// server/routes.ts over a raw (still percent-encoded) pathname: the route and its raw `[name]` segment, "" when it
/// has none. `[name]` = `[^/]+`; a literal path wins over a `[param]` one, as the TS table order makes it.
pub fn match_route(path: &str) -> Option<(Route, &str)> {
    use Route::*;
    let rest = path.strip_prefix("/api/")?;
    // no route has more than 3 segments: a 4th only has to make the slice match nothing
    let segs: Vec<&str> = rest.split('/').take(4).collect();
    Some(match segs.as_slice() {
        ["announcements"] => (Announcements, ""),
        ["connections"] => (Connections, ""),
        ["fleet"] => (Fleet, ""),
        ["fleet", "timeline"] => (FleetTimeline, ""),
        ["fleet", side] if !side.is_empty() => (FleetVehicle, *side),
        ["fleet", side, "history"] if !side.is_empty() => (FleetHistory, *side),
        ["geocode"] => (Geocode, ""),
        ["gtfs-rt.pb"] => (GtfsRt, ""),
        ["health"] => (Health, ""),
        ["line"] => (Line, ""),
        ["lines"] => (Lines, ""),
        ["push"] => (Push, ""),
        ["push", "news"] => (PushNews, ""),
        ["shapes"] => (Shapes, ""),
        ["status"] => (Status, ""),
        ["stop", id, "departures"] if !id.is_empty() => (StopDepartures, *id),
        ["stop", id, "timetable"] if !id.is_empty() => (StopTimetable, *id),
        ["stops"] => (Stops, ""),
        ["trip", id] if !id.is_empty() => (Trip, *id),
        ["trip_execution"] => (TripExecution, ""),
        ["traffic"] => (Traffic, ""),
        ["trips"] => (Trips, ""),
        ["vehicles"] => (Vehicles, ""),
        _ => return None,
    })
}

/// The methods the route's TS module exports, in server/routes.ts order (GET, POST, DELETE).
pub fn methods(route: Route) -> &'static [&'static str] {
    match route {
        Route::Push => &["GET", "POST", "DELETE"],
        Route::PushNews => &["POST", "DELETE"],
        _ => &["GET"],
    }
}

/// server/http.ts `allow`: `methods(route)` joined by ", ", then HEAD and OPTIONS.
pub fn allow(route: Route) -> &'static str {
    match route {
        Route::Push => "GET, POST, DELETE, HEAD, OPTIONS",
        Route::PushNews => "POST, DELETE, HEAD, OPTIONS",
        _ => "GET, HEAD, OPTIONS",
    }
}

/// What a handler reads of a request, so a test builds one directly.
#[derive(Debug, Clone, Default)]
pub struct ApiRequest {
    /// the route's `[name]` segment, decodeURIComponent'd; "" on a route without one
    pub param: String,
    /// the query as the TS handler's `new URL(req.url).search`: with its one '?' (query_param strips it), "" when none
    pub query: String,
    /// request headers, x-forwarded-for set from the socket when absent (as server/http.ts does)
    pub headers: HeaderMap,
    /// the handler's method: GET for a HEAD request
    pub method: Method,
    /// the body, at most 64 KB; None for GET
    pub body: Option<Bytes>,
}

impl ApiRequest {
    /// rate-limit key (lib/rate-limit.ts clientIp)
    pub fn ip(&self) -> String {
        client_ip(&self.headers)
    }

    /// The zbiorkom slug of a list route's `?city=`; Err(None) = a BB request, Err(Some) = parseCity's own 400 /
    /// 404.
    pub fn zb_city(&self) -> Result<&'static str, Option<Response<Body>>> {
        match parse_city(&self.query) {
            Ok(City::Zb(slug)) => Ok(slug),
            Ok(City::Bb) => Err(None),
            Err(res) => Err(Some(res)),
        }
    }
}

/// `void startZb(slug); getZb(slug)` of a list route: the city's live layer, started.
pub fn zb_live(slug: &str) -> Arc<GzmLive> {
    start_zb(slug);
    get_zb(slug)
}

/// `Response.json(data, { headers: { "Cache-Control": cache } })`.
pub fn json_cached(data: &impl Serialize, cache: &'static str) -> Response<Body> {
    match serde_json::to_string(data) {
        Ok(body) => {
            let mut res = json(StatusCode::OK, body);
            res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static(cache));
            res
        }
        Err(err) => internal_error("http", err),
    }
}

/// Answers a request whose route `match_route` found and whose method `methods` allows. The handler
/// runs on its own task, so a panic becomes server/http.ts's 500 (logged `<METHOD> <path> failed: ..`). HEAD is the
/// caller's (`head_of`).
pub async fn dispatch_owned(route: Route, path: &str, req: ApiRequest) -> Response<Body> {
    let method = req.method.clone();
    match tokio::spawn(run_owned(route, req)).await {
        Ok(res) => res,
        Err(err) => internal_error("http", format_args!("{method} {path} failed: {err}")),
    }
}

/// One arm per route: a list or id route answers a zbiorkom request with `<route>::get` and a BB one (None) with
/// `<route>::get_bb`.
async fn run_owned(route: Route, req: ApiRequest) -> Response<Body> {
    let bb = crate::poller_singleton::bb();
    match route {
        Route::Announcements => match announcements::get(&req).await {
            Some(res) => res,
            None => announcements::get_bb(&req, bb).await,
        },
        Route::Connections => match connections::get(&req) {
            Some(res) => res,
            None => connections::get_bb(&req, bb).await,
        },
        Route::Fleet => match fleet::get(&req) {
            Some(res) => res,
            None => fleet::get_bb(&req, bb, get_fleet_tracker).await,
        },
        Route::FleetTimeline => match fleet_timeline::get(&req) {
            Some(res) => res,
            None => fleet_timeline::get_bb(&req, bb, get_fleet_tracker).await,
        },
        Route::FleetVehicle => match fleet_vehicle::get(&req) {
            Some(res) => res,
            None => fleet_vehicle::get_bb(&req, bb, get_fleet_tracker).await,
        },
        Route::FleetHistory => match fleet_history::get(&req) {
            Some(res) => res,
            None => fleet_history::get_bb(&req, bb, get_fleet_tracker).await,
        },
        Route::Geocode => geocode::get_owned(&req).await,
        Route::GtfsRt => gtfs_rt::get(bb).await,
        Route::Health => health::get_owned(bb).await,
        Route::Line => match line::get(&req) {
            Some(res) => res,
            None => line::get_bb(&req, bb).await,
        },
        Route::Lines => match lines::get(&req) {
            Some(res) => res,
            None => lines::get_bb(bb).await,
        },
        Route::Push => push::handle(&req),
        Route::PushNews => push_news::handle(&req),
        Route::Shapes => shapes::get_owned(&req, bb).await,
        Route::Status => status::get(bb).await,
        Route::StopDepartures => match stop_departures::get(&req) {
            Some(res) => res,
            None => stop_departures::get_bb(&req, bb).await,
        },
        Route::StopTimetable => match stop_timetable::get(&req) {
            Some(res) => res,
            None => stop_timetable::get_bb(&req, bb).await,
        },
        Route::Stops => match stops::get(&req) {
            Some(res) => res,
            None => stops::get_bb(&req, bb).await,
        },
        Route::Trip => match trip::get(&req) {
            Some(res) => res,
            None => trip::get_bb(&req, bb).await,
        },
        Route::TripExecution => match trip_execution::get(&req) {
            Some(res) => res,
            None => trip_execution::get_bb(&req, bb).await,
        },
        Route::Traffic => traffic::get_owned(&req).await,
        Route::Trips => trips::get_owned(&req, bb).await,
        Route::Vehicles => match vehicles::get(&req) {
            Some(res) => res,
            None => vehicles::get_bb(&req, bb).await,
        },
    }
}

/// server/http.ts for HEAD: the GET headers plus the body's content-length (none on a bodiless 204/304), no body.
pub async fn head_of(res: Response<Body>) -> Response<Body> {
    let (mut parts, body) = res.into_parts();
    if !matches!(parts.status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED)
        && let Ok(c) = body.collect().await
    {
        parts
            .headers
            .insert(CONTENT_LENGTH, HeaderValue::from(c.to_bytes().len()));
    }
    Response::from_parts(parts, full(Bytes::new()))
}

/// `[...new Set(param.split(",").map((s) => s.trim()).filter(Boolean))]`: a batch route's ids, first occurrence
/// order.
pub fn batch_ids(param: &str) -> Vec<String> {
    let set: IndexSet<&str> = param
        .split(',')
        .map(|s| s.trim_matches(js::is_space))
        .filter(|s| !s.is_empty())
        .collect();
    set.into_iter().map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_table_methods_and_allow() {
        use Route::*;
        let get_only = "GET, HEAD, OPTIONS";
        for (path, route, allow_text) in [
            ("/api/announcements", Announcements, get_only),
            ("/api/connections", Connections, get_only),
            ("/api/fleet", Fleet, get_only),
            ("/api/fleet/timeline", FleetTimeline, get_only),
            ("/api/fleet/12", FleetVehicle, get_only),
            ("/api/fleet/12/history", FleetHistory, get_only),
            ("/api/geocode", Geocode, get_only),
            ("/api/gtfs-rt.pb", GtfsRt, get_only),
            ("/api/health", Health, get_only),
            ("/api/line", Line, get_only),
            ("/api/lines", Lines, get_only),
            ("/api/push", Push, "GET, POST, DELETE, HEAD, OPTIONS"),
            ("/api/push/news", PushNews, "POST, DELETE, HEAD, OPTIONS"),
            ("/api/shapes", Shapes, get_only),
            ("/api/status", Status, get_only),
            ("/api/stop/1/departures", StopDepartures, get_only),
            ("/api/stop/1/timetable", StopTimetable, get_only),
            ("/api/stops", Stops, get_only),
            ("/api/trip/1", Trip, get_only),
            ("/api/trip_execution", TripExecution, get_only),
            ("/api/traffic", Traffic, get_only),
            ("/api/trips", Trips, get_only),
            ("/api/vehicles", Vehicles, get_only),
        ] {
            assert_eq!(match_route(path).map(|m| m.0), Some(route), "{path}");
            assert_eq!(allow(route), allow_text, "{path}");
            assert_eq!(
                format!("{}, HEAD, OPTIONS", methods(route).join(", ")),
                allow_text,
                "{path}"
            );
        }
        for path in [
            "/api",
            "/api/",
            "/api/gtfs-rt%2Epb",
            "/api/gtfs-rtXpb",
            "/api/push/news/x",
            "/api/status/1",
            "/api/nope",
            "/api/stop//departures",
            "/api/fleet/1/history/x",
            "/api/trip/a/b",
        ] {
            assert_eq!(match_route(path), None, "{path}");
        }
        // a literal path wins over [sideNumber]; "timeline" is a side number under /history like in the TS table
        assert_eq!(
            match_route("/api/fleet/timeline/history"),
            Some((FleetHistory, "timeline"))
        );
        assert_eq!(
            match_route("/api/stop/gzm%3A123/departures"),
            Some((StopDepartures, "gzm%3A123"))
        );
    }
}
