//! test/rate-limit.test.ts on an injected clock (ms), plus the bounded key map.

use hyper::header::{HeaderMap, HeaderValue};
use unimaps::rate_limit::*;

const T0: f64 = 1_800_000_000_000.0;

#[test]
fn allows_the_per_ip_burst_refuses_past_it_and_refills_at_the_sustained_rate() {
    let rl = RateLimiter::new(500.0, T0);
    let mut allowed = 0;
    while allowed < 10_000 && rl.allow_request("192.0.2.1", 1.0, T0) {
        allowed += 1;
    }
    assert_eq!(allowed, 600);
    assert!(!rl.allow_request("192.0.2.1", 1.0, T0));
    assert!(rl.allow_request("192.0.2.2", 1.0, T0), "buckets are per IP");
    for _ in 0..40 {
        assert!(rl.allow_request("192.0.2.1", 1.0, T0 + 1000.0));
    }
    assert!(!rl.allow_request("192.0.2.1", 1.0, T0 + 1000.0));
}

#[test]
fn charges_cost_tokens_at_once_and_refuses_a_cost_it_cannot_cover() {
    let rl = RateLimiter::new(500.0, T0);
    assert!(rl.allow_request("192.0.2.3", 300.0, T0));
    assert!(rl.allow_request("192.0.2.3", 300.0, T0));
    assert!(!rl.allow_request("192.0.2.3", 1.0, T0));
}

#[test]
fn the_global_bucket_bounds_every_key_together() {
    let rl = RateLimiter::new(1.0, T0);
    for i in 0..8 {
        assert!(rl.allow_request(&format!("10.0.0.{i}"), 1.0, T0), "{i}");
    }
    assert!(!rl.allow_request("10.0.1.1", 1.0, T0));
}

#[test]
fn the_search_budget_is_200_ms_burst_250_ms_per_s_and_a_long_search_overdraws_it() {
    let rl = RateLimiter::new(500.0, T0);
    assert!(rl.allow_search(T0));
    rl.charge_search("192.0.2.10", 200.0, T0);
    assert!(!rl.allow_search(T0), "the burst is spent");
    assert!(rl.allow_search(T0 + 4.0));
    rl.charge_search("192.0.2.10", 1001.0, T0 + 4.0);
    assert!(!rl.allow_search(T0 + 2004.0), "an overdrawn budget waits its debt out");
    assert!(!rl.allow_search(T0 + 4004.0));
    assert!(rl.allow_search(T0 + 4008.0));
}

#[test]
fn a_clock_stepped_back_drains_nothing() {
    let rl = RateLimiter::new(500.0, T0);
    assert!(rl.allow_search(T0));
    assert!(rl.allow_search(T0 - 3_600_000.0));
    rl.charge_search("192.0.2.10", 199.0, T0 - 3_600_000.0);
    assert!(rl.allow_search(T0 - 3_600_000.0));
}

#[test]
fn a_search_charges_the_clients_own_bucket_one_token_per_2_5_ms() {
    let rl = RateLimiter::new(500.0, T0);
    assert!(rl.allow_request("192.0.2.4", 20.0, T0));
    rl.charge_search("192.0.2.4", 1450.0, T0);
    assert!(!rl.allow_request("192.0.2.4", 1.0, T0), "580 tokens of loop time spent");
    assert!(
        rl.allow_request("192.0.2.5", 1.0, T0),
        "other IPs keep their own bucket"
    );
    rl.charge_search("192.0.2.4", 250.0, T0);
    assert!(!rl.allow_request("192.0.2.4", 1.0, T0 + 2000.0), "100 tokens of debt");
    assert!(
        rl.allow_request("192.0.2.4", 20.0, T0 + 3000.0),
        "repaid at 40 tokens/s"
    );
}

#[test]
fn the_key_map_stays_bounded_by_evicting_the_oldest_key() {
    let rl = RateLimiter::new(1e9, T0);
    assert!(rl.allow_request("first", 600.0, T0));
    assert!(!rl.allow_request("first", 1.0, T0));
    for i in 1..10_000 {
        assert!(rl.allow_request(&format!("ip{i}"), 1.0, T0));
    }
    assert!(!rl.allow_request("first", 1.0, T0), "10 000 keys: still tracked");
    assert!(rl.allow_request("one-more", 1.0, T0));
    assert!(rl.allow_request("first", 1.0, T0), "evicted, so a fresh bucket");
    // only the first 64 characters key a bucket
    let long = "k".repeat(64);
    assert!(rl.allow_request(&format!("{long}a"), 600.0, T0));
    assert!(!rl.allow_request(&format!("{long}b"), 1.0, T0));
}

#[test]
fn client_ip_keys_on_the_last_x_forwarded_for_hop() {
    let h = |pairs: &[(&'static str, &'static str)]| {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(*k, HeaderValue::from_static(v));
        }
        m
    };
    assert_eq!(
        client_ip(&h(&[("x-forwarded-for", "6.6.6.6, 203.0.113.9")])),
        "203.0.113.9"
    );
    assert_eq!(client_ip(&h(&[])), "local");
    assert_eq!(
        client_ip(&h(&[
            ("x-forwarded-for", "1.1.1.1, 2.2.2.2"),
            ("x-forwarded-for", " 3.3.3.3 ")
        ])),
        "3.3.3.3"
    );
    assert_eq!(client_ip(&h(&[("x-forwarded-for", "1.1.1.1, ")])), "local");
    assert_eq!(
        client_ip(&h(&[("x-forwarded-for", ""), ("x-real-ip", "9.9.9.9")])),
        "9.9.9.9"
    );
    assert_eq!(
        client_ip(&h(&[("x-forwarded-for", ""), ("x-forwarded-for", "")])),
        "local"
    );
    assert_eq!(client_ip(&h(&[("x-real-ip", "9.9.9.9")])), "9.9.9.9");
}
