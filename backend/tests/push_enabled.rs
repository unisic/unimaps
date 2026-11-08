//! lib/config.ts `PUSH_ENABLED = envInt("KB_PUSH", 1, 0) !== 0`: KB_PUSH=0 switches push off, and both push routes
//! answer 404 for every method. Alone in its binary: it sets the environment.

use std::sync::LazyLock;

use http_body_util::BodyExt;
use hyper::Method;
use unimaps::api::{ApiRequest, push, push_news};
use unimaps::config::PUSH_ENABLED;

static OFF: LazyLock<()> = LazyLock::new(|| {
    // SAFETY: runs once, before anything in this binary reads the environment (every test starts with OFF)
    unsafe { std::env::set_var("KB_PUSH", "0") };
});

#[test]
fn kb_push_zero_is_off() {
    LazyLock::force(&OFF);
    assert!(!*PUSH_ENABLED);
}

#[tokio::test]
async fn push_routes_404_while_push_is_off() {
    LazyLock::force(&OFF);
    for (route, method) in [
        (push::handle as fn(&ApiRequest) -> _, Method::GET),
        (push::handle, Method::POST),
        (push::handle, Method::DELETE),
        (push_news::handle, Method::POST),
        (push_news::handle, Method::DELETE),
    ] {
        let res = route(&ApiRequest {
            method: method.clone(),
            ..Default::default()
        });
        assert_eq!(res.status(), 404, "{method}");
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], br#"{"error":"Not found"}"#, "{method}");
    }
}
