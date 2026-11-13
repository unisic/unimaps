//! GET /api/traffic?lat=&lon=: the live speed of the road at one point, from TomTom's Flow Segment Data
//! (`KB_TOMTOM_KEY`; unset = 404, the feature off). Only the bus a trip view tracks asks for it, so the dead
//! reckoning (`lib/client/vehicleMotion.ts`) slows down in a jam instead of driving ahead of the bus.
//! Experiment: never run against live TomTom data; whether the slowed marker tracks real buses in jams is unchecked.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use hyper::Response;
use serde::Serialize;
use serde_json::Value;

use super::{ApiRequest, json_cached};
use crate::api_helpers::{bad_request, not_found, query_param, upstream_error};
use crate::config::TOMTOM_KEY;
use crate::gzm::{HttpZb, ZbTransport};
use crate::http::Body;
use crate::rate_limit::{allow_request, too_many_requests};

/// a tracked bus asks about once a minute
const COST: f64 = 2.0;
const TIMEOUT: Duration = Duration::from_secs(4);
/// one segment answers in well under 2 KB
const MAX_BODY: usize = 64 << 10;
/// TomTom's free tier is 20 000 Flow Segment Data requests a month (developer.tomtom.com/pricing): 600 a day stays
/// under it whatever the month. shortcut: a fixed daily cap, make it a KB_* setting once a paid plan is in.
const DAILY: u32 = 600;
/// below this TomTom fills the speed from history, not live probes: it says nothing about today's jam
const MIN_CONFIDENCE: f64 = 0.5;
/// every city Unimaps serves is in Poland
const LAT: (f64, f64) = (49.0, 54.9);
const LON: (f64, f64) = (14.1, 24.2);

/// (UTC day, upstream requests made on it)
static SPENT: Mutex<(i64, u32)> = Mutex::new((0, 0));

#[derive(Serialize)]
struct Answer {
    /// m/s, null when TomTom knows no live speed here
    speed: Option<f64>,
}

/// One request of `cap` a day; false once the day's are spent.
fn take_budget(spent: &mut (i64, u32), day: i64, cap: u32) -> bool {
    if spent.0 != day {
        *spent = (day, 0);
    }
    if spent.1 >= cap {
        return false;
    }
    spent.1 += 1;
    true
}

fn coord(query: &str, name: &str, (lo, hi): (f64, f64)) -> Option<f64> {
    let v: f64 = query_param(query, name)?.parse().ok()?;
    (lo..=hi).contains(&v).then_some(v)
}

/// The live speed (m/s) of a Flow Segment Data answer; None for a closed road or a low-confidence one.
fn live_speed(body: &Value) -> Option<f64> {
    let f = body.get("flowSegmentData")?;
    if f.get("roadClosure").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let confidence = f.get("confidence")?.as_f64()?;
    let kmh = f.get("currentSpeed")?.as_f64()?;
    (confidence >= MIN_CONFIDENCE && kmh >= 0.0).then(|| (kmh / 3.6 * 10.0).round() / 10.0)
}

pub async fn get_owned(req: &ApiRequest) -> Response<Body> {
    handle(req, &HttpZb, TOMTOM_KEY.as_deref()).await
}

/// `get_owned` with TomTom behind `tomtom` and the key passed in.
pub async fn handle<T: ZbTransport>(req: &ApiRequest, tomtom: &T, key: Option<&str>) -> Response<Body> {
    if !allow_request(&req.ip(), COST) {
        return too_many_requests();
    }
    let Some(key) = key else {
        return not_found("Not found");
    };
    let (Some(lat), Some(lon)) = (coord(&req.query, "lat", LAT), coord(&req.query, "lon", LON)) else {
        return bad_request("Invalid 'lat' / 'lon' parameter");
    };
    let day = jiff::Timestamp::now().as_second().div_euclid(86_400);
    if !take_budget(&mut SPENT.lock().unwrap_or_else(PoisonError::into_inner), day, DAILY) {
        return too_many_requests();
    }
    let params = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("key", key)
        .append_pair("point", &format!("{lat:.5},{lon:.5}"))
        .finish();
    // zoom 22: every road, a bus's local streets included (a lower zoom hides the minor ones)
    let url = format!("https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/22/json?{params}");
    let res = match tomtom.get(&url, &[], TIMEOUT, MAX_BODY).await {
        Ok(r) if r.ok() => r,
        Ok(r) => return upstream_error("traffic", format_args!("HTTP {}", r.status)),
        Err(err) => return upstream_error("traffic", err),
    };
    let body: Value = match crate::js::json_parse(&res.body) {
        Ok(v) => v,
        Err(err) => return upstream_error("traffic", err),
    };
    json_cached(
        &Answer {
            speed: live_speed(&body),
        },
        "no-store",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_resets_each_day() {
        let mut spent = (0, 0);
        assert!(take_budget(&mut spent, 5, 2));
        assert!(take_budget(&mut spent, 5, 2));
        assert!(!take_budget(&mut spent, 5, 2));
        assert!(take_budget(&mut spent, 6, 2));
        assert_eq!(spent, (6, 1));
    }

    #[test]
    fn live_speed_needs_confidence_and_an_open_road() {
        let seg = |speed: f64, confidence: f64, closed: bool| serde_json::json!({ "flowSegmentData": { "currentSpeed": speed, "freeFlowSpeed": 50, "confidence": confidence, "roadClosure": closed } });
        assert_eq!(live_speed(&seg(18.0, 0.9, false)), Some(5.0));
        assert_eq!(live_speed(&seg(18.0, 0.3, false)), None);
        assert_eq!(live_speed(&seg(18.0, 0.9, true)), None);
        assert_eq!(live_speed(&serde_json::json!({})), None);
    }
}
