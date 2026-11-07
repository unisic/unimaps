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
