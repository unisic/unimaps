//! server/routes.ts and the route half of server/http.ts for the requests Rust answers itself: GET or HEAD of
//! /api/health and of every zbiorkom request. Everything else (other methods, BB requests, unknown paths, push,
//! status, gtfs-rt) stays with the Node child, through `crate::http`'s proxy.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Limited};
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioTimer};
use indexmap::IndexSet;
use serde::Serialize;

use crate::api_helpers::{City, internal_error, parse_city, query_param};
use crate::gzm::{GzmLive, get_zb, start_zb};
use crate::http::{Body, full, json, strip_hop};
use crate::js;
use crate::rate_limit::client_ip;
use crate::shared::cities::zb_city_of;
use crate::static_files::decode_uri_component;

pub mod announcements;
pub mod connections;
pub mod fleet;
pub mod fleet_history;
pub mod fleet_timeline;
pub mod fleet_vehicle;
pub mod geocode;
pub mod health;
pub mod line;
pub mod lines;
pub mod shapes;
pub mod stop_departures;
pub mod stop_timetable;
pub mod stops;
pub mod trip;
pub mod trip_execution;
pub mod trips;
pub mod vehicles;

/// The API routes Rust answers, one per server/api module (push, push/news, status and gtfs-rt.pb stay in Node).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Announcements,
    Connections,
    Fleet,
    FleetTimeline,
    FleetVehicle,
    FleetHistory,
    Geocode,
    Health,
    Line,
    Lines,
    Shapes,
    StopDepartures,
    StopTimetable,
    Stops,
    Trip,
    TripExecution,
    Trips,
    Vehicles,
}

/// server/routes.ts over a raw (still percent-encoded) pathname: the route and its raw `[name]` segment, "" when it
/// has none. `[name]` = `[^/]+`; a literal path wins over a `[param]` one, as the TS table order makes it.
fn match_route(path: &str) -> Option<(Route, &str)> {
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
        ["health"] => (Health, ""),
        ["line"] => (Line, ""),
        ["lines"] => (Lines, ""),
        ["shapes"] => (Shapes, ""),
        ["stop", id, "departures"] if !id.is_empty() => (StopDepartures, *id),
        ["stop", id, "timetable"] if !id.is_empty() => (StopTimetable, *id),
        ["stops"] => (Stops, ""),
        ["trip", id] if !id.is_empty() => (Trip, *id),
        ["trip_execution"] => (TripExecution, ""),
        ["trips"] => (Trips, ""),
        ["vehicles"] => (Vehicles, ""),
        _ => return None,
    })
}

/// True when the request belongs to a zbiorkom city (or is /api/health): a list route's `?city=` is an enabled
/// zbiorkom slug, an id route's id (decoded path param, `exec_id`) has a zbiorkom prefix, a trips/shapes batch holds
/// at least one such id (split and trimmed as the TS routes split it).
fn zb_request(route: Route, param: &str, query: &str) -> bool {
    use Route::*;
    let batch = || {
        query_param(query, "ids").is_some_and(|ids| {
            ids.split(',')
                .any(|id| zb_city_of(id.trim_matches(js::is_space)).is_some())
        })
    };
    match route {
        Health => true,
        Announcements | Connections | Fleet | FleetTimeline | FleetVehicle | FleetHistory | Geocode | Line | Lines
        | Stops | Vehicles => matches!(parse_city(query), Ok(City::Zb(_))),
        StopDepartures | StopTimetable | Trip => zb_city_of(param).is_some(),
        TripExecution => query_param(query, "exec_id").is_some_and(|id| zb_city_of(&id).is_some()),
        Trips | Shapes => batch(),
    }
}

/// The route Rust answers a request with, and its decodeURIComponent'd path param ("" when none); None = Node
/// answers it. Rust takes GET and HEAD of /api/health and of zbiorkom requests only: an unknown or disabled city,
/// a malformed escape in the path ("Malformed URL") and every BB request get Node's own answer.
pub fn pick(method: &Method, path: &str, query: &str) -> Option<(Route, String)> {
    if method != Method::GET && method != Method::HEAD {
        return None;
    }
    let (route, raw) = match_route(path)?;
    let param = decode_uri_component(raw)?;
    zb_request(route, &param, query).then_some((route, param))
}

/// What a handler reads of a request: no body (GET and HEAD only), so a test builds one directly.
#[derive(Debug, Clone, Default)]
pub struct ApiRequest {
    /// the route's `[name]` segment, decodeURIComponent'd; "" on a route without one
    pub param: String,
    /// the query as the TS handler's `new URL(req.url).search`: with its one '?' (query_param strips it), "" when none
    pub query: String,
    /// request headers, x-forwarded-for set from the socket when absent (as server/http.ts does)
    pub headers: HeaderMap,
}

impl ApiRequest {
    /// rate-limit key (lib/rate-limit.ts clientIp)
    pub fn ip(&self) -> String {
        client_ip(&self.headers)
    }

    /// The zbiorkom slug of a list route's `?city=`; Err(None) = a BB request (Node answers it), Err(Some) =
    /// parseCity's own 400 / 404.
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

/// Answers a request `pick` chose. The handler runs on its own task, so a panic becomes the 500 a TS throw gets
/// (server/http.ts logs `GET <path> failed: ..`); HEAD = the GET response with its content-length and no body.
/// None = the route is not ported yet: the caller proxies the request to Node.
pub async fn dispatch(
    node: &NodeClient,
    route: Route,
    head: bool,
    path: &str,
    req: ApiRequest,
) -> Option<Response<Body>> {
    let res = match tokio::spawn(run(route, req, node.clone())).await {
        Ok(None) => return None,
        Ok(Some(res)) => res,
        Err(err) => internal_error("http", format_args!("GET {path} failed: {err}")),
    };
    Some(if head { head_of(res).await } else { res })
}

/// One arm per route; an arm stays None (Node answers) until its route is ported.
async fn run(route: Route, req: ApiRequest, node: NodeClient) -> Option<Response<Body>> {
    match route {
        Route::Announcements => announcements::get(&req).await,
        Route::Connections => connections::get(&req),
        Route::Fleet => fleet::get(&req),
        Route::FleetTimeline => fleet_timeline::get(&req),
        Route::FleetVehicle => fleet_vehicle::get(&req),
        Route::FleetHistory => fleet_history::get(&req),
        Route::Geocode => geocode::get(&req).await,
        Route::Health => Some(health::get(&req, &node).await),
        Route::Line => line::get(&req),
        Route::Lines => lines::get(&req),
        Route::Shapes => shapes::get(&req, &node).await,
        Route::StopDepartures => stop_departures::get(&req),
        Route::StopTimetable => stop_timetable::get(&req),
        Route::Stops => stops::get(&req),
        Route::Trip => trip::get(&req),
        Route::TripExecution => trip_execution::get(&req),
        Route::Trips => trips::get(&req, &node).await,
        Route::Vehicles => vehicles::get(&req),
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

/// A Node sub-request takes at most this, headers and body together (a trips batch may wait on KB's upstream).
pub const NODE_TIMEOUT: Duration = Duration::from_secs(60);
/// A Node sub-request body past this is an error (a 300-id trips batch is a few MB).
pub const NODE_MAX_BODY: usize = 16 << 20;

/// GET sub-requests to the Node API on 127.0.0.1:KB_NODE_PORT, for the part of a request Node still owns
/// (/api/health's BB half, the BB ids of a mixed trips or shapes batch).
#[derive(Clone)]
pub struct NodeClient {
    client: Client<HttpConnector, Empty<Bytes>>,
    origin: String,
}

/// A Node sub-request's answer; hop-by-hop headers and content-length dropped (whoever uses the body re-frames it).
#[derive(Debug)]
pub struct NodeResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl NodeClient {
    pub fn new(port: u16) -> Self {
        let client = Client::builder(TokioExecutor::new())
            // under Node's 5 s keepAliveTimeout, as the proxy's client
            .pool_idle_timeout(Duration::from_secs(4))
            .pool_max_idle_per_host(16)
            .pool_timer(TokioTimer::new())
            .build_http();
        NodeClient {
            client,
            origin: format!("http://127.0.0.1:{port}"),
        }
    }

    /// GET `path_and_query` ("/api/...") with `headers`; Err on a connect failure, NODE_TIMEOUT or a body past
    /// NODE_MAX_BODY. Any status is Ok: the caller decides what a 429 or a 5xx means.
    pub async fn get(&self, path_and_query: &str, headers: HeaderMap) -> Result<NodeResponse, String> {
        let uri: Uri = format!("{}{path_and_query}", self.origin)
            .parse()
            .map_err(|e| format!("node {path_and_query}: {e}"))?;
        let mut req = Request::get(uri).body(Empty::new()).map_err(|e| e.to_string())?;
        *req.headers_mut() = headers;
        let call = async {
            let res = self.client.request(req).await.map_err(|e| e.to_string())?;
            let (mut parts, body) = res.into_parts();
            let body = Limited::new(body, NODE_MAX_BODY)
                .collect()
                .await
                .map_err(|e| e.to_string())?
                .to_bytes();
            strip_hop(&mut parts.headers);
            parts.headers.remove(CONTENT_LENGTH);
            Ok(NodeResponse {
                status: parts.status,
                headers: parts.headers,
                body,
            })
        };
        tokio::time::timeout(NODE_TIMEOUT, call)
            .await
            .map_err(|_| format!("node {path_and_query}: timeout"))?
    }
}

static INTERNAL_TOKEN: OnceLock<String> = OnceLock::new();

/// main hands the Node child this per-start token (KB_INTERNAL_TOKEN); the first call wins.
pub fn set_internal_token(token: String) {
    let _ = INTERNAL_TOKEN.set(token);
}

/// True when `x-kb-internal` carries the token: a call from our own Node child (push alerts reading a zbiorkom
/// board), which the departures route exempts from the rate limit.
pub fn is_internal(headers: &HeaderMap) -> bool {
    INTERNAL_TOKEN.get().is_some_and(|t| token_matches(headers, t))
}

fn token_matches(headers: &HeaderMap, token: &str) -> bool {
    // constant time over the bytes: the token's length is public (64 hex), its content is not
    headers.get("x-kb-internal").is_some_and(|v| {
        let (a, b) = (v.as_bytes(), token.as_bytes());
        !b.is_empty() && a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    })
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

/// The headers lib/rate-limit.ts clientIp reads: x-real-ip is its fallback when x-forwarded-for is empty.
const CLIENT_IP_HEADERS: [HeaderName; 2] = [
    HeaderName::from_static("x-forwarded-for"),
    HeaderName::from_static("x-real-ip"),
];

/// Headers of a sub-request to Node for a client's request: the ones clientIp reads, so Node rate-limits that
/// client.
pub fn node_headers(client: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for name in CLIENT_IP_HEADERS {
        for v in client.get_all(&name) {
            out.append(name.clone(), v.clone());
        }
    }
    out
}

/// A Node sub-request's answer as the client gets it.
pub fn node_response(res: NodeResponse) -> Response<Body> {
    let mut out = Response::new(full(res.body));
    *out.status_mut() = res.status;
    *out.headers_mut() = res.headers;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(path: &str, query: &str) -> Option<(Route, String)> {
        pick(&Method::GET, path, query)
    }

    #[test]
    fn list_routes_follow_the_city() {
        for (path, route) in [
            ("/api/announcements", Route::Announcements),
            ("/api/connections", Route::Connections),
            ("/api/fleet", Route::Fleet),
            ("/api/fleet/timeline", Route::FleetTimeline),
            ("/api/geocode", Route::Geocode),
            ("/api/line", Route::Line),
            ("/api/lines", Route::Lines),
            ("/api/stops", Route::Stops),
            ("/api/vehicles", Route::Vehicles),
        ] {
            assert_eq!(get(path, "city=gzm"), Some((route, String::new())), "{path}");
            assert_eq!(get(path, "?a=1&city=krakow"), Some((route, String::new())), "{path}");
            assert_eq!(get(path, "city=bb"), None, "{path}");
            assert_eq!(get(path, ""), None, "{path}");
            assert_eq!(get(path, "city=atlantis"), None, "{path}");
        }
        assert_eq!(
            get("/api/fleet/283_4285", "city=gzm"),
            Some((Route::FleetVehicle, "283_4285".into()))
        );
        assert_eq!(
            get("/api/fleet/12/history", "city=gzm"),
            Some((Route::FleetHistory, "12".into()))
        );
        assert_eq!(get("/api/fleet/12/history", ""), None);
        assert_eq!(get("/api/fleet/12", "city=nowhere"), None);
    }

    #[test]
    fn id_routes_follow_the_id() {
        assert_eq!(
            get("/api/stop/gzm%3A123/departures", ""),
            Some((Route::StopDepartures, "gzm:123".into()))
        );
        assert_eq!(
            get("/api/stop/krakow:9/timetable", "date=2026-11-08"),
            Some((Route::StopTimetable, "krakow:9".into()))
        );
        assert_eq!(get("/api/trip/gzm:1_2", ""), Some((Route::Trip, "gzm:1_2".into())));
        assert_eq!(get("/api/stop/19223/departures", ""), None);
        assert_eq!(get("/api/stop/mzk:1/timetable", ""), None);
        assert_eq!(get("/api/trip/atlantis:1", ""), None);
        // the city param does not make an id route zbiorkom
        assert_eq!(get("/api/trip/123", "city=gzm"), None);
        assert_eq!(
            get("/api/trip_execution", "exec_id=gzm%3A3_100&index=0"),
            Some((Route::TripExecution, String::new()))
        );
        assert_eq!(get("/api/trip_execution", "exec_id=QUJD"), None);
        assert_eq!(get("/api/trip_execution", ""), None);
    }

    #[test]
    fn batches_need_one_zbiorkom_id() {
        assert_eq!(get("/api/trips", "ids=1,gzm:2"), Some((Route::Trips, String::new())));
        assert_eq!(
            get("/api/trips", "ids=%20gzm:2%20"),
            Some((Route::Trips, String::new()))
        );
        assert_eq!(get("/api/trips", "ids=1,2,mzk:3"), None);
        assert_eq!(get("/api/trips", ""), None);
        assert_eq!(
            get("/api/shapes", "ids=kb:0123456789ab,krakow:x.abcdef"),
            Some((Route::Shapes, String::new()))
        );
        assert_eq!(get("/api/shapes", "ids=kb:0123456789ab,mzk:12"), None);
    }

    #[test]
    fn malformed_escapes_methods_and_other_paths_go_to_node() {
        assert_eq!(get("/api/stop/gzm%3/departures", ""), None);
        assert_eq!(get("/api/trip/gzm:%E0%A4%A", ""), None);
        assert_eq!(get("/api/fleet/%FF", "city=gzm"), None);
        assert_eq!(get("/api/health", ""), Some((Route::Health, String::new())));
        assert_eq!(
            pick(&Method::HEAD, "/api/vehicles", "city=gzm"),
            Some((Route::Vehicles, String::new()))
        );
        assert_eq!(pick(&Method::POST, "/api/health", ""), None);
        assert_eq!(pick(&Method::OPTIONS, "/api/vehicles", "city=gzm"), None);
        for path in [
            "/api",
            "/api/push",
            "/api/push/news",
            "/api/status",
            "/api/gtfs-rt.pb",
            "/api/nope",
            "/api/stop//departures",
            "/api/fleet/1/history/x",
            "/api/trip/a/b",
        ] {
            assert_eq!(get(path, "city=gzm&ids=gzm:1"), None, "{path}");
        }
        // a literal path wins over [sideNumber]; "timeline" is a side number under /history like in the TS table
        assert_eq!(
            get("/api/fleet/timeline/history", "city=gzm"),
            Some((Route::FleetHistory, "timeline".into()))
        );
    }

    #[test]
    fn internal_token_gate() {
        let token = "ab".repeat(32);
        let with = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert("x-kb-internal", HeaderValue::from_str(v).unwrap());
            h
        };
        assert!(token_matches(&with(&token), &token));
        assert!(!token_matches(&with(&"ab".repeat(31)), &token));
        assert!(!token_matches(&with(&format!("{}ac", "ab".repeat(31))), &token));
        assert!(!token_matches(&HeaderMap::new(), &token));
        assert!(!token_matches(&with(""), ""));
    }
}
