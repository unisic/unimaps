//! server/api/health/route.ts.

use std::panic::{AssertUnwindSafe, catch_unwind};

use hyper::{Response, StatusCode};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::api_helpers::{internal_error, upstream_error};
use crate::config;
use crate::fleet_tracker::blocking_io;
use crate::gzm::{safe_gzm_health, safe_zb_health};
use crate::http::{Body, json};
use crate::js::{self, JsNum};
use crate::poller_singleton::{Bb, BbKinds};

/// HealthResponse in TS key order.
#[derive(Serialize)]
struct Health {
    status: &'static str,
    stops: usize,
    scan_count: u64,
    last_scan: JsNum,
    vehicles: usize,
    tracked: usize,
    last_refresh: JsNum,
    last_good_refresh: JsNum,
    feed_age_secs: JsNum,
    loop_restarts: u64,
    last_loop_error: Option<String>,
    stops_loaded_at: JsNum,
    #[serde(flatten)]
    stops_health: Option<StopsHealth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shapes: Option<Map<String, Value>>,
    stale_index: usize,
    gps_polls: u64,
    gps_disagree: u64,
    gzm: Value,
    zb: Value,
}

#[derive(Serialize)]
struct StopsHealth {
    mzk_stops: usize,
    mzk_stops_loaded_at: JsNum,
    merged_stops: MergedStops,
}

#[derive(Serialize)]
struct MergedStops {
    both: usize,
    kb: usize,
    mzk: usize,
    partial: bool,
    mzk_dir_stops: usize,
    built_at: i64,
}

/// GET /api/health: "degraded" + 503 (flips the Docker healthcheck) when the scan loop stalled or the
/// last proven upstream contact is older than KB_HEALTH_STALE_SEC. Deliberately no vehicle-count condition: 0
/// vehicles overnight is normal. The stops, shapes, gzm and zb blocks are informational and never flip `status`.
pub async fn get_owned<T: BbKinds>(bb: &'static Bb<T>) -> Response<Body> {
    if let Err(err) = bb.start_poller().await {
        return upstream_error("health", err);
    }
    let poller = bb.poller();
    let h = poller.health_snapshot();
    let now = bb.now_ms() as f64 / 1000.0;
    // lastScan stamps once per loop iteration even when the scan throws, and the supervisor restarts a crashed
    // loop within <= 300 s, so 2 intervals + slack of genuine silence means the loop is really stuck
    let loop_stalled = h.scan_count > 0 && now - h.last_scan > 2.0 * poller.scan_interval + 120.0;
    let feed_stale = now - h.last_good_refresh > *config::HEALTH_STALE_SEC as f64;
    let degraded = loop_stalled || feed_stale;
    // a problem in these stores must never break the healthcheck: the TS catch drops the block
    let stops_health = blocking_io(|| catch_unwind(AssertUnwindSafe(|| stops_health(bb))).ok());
    let shapes = catch_unwind(AssertUnwindSafe(|| bb.shapes().health())).ok();
    let body = Health {
        status: if degraded { "degraded" } else { "ok" },
        stops: h.stops,
        scan_count: h.scan_count,
        last_scan: JsNum(h.last_scan),
        vehicles: h.live,
        tracked: h.tracked,
        last_refresh: JsNum(h.last_refresh),
        last_good_refresh: JsNum(h.last_good_refresh),
        feed_age_secs: JsNum(js::round(now - h.last_good_refresh)),
        loop_restarts: h.loop_restarts,
        last_loop_error: h.last_loop_error,
        stops_loaded_at: JsNum(h.stops_loaded_at),
        stops_health,
        shapes,
        stale_index: h.stale_index,
        gps_polls: h.gps_polls,
        gps_disagree: h.gps_disagree,
        gzm: safe_gzm_health(),
        zb: safe_zb_health(),
    };
    match serde_json::to_string(&body) {
        Ok(text) => json(
            if degraded {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::OK
            },
            text,
        ),
        Err(err) => internal_error("health", err),
    }
}

/// safeStopsHealth: the MZK stop list and the memoized merge (a changed input re-merges here).
fn stops_health<T: BbKinds>(bb: &'static Bb<T>) -> StopsHealth {
    let (mzk_stops, mzk_stops_loaded_at) = {
        let st = bb.mzk_poller().state();
        (st.stops.len(), st.stops_loaded_at)
    };
    let view = bb.merged_stops_view();
    StopsHealth {
        mzk_stops,
        mzk_stops_loaded_at: JsNum(mzk_stops_loaded_at),
        merged_stops: MergedStops {
            both: view.summary.both,
            kb: view.summary.kb,
            mzk: view.summary.mzk,
            partial: view.partial,
            mzk_dir_stops: view.summary.mzk_dir_stops,
            built_at: view.summary.built_at,
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn owned_body_keeps_the_ts_key_order_and_drops_a_failed_block() {
        let body = |stops_health, shapes| Health {
            status: "ok",
            stops: 2,
            scan_count: 3,
            last_scan: JsNum(1.5),
            vehicles: 1,
            tracked: 4,
            last_refresh: JsNum(10.0),
            last_good_refresh: JsNum(10.0),
            feed_age_secs: JsNum(js::round(-0.4)),
            loop_restarts: 0,
            last_loop_error: None,
            stops_loaded_at: JsNum(0.0),
            stops_health,
            shapes,
            stale_index: 0,
            gps_polls: 5,
            gps_disagree: 6,
            gzm: json!({"enabled": false}),
            zb: json!({}),
        };
        let head = r#"{"status":"ok","stops":2,"scan_count":3,"last_scan":1.5,"vehicles":1,"tracked":4,"last_refresh":10,"last_good_refresh":10,"feed_age_secs":0,"loop_restarts":0,"last_loop_error":null,"stops_loaded_at":0,"#;
        let tail = r#""stale_index":0,"gps_polls":5,"gps_disagree":6,"gzm":{"enabled":false},"zb":{}}"#;
        assert_eq!(
            serde_json::to_string(&body(None, None)).ok(),
            Some(format!("{head}{tail}"))
        );
        let stops = StopsHealth {
            mzk_stops: 7,
            mzk_stops_loaded_at: JsNum(1700000000.25),
            merged_stops: MergedStops {
                both: 1,
                kb: 2,
                mzk: 3,
                partial: true,
                mzk_dir_stops: 4,
                built_at: 1700000001,
            },
        };
        let mid = r#""mzk_stops":7,"mzk_stops_loaded_at":1700000000.25,"merged_stops":{"both":1,"kb":2,"mzk":3,"partial":true,"mzk_dir_stops":4,"built_at":1700000001},"shapes":{},"#;
        assert_eq!(
            serde_json::to_string(&body(Some(stops), Some(Map::new()))).ok(),
            Some(format!("{head}{mid}{tail}"))
        );
    }
}
