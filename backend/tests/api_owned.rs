//! The server end to end: `App::owned` behind main.rs's accept loop, with the live `poller_singleton::bb()`, push
//! and GZM, every upstream a refused port. The cases named after scripts/http-contract.test.ts are its
//! counterparts here; the BB route answers are the TS server's under the same environment (server/main.ts, no
//! network, 2026-11-08).
//! MZK has no URL setting (rozklady.bielsko.pl, as in the TS) and web push posts to the push services, so
//! HTTP(S)_PROXY points at the refused port too: reqwest reads it and every outbound call fails at connect.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

#[path = "support/build.rs"]
mod build;
#[path = "support/owned_front.rs"]
mod owned_front;

use build::{ASSET, ASSET_BR, write_build};
use owned_front::{Front, Res};

const ALLOW: &str = "GET, HEAD, OPTIONS";
const DEAD: &str = "http://127.0.0.1:9";

struct Owned {
    front: Front,
    dir: PathBuf,
    /// `<cwd>/output` before the server started: where a path that ignored KB_OUTPUT_DIR would land
    cwd_output: Vec<(PathBuf, u64, SystemTime)>,
}

static OWNED: LazyLock<Owned> = LazyLock::new(|| {
    let cwd_output = snapshot(&std::env::current_dir().unwrap().join("output"));
    let dir = std::env::temp_dir().join(format!("unimaps-api-owned-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let out = dir.join("out");
    write_build(&out);
    // SAFETY: runs once, before anything in this binary reads the environment (every test starts with OWNED)
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", dir.join("output"));
        std::env::set_var("KB_PUSH_DIR", dir.join("output/push"));
        std::env::set_var("KB_STATIC_DIR", &out);
        for k in ["NO_PROXY", "no_proxy", "REQUEST_METHOD"] {
            std::env::remove_var(k);
        }
        for k in [
            "KB_BASE_URL",
            "KB_GZM_GTFS_URL",
            "KB_GZM_POSITIONS_URL",
            "KB_ZB_API_URL",
            "KB_GZM_SDIP_URL",
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            std::env::set_var(k, DEAD);
        }
        for k in ["KB_GZM_NEWS_URL", "KB_OSRM_URL", "KB_GEOCODER_URL"] {
            std::env::set_var(k, "off");
        }
        std::env::set_var("KB_GZM_SDIP", "0");
        std::env::set_var("KB_LOG_LEVEL", "error");
    }
    let front = Front::serve(Path::new(&std::env::var_os("KB_STATIC_DIR").unwrap()));
    Owned { front, dir, cwd_output }
});

/// Every file under `dir` with its size and mtime, sorted; empty when `dir` does not exist.
fn snapshot(dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    let mut out = Vec::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let meta = e.metadata().unwrap();
            if meta.is_dir() {
                todo.push(e.path());
            } else {
                out.push((e.path(), meta.len(), meta.modified().unwrap()));
            }
        }
    }
    out.sort();
    out
}

fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Res {
    OWNED.front.request(method, path, headers, body)
}

fn get(path: &str) -> Res {
    request("GET", path, &[], &[])
}

fn json_of(r: &Res) -> Value {
    serde_json::from_slice(&r.bytes).unwrap_or_else(|e| panic!("{e}: {}", r.body))
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
    assert_eq!(r.header("content-length"), Some(r.bytes.len().to_string().as_str()));
    assert!(r.body.to_lowercase().contains("<html"));

    let again = request("GET", "/", &[("if-none-match", &etag)], &[]);
    assert_eq!(again.status, 304);
    assert_eq!(again.bytes.len(), 0);
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
    let html = get("/").body;
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
        Some(plain.bytes.len().to_string().as_str())
    );
    assert_eq!(plain.bytes, ASSET.as_bytes());

    let br = request("GET", &src, &[("accept-encoding", "gzip, deflate, br")], &[]);
    assert_eq!(br.header("content-encoding"), Some("br"));
    assert_eq!(br.header("content-length"), Some(br.bytes.len().to_string().as_str()));
    assert_eq!(br.bytes, ASSET_BR.as_slice());

    let gz = request("GET", &src, &[("accept-encoding", "gzip")], &[]);
    assert_eq!(gz.header("content-encoding"), Some("gzip"));
    assert_eq!(gz.header("content-length"), Some(gz.bytes.len().to_string().as_str()));
    let mut unzipped = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&gz.bytes[..]), &mut unzipped).unwrap();
    assert_eq!(unzipped.as_bytes(), plain.bytes);

    assert_eq!(
        request("GET", &src, &[("accept-encoding", "brotli")], &[]).header("content-encoding"),
        None
    );

    let head = request("HEAD", &src, &[("accept-encoding", "br")], &[]);
    assert_eq!(head.status, 200);
    assert_eq!(head.bytes.len(), 0);
    assert_eq!(head.header("content-length"), br.header("content-length"));
}

#[test]
fn unknown_page_the_404_page_with_status_404() {
    let r = get("/nope");
    assert_eq!(r.status, 404);
    assert_eq!(r.header("content-type"), Some("text/html; charset=utf-8"));
    assert!(!r.bytes.is_empty());
    let etag = r.header("etag").unwrap_or("").to_owned();
    assert_eq!(request("GET", "/nope", &[("if-none-match", &etag)], &[]).status, 404);
}

#[test]
fn pages_405_for_other_methods_400_for_a_malformed_escape() {
    let post = request("POST", "/", &[], b"x");
    assert_eq!(post.status, 405);
    assert_eq!(post.header("allow"), Some("GET, HEAD"));
    assert_eq!(post.bytes.len(), 0);
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
    for p in ["/api", "/api/nope"] {
        let r = get(p);
        assert_eq!(r.status, 404, "{p}");
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(json_of(&r), json!({ "error": "Not found" }));
    }
    let opt = request("OPTIONS", "/api/health", &[], &[]);
    assert_eq!(opt.status, 204);
    assert_eq!(opt.header("allow"), Some(ALLOW));

    let post = request("POST", "/api/vehicles", &[], b"{}");
    assert_eq!(post.status, 405);
    assert_eq!(post.header("allow"), Some(ALLOW));
    assert_eq!(json_of(&post), json!({ "error": "Method not allowed" }));
}

#[test]
fn api_health_answers_json_head_has_no_body() {
    let r = get("/api/health");
    assert!(r.status == 200 || r.status == 503, "status {}", r.status);
    assert!(r.header("content-type").unwrap_or("").starts_with("application/json"));
    assert!(json_of(&r)["status"].is_string());
    let head = request("HEAD", "/api/health", &[], &[]);
    assert_eq!(head.bytes.len(), 0);
}

#[test]
fn api_a_body_over_64_kb_is_refused_with_413() {
    let r = request(
        "POST",
        "/api/push",
        &[("content-type", "application/json")],
        &vec![0x20; 70 * 1024],
    );
    assert_eq!(r.status, 413);
    assert_eq!(json_of(&r), json!({ "error": "Body too large" }));
}

// server/http.ts and the BB routes, owned

#[test]
fn delete_on_a_get_route_405_with_allow() {
    let r = request("DELETE", "/api/vehicles", &[], &[]);
    assert_eq!(r.status, 405);
    assert_eq!(r.header("allow"), Some(ALLOW));
    assert_eq!(r.body, r#"{"error":"Method not allowed"}"#);
}

#[test]
fn head_gtfs_rt_has_the_length_of_get_and_no_body() {
    let g = get("/api/gtfs-rt.pb");
    let h = request("HEAD", "/api/gtfs-rt.pb", &[], &[]);
    for r in [&g, &h] {
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-type"), Some("application/x-protobuf"));
        assert_eq!(r.header("cache-control"), Some("no-store"));
        assert_eq!(
            r.header("content-disposition"),
            Some("attachment; filename=VehiclePositions.pb")
        );
        assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    }
    assert!(!g.bytes.is_empty());
    assert_eq!(g.header("content-length"), Some(g.bytes.len().to_string().as_str()));
    assert_eq!(h.header("content-length"), g.header("content-length"));
    assert_eq!(h.bytes.len(), 0);
}

#[test]
fn bb_routes_answer_with_upstreams_dead_no_file_outside_the_temp_dir() {
    const FAILED: &str = r#"{"error":"Upstream request failed"}"#;
    let started = std::time::Instant::now();
    for (path, status, cache, body) in [
        (
            "/api/stops",
            200,
            Some("no-cache"),
            r#"{"count":0,"stops":[],"partial":true}"#,
        ),
        (
            "/api/lines",
            200,
            Some("public, max-age=3600"),
            r#"{"count":0,"lines":[]}"#,
        ),
        ("/api/stop/123/departures", 502, None, FAILED),
        ("/api/stop/mzk:1/departures", 502, None, FAILED),
        (
            "/api/stop/123/timetable",
            200,
            Some("no-store"),
            r#"{"departures":[],"warnings":["kb"]}"#,
        ),
        (
            "/api/stop/mzk:1/timetable",
            200,
            Some("no-store"),
            r#"{"departures":[],"warnings":["mzk"]}"#,
        ),
        (
            "/api/stop/%E0%A4%A/departures",
            400,
            None,
            r#"{"error":"Malformed URL"}"#,
        ),
        ("/api/trip/123", 502, None, FAILED),
        ("/api/trip/mzk:1", 502, None, FAILED),
        ("/api/trip_execution?exec_id=abc", 502, None, FAILED),
        ("/api/trip_execution?exec_id=mzk:1", 502, None, FAILED),
        (
            "/api/trip_execution",
            400,
            None,
            r#"{"error":"exec_id query parameter is required"}"#,
        ),
        ("/api/trips?ids=1", 502, None, FAILED),
        ("/api/trips?ids=mzk:1", 502, None, FAILED),
        (
            "/api/shapes?ids=kb:abc.000000",
            400,
            None,
            r#"{"error":"Invalid shape id"}"#,
        ),
        (
            "/api/shapes?ids=kb:0123456789ab.abcdef,mzk:12.abcdef",
            200,
            Some("public, max-age=30"),
            r#"{"precision":6,"shapes":{},"missing":["kb:0123456789ab.abcdef","mzk:12.abcdef"]}"#,
        ),
        (
            "/api/connections?from=1&to=2",
            200,
            Some("public, max-age=60"),
            r#"{"count":0,"connections":[]}"#,
        ),
        ("/api/line?name=10", 503, None, r#"{"error":"Data is loading"}"#),
        ("/api/announcements", 200, None, r#"{"announcements":[],"hash":""}"#),
        (
            "/api/fleet/timeline",
            200,
            Some("no-cache"),
            r#"{"slotSecs":300,"points":[]}"#,
        ),
        (
            "/api/fleet/230/history",
            200,
            Some("no-cache"),
            r#"{"days":[],"complete":true}"#,
        ),
        ("/api/geocode?q=abc", 404, None, r#"{"error":"Not found"}"#),
    ] {
        let r = get(path);
        assert_eq!((r.status, r.body.as_str()), (status, body), "{path}");
        assert_eq!(r.header("cache-control"), cache, "{path}");
        assert_eq!(r.header("content-type"), Some("application/json"), "{path}");
    }
    assert_eq!(get("/api/line?name=10").header("retry-after"), Some("10"));

    let no_store = Some("no-store, no-cache, must-revalidate, max-age=0");
    let r = get("/api/vehicles");
    assert_eq!(r.status, 200);
    assert_eq!(r.header("cache-control"), no_store);
    assert_eq!(r.header("pragma"), Some("no-cache"));
    assert_eq!(r.header("vary"), Some("Accept-Encoding"));
    assert!(r.header("x-server-time").is_some_and(|t| t.parse::<u64>().is_ok()));
    let v = json_of(&r);
    assert_eq!(
        (&v["scan_count"], &v["last_scan"], &v["count"], &v["vehicles"]),
        (&json!(0), &json!(0), &json!(0), &json!([]))
    );

    let r = get("/api/health");
    let h = json_of(&r);
    assert_eq!((r.status, &h["status"]), (200, &json!("ok")));
    assert_eq!((&h["stops"], &h["mzk_stops"]), (&json!(0), &json!(0)));
    assert_eq!(h["merged_stops"]["partial"], json!(true));

    let r = get("/api/status");
    assert_eq!((r.status, r.header("cache-control")), (200, Some("no-cache")));
    let bb = &json_of(&r)["cities"][0];
    assert_eq!(bb["city"], "bb");
    assert_eq!(
        (&bb["sources"][0]["name"], &bb["sources"][1]["name"]),
        (&json!("KB"), &json!("MZK"))
    );

    let r = get("/api/fleet");
    assert_eq!((r.status, r.header("cache-control")), (200, no_store));
    let f = json_of(&r);
    assert_eq!((&f["stats"]["totalFleet"], &f["count"]), (&json!(147), &json!(147)));

    let r = get("/api/fleet/230");
    assert_eq!((r.status, r.header("cache-control")), (200, Some("no-cache")));
    let v = &json_of(&r)["vehicle"];
    assert_eq!(
        (&v["sideNumber"], &v["operator"], &v["status"]),
        (&json!("230"), &json!("MZK"), &json!("depot"))
    );

    assert_eq!(get("/api/push").status, 200);
    assert!(started.elapsed().as_secs() < 60, "{:?}", started.elapsed());
    assert!(OWNED.dir.join("output/push/vapid.json").is_file());
    assert_eq!(
        snapshot(&std::env::current_dir().unwrap().join("output")),
        OWNED.cwd_output,
        "a file was written outside the temp dir"
    );
}

// /api/push and /api/push/news: no TS test exists

const SUB: &str = r#"{"endpoint":"https://fcm.googleapis.com/fcm/send/api-owned-1","keys":{"p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","auth":"BTBZMqHH6r4Tts7J_aSIgg"}}"#;

#[test]
fn push_a_seventh_alert_of_one_subscription_503_retry_after_300() {
    let until = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() + 3600;
    let post = |key: &str| {
        let alert = format!(
            r#"{{"key":"{key}","designator":"1234","stopName":"Stop","line":"10","dest":"Dworzec","leadMin":5,"until":{until}}}"#
        );
        request(
            "POST",
            "/api/push",
            &[],
            format!(r#"{{"subscription":{SUB},"alert":{alert}}}"#).as_bytes(),
        )
    };
    let keys = ["a1", "a2", "a3", "a4", "a5", "a6"];
    for k in keys {
        let r = post(k);
        assert_eq!((r.status, r.body.as_str()), (204, ""), "{k}");
    }
    let full = post("a7");
    assert_eq!(
        (full.status, full.body.as_str()),
        (503, r#"{"error":"Too many alerts"}"#)
    );
    assert_eq!(full.header("retry-after"), Some("300"));
    // a key it already holds replaces that alert: not a seventh one
    assert_eq!(post("a1").status, 204);
    for k in keys {
        let body = format!(r#"{{"subscription":{SUB},"key":"{k}"}}"#);
        let r = request("DELETE", "/api/push", &[], body.as_bytes());
        assert_eq!((r.status, r.body.as_str()), (204, ""), "{k}");
    }
    assert_eq!(post("a7").status, 204);
    let r = request(
        "DELETE",
        "/api/push",
        &[],
        format!(r#"{{"subscription":{SUB},"key":"a7"}}"#).as_bytes(),
    );
    assert_eq!(r.status, 204);
}

/// lib/push-news.ts add + save: the subscription is kept as the browser sent it (PushSubscription.toJSON() adds
/// expirationTime) and written to news.v1.json whole, in the client's key order.
#[test]
fn push_news_persists_the_subscription_as_the_client_sent_it() {
    let sub = r#"{"endpoint":"https://fcm.googleapis.com/fcm/send/api-owned-news","expirationTime":null,"keys":{"auth":"BTBZMqHH6r4Tts7J_aSIgg","p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"}}"#;
    let body = format!(r#"{{"subscription":{sub},"city":"bb"}}"#);
    let r = request("POST", "/api/push/news", &[], body.as_bytes());
    assert_eq!((r.status, r.body.as_str()), (204, ""));
    std::thread::sleep(Duration::from_millis(2500));
    let file = std::fs::read_to_string(OWNED.dir.join("output/push/news.v1.json")).unwrap();
    assert!(file.contains(&format!(r#"{{"sub":{sub},"cities":["bb"]}}"#)), "{file}");
    let r = request("DELETE", "/api/push/news", &[], body.as_bytes());
    assert_eq!(r.status, 204);
}
