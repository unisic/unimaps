//! test/zb-residency.test.ts: zbiorkom city residency (KB_ZB_RESIDENT = 2: a quiet city is evicted for a newcomer,
//! one still viewed only once a minute, meanwhile the newcomer is a parked, never-started stand-in) and the
//! connections memo never keeping a swapped-out feed alive. The registry is built with an injected clock (the TS
//! mocks Date around the global one).

mod gzm_rig;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use gzm_rig::{Fake, at, feed_fn, files, load_gzm_feed, ok};
use unimaps::gzm::{GzmLive, ZbRegistry};
use unimaps::router::RouteQuery;

mod zbiorkom_residency {
    use super::*;

    #[test]
    fn drops_a_viewed_city_once_a_minute_a_quiet_one_at_once_parks_the_rest() {
        let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
        let c = Arc::clone(&clock);
        let reg = Arc::new(ZbRegistry::new(
            Arc::new(move || c.load(Ordering::SeqCst)),
            2,
            30,
            true,
            |_| {},
            |_| {},
        ));
        let resident = || {
            let h = reg.health();
            let mut keys: Vec<String> = h
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, v)| v.is_object())
                .map(|(k, _)| k.clone())
                .collect();
            keys.sort();
            keys
        };
        reg.get("krakow");
        reg.get("lodz");
        reg.get("szczecin");
        assert_eq!(resident(), ["lodz", "szczecin"]);

        let p = reg.get("krakow");
        assert!(p.current_feed().is_none());
        reg.start("krakow");
        assert!(!p.running());
        assert!(Arc::ptr_eq(&reg.get("krakow"), &p));
        assert_eq!(resident(), ["lodz", "szczecin"]);
        assert_eq!(reg.health()["parked_requests"], 3);

        for _ in 0..3 {
            clock.fetch_add(20_000, Ordering::SeqCst);
            reg.get("lodz");
            reg.get("szczecin");
        }
        assert!(!Arc::ptr_eq(&reg.get("krakow"), &p));
        assert_eq!(resident(), ["krakow", "szczecin"]);

        clock.fetch_add(31_000, Ordering::SeqCst);
        reg.get("krakow");
        reg.get("tricity");
        assert_eq!(resident(), ["krakow", "tricity"]);
    }
}

// describe("prebuiltJson"): not ported, the Rust backend has no gzip of a prebuilt body yet.

mod connections_memo {
    use super::*;

    #[test]
    fn lets_a_swapped_out_feed_be_collected() {
        let cur = Arc::new(Mutex::new(Some(Arc::new(load_gzm_feed(&files(), "gzm")))));
        let old = Arc::downgrade(cur.lock().unwrap().as_ref().unwrap());
        let live = GzmLive::new("gzm", Fake::new(|_| Ok(ok(""))))
            .with_now(Arc::new(|| at("08:00", 0) * 1000))
            .with_feed(feed_fn(&cur))
            .with_sdip_url(None);
        let q = |from, to| RouteQuery {
            from,
            to,
            ..RouteQuery::default()
        };
        assert_eq!(live.connections(&q("gzm:a", "gzm:c"), &[]).map(|c| c.len()), Some(1));
        *cur.lock().unwrap() = Some(Arc::new(load_gzm_feed(&files(), "gzm")));
        assert_eq!(live.connections(&q("gzm:a", "gzm:b"), &[]).map(|c| c.len()), Some(1));
        assert!(old.upgrade().is_none());
    }
}
