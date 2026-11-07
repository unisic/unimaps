//! test/gzm-live.test.ts from `describe("schedulePosition")` on: the timetable placement, scheduled metro in a
//! zbiorkom city, the poll grid, `parseSdip` and the SDIP overlay (login, dating a change, re-login, pause).

mod gzm_rig;

use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use gzm_rig::{
    FEED, Fake, LAT, LON_A, LON_B, RecOpts, at, files, load_gzm_feed, now_fn, ok, only, positions_body, rec, rig_with,
};
use serde_json::{Value, json};
use unimaps::gzm::{
    GzmLive, POLL_MS, POLL_PHASE_MS, SchedAt, ZbResponse, next_poll_delay, parse_sdip, schedule_position,
};
use unimaps::gzm_feed::GzmFeed;

mod schedule_position {
    use super::*;

    #[test]
    fn runs_from_the_first_departure_up_to_the_last_arrival_standing_through_a_dwell() {
        let (arr, dep) = ([100, 200, 330], [100, 230, 330]);
        let at = |t: f64| schedule_position(&arr, &dep, t);
        assert_eq!(at(99.0), None);
        assert_eq!(at(100.0), Some(SchedAt { i: 0, f: 0.0, next: 1 }));
        assert_eq!(at(150.0), Some(SchedAt { i: 0, f: 0.5, next: 1 }));
        assert_eq!(at(215.0), Some(SchedAt { i: 1, f: 0.0, next: 1 }));
        assert_eq!(at(280.0), Some(SchedAt { i: 1, f: 0.5, next: 2 }));
        assert_eq!(at(330.0), None);
        assert_eq!(schedule_position(&arr[..1], &dep[..1], 100.0), None);
    }
}

mod scheduled_metro {
    use super::*;

    /// The fixture with line 7 as metro (route_type 1), parsed as Warsaw.
    static METRO: LazyLock<Arc<GzmFeed>> = LazyLock::new(|| {
        let mut f = files();
        for (name, body) in &mut f {
            if *name == "routes.txt" {
                *body = body.replace("Tramwaj 7,0", "Metro 7,1");
            }
        }
        Arc::new(load_gzm_feed(&f, "warsaw"))
    });

    /// `/^warsaw:1_S[A-Za-z0-9_-]{10}$/`
    fn is_sched_id(s: &str) -> bool {
        s.strip_prefix("warsaw:1_S")
            .is_some_and(|t| t.len() == 10 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    }

    #[tokio::test]
    async fn places_every_running_metro_trip_by_the_timetable_on_the_shape_when_it_has_one() {
        let r = rig_with(Some(Arc::clone(&METRO)), "warsaw");
        let b = r.poll(at("08:02", 30), vec![]).await;
        let by_trip: BTreeMap<String, Value> = b["vehicles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v["trip_id"].as_str().unwrap().to_owned(), v.clone()))
            .collect();
        assert_eq!(by_trip.keys().collect::<Vec<_>>(), ["warsaw:tA", "warsaw:tX"]);
        let a = &by_trip["warsaw:tA"];
        assert_eq!(a["scheduled"], true);
        assert_eq!(a.get("delay"), Some(&Value::Null));
        assert_eq!(a["vehicle_type"], 1);
        assert_eq!(a["next_stop_name"], "Beta 01");
        assert!((a["lon"].as_f64().unwrap() - (LON_A + LON_B) / 2.0).abs() < 1e-4);
        assert!(
            a["shape"].as_str().is_some_and(|s| s.starts_with("warsaw:shA."))
                && a["dist_m"].as_f64().is_some_and(|d| d > 0.0)
        );
        let x = &by_trip["warsaw:tX"];
        assert_eq!(x.get("shape"), None);
        assert!((x["lon"].as_f64().unwrap() - (LON_A + (LON_B - LON_A) * (150.0 / 360.0))).abs() < 1e-6);
        let id = a["id"].as_str().unwrap();
        assert!(is_sched_id(id), "{id}");
        // the same trip keeps its id between polls, so the marker glides
        let again = r.poll(at("08:03", 0), vec![]).await;
        assert!(again["vehicles"].as_array().unwrap().iter().any(|v| v["id"] == id));
        assert_eq!(r.live.health()["scheduled"], 2);
        let ex = r.live.trip_execution(id);
        assert_eq!(ex.as_ref().and_then(|e| e.get("vehicle_trip_index")), Some(&json!(1)));
    }

    #[tokio::test]
    async fn a_line_some_live_record_serves_is_never_doubled_gzm_never_schedules() {
        let r = rig_with(Some(Arc::clone(&METRO)), "warsaw");
        let mut live7 = rec(&RecOpts {
            key: Some("1_9"),
            ts: at("08:02", 20),
            calls: vec![(1, "08:05")],
            ..RecOpts::default()
        });
        live7["vehicle"]["type"] = json!("1");
        let b = r.poll(at("08:02", 30), vec![live7]).await;
        let scheduled = b["vehicles"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["scheduled"] == true);
        assert_eq!(scheduled.count(), 0);
        let gzm = rig_with(Some(Arc::clone(&METRO)), "gzm");
        assert_eq!(
            gzm.poll(at("08:02", 30), vec![]).await["vehicles"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}

mod next_poll_delay {
    use super::*;

    #[test]
    fn wakes_3_s_past_the_next_10_s_grid_point_never_sooner_than_1_s() {
        let d = |now| next_poll_delay(now, POLL_MS, POLL_PHASE_MS);
        assert_eq!(d(1_000_000), 3000);
        assert_eq!(d(1_002_500), 500 + 10000);
        assert_eq!(d(1_003_000), 10000);
        assert_eq!(d(1_007_000), 6000);
    }

    #[test]
    fn follows_sdips_5_s_grid_at_its_own_phase() {
        assert_eq!(next_poll_delay(1_000_000, 5000, 2500), 2500);
        assert_eq!(next_poll_delay(1_002_600, 5000, 2500), 4900);
    }
}

mod parse_sdip {
    use super::*;

    #[test]
    fn keys_like_zbiorkom_converts_compass_radians_to_degrees_drops_foreign_ids_and_0_0() {
        let m = parse_sdip(&json!([
            { "id": "104_3053", "lat": LAT, "lon": LON_A, "bearing": PI / 2.0 },
            { "id": "104_3054", "lat": LAT, "lon": LON_A, "bearing": -PI / 2.0 },
            { "id": "104_1", "lat": 0, "lon": 0, "bearing": 0 },
            { "id": "x", "lat": LAT, "lon": LON_A, "bearing": 0 },
            { "id": "104_2", "lat": LAT, "lon": LON_A },
        ]))
        .unwrap();
        assert_eq!(m.keys().collect::<Vec<_>>(), ["104_3053", "104_3054", "104_2"]);
        assert_eq!(m["104_3053"].bearing, Some(90.0));
        assert_eq!(m["104_3054"].bearing, Some(270.0));
        assert_eq!(m["104_2"].bearing, None);
        assert!(parse_sdip(&json!("<html>")).is_err());
    }
}

mod sdip_overlay {
    use super::*;

    const SDIP: &str = "https://sdip.invalid/vm/main";

    /// What the fake zbiorkom / SDIP upstream answers next, and the TS `calls` log.
    #[derive(Default)]
    struct Up {
        positions: Vec<Value>,
        sdip: Value,
        calls: Vec<String>,
        expired: bool,
    }

    /// The TS `sdipRig()`.
    struct SdipRig {
        live: GzmLive<Fake>,
        clock: Arc<AtomicI64>,
        up: Arc<Mutex<Up>>,
    }

    fn sdip_rig() -> SdipRig {
        let clock = Arc::new(AtomicI64::new(at("08:03", 0) * 1000));
        let up = Arc::new(Mutex::new(Up {
            sdip: json!([]),
            ..Up::default()
        }));
        let u = Arc::clone(&up);
        let fake = Fake::new(move |req| {
            let mut u = u.lock().unwrap();
            let url = req.url.as_str();
            let call = if url == SDIP {
                "login".to_owned()
            } else if url.starts_with(SDIP) {
                format!("v:{}", req.header("cookie").unwrap_or(""))
            } else {
                "zb".to_owned()
            };
            u.calls.push(call);
            Ok(if url == SDIP {
                ZbResponse {
                    set_cookies: vec![format!("JSESSIONID=s{}; Path=/vm; HttpOnly", u.calls.len())],
                    ..ok("<html/>")
                }
            } else if url.starts_with(SDIP) {
                if u.expired {
                    u.expired = false;
                    ok("<html>login</html>")
                } else {
                    ok(u.sdip.to_string())
                }
            } else {
                positions_body(&u.positions)
            })
        });
        let live = GzmLive::new("gzm", fake)
            .with_now(now_fn(&clock))
            .with_feed(Arc::new(|| Some(Arc::clone(&FEED))))
            .with_url(Some("https://x.invalid/positions".into()))
            .with_sdip_url(Some(SDIP.into()));
        SdipRig { live, clock, up }
    }

    impl SdipRig {
        async fn zb(&self, now_s: i64, list: Vec<Value>) {
            self.clock.store(now_s * 1000, Ordering::SeqCst);
            self.up.lock().unwrap().positions = list;
            assert!(self.live.poll_once().await);
        }

        async fn sdip(&self, now_s: i64, list: Value) {
            self.clock.store(now_s * 1000, Ordering::SeqCst);
            self.up.lock().unwrap().sdip = list;
            assert!(self.live.poll_sdip_once().await);
        }

        fn veh(&self) -> Value {
            only(&gzm_rig::body(&self.live))
        }

        fn calls(&self) -> Vec<String> {
            self.up.lock().unwrap().calls.clone()
        }

        fn expire(&self) {
            self.up.lock().unwrap().expired = true;
        }
    }

    fn calls() -> Vec<(i64, &'static str)> {
        vec![(1, "08:05"), (2, "08:10")]
    }

    fn zb_rec(ts: i64, lon: f64) -> Value {
        rec(&RecOpts {
            ts,
            calls: calls(),
            lon: Some(lon),
            ..RecOpts::default()
        })
    }

    fn sd(lon: f64, bearing_rad: f64) -> Value {
        json!([{ "id": "283_4285", "lat": LAT, "lon": lon, "bearing": bearing_rad }])
    }

    /// TS `at(hhmm, sec)` with a fractional second.
    fn at_f(hhmm: &str, sec: f64) -> f64 {
        at(hhmm, 0) as f64 + sec
    }

    #[tokio::test]
    async fn takes_sdips_position_once_it_is_seen_changing_dated_at_the_poll_window_midpoint() {
        let r = sdip_rig();
        let ts = at("08:02", 40);
        r.zb(at("08:03", 0), vec![zb_rec(ts, 19.004)]).await;
        r.sdip(at("08:03", 1), sd(19.0045, PI / 2.0)).await;
        assert_eq!(r.veh()["lon"], 19.004, "first sight: age unknown, zbiorkom stays");
        r.sdip(at("08:03", 6), sd(19.0052, 0.0)).await;
        let v = r.veh();
        assert_eq!(v["lon"], 19.0052);
        assert_eq!(v["fix_at"], at_f("08:03", 3.5));
        assert_eq!(v["bearing"], 0);
        assert_eq!(v["trip_id"], "gzm:tA", "the join stays zbiorkom's");
        assert_eq!(v["delay"], 0);
        assert!(
            v["dist_m"].as_f64().is_some_and(|d| d > 350.0),
            "dist_m {}",
            v["dist_m"]
        );
        assert_eq!(r.calls(), ["zb", "login", "v:JSESSIONID=s2", "v:JSESSIONID=s2"]);
    }

    #[tokio::test]
    async fn keeps_the_newer_sdip_fix_when_zbiorkoms_snapshot_is_older_zbiorkom_wins_once_sdip_goes_quiet() {
        let r = sdip_rig();
        let ts = at("08:02", 40);
        r.zb(at("08:03", 0), vec![zb_rec(ts, 19.004)]).await;
        r.sdip(at("08:03", 1), sd(19.0045, PI / 2.0)).await;
        r.sdip(at("08:03", 6), sd(19.006, PI / 2.0)).await;
        // zbiorkom's next snapshot (fix 08:02:50) is older than SDIP's (08:03:03.5)
        r.zb(at("08:03", 20), vec![zb_rec(ts + 20, 19.005)]).await;
        assert_eq!(r.veh()["lon"], 19.006);
        // SDIP silent for > 60 s: zbiorkom's fresh fix again
        r.zb(at("08:05", 0), vec![zb_rec(at("08:04", 40), 19.009)]).await;
        assert_eq!(r.veh()["lon"], 19.009);
    }

    #[tokio::test]
    async fn a_standing_bus_stays_on_sdips_position_zbiorkoms_lagging_copy_never_pulls_it_back() {
        let r = sdip_rig();
        r.zb(at("08:03", 0), vec![zb_rec(at("08:02", 40), 19.004)]).await;
        r.sdip(at("08:03", 1), sd(19.0045, PI / 2.0)).await;
        r.sdip(at("08:03", 6), sd(19.006, PI / 2.0)).await;
        // standing since 08:03:03.5; zbiorkom's next snapshots still show where the bus was before, with newer stamps
        for i in 1..=14 {
            let list = if i == 7 { json!([]) } else { sd(19.006, PI / 2.0) };
            r.sdip(at("08:03", 6 + 5 * i), list).await;
            if i % 4 == 0 {
                r.zb(at("08:03", 6 + 5 * i), vec![zb_rec(at("08:03", 5 * i), 19.005)])
                    .await;
            }
        }
        let v = r.veh();
        assert_eq!(v["lon"], 19.006, "one SDIP list without the bus holds it too");
        assert_eq!(v["fix_at"], at_f("08:03", 3.5));
    }

    #[tokio::test]
    async fn never_dates_a_change_across_a_long_gap_re_logs_in_when_the_session_expired() {
        let r = sdip_rig();
        r.zb(at("08:03", 0), vec![zb_rec(at("08:02", 40), 19.004)]).await;
        r.sdip(at("08:03", 1), sd(19.0045, PI / 2.0)).await;
        r.sdip(at("08:03", 30), sd(19.006, PI / 2.0)).await;
        assert_eq!(r.veh()["lon"], 19.004, "29 s between polls: the change can't be dated");
        r.expire();
        r.sdip(at("08:03", 35), sd(19.007, PI / 2.0)).await;
        assert_eq!(r.veh()["lon"], 19.007);
        let log = r.calls();
        assert_eq!(log[log.len() - 3..], ["v:JSESSIONID=s2", "login", "v:JSESSIONID=s6"]);
        assert_eq!(r.live.sdip_moved(), 1);
    }

    #[tokio::test]
    async fn pauses_5_min_after_3_failed_polls() {
        let down = Fake::new(|_| {
            Ok(ZbResponse {
                status: 503,
                ..ok("down")
            })
        });
        let live = GzmLive::new("gzm", down)
            .with_now(Arc::new(|| 1_000_000_000_000))
            .with_feed(Arc::new(|| Some(Arc::clone(&FEED))))
            .with_sdip_url(Some(SDIP.into()));
        for _ in 0..3 {
            assert!(!live.poll_sdip_once().await);
        }
        let h = &live.health()["sdip"];
        assert_eq!(h["paused_until"], 1e9 + 300.0);
        let err = h["last_error"].as_str().unwrap_or_default();
        assert!(err.contains("HTTP 503"), "{err}");
    }
}
