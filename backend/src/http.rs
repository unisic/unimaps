//! server/http.ts, front half: a trailing slash redirects, `/api` and `/api/*` go to the API, everything else to
//! the static build. `crate::api::pick` chooses what Rust answers itself: GET/HEAD of every zbiorkom request (a
//! list route with `?city=<zbiorkom slug>`, an id route with a zbiorkom id, the zbiorkom half of a mixed trips or
//! shapes batch, whose other ids go to Node as a sub-request) and of /api/health (Node's BB health with Rust's
//! "gzm"/"zb" blocks). The rest goes to the Node process on 127.0.0.1:KB_NODE_PORT, which still owns BB, push,
//! status, gtfs-rt, other methods, 404/405/OPTIONS/413.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::header::{CONTENT_TYPE, HOST, HeaderMap, HeaderValue, LOCATION};
use hyper::{Method, Request, Response, StatusCode, Uri, Version};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioTimer};

use crate::api;
use crate::logger;
use crate::static_files::Static;

pub type Body = BoxBody<Bytes, hyper::Error>;

pub fn full(b: impl Into<Bytes>) -> Body {
    Full::new(b.into()).map_err(|never| match never {}).boxed()
}

/// `Headers.get` of a Web Request: every value of `name` read as Latin-1 (Node's header strings), joined by ", ";
/// None when the header is absent.
pub fn header_str(h: &HeaderMap, name: &str) -> Option<String> {
    let mut vals = h.get_all(name).iter().peekable();
    vals.peek()?;
    let mut out = String::new();
    for (i, v) in vals.enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.extend(v.as_bytes().iter().map(|&b| char::from(b)));
    }
    Some(out)
}

pub struct App {
    pub statics: Static,
    node: Client<HttpConnector, Incoming>,
    node_origin: String,
    node_api: api::NodeClient,
    /// false: a Node this process did not start, which owns the zbiorkom cities itself (no KB_ZB_REMOTE), so every
    /// /api request goes to it as in stage 1
    owns_zb: bool,
}

impl App {
    pub fn new(statics: Static, node_port: u16, owns_zb: bool) -> Self {
        let node = Client::builder(TokioExecutor::new())
            // under Node's 5 s keepAliveTimeout, so a pooled socket is never one Node is closing
            .pool_idle_timeout(Duration::from_secs(4))
            .pool_max_idle_per_host(64)
            .pool_timer(TokioTimer::new())
            .build_http();
        App {
            statics,
            node,
            node_origin: format!("http://127.0.0.1:{node_port}"),
            node_api: api::NodeClient::new(node_port),
            owns_zb,
        }
    }
}

/// Connection-scoped headers (RFC 9110 7.6.1): they describe one hop, never the next.
pub(crate) fn strip_hop(h: &mut HeaderMap) {
    for name in [
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    ] {
        h.remove(name);
    }
}

pub fn json(status: StatusCode, body: impl Into<Bytes>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(full(body))
        .expect("static response")
}

pub async fn handle(app: &App, peer: SocketAddr, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    let raw = req.uri().path_and_query().map_or("/", |p| p.as_str()).to_owned();
    let (path, query) = raw.split_at(raw.find('?').unwrap_or(raw.len()));
    if path.len() > 1 && path.ends_with('/') {
        // leading slashes and backslashes collapsed: `//host/` or `/\host/` must not redirect off-site
        let to = format!("/{}{query}", path.trim_start_matches(['/', '\\']).trim_end_matches('/'));
        return Ok(Response::builder()
            .status(StatusCode::PERMANENT_REDIRECT)
            .header(LOCATION, to)
            .body(full(Bytes::new()))
            .expect("redirect"));
    }
    if path != "/api" && !path.starts_with("/api/") {
        return Ok(app.statics.serve(&req, path));
    }
    if !app.owns_zb {
        return Ok(proxy(app, peer, req, &raw).await);
    }
    // a Host new URL rejects: Node, which gets the same Host, answers 400 "Bad request" after its 404/405/400 checks;
    // an HTTP/1.1 request without Host: Node's requireHostHeader answers 400 before any handler
    let host_ok = req.version() != Version::HTTP_11 || req.headers().contains_key(HOST);
    let Some(search) = url_search(req.headers(), &raw).filter(|_| host_ok) else {
        return Ok(proxy(app, peer, req, &raw).await);
    };
    let _photon = match api::geocode::node_slot(req.method(), path, &search) {
        Ok(slot) => slot,
        Err(res) if req.method() == Method::HEAD => return Ok(api::head_of(res).await),
        Err(res) => return Ok(res),
    };
    if let Some((route, param)) = api::pick(req.method(), path, &search) {
        let mut headers = req.headers().clone();
        forwarded_for(&mut headers, peer);
        let api_req = api::ApiRequest {
            param,
            query: search,
            headers,
        };
        let head = req.method() == Method::HEAD;
        if let Some(res) = api::dispatch(&app.node_api, route, head, path, api_req).await {
            return Ok(res);
        }
    }
    Ok(proxy(app, peer, req, &raw).await)
}

/// `new URL(\`http://${req.headers.host ?? "localhost"}${req.url}\`).search` of server/http.ts, the query every TS
/// handler reads (a Host may carry one: `a?city=gzm&`); None = the URL does not parse (TS: 400 "Bad request").
/// ponytail: the url crate, not Node's Ada; both implement the WHATWG URL Standard, edge cases may differ.
fn url_search(h: &HeaderMap, raw: &str) -> Option<String> {
    let host = h.get(HOST).map_or_else(
        || "localhost".to_owned(),
        |v| v.as_bytes().iter().map(|&b| char::from(b)).collect(),
    );
    let url = url::Url::parse(&format!("http://{host}{raw}")).ok()?;
    Some(
        url.query()
            .filter(|q| !q.is_empty())
            .map_or_else(String::new, |q| format!("?{q}")),
    )
}

/// As server/http.ts: a request with no proxy in front is keyed on its socket (lib/rate-limit.ts clientIp).
fn forwarded_for(h: &mut HeaderMap, peer: SocketAddr) {
    if !h.contains_key("x-forwarded-for") {
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_str(&peer.ip().to_string()).expect("ip is a header value"),
        );
    }
}

async fn proxy(app: &App, peer: SocketAddr, mut req: Request<Incoming>, raw: &str) -> Response<Body> {
    let Ok(uri) = format!("{}{raw}", app.node_origin).parse::<Uri>() else {
        return json(StatusCode::BAD_REQUEST, r#"{"error":"Bad request"}"#);
    };
    *req.uri_mut() = uri;
    *req.version_mut() = Version::HTTP_11;
    let h = req.headers_mut();
    strip_hop(h);
    forwarded_for(h, peer);
    match app.node.request(req).await {
        Ok(res) => {
            let (mut parts, body) = res.into_parts();
            strip_hop(&mut parts.headers);
            Response::from_parts(parts, body.boxed())
        }
        Err(err) => {
            logger::error("http", format_args!("api proxy: {err}"));
            json(StatusCode::BAD_GATEWAY, r#"{"error":"Upstream request failed"}"#)
        }
    }
}
