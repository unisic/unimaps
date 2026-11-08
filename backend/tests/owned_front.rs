//! The owned-mode front (no Node child, `App::owned`): server/http.ts's route table checks in its order, answered
//! by Rust. Only routes that touch no upstream run here (no BB branch: the KB and MZK clients are live), zbiorkom's
//! feed URL is a refused port. Push writes its VAPID pair and stores under the temp KB_OUTPUT_DIR; every alert and
//! news subscription is removed in the same test, so no push tick (30 s, 15 min) ever reads a board.

use std::sync::LazyLock;

#[allow(dead_code)]
#[path = "support/owned_front.rs"]
mod owned_front;

use owned_front::{Front, Res};

static FRONT: LazyLock<Front> = LazyLock::new(|| {
    let dir = std::env::temp_dir().join(format!("unimaps-owned-front-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // SAFETY: runs once, before anything in this binary reads the environment (every test starts with FRONT)
    unsafe {
        std::env::set_var("KB_OUTPUT_DIR", dir.join("output"));
        std::env::set_var("KB_GZM_GTFS_URL", "http://127.0.0.1:9/gtfs");
        std::env::set_var("KB_GZM_POSITIONS_URL", "http://127.0.0.1:9/positions");
        std::env::set_var("KB_ZB_API_URL", "http://127.0.0.1:9");
        std::env::set_var("KB_GZM_SDIP", "0");
        std::env::set_var("KB_GZM_SDIP_URL", "http://127.0.0.1:9/sdip");
        std::env::set_var("KB_GZM_NEWS_URL", "off");
        std::env::set_var("KB_OSRM_URL", "off");
        std::env::set_var("KB_GEOCODER_URL", "off");
        std::env::set_var("KB_LOG_LEVEL", "error");
    }
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("index.html"), "<!doctype html><html></html>").unwrap();
    std::fs::write(out.join("404.html"), "<!doctype html><html>404</html>").unwrap();
    Front::serve(&out)
});

fn raw(head: &str, body: &[u8]) -> Res {
    FRONT.raw(head, body)
}

fn request(method: &str, path: &str, body: &[u8]) -> Res {
    FRONT.request(method, path, &[], body)
}

#[test]
fn unknown_api_path_404() {
    let r = request("GET", "/api/nope", b"");
    assert_eq!((r.status, r.body.as_str()), (404, r#"{"error":"Not found"}"#));
}

#[test]
fn options_204_with_the_route_methods() {
    let r = request("OPTIONS", "/api/push", b"");
    assert_eq!(r.status, 204);
    assert_eq!(r.header("allow"), Some("GET, POST, DELETE, HEAD, OPTIONS"));
    assert_eq!(r.body, "");
}

#[test]
fn head_of_a_post_only_route_is_405_with_length_and_no_body() {
    let r = request("HEAD", "/api/push/news", b"");
    assert_eq!(r.status, 405);
    assert_eq!(r.header("allow"), Some("POST, DELETE, HEAD, OPTIONS"));
    assert_eq!(r.header("content-length"), Some("30"));
    assert_eq!(r.body, "");
    let r = request("DELETE", "/api/stops", b"");
    assert_eq!((r.status, r.body.as_str()), (405, r#"{"error":"Method not allowed"}"#));
    assert_eq!(r.header("allow"), Some("GET, HEAD, OPTIONS"));
}

#[test]
fn malformed_param_escape_400() {
    let r = request("GET", "/api/trip/%E0%A4%A", b"");
    assert_eq!((r.status, r.body.as_str()), (400, r#"{"error":"Malformed URL"}"#));
}

#[test]
fn body_over_64_kb_413_and_close() {
    let r = request("POST", "/api/push", &vec![b' '; 70 * 1024]);
    assert_eq!((r.status, r.body.as_str()), (413, r#"{"error":"Body too large"}"#));
    assert_eq!(r.header("connection"), Some("close"));
}

/// server/http.ts readBody resolves null on the chunk that passes 64 KB: the 413 goes out then and the socket
/// closes, the client never has to finish (or end) its upload.
#[test]
fn body_over_64_kb_413_before_the_upload_ends() {
    let chunk = vec![b' '; 70 * 1024];
    let heads = [
        "POST /api/push HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10485760\r\n\r\n".to_owned(),
        format!(
            "POST /api/push/news HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            chunk.len()
        ),
    ];
    for head in heads {
        let r = raw(&head, &chunk);
        assert_eq!(
            (r.status, r.body.as_str()),
            (413, r#"{"error":"Body too large"}"#),
            "{head}"
        );
        assert_eq!(r.header("connection"), Some("close"));
    }
}

#[test]
fn http11_without_host_400_empty() {
    let r = raw("GET /api/stops HTTP/1.1\r\n\r\n", b"");
    assert_eq!((r.status, r.body.as_str()), (400, ""));
    assert_eq!(r.header("connection"), Some("close"));
}

#[test]
fn zbiorkom_answers_itself() {
    let r = request("GET", "/api/stops?city=nowhere", b"");
    assert_eq!(r.status, 400);
    let r = request("GET", "/api/stops?city=gzm", b"");
    assert_eq!(r.status, 503);
    assert!(r.header("retry-after").is_some(), "{}", r.head);
}

const SUB: &str = r#"{"endpoint":"https://fcm.googleapis.com/fcm/send/owned-1","keys":{"p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","auth":"BTBZMqHH6r4Tts7J_aSIgg"}}"#;

#[test]
fn push_routes_key_add_remove_and_refusals() {
    let r = request("GET", "/api/push", b"");
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.header("cache-control"), Some("no-cache"));
    assert!(r.body.starts_with(r#"{"key":"B"#), "{}", r.body);

    let bad = |method: &str, path: &str, body: &str, err: &str| {
        let r = request(method, path, body.as_bytes());
        assert_eq!((r.status, r.body.as_str()), (400, err), "{method} {path} {body}");
    };
    bad(
        "POST",
        "/api/push",
        "{}",
        r#"{"error":"Invalid subscription or alert"}"#,
    );
    bad(
        "POST",
        "/api/push",
        "[1]",
        r#"{"error":"Invalid subscription or alert"}"#,
    );
    bad("POST", "/api/push", "", r#"{"error":"Invalid subscription or alert"}"#);
    bad(
        "DELETE",
        "/api/push",
        &format!(r#"{{"subscription":{SUB},"key":1}}"#),
        r#"{"error":"Invalid subscription or key"}"#,
    );
    bad(
        "POST",
        "/api/push/news",
        "{}",
        r#"{"error":"Invalid subscription or city"}"#,
    );
    bad(
        "POST",
        "/api/push/news",
        &format!(r#"{{"subscription":{SUB},"city":"waw"}}"#),
        r#"{"error":"Invalid subscription or city"}"#,
    );

    let until = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let alert = format!(
        r#"{{"key":"k1","designator":"1234","stopName":"Stop","line":"10","dest":"Dworzec","leadMin":5,"until":{until}}}"#
    );
    for (method, path, body) in [
        (
            "POST",
            "/api/push",
            format!(r#"{{"subscription":{SUB},"alert":{alert}}}"#),
        ),
        ("DELETE", "/api/push", format!(r#"{{"subscription":{SUB},"key":"k1"}}"#)),
        (
            "POST",
            "/api/push/news",
            format!(r#"{{"subscription":{SUB},"city":"bb"}}"#),
        ),
        (
            "DELETE",
            "/api/push/news",
            format!(r#"{{"subscription":{SUB},"city":"bb"}}"#),
        ),
    ] {
        let r = request(method, path, body.as_bytes());
        assert_eq!((r.status, r.body.as_str()), (204, ""), "{method} {path}");
        assert_eq!(r.header("content-type"), None);
    }
}
