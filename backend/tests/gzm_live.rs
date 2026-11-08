//! test/gzm-live.test.ts up to `describe("schedulePosition")`: zbiorkom record parsing, the trip join (all pairs,
//! brigade tie-break), and `GzmLive` on the synthetic feed: layover onto the brigade's next trip, not-started,
//! prune, fix_at on the record clock, staleness, trips, the board, the answers while the feed loads, the loops.

mod gzm_rig;

use gzm_rig::{DATE, LAT, LON_A, LON_C, RecOpts, at, rec};
use serde_json::{Value, json};

/// `assert.equal(v[k], null)`: present and null (undefined would fail the strict check).
fn null(v: &Value, k: &str) -> bool {
    v.get(k) == Some(&Value::Null)
}

fn opts(ts: i64, calls: &[(i64, &'static str)]) -> RecOpts<'static> {
    RecOpts {
        ts,
        calls: calls.to_vec(),
        ..RecOpts::default()
    }
}

mod parse_zbiorkom {
    use super::*;
    use unimaps::gzm::{AREA, parse_zbiorkom, zb_key};

    fn now() -> i64 {
        at("08:03", 0) * 1000
    }

    fn with(mut v: Value, k: &str, x: Value) -> Value {
        v[k] = x;
        v
    }

    #[test]
    fn keeps_valid_records_keyed_by_op_fleet_the_newest_per_key() {
        let body = json!({ "positions": [
            rec(&opts(at("08:02", 0), &[(1, "08:05")])),
            rec(&RecOpts { delay: 30, ..opts(at("08:02", 40), &[(1, "08:05")]) }),
            with(rec(&opts(at("08:02", 0), &[])), "url", json!("https://x.invalid/gzm/vehicle/bogus")),
            rec(&RecOpts { key: Some("1_1"), lat: Some(0.0), lon: Some(0.0), ..opts(at("08:02", 0), &[]) }),
            rec(&RecOpts { key: Some("1_2"), ..opts(at("07:50", 0), &[]) }),
            with(rec(&RecOpts { key: Some("1_3"), ..opts(at("08:02", 0), &[(2, "08:10"), (1, "08:05")]) }), "bearing", json!(-90)),
        ]});
        let recs = parse_zbiorkom(&body, now(), &AREA, false).unwrap();
        let got: Vec<(&str, Option<f64>)> = recs.iter().map(|r| (r.key.as_str(), r.delay_ms)).collect();
        assert_eq!(got, [("283_4285", Some(30000.0)), ("1_3", Some(0.0))]);
        assert_eq!(recs[0].label, "4285");
        assert_eq!(recs[1].upcoming.iter().map(|u| u.seq).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(recs[1].bearing, Some(270.0));
    }

    #[test]
    fn keys_another_citys_vehicles_by_type_agency_and_id_two_operators_bus_101_stay_two_vehicles() {
        let k = |v: Value| zb_key(v.as_object().unwrap());
        assert_eq!(
            k(json!({ "type": "3", "id": "36146", "agency": "default" })).as_deref(),
            Some("3_36146")
        );
        assert_eq!(
            k(json!({ "type": "3", "id": "101", "agency": "MINSK" })).as_deref(),
            Some("3_MINSK_101")
        );
        assert_eq!(
            k(json!({ "type": "3", "id": "101", "agency": "GPA" })).as_deref(),
            Some("3_GPA_101")
        );
        assert_eq!(
            k(json!({ "type": "3", "id": "04 ", "agency": "OTWOCK" })).as_deref(),
            Some("3_OTWOCK_04_")
        );
        assert_eq!(k(json!({ "type": "0", "id": "2369" })).as_deref(), Some("0_2369"));
        assert_eq!(k(json!({ "type": "3", "id": "", "agency": "MINSK" })), None);
    }

    #[test]
    fn marks_another_operators_vehicle_with_its_agency_in_a_zbiorkom_city_never_in_gzm() {
        let own = rec(&opts(at("08:02", 0), &[]));
        let mut otwock = own.clone();
        otwock["vehicle"]["id"] = json!("03");
        otwock["vehicle"]["type"] = json!("3");
        otwock["vehicle"]["agency"] = json!("OTWOCK");
        let recs = parse_zbiorkom(
            &json!({ "positions": [own.clone(), otwock.clone()] }),
            now(),
            &AREA,
            true,
        )
        .unwrap();
        let (a, b) = (&recs[0], &recs[1]);
        assert_eq!(
            (a.key.as_str(), a.agency.as_deref(), b.key.as_str(), b.agency.as_deref()),
            ("0_4285", None, "3_OTWOCK_03", Some("OTWOCK"))
        );
        let url = own["url"].as_str().unwrap().replace("283_4285", "1_1");
        let gzm = with(otwock, "url", json!(url));
        assert_eq!(
            parse_zbiorkom(&json!({ "positions": [gzm] }), now(), &AREA, false).unwrap()[0].agency,
            None
        );
    }

    #[test]
    fn throws_on_a_body_without_a_positions_array() {
        assert!(parse_zbiorkom(&json!({ "vehicles": [] }), now(), &AREA, false).is_err());
    }
}

mod match_trip {
    use super::*;
    use gzm_rig::FEED;
    use unimaps::gzm::{AREA, GzmMatch, ZbRecord, match_trip, parse_zbiorkom};

    fn days() -> [(String, i64); 1] {
        [(DATE.to_owned(), at("00:00", 0))]
    }

    fn one(o: &RecOpts) -> ZbRecord {
        parse_zbiorkom(&json!({ "positions": [rec(o)] }), (o.ts + 1) * 1000, &AREA, false)
            .unwrap()
            .remove(0)
    }

    /// `matchTrip(...)?.trip.tripId`
    fn trip_id(m: Option<GzmMatch>) -> Option<String> {
        m.map(|m| FEED.trip_at(m.trip).t.trip_id.clone())
    }

    fn m(o: &RecOpts) -> Option<String> {
        trip_id(match_trip(&FEED, &one(o), &days()))
    }

    #[test]
    fn needs_every_sequence_departure_pair_the_brigade_breaks_a_tie() {
        assert_eq!(
            m(&opts(at("08:02", 0), &[(1, "08:05"), (2, "08:10")])).as_deref(),
            Some("gzm:tA")
        );
        assert_eq!(m(&opts(at("08:02", 0), &[(1, "08:05"), (2, "08:11")])), None);
        let first = |brigade| RecOpts {
            brigade: Some(brigade),
            ..opts(at("07:58", 0), &[(0, "08:00")])
        };
        assert_eq!(m(&first("4")).as_deref(), Some("gzm:tX"));
        assert_eq!(m(&first("9")), None);
        let line8 = RecOpts {
            line: Some("8"),
            ..opts(at("08:02", 0), &[(1, "08:05")])
        };
        assert_eq!(m(&line8), None);
    }

    #[test]
    fn joins_calls_timed_a_few_seconds_off_the_feed_only_when_no_trip_fits_exactly() {
        let r = one(&opts(at("08:02", 0), &[(1, "08:05"), (2, "08:10")]));
        let late = |s: f64| {
            let mut x = r.clone();
            for c in &mut x.upcoming {
                c.dep += s;
            }
            trip_id(match_trip(&FEED, &x, &days()))
        };
        assert_eq!(late(5.0).as_deref(), Some("gzm:tA"));
        assert_eq!(late(45.0), None);
    }
}

mod gzm_live {
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use gzm_rig::{FEED, Fake, Running, body, feed_fn, now_fn, ok, only, positions_body, rig, rig_with, until};
    use unimaps::gzm::{GzmFleetSource, GzmLive, GzmNextTrip, Lookup};
    use unimaps::router::RouteQuery;

    const CALLS: &[(i64, &str)] = &[(1, "08:05"), (2, "08:10")];

    /// `assert.match(s, /^gzm:shA\.[0-9a-f]{6}$/)`
    fn is_sha_wire_id(s: &str) -> bool {
        s.strip_prefix("gzm:shA.")
            .is_some_and(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    }

    fn found(l: Lookup<Value>) -> Value {
        match l {
            Lookup::Found(v) => v,
            other => panic!("expected a value, got {other:?}"),
        }
    }

    fn by_id<'a>(r: &'a Value, k: &str) -> &'a Value {
        let id = format!("gzm:{k}");
        r["vehicles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id.as_str())
            .unwrap()
    }

    #[tokio::test]
    async fn joins_a_running_vehicle_trip_delay_in_seconds_stop_indices_shape() {
        let r = rig();
        let o = RecOpts {
            delay: 60,
            lon: Some(19.005),
            ..opts(at("08:02", 40), CALLS)
        };
        let v = only(&r.poll(at("08:03", 0), vec![rec(&o)]).await);
        assert_eq!(v["id"], "gzm:283_4285");
        assert_eq!(v["trip_id"], "gzm:tA");
        assert_eq!(v["sched_trip_id"], "gzm:tA");
        assert_eq!(v["operator"], "GZM");
        assert_eq!(v["vehicle_type"], 0);
        assert_eq!(v["delay"], 60);
        assert_eq!(v["side_number"], "4285");
        assert_eq!(v["current_stop_sequence"], 0);
        assert_eq!(v["next_stop_seq"], 1);
        assert_eq!(v["next_stop_name"], "Beta 01");
        assert_eq!(v["at_stop"], false);
        assert!(
            is_sha_wire_id(v["shape"].as_str().unwrap_or("")),
            "shape {}",
            v["shape"]
        );
        let d = v["dist_m"].as_f64();
        assert!(d.is_some_and(|d| d > 300.0 && d < 420.0), "dist_m {d:?}");
    }

    #[tokio::test]
    async fn an_unmatched_vehicle_keeps_its_position_with_no_trip_and_no_delay() {
        let r = rig();
        let o = RecOpts {
            delay: 60,
            ..opts(at("08:02", 40), &[(1, "08:07")])
        };
        let v = only(&r.poll(at("08:03", 0), vec![rec(&o)]).await);
        assert_eq!(v["trip_id"], "");
        assert!(null(&v, "delay"));
        assert!(null(&v, "next_stop_name"));
    }

    #[tokio::test]
    async fn feeds_the_fleet_only_the_vehicles_on_a_trip_and_nothing_while_the_feed_loads() {
        let got: Arc<Mutex<Vec<Vec<GzmFleetSource>>>> = Arc::default();
        let loaded = Arc::new(Mutex::new(None));
        let positions = vec![
            rec(&RecOpts {
                delay: 60,
                lon: Some(19.005),
                ..opts(at("08:02", 40), CALLS)
            }),
            rec(&RecOpts {
                key: Some("108_3"),
                ..opts(at("08:02", 40), &[(1, "08:07")])
            }),
        ];
        let g = Arc::clone(&got);
        let live = GzmLive::new("gzm", Fake::new(move |_| Ok(positions_body(&positions))))
            .with_feed(feed_fn(&loaded))
            .with_now(Arc::new(|| at("08:03", 0) * 1000))
            .with_url(Some("https://x.invalid/positions".into()))
            .with_fleet(Some(Arc::new(move |s| g.lock().unwrap().push(s))));
        assert!(live.poll_once().await);
        assert_eq!(
            got.lock().unwrap().len(),
            0,
            "no trips yet: an empty list would close every running course"
        );
        *loaded.lock().unwrap() = Some(Arc::clone(&FEED));
        assert!(live.poll_once().await);
        let got = got.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].iter().map(|s| s.side.as_str()).collect::<Vec<_>>(), ["283_4285"]);
        let s = &got[0][0];
        assert_eq!(s.label, "4285");
        assert_eq!(s.trip_id, "tA");
        assert_eq!(s.brigade.as_deref(), Some("3"));
        assert_eq!(s.delay_sec, Some(60.0));
        assert!(!s.not_started);
        assert_eq!((s.served_idx, s.next_idx), (Some(0), Some(1)));
        let day = |hhmm| (at(hhmm, 0) - at("00:00", 0)) as i32;
        assert_eq!(
            s.stops
                .iter()
                .map(|x| (x.id.as_str(), x.name.as_str(), x.dep))
                .collect::<Vec<_>>(),
            [
                ("gzm:a", "Alfa 01", day("08:00")),
                ("gzm:b", "Beta 01", day("08:05")),
                ("gzm:c", "Gamma 01", day("08:10"))
            ]
        );
        let d: Vec<Option<f64>> = s.stops.iter().map(|x| x.dist_m).collect();
        assert!(
            matches!(d[..], [Some(a), Some(b), Some(c)] if a < b && b < c),
            "distM {d:?}"
        );
        assert_eq!(
            s.next_trips,
            [GzmNextTrip {
                line: "7".into(),
                headsign: "Alfa".into(),
                first_stop_name: "Gamma 01".into(),
                first_stop_id: "gzm:c".into(),
                dep: day("08:20"),
            }]
        );
    }

    #[tokio::test]
    async fn a_vehicle_at_its_first_stop_before_departure_is_not_started_with_no_delay() {
        let r = rig();
        let o = RecOpts {
            brigade: Some("4"),
            lon: Some(LON_A),
            ..opts(at("07:57", 40), &[(0, "08:00")])
        };
        let v = only(&r.poll(at("07:58", 0), vec![rec(&o)]).await);
        assert_eq!(v["trip_id"], "gzm:tX");
        assert_eq!(v["not_started"], true);
        assert!(null(&v, "delay"));
        assert_eq!(v["at_stop"], true);
    }

    #[tokio::test]
    async fn a_bus_driving_to_its_first_stop_off_the_route_is_not_started_one_on_the_route_past_it_has_begun() {
        let r = rig();
        let call = RecOpts {
            brigade: Some("3"),
            ..opts(at("07:59", 40), &[(0, "08:00")])
        };
        let o = RecOpts {
            lat: Some(LAT + 0.01),
            lon: Some(LON_A + 0.005),
            calls: call.calls.clone(),
            ..call
        };
        let depot = only(&r.poll(at("08:00", 0), vec![rec(&o)]).await);
        assert_eq!(
            [&depot["trip_id"], &depot["not_started"], &depot["delay"]],
            [&json!("gzm:tA"), &json!(true), &Value::Null]
        );
        assert!(depot.get("delay").is_some());
        let o = RecOpts {
            ts: at("08:00", 0),
            lon: Some(LON_A + 0.007),
            calls: call.calls.clone(),
            ..call
        };
        let lagging = only(&r.poll(at("08:00", 20), vec![rec(&o)]).await);
        assert_eq!(lagging.get("not_started"), None);
    }

    #[tokio::test]
    async fn lays_over_onto_the_brigades_next_trip_once_the_last_stop_is_behind_then_hands_over() {
        let r = rig();
        // last stop c was due 08:10 + 0 s; at 08:13 the vehicle stands at c, listed on tA with a frozen delay
        let o = RecOpts {
            lon: Some(LON_C),
            ..opts(at("08:12", 40), &[(2, "08:10")])
        };
        let v = only(&r.poll(at("08:13", 0), vec![rec(&o)]).await);
        assert_eq!(v["trip_id"], "gzm:tB");
        assert_eq!(v["not_started"], true);
        assert!(null(&v, "delay"));
        assert_eq!(v["next_stop_name"], "Gamma 01");
        // the same vehicle with no upcoming calls stays on the cached trip's successor
        let o = RecOpts {
            lon: Some(LON_C),
            ..opts(at("08:13", 40), &[])
        };
        let v = only(&r.poll(at("08:14", 0), vec![rec(&o)]).await);
        assert_eq!(v["trip_id"], "gzm:tB");
        // zbiorkom moves it to tB: a direct match, now running
        let o = RecOpts {
            delay: 90,
            lon: Some(19.015),
            ..opts(at("08:21", 40), &[(1, "08:25"), (2, "08:30")])
        };
        let v = only(&r.poll(at("08:22", 0), vec![rec(&o)]).await);
        assert_eq!(v["trip_id"], "gzm:tB");
        assert_eq!(v.get("not_started"), None);
        assert_eq!(v["delay"], 90);
    }

    #[tokio::test]
    async fn still_en_route_to_the_last_stop_is_no_layover_eta_schedule_delay() {
        let r = rig();
        let o = RecOpts {
            delay: 240,
            lon: Some(19.018),
            ..opts(at("08:12", 40), &[(2, "08:10")])
        };
        let v = only(&r.poll(at("08:13", 0), vec![rec(&o)]).await);
        assert_eq!(v["trip_id"], "gzm:tA");
        assert_eq!(v["delay"], 240);
    }

    #[tokio::test]
    async fn standing_at_the_last_stop_ends_the_trip_even_while_zbiorkoms_delay_grows_with_the_clock() {
        let r = rig();
        // eta = 08:10 + 160 s = the snapshot time: the eta rule alone would keep the vehicle on tA
        let o = RecOpts {
            delay: 160,
            lon: Some(LON_C),
            ..opts(at("08:12", 40), &[(2, "08:10")])
        };
        let v = only(&r.poll(at("08:13", 0), vec![rec(&o)]).await);
        assert_eq!(v["trip_id"], "gzm:tB");
        assert_eq!(v["not_started"], true);
    }

    #[tokio::test]
    async fn a_trip_zbiorkom_never_closes_standing_10_min_delay_growing_is_dropped_mid_route_laid_over_before_the_last_stop()
     {
        let r = rig();
        let mid = |ts, delay| {
            rec(&RecOpts {
                key: Some("283_1"),
                lon: Some(19.005),
                delay,
                ..opts(ts, CALLS)
            })
        };
        let end = |ts, delay| {
            rec(&RecOpts {
                key: Some("283_2"),
                lon: Some(19.0158),
                delay,
                ..opts(ts, &[(2, "08:10")])
            })
        };
        let b = r
            .poll(
                at("08:13", 0),
                vec![mid(at("08:12", 40), 460), end(at("08:12", 40), 160)],
            )
            .await;
        assert_eq!(by_id(&b, "283_1")["trip_id"], "gzm:tA");
        assert_eq!(by_id(&b, "283_1")["delay"], 460);
        assert_eq!(by_id(&b, "283_2")["trip_id"], "gzm:tA");
        // 11 min later, not moved a metre, each delay grown by the 11 min
        let b = r
            .poll(
                at("08:24", 0),
                vec![mid(at("08:23", 40), 1120), end(at("08:23", 40), 820)],
            )
            .await;
        assert_eq!(by_id(&b, "283_1")["trip_id"], "");
        assert!(null(by_id(&b, "283_1"), "delay"));
        assert_eq!(by_id(&b, "283_2")["trip_id"], "gzm:tB");
        assert_eq!(by_id(&b, "283_2")["not_started"], true);
    }

    #[tokio::test]
    async fn prunes_vehicles_missing_from_a_poll_fix_at_follows_the_record_clock_never_the_poll_time() {
        let r = rig();
        let ts = at("08:02", 40);
        let main = |ts, lon| {
            rec(&RecOpts {
                lon: Some(lon),
                ..opts(ts, CALLS)
            })
        };
        let other = rec(&RecOpts {
            key: Some("283_1"),
            brigade: Some("4"),
            ..opts(ts, &[(1, "08:06")])
        });
        let both = r.poll(at("08:03", 0), vec![main(ts, 19.004), other]).await;
        let got: Vec<(Value, Value)> = both["vehicles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (x["id"].clone(), x["fix_at"].clone()))
            .collect();
        // the middle of zbiorkom's 10 s window
        assert_eq!(
            got,
            [
                (json!("gzm:283_4285"), json!(ts - 5)),
                (json!("gzm:283_1"), json!(ts - 5))
            ]
        );
        let v = only(&r.poll(at("08:03", 20), vec![main(ts, 19.004)]).await);
        assert_eq!(v["fix_at"], ts - 5, "same snapshot: same fix");
        let v = only(&r.poll(at("08:03", 40), vec![main(ts + 20, 19.006)]).await);
        assert_eq!(v["fix_at"], ts + 10);
        assert_ne!(v["fix_at"], at("08:03", 40));
    }

    #[tokio::test]
    async fn goes_empty_once_the_last_good_poll_is_stale() {
        let r = rig();
        r.poll(at("08:03", 0), vec![rec(&opts(at("08:02", 40), CALLS))]).await;
        assert!(r.live.trip_execution("gzm:283_4285").is_some());
        r.clock.store((at("08:03", 0) + 181) * 1000, Ordering::SeqCst);
        assert_eq!(body(&r.live)["count"], 0);
        assert_eq!(r.live.trip_execution("gzm:283_4285"), None);
    }

    #[tokio::test]
    async fn serves_live_trips_with_estimates_from_the_next_stop_on_static_trips_carry_none() {
        let r = rig();
        let o = RecOpts {
            delay: 60,
            ..opts(at("08:02", 40), CALLS)
        };
        r.poll(at("08:03", 0), vec![rec(&o)]).await;
        let t = r.live.trip_execution("gzm:283_4285").unwrap();
        assert_eq!(t["vehicle_trip_index"], 1);
        let times = t["trip"]["times"].as_array().unwrap();
        let est: Vec<Value> = times
            .iter()
            .map(|x| {
                x.get("estimate")
                    .and_then(|e| e.get("time_diff"))
                    .cloned()
                    .unwrap_or(Value::Null)
            })
            .collect();
        assert_eq!(est, [Value::Null, json!(60), json!(60)]);
        let dep: Vec<&Value> = times.iter().map(|x| &x["departure_time"]).collect();
        assert_eq!(dep, ["08:00", "08:05", "08:10"]);
        assert_eq!(times[0]["place_id"], "gzm:a");
        assert_eq!(t["shape_status"], "road");
        // flat like the client's Trip: times beside the shape ref, never the trip_execution envelope
        let s = found(r.live.trip("gzm:tA", false));
        assert!(
            s["times"]
                .as_array()
                .unwrap()
                .iter()
                .all(|x| x.get("estimate").is_none())
        );
        assert_eq!(s["shape_status"], "road");
        assert_eq!(s.get("trip"), None);
        assert_eq!(r.live.trip("gzm:nope", false), Lookup::Unknown);
    }

    #[tokio::test]
    async fn logs_when_each_stop_was_passed_per_trip_the_vehicle_id_outlives_its_trip() {
        let r = rig();
        let arrived = || r.live.trip_execution("gzm:283_4285").unwrap().get("arrived").cloned();
        let o = RecOpts {
            lon: Some(19.004),
            ..opts(at("08:02", 40), CALLS)
        };
        r.poll(at("08:03", 0), vec![rec(&o)]).await;
        assert_eq!(
            arrived(),
            Some(json!([])),
            "the first sighting is a baseline: stops passed before it stay unknown"
        );
        let o = RecOpts {
            delay: 60,
            lon: Some(19.012),
            ..opts(at("08:03", 0), &[(2, "08:10")])
        };
        let v = only(&r.poll(at("08:03", 20), vec![rec(&o)]).await);
        assert_eq!(arrived(), Some(json!([null, v["fix_at"]])));
        let o = RecOpts {
            lon: Some(LON_C),
            ..opts(at("08:12", 40), &[(2, "08:10")])
        };
        r.poll(at("08:13", 0), vec![rec(&o)]).await;
        assert_eq!(arrived(), Some(json!([])), "the brigade's next trip starts its own log");
    }

    #[tokio::test]
    async fn builds_the_board_from_the_feed_with_the_live_delay_hiding_visits_already_passed() {
        let r = rig();
        let o = RecOpts {
            delay: 60,
            lon: Some(19.005),
            ..opts(at("08:02", 40), CALLS)
        };
        r.poll(at("08:03", 0), vec![rec(&o)]).await;
        let board = found(r.live.departures("gzm:b", false));
        let rows = board["rows"].as_array().unwrap();
        let ids = |rows: &[Value]| rows.iter().map(|x| x["trip_id"].clone()).collect::<Vec<_>>();
        assert_eq!(ids(rows), ["gzm:tA", "gzm:tX", "gzm:tB"]);
        assert_eq!(rows[0]["plan_ts"], at("08:05", 0));
        assert_eq!(rows[0]["eta_ts"], at("08:06", 0));
        assert_eq!(rows[0]["delay_sec"], 60);
        assert_eq!(rows[0]["trip_execution_id"], "gzm:283_4285");
        assert_eq!(rows[0]["time"], "08:06");
        assert!(null(&rows[1], "eta_ts"));
        assert_eq!(rows[1]["trip_execution_id"], "");
        // the vehicle passed b: its tA visit there is gone
        let o = RecOpts {
            delay: 60,
            lon: Some(19.012),
            ..opts(at("08:06", 40), &[(2, "08:10")])
        };
        r.poll(at("08:07", 0), vec![rec(&o)]).await;
        let later = found(r.live.departures("gzm:b", false));
        assert_eq!(ids(later["rows"].as_array().unwrap()), ["gzm:tX", "gzm:tB"]);
        assert_eq!(r.live.departures("gzm:nope", false), Lookup::Unknown);
    }

    #[tokio::test]
    async fn answers_null_while_the_feed_loads_and_still_shows_bare_positions() {
        let r = rig_with(None, "gzm");
        let v = only(
            &r.poll(at("08:03", 0), vec![rec(&opts(at("08:02", 40), &[(1, "08:05")]))])
                .await,
        );
        assert_eq!(v["trip_id"], "");
        assert_eq!(r.live.departures("gzm:b", false), Lookup::Loading);
        assert_eq!(r.live.timetable("gzm:b", DATE), Lookup::Loading);
        assert_eq!(r.live.trip("gzm:tA", false), Lookup::Loading);
        let q = RouteQuery {
            from: "gzm:a",
            to: "gzm:c",
            ..RouteQuery::default()
        };
        assert!(r.live.connections(&q, &[]).is_none());
        let s = r.live.shapes(&["gzm:shA".to_owned()]);
        assert!(s.shapes.is_empty());
        assert_eq!(s.missing, ["gzm:shA"]);
        assert!(!s.exact);
    }

    #[tokio::test]
    async fn a_zbiorkom_city_polls_all_of_poland_while_its_feed_parses_then_again_as_soon_as_the_feed_lands() {
        let f = Arc::new(Mutex::new(None));
        let up = Fake::new(|_| {
            let o = RecOpts {
                lat: Some(52.23),
                lon: Some(21.01),
                ..opts(at("08:02", 40), &[(1, "08:05")])
            };
            Ok(positions_body(&[rec(&o)]))
        });
        let live = Arc::new(
            GzmLive::new("warsaw", up.clone())
                .with_feed(feed_fn(&f))
                // the next grid step is 9 s away
                .with_now(Arc::new(|| at("08:03", 4) * 1000)),
        );
        live.touch();
        let _run = Running::start(&live);
        until(|| body(&live)["count"] == 1).await;
        let urls = up.urls();
        assert!(urls[0].ends_with("/warsaw/positions/14,49,24.2,55"), "{}", urls[0]);
        assert_eq!(only(&body(&live))["lat"], 52.23);
        *f.lock().unwrap() = Some(Arc::clone(&FEED));
        until(|| up.urls().len() == 2).await;
        let urls = up.urls();
        assert!(!urls[1].ends_with("14,49,24.2,55"), "{}", urls[1]);
    }

    #[tokio::test]
    async fn tells_the_client_when_its_next_body_lands_and_nothing_once_the_loop_went_idle() {
        let now_ms = Arc::new(AtomicI64::new(at("08:03", 4) * 1000));
        let live = Arc::new(
            GzmLive::new("gzm", Fake::new(|_| Ok(positions_body(&[]))))
                .with_feed(Arc::new(|| Some(Arc::clone(&FEED))))
                .with_now(now_fn(&now_ms))
                .with_sdip_url(None),
        );
        assert_eq!(live.next_body_at(), None);
        let _run = Running::start(&live);
        until(|| live.next_body_at().is_some()).await;
        let now = || now_ms.load(Ordering::SeqCst);
        // 3 s past the next 10 s step, plus the slack
        assert_eq!(live.next_body_at(), Some(now() + 9000 + 250));
        // that poll runs late: ask again in a second
        now_ms.fetch_add(9300, Ordering::SeqCst);
        assert_eq!(live.next_body_at(), Some(now() + 1000));
        now_ms.fetch_add(10_000, Ordering::SeqCst);
        assert_eq!(live.next_body_at(), None);
    }

    #[test]
    fn lists_a_poles_day_timetable_and_nothing_outside_the_feeds_dates() {
        let live = GzmLive::new("gzm", Fake::new(|_| Ok(ok("{}")))).with_feed(Arc::new(|| Some(Arc::clone(&FEED))));
        let tt = found(live.timetable("gzm:b", DATE));
        let got: Vec<(Value, Value)> = tt["departures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| (d["trip_id"].clone(), d["departure"].clone()))
            .collect();
        assert_eq!(
            got,
            [
                (json!("gzm:tA"), json!(8 * 3600 + 300)),
                (json!("gzm:tX"), json!(8 * 3600 + 360)),
                (json!("gzm:tB"), json!(8 * 3600 + 1500))
            ]
        );
        assert_eq!(
            live.timetable("gzm:b", "2027-01-01"),
            Lookup::Found(json!({ "departures": [] }))
        );
    }
}

/// The health block as the TS `pollOnce` / `pollSdipOnce` leave it: `String(err)`, `text.length` (UTF-16 units) and
/// one synchronous step from the applied response to `lastGood`.
mod poll_bookkeeping {
    use std::sync::{Arc, Barrier, Mutex};

    use super::*;
    use gzm_rig::{FEED, Fake, body, ok, positions_body};
    use unimaps::gzm::{GzmFleetSource, GzmLive, ZbResponse};

    type Answer = Arc<Mutex<Result<ZbResponse, String>>>;

    fn down() -> Result<ZbResponse, String> {
        Ok(ZbResponse {
            status: 503,
            ..ok("down")
        })
    }

    fn live(answer: &Answer, fleet: Option<Arc<dyn Fn(Vec<GzmFleetSource>) + Send + Sync>>) -> GzmLive<Fake> {
        let a = Arc::clone(answer);
        GzmLive::new("gzm", Fake::new(move |_| a.lock().unwrap().clone()))
            .with_now(Arc::new(|| at("08:03", 0) * 1000))
            .with_feed(Arc::new(|| Some(Arc::clone(&FEED))))
            .with_url(Some("https://x.invalid/positions".into()))
            .with_sdip_url(Some("https://sdip.invalid/vm/main".into()))
            .with_fleet(fleet)
    }

    #[tokio::test]
    async fn last_error_is_string_err_a_thrown_error_reads_error_colon_a_fetch_failure_keeps_its_class() {
        let answer: Answer = Arc::new(Mutex::new(down()));
        let live = live(&answer, None);
        let cases = [
            (down(), "Error: HTTP 503"),
            (Ok(ok("{}")), "Error: zbiorkom: response has no positions array"),
            (
                Err("response body exceeds the size cap".into()),
                "Error: response body exceeds the size cap",
            ),
            (Err("TypeError: fetch failed".into()), "TypeError: fetch failed"),
            (
                Err("TimeoutError: The operation was aborted due to timeout".into()),
                "TimeoutError: The operation was aborted due to timeout",
            ),
        ];
        for (res, want) in cases {
            *answer.lock().unwrap() = res;
            assert!(!live.poll_once().await);
            assert_eq!(live.health()["last_error"], want);
        }
        *answer.lock().unwrap() = Ok(ok("<html/>"));
        assert!(!live.poll_once().await);
        let err = live.health()["last_error"].as_str().unwrap_or_default().to_owned();
        assert!(err.starts_with("SyntaxError: "), "{err}");
    }

    #[tokio::test]
    async fn sdip_last_error_is_string_err() {
        let answer: Answer = Arc::new(Mutex::new(down()));
        let live = live(&answer, None);
        assert!(!live.poll_sdip_once().await);
        assert_eq!(
            live.health()["sdip"]["last_error"],
            "Error: SDIP session: HTTP 503, no JSESSIONID"
        );
        *answer.lock().unwrap() = Ok(ZbResponse {
            set_cookies: vec!["JSESSIONID=s1; Path=/vm".into()],
            ..ok("<html/>")
        });
        assert!(!live.poll_sdip_once().await);
        assert_eq!(
            live.health()["sdip"]["last_error"],
            "Error: SDIP sent no JSON with a fresh session"
        );
    }

    #[tokio::test]
    async fn bytes_per_hour_counts_utf16_units_like_text_length() {
        let positions = positions_body(&[json!({ "headsign": "Sosnowiec Środula" })]);
        let units = positions.body.encode_utf16().count() as f64;
        assert!(units < positions.body.len() as f64);
        let answer: Answer = Arc::new(Mutex::new(Ok(positions)));
        let live = live(&answer, None);
        assert!(live.poll_once().await);
        // a constant clock: hours = 1/60
        assert_eq!(live.health()["bytes_per_hour"].as_f64(), Some(units * 60.0));
        let list = r#"["Środula"]"#;
        *answer.lock().unwrap() = Ok(ZbResponse {
            set_cookies: vec!["JSESSIONID=s1; Path=/vm".into()],
            ..ok(list)
        });
        live.poll_sdip_once().await;
        assert_eq!(
            live.health()["sdip"]["bytes_per_hour"].as_f64(),
            Some(list.encode_utf16().count() as f64 * 60.0)
        );
    }

    #[tokio::test]
    async fn a_concurrent_reader_sees_the_applied_poll_together_with_its_last_good() {
        let rec_on_trip = rec(&RecOpts {
            delay: 60,
            lon: Some(19.005),
            ..opts(at("08:02", 40), &[(1, "08:05"), (2, "08:10")])
        });
        let answer: Answer = Arc::new(Mutex::new(down()));
        let gate = Arc::new(Barrier::new(2));
        let g = Arc::clone(&gate);
        // the fleet callback holds the poll between the applied response and the end of its step
        let live = Arc::new(live(
            &answer,
            Some(Arc::new(move |_| {
                g.wait();
                g.wait();
            })),
        ));
        assert!(!live.poll_once().await);
        let (l, g) = (Arc::clone(&live), Arc::clone(&gate));
        let reader = std::thread::spawn(move || {
            g.wait();
            let seen = (body(&l)["count"].clone(), l.health());
            g.wait();
            seen
        });
        *answer.lock().unwrap() = Ok(positions_body(&[rec_on_trip]));
        assert!(live.poll_once().await);
        let (count, h) = reader.join().unwrap();
        assert_eq!(
            count, 1,
            "TS: the request lands before or after the step, never inside it"
        );
        assert_eq!(h["last_good"].as_f64(), Some(at("08:03", 0) as f64));
        assert_eq!(h["failures"], 0);
        assert_eq!(h["last_error"], Value::Null);
    }
}
