//! server/http.ts: a trailing slash redirects, `/api` and `/api/*` go to the API, everything else to the static
//! build. Owned mode (no Node child): Rust answers every API request with server/http.ts's route table, methods,
//! OPTIONS/404/405/400/413/500 and HEAD. Proxy mode (a Node child, `App::new`): `crate::api::pick` chooses what Rust
//! answers itself: GET/HEAD of every zbiorkom request (a list route with `?city=<zbiorkom slug>`, an id route with a
//! zbiorkom id, the zbiorkom half of a mixed trips or shapes batch, whose other ids go to Node as a sub-request) and
//! of /api/health (Node's BB health with Rust's "gzm"/"zb" blocks). The rest goes to the Node process on
//! 127.0.0.1:KB_NODE_PORT, which owns BB, push, status, gtfs-rt, other methods, 404/405/OPTIONS/413.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::header::{ALLOW, CONNECTION, CONTENT_TYPE, HOST, HeaderMap, HeaderValue, LOCATION};
use hyper::{Method, Request, Response, StatusCode, Uri, Version};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioTimer};

use crate::api;
use crate::api_helpers::internal_error;
use crate::logger;
use crate::static_files::{Static, decode_uri_component};

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
    /// None = owned mode
    proxy: Option<Proxy>,
}

struct Proxy {
    node: Client<HttpConnector, Incoming>,
    node_origin: String,
    node_api: api::NodeClient,
    /// false: a Node this process did not start, which owns the zbiorkom cities itself (no KB_ZB_REMOTE), so every
    /// /api request goes to it as in stage 1 (main.rs no longer builds one; tests/api_front.rs does)
    owns_zb: bool,
}

impl App {
    /// Proxy mode: the API goes to the Node process on 127.0.0.1:`node_port`, but for what `api::pick` takes.
    pub fn new(statics: Static, node_port: u16, owns_zb: bool) -> Self {
        let node = Client::builder(TokioExecutor::new())
            // under Node's 5 s keepAliveTimeout, so a pooled socket is never one Node is closing
            .pool_idle_timeout(Duration::from_secs(4))
            .pool_max_idle_per_host(64)
            .pool_timer(TokioTimer::new())
            .build_http();
        App {
            statics,
            proxy: Some(Proxy {
                node,
                node_origin: format!("http://127.0.0.1:{node_port}"),
                node_api: api::NodeClient::new(node_port),
                owns_zb,
            }),
        }
    }

    /// Owned mode: no Node, Rust answers every API request.
    pub fn owned(statics: Static) -> Self {
        App { statics, proxy: None }
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
    let Some(px) = &app.proxy else {
        let head = req.method() == Method::HEAD;
        let res = owned(peer, req, path, &raw).await;
        return Ok(if head { api::head_of(res).await } else { res });
    };
    if !px.owns_zb {
        return Ok(proxy(px, peer, req, &raw).await);
    }
    // a Host new URL rejects: Node, which gets the same Host, answers 400 "Bad request" after its 404/405/400 checks;
    // an HTTP/1.1 request without Host: Node's requireHostHeader answers 400 before any handler
    let host_ok = req.version() != Version::HTTP_11 || req.headers().contains_key(HOST);
    let Some(search) = url_search(req.headers(), &raw).filter(|_| host_ok) else {
        return Ok(proxy(px, peer, req, &raw).await);
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
            method: Method::GET,
            body: None,
        };
        let head = req.method() == Method::HEAD;
        if let Some(res) = api::dispatch(&px.node_api, route, head, path, api_req).await {
            return Ok(res);
        }
    }
    Ok(proxy(px, peer, req, &raw).await)
}

/// The most server/http.ts reads of a request body (push subscriptions are ~1 KB).
const MAX_BODY: usize = 64 * 1024;
/// Node's server.requestTimeout: a body still arriving after this gets 408. ponytail: timed from the body read, not
/// from the request's first byte as Node does (hyper's header_read_timeout covers the head); move it into the
/// accept loop if a slow-header client ever matters.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// server/http.ts `api()` in owned mode, its checks in its order; HEAD is the caller's (`head_of`).
async fn owned(peer: SocketAddr, req: Request<Incoming>, path: &str, raw: &str) -> Response<Body> {
    // Node's requireHostHeader refuses an HTTP/1.1 request without Host before any handler
    if req.version() == Version::HTTP_11 && !req.headers().contains_key(HOST) {
        return closing(StatusCode::BAD_REQUEST, Bytes::new());
    }
    let Some((route, raw_param)) = api::match_route(path) else {
        return json(StatusCode::NOT_FOUND, r#"{"error":"Not found"}"#);
    };
    let method = if req.method() == Method::HEAD {
        Method::GET
    } else {
        req.method().clone()
    };
    let allow = HeaderValue::from_static(api::allow(route));
    if method == Method::OPTIONS {
        let mut res = Response::new(full(Bytes::new()));
        *res.status_mut() = StatusCode::NO_CONTENT;
        res.headers_mut().insert(ALLOW, allow);
        return res;
    }
    if !api::methods(route).contains(&method.as_str()) {
        let mut res = json(StatusCode::METHOD_NOT_ALLOWED, r#"{"error":"Method not allowed"}"#);
        res.headers_mut().insert(ALLOW, allow);
        return res;
    }
    let Some(param) = decode_uri_component(raw_param) else {
        return json(StatusCode::BAD_REQUEST, r#"{"error":"Malformed URL"}"#);
    };
    let (parts, incoming) = req.into_parts();
    let mut headers = parts.headers;
    forwarded_for(&mut headers, peer);
    let body = if method == Method::GET {
        None
    } else {
        match tokio::time::timeout(REQUEST_TIMEOUT, read_body(incoming)).await {
            Ok(Ok(Some(b))) => Some(b),
            Ok(Ok(None)) => return closing(StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"Body too large"}"#.into()),
            Ok(Err(err)) => {
                return internal_error("http", format_args!("{method} {path}: {err}"));
            }
            Err(_) => return closing(StatusCode::REQUEST_TIMEOUT, Bytes::new()),
        }
    };
    let Some(query) = url_search(&headers, raw) else {
        return json(StatusCode::BAD_REQUEST, r#"{"error":"Bad request"}"#);
    };
    let req = api::ApiRequest {
        param,
        query,
        headers,
        method,
        body,
    };
    api::dispatch_owned(route, path, req).await
}

/// server/http.ts readBody: the whole body, None on the frame that passes MAX_BODY. The 413 then goes out at once
/// with `connection: close` and hyper closes the socket after it, the unread rest unread (Node's destroySoon).
async fn read_body(mut body: Incoming) -> Result<Option<Bytes>, hyper::Error> {
    let mut buf = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(data) = frame?.into_data() else { continue };
        if buf.len() + data.len() > MAX_BODY {
            return Ok(None);
        }
        buf.extend_from_slice(&data);
    }
    Ok(Some(buf.into()))
}

/// A server/http.ts `plain()` answer with `connection: close` (a JSON body, or Node's empty one).
fn closing(status: StatusCode, body: Bytes) -> Response<Body> {
    let mut res = if body.is_empty() {
        let mut r = Response::new(full(body));
        *r.status_mut() = status;
        r
    } else {
        json(status, body)
    };
    res.headers_mut().insert(CONNECTION, HeaderValue::from_static("close"));
    res
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

async fn proxy(app: &Proxy, peer: SocketAddr, mut req: Request<Incoming>, raw: &str) -> Response<Body> {
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
