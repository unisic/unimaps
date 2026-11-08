//! test/city-status.test.ts: what a zbiorkom or SDIP answer means for a city's dot on /status.

mod gzm_rig;

use gzm_rig::{Fake, LAT, LON_A, RecOpts, at, ok, rec};
use serde_json::{Value, json};
use unimaps::city_status::{SourceStatus, probe_sdip, probe_zb};
use unimaps::gzm::ZbResponse;

fn status(code: u16) -> ZbResponse {
    ZbResponse {
        status: code,
        ..ZbResponse::default()
    }
}

fn wire(s: &SourceStatus) -> Value {
    serde_json::to_value(s).unwrap()
}

mod probe_zb {
    use super::*;

    fn now() -> i64 {
        at("08:03", 0) * 1000
    }

    #[tokio::test]
    async fn counts_the_parsed_vehicles_and_dates_them_by_the_newest_fix() {
        let body = json!({ "positions": [
            rec(&RecOpts { ts: at("08:02", 0), ..RecOpts::default() }),
            rec(&RecOpts { key: Some("1_1"), ts: at("08:02", 40), ..RecOpts::default() }),
        ] })
        .to_string();
        let f = Fake::new(move |_| Ok(ok(body.clone())));
        assert_eq!(
            wire(&probe_zb("gzm", &f, now()).await),
            json!({ "name": "zbiorkom", "state": "ok", "vehicles": 2, "age": 20 })
        );
    }

    #[tokio::test]
    async fn tells_an_empty_answer_night_or_the_outage_of_2026_10_31_from_a_dead_one() {
        let empty = Fake::new(|_| Ok(ok(json!({ "positions": [] }).to_string())));
        assert_eq!(wire(&probe_zb("gzm", &empty, now()).await)["state"], "empty");
        async fn down(f: Fake) -> (Value, Option<String>) {
            let s = probe_zb("krakow", &f, now()).await;
            (wire(&s)["state"].clone(), s.error)
        }
        let pair = |state: &str, error: &str| (json!(state), Some(error.to_owned()));
        assert_eq!(down(Fake::new(|_| Ok(status(503)))).await, pair("down", "HTTP 503"));
        assert_eq!(
            down(Fake::new(|_| Ok(ok("<html>")))).await,
            pair("down", "invalid response")
        );
        assert_eq!(
            down(Fake::new(|_| Ok(ok(json!({ "vehicles": [] }).to_string())))).await,
            pair("down", "invalid response")
        );
        assert_eq!(
            down(Fake::new(|_| Err("TypeError: fetch failed".into()))).await,
            pair("down", "network error")
        );
        assert_eq!(
            down(Fake::new(|_| Err("TimeoutError: t".into()))).await,
            pair("down", "timeout")
        );
    }
}

mod probe_sdip {
    use super::*;

    const URL: &str = "https://sdip.invalid/vm/main";

    #[tokio::test]
    async fn opens_a_session_then_counts_the_list() {
        let f = Fake::new(|req| {
            if req.url == URL {
                return Ok(ZbResponse {
                    set_cookies: vec!["JSESSIONID=abc; Path=/".into()],
                    ..status(200)
                });
            }
            assert_eq!(req.header("Cookie"), Some("JSESSIONID=abc"));
            Ok(ok(
                json!([{ "id": "104_1", "lat": LAT, "lon": LON_A, "bearing": 0 }]).to_string()
            ))
        });
        assert_eq!(
            wire(&probe_sdip(&f, URL).await),
            json!({ "name": "SDIP", "state": "ok", "vehicles": 1, "age": null })
        );
    }

    #[tokio::test]
    async fn is_down_without_a_session() {
        let s = probe_sdip(&Fake::new(|_| Ok(status(502))), URL).await;
        assert_eq!(
            (wire(&s)["state"].clone(), s.error),
            (json!("down"), Some("HTTP 502".to_owned()))
        );
    }
}

mod city_status {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use unimaps::city_status::city_status_with;
    use unimaps::gzm::ZbTransport;
    use unimaps::kb_api::KbSource;
    use unimaps::mzk_api::{MzkLine, MzkRunningVehicle, MzkSource, MzkStopPoint};
    use unimaps::mzk_poller::MzkPoller;
    use unimaps::osrm::{OsrmHttp, OsrmTransport};
    use unimaps::poller::{LivePoller, LivePollerOptions};
    use unimaps::poller_singleton::{Bb, BbKinds};
    use unimaps::shape_store::{ShapeStore, ShapeStoreOptions};
    use unimaps::types::Stop;

    const T0: i64 = 1_800_000_000_000;

    struct NoKb;

    impl KbSource for NoKb {
        async fn fetch_revision(&self) -> String {
            "1".to_owned()
        }
        async fn fetch_stops(&self, _: Option<&str>) -> Result<Vec<Stop>, String> {
            Err("no kb".to_owned())
        }
        async fn fetch_multiple_departures(&self, _: &[String]) -> Result<Value, String> {
            Err("no kb".to_owned())
        }
        async fn fetch_trip_execution(&self, _: &str, _: i64) -> Result<Value, String> {
            Err("no kb".to_owned())
        }
    }

    struct NoMzk;

    impl MzkSource for NoMzk {
        async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
            Ok(Vec::new())
        }
        async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
            Ok(Vec::new())
        }
        async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
            Ok(Vec::new())
        }
        async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
            Ok(Vec::new())
        }
    }

    struct NoOsrm;

    impl OsrmTransport for NoOsrm {
        async fn throttle(&self) {}
        async fn get(&self, _: &str) -> Result<OsrmHttp, String> {
            Err("no osrm".to_owned())
        }
    }

    struct Fakes;

    impl BbKinds for Fakes {
        type Kb = NoKb;
        type Mzk = NoMzk;
        type Osrm = NoOsrm;
    }

    /// Every probe answers an empty list after 1 s; `urls` logs what reached "upstream".
    #[derive(Default)]
    struct SlowZb {
        urls: Mutex<Vec<String>>,
    }

    impl ZbTransport for SlowZb {
        async fn get(&self, url: &str, _: &[(&str, &str)], _: Duration, _: usize) -> Result<ZbResponse, String> {
            self.urls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(url.to_owned());
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(ok(json!({ "positions": [] }).to_string()))
        }
    }

    fn fake_bb() -> &'static Bb<Fakes> {
        let shapes = ShapeStore::new(ShapeStoreOptions {
            timers: false,
            ..ShapeStoreOptions::new(NoOsrm)
        });
        let bb = Bb::<Fakes>::from_parts(
            NoKb,
            LivePoller::new(NoKb, LivePollerOptions::default()),
            NoMzk,
            MzkPoller::new(NoMzk).with_stop_dirs_file(None),
            shapes,
        )
        .with_now(Arc::new(|| T0));
        Box::leak(Box::new(bb))
    }

    /// The TS memo holds the sweep's Promise, which runs on whoever stops waiting: a viewer closing the tab
    /// mid-sweep and a reload 2 s later share one sweep, every probe goes upstream once, checked_at = the first.
    #[tokio::test(start_paused = true)]
    async fn a_sweep_outlives_the_request_that_started_it() {
        let bb = fake_bb();
        let zb: &'static SlowZb = Box::leak(Box::default());
        let first = tokio::time::timeout(Duration::from_millis(500), city_status_with(bb, zb, T0)).await;
        assert!(
            first.is_err(),
            "the first sweep is still in flight when its viewer leaves"
        );
        let body = city_status_with(bb, zb, T0 + 2000).await.unwrap();
        assert_eq!(body.checked_at, T0 / 1000);
        let urls = zb.urls.lock().unwrap().clone();
        let mut once = urls.clone();
        once.sort();
        once.dedup();
        assert!(!urls.is_empty());
        assert_eq!(urls.len(), once.len(), "a probe went upstream twice");
    }
}
