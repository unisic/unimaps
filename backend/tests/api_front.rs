//! The Rust front end to end: `http::handle` behind the same hyper server shape as main.rs, in front of a fake Node
//! that records every request it gets and answers like Node's route table. The cases named after
//! scripts/http-contract.test.ts are its counterparts (that file runs against a live server, so it is not in CI);
//! the rest pin the stage-2 split: zbiorkom GET/HEAD answered in Rust, everything else proxied unchanged.

use std::convert::Infallible;
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::HeaderMap;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::runtime::Runtime;
use unimaps::gzm::{safe_gzm_health, safe_zb_health};
use unimaps::http::{App, handle};
use unimaps::rate_limit::client_ip;
use unimaps::static_files::Static;

const ALLOW: &str = "GET, HEAD, OPTIONS";
const NODE_HEALTH: &str =
    r#"{"status":"degraded","vehicles":3,"gzm":{"enabled":false},"ratio":1.5e-7,"zb":null,"tail":[1,2]}"#;
const NODE_TRIP: &str = r#"{"trip_id":"123","delay":1.5e-7}"#;
const INDEX_HTML: &str =
    r#"<!doctype html><html><head><script type="module" src="/assets/index-a1b2c3.js"></script></head></html>"#;
const ASSET: &str = "export const city = \"gzm\";\n";
/// zlib.brotliCompressSync(ASSET) from Node: the bytes the TS test decompresses back to ASSET
const ASSET_BR: [u8; 31] = [
    11, 13, 128, 101, 120, 112, 111, 114, 116, 32, 99, 111, 110, 115, 116, 32, 99, 105, 116, 121, 32, 61, 32, 34, 103,
    122, 109, 34, 59, 10, 3,
];

struct Seen {
    method: Method,
    uri: String,
    headers: HeaderMap,
    body: Bytes,
}

struct Res {
    status: u16,
    headers: HeaderMap,
    body: Bytes,
}

impl Res {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

struct Front {
    rt: Runtime,
    addr: SocketAddr,
    /// a front with a Node it did not start (no KB_NODE_CMD): zbiorkom stays Node's
    node_only: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

/// One runtime for the whole binary: the servers and the GZM singleton's tasks outlive every test.
static FRONT: LazyLock<Front> = LazyLock::new(|| {
    let dir = std::env::temp_dir().join(format!("unimaps-api-front-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // SAFETY: runs once, before anything in this binary reads the environment (every test starts with FRONT)
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", dir.join("output"));
        // a refused port: no zbiorkom feed, positions, SDIP or OSRM ever loads, so zbiorkom routes answer warming()
        std::env::set_var("KB_GZM_GTFS_URL", "http://127.0.0.1:1/gtfs");
        std::env::set_var("KB_GZM_POSITIONS_URL", "http://127.0.0.1:1/positions");
        std::env::set_var("KB_ZB_API_URL", "http://127.0.0.1:1");
        std::env::set_var("KB_GZM_SDIP", "0");
        std::env::set_var("KB_GZM_SDIP_URL", "http://127.0.0.1:1/sdip");
        std::env::set_var("KB_GZM_NEWS_URL", "off");
        std::env::set_var("KB_OSRM_URL", "off");
        std::env::set_var("KB_GEOCODER_URL", "off");
        std::env::set_var("KB_LOG_LEVEL", "error");
    }
    let out = dir.join("out");
    write_build(&out);
    let statics = Static::load(&out).unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (addr, node_only) = rt.block_on(async {
        let node = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node_port = node.local_addr().unwrap().port();
        tokio::spawn(fake_node(node, seen.clone()));
        let front = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = front.local_addr().unwrap();
        let only = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node_only = only.local_addr().unwrap();
        tokio::spawn(serve_front(
            only,
            Arc::new(App::new(Static::load(&out).unwrap(), node_port, false)),
        ));
        tokio::spawn(serve_front(front, Arc::new(App::new(statics, node_port, true))));
        (addr, node_only)
    });
    Front {
        rt,
        addr,
        node_only,
        seen,
    }
});

fn write_build(out: &Path) {
    std::fs::create_dir_all(out.join("assets")).unwrap();
    std::fs::write(out.join("index.html"), INDEX_HTML).unwrap();
    std::fs::write(
        out.join("brygady.html"),
        "<!doctype html><html><body>brygady</body></html>",
    )
    .unwrap();
    std::fs::write(out.join("404.html"), "<!doctype html><html><body>404</body></html>").unwrap();
    std::fs::write(out.join("assets/index-a1b2c3.js"), ASSET).unwrap();
    std::fs::write(out.join("assets/index-a1b2c3.js.br"), ASSET_BR).unwrap();
    // scripts/compress-static.mjs gives every page of the real build a .gz (and a .br), hence its Vary
    std::fs::write(out.join("index.html.gz"), gzip(INDEX_HTML)).unwrap();
    std::fs::write(out.join("assets/index-a1b2c3.js.gz"), gzip(ASSET)).unwrap();
}

fn gzip(s: &str) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(s.as_bytes()).unwrap();
    gz.finish().unwrap()
}

/// main.rs accept_loop without the connection cap.
async fn serve_front(listener: TcpListener, app: Arc<App>) {
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            continue;
        };
        let app = app.clone();
        tokio::spawn(async move {
            let svc = service_fn(|req| handle(&app, peer, req));
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .serve_connection(TokioIo::new(stream), svc)
                .await;
        });
    }
}

async fn fake_node(listener: TcpListener, seen: Arc<Mutex<Vec<Seen>>>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let seen = seen.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req: Request<Incoming>| {
                let seen = seen.clone();
                async move {
                    let (parts, body) = req.into_parts();
                    let body = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                    let uri = parts.uri.path_and_query().map_or("", |p| p.as_str()).to_owned();
                    let res = node_answer(&parts.method, &uri, body.len());
                    seen.lock().unwrap().push(Seen {
                        method: parts.method,
                        uri,
                        headers: parts.headers,
                        body,
                    });
                    Ok::<_, Infallible>(res)
                }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
        });
    }
}

/// What server/http.ts and its route modules answer, as far as these tests ask.
fn node_answer(method: &Method, uri: &str, body_len: usize) -> Response<Full<Bytes>> {
    let path = uri.split('?').next().unwrap_or("");
    let known = matches!(
        path,
        "/api/health" | "/api/vehicles" | "/api/stops" | "/api/trips" | "/api/push"
    ) || path.starts_with("/api/trip/");
    let (status, extra, body): (u16, Option<(&str, &str)>, String) = if !known {
        (404, None, r#"{"error":"Not found"}"#.into())
    } else if method == Method::OPTIONS {
        (204, Some(("allow", ALLOW)), String::new())
    } else if method == Method::POST && path == "/api/push" {
        if body_len > 64 * 1024 {
            (413, None, r#"{"error":"Body too large"}"#.into())
        } else {
            (200, None, r#"{"ok":true}"#.into())
        }
    } else if method != Method::GET && method != Method::HEAD {
        (405, Some(("allow", ALLOW)), r#"{"error":"Method not allowed"}"#.into())
    } else if path == "/api/health" {
        (503, Some(("cache-control", "no-store")), NODE_HEALTH.into())
    } else if uri == "/api/trips?ids=123" {
        (
            200,
            Some(("cache-control", "public, max-age=3600")),
            format!(r#"{{"count":1,"trips":{{"123":{NODE_TRIP}}}}}"#),
        )
    } else {
        (200, None, json!({ "node": uri }).to_string())
    };
    let mut b = Response::builder().status(status).header("x-node", "1");
    if !body.is_empty() {
        b = b.header("content-type", "application/json");
    }
    if let Some((k, v)) = extra {
        b = b.header(k, v);
    }
    b.body(Full::new(Bytes::from(body))).unwrap()
}

/// node:http with `agent: false`: no pooling, no accept-encoding of its own, no body decoding.
fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Res {
    request_at(FRONT.addr, method, path, headers, body)
}

fn request_at(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Res {
    let f = &*FRONT;
    f.rt.block_on(async {
        let client = Client::builder(TokioExecutor::new())
            .pool_max_idle_per_host(0)
            .build_http::<Full<Bytes>>();
        let mut req = Request::builder().method(method).uri(format!("http://{addr}{path}"));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let req = req.body(Full::new(Bytes::copy_from_slice(body))).unwrap();
        let res = tokio::time::timeout(Duration::from_secs(30), client.request(req))
            .await
            .unwrap()
            .unwrap();
        let (parts, body) = res.into_parts();
        let body = tokio::time::timeout(Duration::from_secs(30), body.collect())
            .await
            .unwrap()
            .unwrap()
            .to_bytes();
        Res {
            status: parts.status.as_u16(),
            headers: parts.headers,
            body,
        }
    })
}

fn get(path: &str) -> Res {
    request("GET", path, &[], &[])
}

/// The requests the fake Node got whose `name` header equals `value`, as (method, uri).
fn seen_by(name: &str, value: &str) -> Vec<(Method, String)> {
    let seen = FRONT.seen.lock().unwrap();
    seen.iter()
        .filter(|s| s.headers.get(name).is_some_and(|v| v == value))
        .map(|s| (s.method.clone(), s.uri.clone()))
        .collect()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().unwrap().keys().map(String::as_str).collect()
}

// scripts/http-contract.test.ts

#[test]
fn index_page_html_no_cache_weak_etag_revalidates_to_304() {
    let weak = |e: &str| {
        let Some(inner) = e.strip_prefix("W/\"").and_then(|e| e.strip_suffix('"')) else {
            return false;
        };
        let mut parts = inner.split('-');
        let hex = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_hexdigit()));
        hex(parts.next()) && hex(parts.next()) && parts.next().is_none()
    };
    let r = get("/");
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(r.header("cache-control"), Some("no-cache"));
    let etag = r.header("etag").unwrap_or("").to_owned();
    assert!(weak(&etag), "{etag}");
    assert_eq!(r.header("vary"), Some("Accept-Encoding"));
    assert_eq!(r.header("content-encoding"), None);
    assert_eq!(r.header("content-length"), Some(r.body.len().to_string().as_str()));
    assert!(String::from_utf8_lossy(&r.body).to_lowercase().contains("<html"));

    let again = request("GET", "/", &[("if-none-match", &etag)], &[]);
    assert_eq!(again.status, 304);
    assert_eq!(again.body.len(), 0);
    assert_eq!(again.header("etag"), Some(etag.as_str()));
    assert_eq!(again.header("cache-control"), Some("no-cache"));

    assert_eq!(request("GET", "/", &[("if-none-match", "W/\"0-0\"")], &[]).status, 200);
    assert_eq!(get("/index.html").header("etag"), Some(etag.as_str()));
}

#[test]
fn pages_answer_with_and_without_html() {
    let a = get("/brygady");
    let b = get("/brygady.html");
    assert_eq!(a.status, 200);
    assert_eq!(b.status, 200);
    assert_eq!(a.header("etag"), b.header("etag"));
    assert_eq!(a.header("content-type"), Some("text/html; charset=utf-8"));
}

#[test]
fn hashed_asset_immutable_br_gzip_identity_by_accept_encoding() {
    let html = String::from_utf8(get("/").body.to_vec()).unwrap();
    let src = html
        .split(['"'])
        .find(|s| s.starts_with("/assets/") && s.ends_with(".js"))
        .expect("index.html links a /assets/*.js bundle")
        .to_owned();
    let plain = get(&src);
    assert_eq!(plain.status, 200);
    assert_eq!(
        plain.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(
        plain.header("content-type"),
        Some("application/javascript; charset=utf-8")
    );
    assert_eq!(plain.header("content-encoding"), None);
    assert_eq!(
        plain.header("content-length"),
        Some(plain.body.len().to_string().as_str())
    );
    assert_eq!(plain.body, ASSET.as_bytes());

    let br = request("GET", &src, &[("accept-encoding", "gzip, deflate, br")], &[]);
    assert_eq!(br.header("content-encoding"), Some("br"));
    assert_eq!(br.header("content-length"), Some(br.body.len().to_string().as_str()));
    assert_eq!(br.body, ASSET_BR.as_slice());

    let gz = request("GET", &src, &[("accept-encoding", "gzip")], &[]);
    assert_eq!(gz.header("content-encoding"), Some("gzip"));
    assert_eq!(gz.header("content-length"), Some(gz.body.len().to_string().as_str()));
    let mut unzipped = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&gz.body[..]), &mut unzipped).unwrap();
    assert_eq!(unzipped.as_bytes(), plain.body);

    assert_eq!(
        request("GET", &src, &[("accept-encoding", "brotli")], &[]).header("content-encoding"),
        None
    );

    let head = request("HEAD", &src, &[("accept-encoding", "br")], &[]);
    assert_eq!(head.status, 200);
    assert_eq!(head.body.len(), 0);
    assert_eq!(head.header("content-length"), br.header("content-length"));
}

#[test]
fn unknown_page_the_404_page_with_status_404() {
    let r = get("/nope");
    assert_eq!(r.status, 404);
    assert_eq!(r.header("content-type"), Some("text/html; charset=utf-8"));
    assert!(!r.body.is_empty());
    let etag = r.header("etag").unwrap_or("").to_owned();
    assert_eq!(request("GET", "/nope", &[("if-none-match", &etag)], &[]).status, 404);
}

#[test]
fn pages_405_for_other_methods_400_for_a_malformed_escape() {
    let post = request("POST", "/", &[], b"x");
    assert_eq!(post.status, 405);
    assert_eq!(post.header("allow"), Some("GET, HEAD"));
    assert_eq!(post.body.len(), 0);
    assert_eq!(get("/%E0%A4%A").status, 400);
    assert_eq!(get("/%C5").status, 400);
}

#[test]
fn trailing_slash_308_to_the_bare_path_never_off_site() {
    for (from, to) in [
        ("/brygady/?x=1", "/brygady?x=1"),
        ("//evil.com/", "/evil.com"),
        ("///evil.com//", "/evil.com"),
        ("/api/vehicles/", "/api/vehicles"),
    ] {
        let r = get(from);
        assert_eq!(r.status, 308, "{from}");
        assert_eq!(r.header("location"), Some(to), "{from}");
    }
}

#[test]
fn api_404_405_options_from_the_route_table() {
    let case = [("x-case", "route-table")];
    for p in ["/api", "/api/nope"] {
        let r = request("GET", p, &case, &[]);
        assert_eq!(r.status, 404, "{p}");
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(r.json(), json!({ "error": "Not found" }));
    }
    let opt = request("OPTIONS", "/api/health", &case, &[]);
    assert_eq!(opt.status, 204);
    assert_eq!(opt.header("allow"), Some(ALLOW));

    let post = request("POST", "/api/vehicles", &case, b"{}");
    assert_eq!(post.status, 405);
    assert_eq!(post.header("allow"), Some(ALLOW));
    assert_eq!(post.json(), json!({ "error": "Method not allowed" }));
    // all four are Node's: the Rust front answers none of them
    assert_eq!(
        seen_by("x-case", "route-table"),
        [
            (Method::GET, "/api".to_owned()),
            (Method::GET, "/api/nope".to_owned()),
            (Method::OPTIONS, "/api/health".to_owned()),
            (Method::POST, "/api/vehicles".to_owned()),
        ]
    );
}

#[test]
fn api_health_answers_json_head_has_no_body() {
    let r = get("/api/health");
    assert!(r.status == 200 || r.status == 503, "status {}", r.status);
    assert!(r.header("content-type").unwrap_or("").starts_with("application/json"));
    assert!(r.json()["status"].is_string());
    let head = request("HEAD", "/api/health", &[], &[]);
    assert_eq!(head.body.len(), 0);
}

#[test]
fn api_a_body_over_64_kb_is_refused_with_413() {
    let body = vec![0x20; 70 * 1024];
    let r = request(
        "POST",
        "/api/push",
        &[("content-type", "application/json"), ("x-case", "push-413")],
        &body,
    );
    assert_eq!(r.status, 413);
    assert_eq!(r.json(), json!({ "error": "Body too large" }));
    let seen = FRONT.seen.lock().unwrap();
    let got: Vec<_> = seen
        .iter()
        .filter(|s| s.headers.get("x-case").is_some_and(|v| v == "push-413"))
        .collect();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].body.len(), 70 * 1024);
}

// the stage-2 split

#[test]
fn bb_requests_reach_node_unchanged_with_x_forwarded_for() {
    let sent = [
        ("x-case", "bb"),
        ("accept-encoding", "gzip"),
        ("if-none-match", "\"abc\""),
    ];
    for path in ["/api/vehicles", "/api/stops?q=%20x&city=bb", "/api/trip/123?index=0"] {
        let r = request("GET", path, &sent, &[]);
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(r.header("x-node"), Some("1"), "{path}");
        assert_eq!(r.json(), json!({ "node": path }), "{path}");
    }
    let seen = FRONT.seen.lock().unwrap();
    let got: Vec<_> = seen
        .iter()
        .filter(|s| s.headers.get("x-case").is_some_and(|v| v == "bb"))
        .collect();
    let uris: Vec<_> = got.iter().map(|s| (s.method.clone(), s.uri.as_str())).collect();
    assert_eq!(
        uris,
        [
            (Method::GET, "/api/vehicles"),
            (Method::GET, "/api/stops?q=%20x&city=bb"),
            (Method::GET, "/api/trip/123?index=0"),
        ]
    );
    for s in got {
        for (k, v) in sent {
            assert_eq!(s.headers.get(k).and_then(|v| v.to_str().ok()), Some(v), "{} {k}", s.uri);
        }
        // server/http.ts: a request with no proxy in front is keyed on its socket
        assert_eq!(
            s.headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()),
            Some("127.0.0.1")
        );
        assert!(s.body.is_empty());
    }
    drop(seen);
    // a forwarded-for the client sent is kept as is
    request(
        "GET",
        "/api/vehicles",
        &[("x-case", "bb-xff"), ("x-forwarded-for", "203.0.113.7")],
        &[],
    );
    let seen = FRONT.seen.lock().unwrap();
    let xff: Vec<_> = seen
        .iter()
        .filter(|s| s.headers.get("x-case").is_some_and(|v| v == "bb-xff"))
        .map(|s| {
            s.headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
        })
        .collect();
    assert_eq!(xff, ["203.0.113.7"]);
}

#[test]
fn zbiorkom_requests_never_reach_node() {
    let case = [("x-case", "zb"), ("x-forwarded-for", "198.51.100.11")];
    for path in ["/api/stops?city=gzm", "/api/stop/gzm:x/departures"] {
        let r = request("GET", path, &case, &[]);
        assert_eq!(r.status, 503, "{path}");
        assert_eq!(r.header("retry-after"), Some("10"), "{path}");
        assert_eq!(r.json(), json!({ "error": "Data is loading" }), "{path}");
        assert_eq!(r.header("x-node"), None, "{path}");
    }
    let head = request("HEAD", "/api/stops?city=gzm", &case, &[]);
    assert_eq!(head.status, 503);
    assert_eq!(head.body.len(), 0);
    assert_eq!(head.header("retry-after"), Some("10"));
    assert_eq!(seen_by("x-case", "zb"), []);
    assert_eq!(seen_by("x-forwarded-for", "198.51.100.11"), []);
}

#[test]
fn without_a_node_child_zbiorkom_and_health_stay_nodes() {
    let case = [("x-case", "node-only")];
    for path in [
        "/api/stops?city=gzm",
        "/api/stop/gzm:x/departures",
        "/api/vehicles?city=warsaw",
    ] {
        let r = request_at(FRONT.node_only, "GET", path, &case, &[]);
        assert_eq!(r.header("x-node"), Some("1"), "{path}");
    }
    let r = request_at(FRONT.node_only, "GET", "/api/health", &case, &[]);
    assert_eq!((r.status, r.header("x-node")), (503, Some("1")));
    assert_eq!(std::str::from_utf8(&r.body).unwrap(), NODE_HEALTH);
    assert_eq!(
        seen_by("x-case", "node-only"),
        [
            (Method::GET, "/api/stops?city=gzm".to_owned()),
            (Method::GET, "/api/stop/gzm:x/departures".to_owned()),
            (Method::GET, "/api/vehicles?city=warsaw".to_owned()),
            (Method::GET, "/api/health".to_owned()),
        ]
    );
}

#[test]
fn other_methods_reach_node() {
    let case = [("x-case", "methods")];
    let push = request("POST", "/api/push", &case, br#"{"subscription":{}}"#);
    assert_eq!(push.status, 200);
    assert_eq!(push.json(), json!({ "ok": true }));
    let opt = request("OPTIONS", "/api/vehicles?city=gzm", &case, &[]);
    assert_eq!(opt.status, 204);
    assert_eq!(opt.header("allow"), Some(ALLOW));
    assert_eq!(
        seen_by("x-case", "methods"),
        [
            (Method::POST, "/api/push".to_owned()),
            (Method::OPTIONS, "/api/vehicles?city=gzm".to_owned()),
        ]
    );
    let seen = FRONT.seen.lock().unwrap();
    let post = seen
        .iter()
        .find(|s| s.method == Method::POST && s.headers.get("x-case").is_some_and(|v| v == "methods"))
        .unwrap();
    assert_eq!(post.body, br#"{"subscription":{}}"#.as_slice());
}

#[test]
fn mixed_trips_batch_sends_only_the_other_ids_to_node() {
    let r = request(
        "GET",
        "/api/trips?ids=gzm:t1,123",
        &[("x-case", "mixed"), ("x-forwarded-for", "198.51.100.21")],
        &[],
    );
    // the GZM feed never loads here: its trip is absent and the answer uncached, as the TS route's gzmLoading
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("application/json"));
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert_eq!(
        std::str::from_utf8(&r.body).unwrap(),
        format!(r#"{{"count":1,"trips":{{"123":{NODE_TRIP}}}}}"#)
    );
    // a sub-request, not the proxied client request: only the client's address headers go along
    assert_eq!(seen_by("x-case", "mixed"), []);
    assert_eq!(
        seen_by("x-forwarded-for", "198.51.100.21"),
        [(Method::GET, "/api/trips?ids=123".to_owned())]
    );
}

#[test]
fn mixed_batch_sub_request_keys_node_on_the_clients_ip() {
    // lib/rate-limit.ts clientIp: an empty forwarded-for (kept by server/http.ts, the key is present) falls back
    // to x-real-ip, so the TS charges id 123 to 198.51.100.7, and Node must see the same address
    let r = request(
        "GET",
        "/api/trips?ids=gzm:t1,123",
        &[("x-forwarded-for", ""), ("x-real-ip", "198.51.100.7")],
        &[],
    );
    assert_eq!(r.status, 200);
    // the lock is released before asserting: a failure must not poison it for the other tests
    let ips: Vec<String> = FRONT
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.uri == "/api/trips?ids=123" && s.headers.get("x-forwarded-for").is_some_and(|v| v.is_empty()))
        .map(|s| client_ip(&s.headers))
        .collect();
    assert_eq!(ips, ["198.51.100.7"]);
}

#[test]
fn health_merges_gzm_and_zb_into_node_body() {
    let r = request("GET", "/api/health", &[("x-forwarded-for", "198.51.100.31")], &[]);
    assert_eq!(r.status, 503);
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert_eq!(r.header("x-node"), Some("1"));
    assert_eq!(r.header("content-type"), Some("application/json"));
    let text = std::str::from_utf8(&r.body).unwrap();
    assert!(
        text.starts_with(r#"{"status":"degraded","vehicles":3,"gzm":{"#),
        "{text}"
    );
    assert!(text.contains(r#"},"ratio":1.5e-7,"zb":{"#), "{text}");
    assert!(text.ends_with(r#"},"tail":[1,2]}"#), "{text}");
    let body = r.json();
    assert_eq!(keys(&body), ["status", "vehicles", "gzm", "ratio", "zb", "tail"]);
    assert_eq!(body["gzm"]["enabled"], true);
    assert_eq!(keys(&body["gzm"]), keys(&safe_gzm_health()));
    assert_eq!(body["zb"], safe_zb_health());
    assert_eq!(
        seen_by("x-forwarded-for", "198.51.100.31"),
        [(Method::GET, "/api/health".to_owned())]
    );
}

#[test]
fn query_is_read_once_as_url_search() {
    // new URL("http://h/api/vehicles??city=bb&city=gzm").searchParams: keys "?city" and "city", get("city") = "gzm"
    let r = request("GET", "/api/vehicles??city=bb&city=gzm", &[("x-case", "double-q")], &[]);
    // no zbiorkom poll ever lands here: the GZM vehicles body before the first one
    assert_eq!(r.status, 200);
    assert_eq!(r.header("x-node"), None);
    assert_eq!(r.json()["count"], 0);
    assert_eq!(seen_by("x-case", "double-q"), []);
}

#[test]
fn a_host_new_url_rejects_gets_nodes_400_like_any_request() {
    // server/http.ts: new Request(`http://${host}${req.url}`) throws -> 400 {"error":"Bad request"}, Node's to give
    for host in ["a:b", "example.com:99999", "a b"] {
        let case = [("host", host), ("x-case", "bad-host")];
        let zb = request("GET", "/api/vehicles?city=gzm", &case, &[]);
        assert_eq!(zb.header("x-node"), Some("1"), "{host}");
        let health = request("GET", "/api/health", &case, &[]);
        assert_eq!(health.header("x-node"), Some("1"), "{host}");
        assert_eq!(std::str::from_utf8(&health.body).unwrap(), NODE_HEALTH, "{host}");
    }
    let pair = ["/api/vehicles?city=gzm", "/api/health"].map(|u| (Method::GET, u.to_owned()));
    assert_eq!(
        seen_by("x-case", "bad-host"),
        pair.iter().cycle().take(6).cloned().collect::<Vec<_>>()
    );
}

#[test]
fn a_host_with_a_query_moves_the_query_like_url_search() {
    // new URL("http://a?city=gzm&/api/vehicles").search = "?city=gzm&/api/vehicles": a GZM request in TS
    let r = request(
        "GET",
        "/api/vehicles",
        &[("host", "a?city=gzm&"), ("x-case", "host-query")],
        &[],
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.header("x-node"), None);
    assert_eq!(r.json()["count"], 0);
    assert_eq!(seen_by("x-case", "host-query"), []);
}

#[test]
fn an_http11_request_without_host_goes_to_node_for_its_400() {
    // Node's requireHostHeader answers 400 before server/http.ts runs; hyper's client always sends Host, so a raw socket
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(FRONT.addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    s.write_all(b"GET /api/vehicles?city=gzm HTTP/1.1\r\nx-case: no-host\r\nconnection: close\r\n\r\n")
        .unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    assert!(out.starts_with(b"HTTP/1.1 "), "{}", String::from_utf8_lossy(&out));
    assert_eq!(
        seen_by("x-case", "no-host"),
        [(Method::GET, "/api/vehicles?city=gzm".to_owned())]
    );
}
