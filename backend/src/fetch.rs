//! The process-wide outbound HTTP client (Node's global `fetch`): rustls on the ring provider, the system CA store.
//! Redirects: reqwest follows 10, fetch 20; no upstream redirects more than once.

use std::sync::OnceLock;

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        // reqwest's `rustls-no-provider` panics without a process default; Err = one is installed already
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .build()
            .expect("the TLS client config is static")
    })
}

/// `String(err)` of undici's fetch (Node 22) when it gave up on a request or a body read.
pub fn fetch_error(e: &reqwest::Error, otherwise: &str) -> String {
    if e.is_timeout() {
        "TimeoutError: The operation was aborted due to timeout".into()
    } else {
        otherwise.into()
    }
}

/// `String(err)` of the TS catch: a bare message is a thrown `Error`'s; a fetch or JSON failure names its class.
pub fn string_err(err: String) -> String {
    if ["TypeError: ", "TimeoutError: ", "SyntaxError: "]
        .iter()
        .any(|class| err.starts_with(class))
    {
        err
    } else {
        format!("Error: {err}")
    }
}
