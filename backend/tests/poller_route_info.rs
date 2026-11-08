//! Port of test/poller-route-info.test.ts: LivePoller's attachRouteInfo end to end. The real line-120 loop capture
//! goes through ingest_trip_execution (the same path a polled trip execution takes) with a stored road shape, and the
//! resulting dist_m must stay on the right leg even when upstream's vehicle_trip_index freezes.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock};

use serde::Deserialize;
use serde_json::{Value, json};
use unimaps::kb_api::KbSource;
use unimaps::poller::{LivePoller, LivePollerOptions};
use unimaps::route_info::KbShapeSink;
use unimaps::shape_patterns::KbPattern;
use unimaps::shape_store::{ShapeGeometry, ShapePrio, ShapeSrc};
use unimaps::shared::polyline::{LatLng, decode_polyline, prepare_polyline, project_stops_along};
use unimaps::types::Stop;

#[path = "support/trip_progress.rs"]
mod trip_progress;

use trip_progress::stops_at_chainage;

#[derive(Deserialize)]
struct Snap {
    t: i64,
    lat: f64,
    lon: f64,
    vti: i64,
    ndi: i64,
    at: bool,
}

#[derive(Deserialize)]
struct FxStop {
    i: i64,
    id: String,
    name: String,
    lat: f64,
    lon: f64,
    sched: String,
}

#[derive(Deserialize)]
struct Fixture {
    polyline: String,
    stops: Vec<FxStop>,
    snapshots: Vec<Snap>,
}

struct Setup {
    fx: Fixture,
    along: Vec<Option<f64>>,
    geometry: Arc<ShapeGeometry>,
    stops: Vec<Stop>,
    times: Vec<Value>,
}

static SETUP: LazyLock<Setup> = LazyLock::new(|| {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/line120-loop-capture.json"
    );
    let fx: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let pl = prepare_polyline(&decode_polyline(&fx.polyline, 6)).unwrap();
    let stop_pts: Vec<Option<LatLng>> = fx.stops.iter().map(|s| Some([s.lat, s.lon])).collect();
    let along = project_stops_along(&pl, &stop_pts, 80.0);
    let geometry = Arc::new(ShapeGeometry {
        pl,
        stops: along.clone(),
        rev: "abc123".into(),
        src: ShapeSrc::Osrm,
    });
    let stops = fx
        .stops
        .iter()
        .map(|s| Stop {
            url_id: s.id.clone(),
            internal_id: s.id.parse().unwrap(),
            name: s.name.clone(),
            lon: s.lon,
            lat: s.lat,
            stop_id: s.id.clone(),
            ..Default::default()
        })
        .collect();
    let times = fx
        .stops
        .iter()
        .map(|s| {
            json!({
                "stop_name": s.name,
                "designator": s.id.parse::<i64>().unwrap(),
                "place_id": s.id,
                "departure_time": s.sched,
                "index": s.i,
            })
        })
        .collect();
    Setup {
        fx,
        along,
        geometry,
        stops,
        times,
    }
});

struct Api;

impl KbSource for Api {
    async fn fetch_revision(&self) -> String {
        "1".into()
    }

    async fn fetch_stops(&self, _revision: Option<&str>) -> Result<Vec<Stop>, String> {
        Ok(SETUP.stops.clone())
    }

    async fn fetch_multiple_departures(&self, _ids: &[String]) -> Result<Value, String> {
        Err("TypeError: this.api.fetchMultipleDepartures is not a function".into())
    }

    async fn fetch_trip_execution(&self, _eid: &str, _index: i64) -> Result<Value, String> {
        Err("TypeError: this.api.fetchTripExecution is not a function".into())
    }
}

/// The TS `{ touchKb: () => {}, geometry: () => geometry }`
struct Shapes;

impl KbShapeSink for Shapes {
    fn touch_kb(&self, _p: &KbPattern, _prio: ShapePrio) {}

    fn geometry(&self, _key: &str) -> Option<Arc<ShapeGeometry>> {
        Some(SETUP.geometry.clone())
    }
}

/// replay every snapshot through the poller; `freeze_at` = upstream's index sticks there once the bus reaches it
async fn replay(freeze_at: Option<i64>, every: usize) -> Vec<String> {
    let st = &*SETUP;
    let n = st.fx.stops.len() as i64;
    let clock = Arc::new(AtomicI64::new(st.fx.snapshots.first().map_or(0, |s| s.t)));
    let c = clock.clone();
    let poller = LivePoller::new(
        Api,
        LivePollerOptions {
            shapes: Some(Arc::new(Shapes)),
            ..Default::default()
        },
    )
    .with_now(Arc::new(move || c.load(Ordering::SeqCst)));
    let _ = poller.load_stops().await;
    let eid = "4263:739891:0";
    let mut bad = Vec::new();
    for (k, s) in st.fx.snapshots.iter().enumerate() {
        // a sparse poller: long gaps between the fixes it sees
        if k % every != 0 {
            continue;
        }
        let frozen = freeze_at.filter(|&f| s.vti >= f);
        let vti = frozen.unwrap_or(s.vti);
        let at = frozen.is_none() && s.at;
        let ndi = frozen.map_or(s.ndi, |f| f + 1);
        clock.store(s.t, Ordering::SeqCst);
        let resp = json!({
            "trip": { "times": st.times, "line": { "name": "120" }, "direction": "SZCZYRK SALMOPOL (SOLISKO)" },
            "vehicle": { "lat": s.lat, "lon": s.lon },
            "vehicle_trip_index": vti,
            "next_departure_index": ndi,
            "at_stop": at,
            "estimates": [{ "to_go": 0, "arrival_abs": "23:00" }],
        });
        let pos = poller.ingest_trip_execution(eid, &resp, None).expect("ingested");
        let dist = pos.dist_m.expect("the fix is on the stored shape");
        let r = stops_at_chainage(&st.along, dist, vti, at);
        let exp = if s.at {
            (s.vti, true)
        } else {
            ((s.vti + 1).min(n - 1), false)
        };
        let ok = r.is_some_and(|(i, _)| {
            let i = i as i64;
            i == exp.0 || (exp.1 && i == exp.0 + 1)
        });
        if !ok {
            let when = jiff::Timestamp::from_millisecond(s.t)
                .map(|t| t.to_string())
                .unwrap_or_default();
            let got = r.map_or("undefined".to_string(), |(i, _)| i.to_string());
            bad.push(format!(
                "{when} upstream {}{} (sent {vti}) -> {got}",
                s.vti,
                if s.at { "@" } else { "" }
            ));
        }
    }
    bad
}

#[tokio::test]
async fn upstream_right_dist_m_maps_to_upstream_s_stop_at_every_snapshot() {
    assert_eq!(replay(None, 1).await, Vec::<String>::new());
}

#[tokio::test]
async fn upstream_index_frozen_at_19_dist_m_stays_on_the_return_leg() {
    assert_eq!(replay(Some(19), 1).await, Vec::<String>::new());
}

#[tokio::test]
async fn upstream_index_frozen_at_20_dist_m_stays_on_the_return_leg() {
    assert_eq!(replay(Some(20), 1).await, Vec::<String>::new());
}

#[tokio::test]
async fn upstream_index_frozen_at_21_dist_m_stays_on_the_return_leg() {
    assert_eq!(replay(Some(21), 1).await, Vec::<String>::new());
}

#[tokio::test]
async fn upstream_index_frozen_at_22_dist_m_stays_on_the_return_leg() {
    assert_eq!(replay(Some(22), 1).await, Vec::<String>::new());
}

#[tokio::test]
async fn a_slow_poller_a_fix_every_48_s_600_m_of_road_the_forward_window_widens_with_the_gap_frozen_index_at_22() {
    assert_eq!(replay(Some(22), 8).await, Vec::<String>::new());
    assert_eq!(replay(None, 8).await, Vec::<String>::new());
}
