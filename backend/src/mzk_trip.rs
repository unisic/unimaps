//! lib/mzk-trip.ts: an MZK trip answer (`/api/trip`, `/api/trips`, `/api/trip_execution`) from the running list,
//! else OnTime's realCourse, with the variant's road shape.

use std::sync::Arc;

use jiff::Timestamp;
use serde_json::{Map, Value, json};

use crate::fetch::string_err;
use crate::js::{self, num_value, number_to_string, parse_int, truthy, value_to_string};
use crate::mzk_api::MzkSource;
use crate::mzk_poller::MZK_STALE_SEC;
use crate::mzk_state::{MzkLifecycleInput, clamp_planned_monotone, is_mzk_not_started};
use crate::poller::js_number_of;
use crate::poller_singleton::{Bb, BbKinds};
use crate::shared::departures::{WARSAW, hhmm};
use crate::shared::polyline::LatLng;
use crate::stop_board::hh_mm_of_secs;

/// `getVariantShape`: the road polyline of an MZK variant from the shape store (fetched on demand, deduped,
/// negative-cached and persisted there).
pub async fn get_variant_shape<T: BbKinds>(bb: &Bb<T>, variant_id: f64) -> Option<Vec<LatLng>> {
    // ponytail: a fractional variant id is truncated for the fetch (OnTime ids are integers)
    bb.shapes().get_mzk_shape(variant_id as i64).await
}

fn shape_json(shape: Option<Vec<LatLng>>) -> Value {
    shape.map_or(Value::Null, |pts| {
        pts.iter()
            .map(|&[lat, lon]| json!([num_value(lat), num_value(lon)]))
            .collect()
    })
}

/// A JS-truthy variant id (not 0 or NaN).
fn variant_of(v: Option<f64>) -> Option<f64> {
    v.filter(|x| *x != 0.0 && !x.is_nan())
}

/// `shapeRef`: `shape_id` (the fleet's wire id, so the client reuses the fleet track's shape) + `shape_status`.
fn shape_ref<T: BbKinds>(bb: &Bb<T>, out: &mut Map<String, Value>, variant: Option<f64>) {
    let Some(v) = variant_of(variant) else {
        out.insert("shape_status".into(), "none".into());
        return;
    };
    let key = format!("mzk:{}", number_to_string(v));
    if let Some(id) = bb.shapes().wire_id(&key) {
        out.insert("shape_id".into(), id.into());
    }
    out.insert("shape_status".into(), bb.shapes().status(Some(&key)).as_str().into());
}

fn copy(out: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        out.insert(key.into(), v.clone());
    }
}

/// A non-null value as `Number(v)`; None for null/absent.
fn non_null_num(v: Option<&Value>) -> Option<f64> {
    v.filter(|v| !v.is_null()).map(js_number_of)
}

/// `buildMzkTimes`: `trip.times` of a running vehicle (`cached` = its OnTime record). `estimate.time_diff`
/// (planned - scheduled, s) only for live callers and never while the course has not begun; the planned times of
/// the stops still ahead are made forward-monotone. `now_ms` stands in for a missing scheduled departure.
// ponytail: a stop point that is not an object is read as one without fields (the TS throws; OnTime never sends one)
pub fn build_mzk_times(cached: &Value, live: bool, not_started: bool, now_ms: f64) -> Vec<Value> {
    let sps = cached
        .get("stopPoints")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let planned_in: Vec<Option<f64>> = sps
        .iter()
        .map(|sp| sp.get("plannedDeparture").and_then(Value::as_f64))
        .collect();
    let from = non_null_num(cached.get("orderInCourse")).unwrap_or(0.0);
    let planned = clamp_planned_monotone(&planned_in, from);
    sps.iter()
        .enumerate()
        .map(|(idx, sp)| {
            let sched = sp.get("scheduledDeparture");
            let sched_ms = if truthy(sched) {
                non_null_num(sched).unwrap_or(f64::NAN)
            } else {
                now_ms
            };
            let planned_ms = planned
                .get(idx)
                .copied()
                .flatten()
                .filter(|p| *p != 0.0)
                .unwrap_or(sched_ms);
            let mut e = Map::new();
            copy(&mut e, "stop_name", sp.get("name"));
            e.insert("designator".into(), Value::Null);
            e.insert(
                "place_id".into(),
                format!("mzk:{}", value_to_string(sp.get("symbol"))).into(),
            );
            e.insert("departure_time".into(), hhmm(sched_ms / 1000.0).into());
            e.insert("index".into(), idx.into());
            e.insert("platform".into(), Value::Null);
            if live && !not_started {
                let diff = js::round((planned_ms - sched_ms) / 1000.0);
                e.insert("estimate".into(), json!({ "time_diff": num_value(diff) }));
            }
            Value::Object(e)
        })
        .collect()
}

/// `resolveMzkTrip`: the trip answer of an MZK id (`mzk:<course>[:<vehicle>]`, `mzk:<course>:<variant>[:<vehicle>]`)
/// from the running list while the feed is fresh, else from OnTime's realCourse; None = neither knows it. `live`
/// = a live trip view: per-stop `estimate`s, except while the course has not begun (static callers are cached for
/// minutes and must not carry them). Err = the realCourse fetch failed (`String(err)`).
pub async fn resolve_mzk_trip<T: BbKinds>(
    bb: &Bb<T>,
    identifier: &str,
    live: bool,
) -> Result<Option<Map<String, Value>>, String> {
    let clean = identifier.strip_prefix("mzk:").unwrap_or(identifier);
    let parts: Vec<&str> = clean.split(':').collect();
    let course_id = parts.first().copied().unwrap_or_default();
    let cid = parse_int(course_id);
    let now_ms = bb.now_ms() as f64;
    let poller = Arc::clone(bb.mzk_poller());

    // one look at the poller state, released before any await
    let (explicit_variant, cached, first) = {
        let st = poller.state();
        let mut vehicle_id = parts.get(1).copied();
        let mut explicit_variant = None;
        if let Some(v) = vehicle_id.filter(|v| !v.is_empty())
            && !st.static_vehicles.contains_key(v)
            && parse_int(v) > 1000.0
        {
            explicit_variant = Some(parse_int(v));
            vehicle_id = parts.get(2).copied();
        }
        // a failing OnTime feed leaves the last running list in place: a frozen bus must not look live
        let fresh = now_ms / 1000.0 - st.last_good_refresh <= MZK_STALE_SEC;
        let running = &st.running_vehicles;
        let cached = fresh
            .then(|| {
                vehicle_id
                    .filter(|v| !v.is_empty())
                    .and_then(|v| running.get(&format!("mzk:{course_id}:{v}")))
                    .or_else(|| running.get(course_id))
                    .or_else(|| running.get(identifier))
                    .cloned()
            })
            .flatten()
            .filter(|c| {
                c.get("stopPoints")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty())
            });
        let first = cached
            .as_ref()
            .and_then(|c| c.pointer("/stopPoints/0/symbol"))
            .and_then(Value::as_str)
            .and_then(|s| st.stops_by_symbol.get(s))
            .map(|s| (s.lat, s.lon));
        (explicit_variant, cached, first)
    };

    if let Some(c) = cached {
        let not_started = live && is_mzk_not_started(&MzkLifecycleInput::from_json(&c), first);
        let times = build_mzk_times(&c, live, not_started, now_ms);
        let variant = variant_of(c.get("variantLoid").filter(|v| truthy(Some(v))).map(js_number_of));
        let shape = match variant {
            Some(v) => get_variant_shape(bb, v).await,
            None => None,
        };
        let bearing = {
            let st = poller.state();
            let vid = c.get("vehicleId").filter(|v| truthy(Some(v)));
            vid.and_then(|v| {
                st.positions
                    .get(&format!(
                        "mzk:{}:{}",
                        value_to_string(c.get("courseLoid")),
                        value_to_string(Some(v))
                    ))
                    .or_else(|| v.as_str().and_then(|s| st.last_positions_by_vehicle.get(s)))
            })
            .or_else(|| st.positions.get(identifier))
            .and_then(|p| p.bearing)
        };

        let direction = [c.get("direction"), c.get("optionalDirection")]
            .into_iter()
            .find(|v| truthy(*v))
            .flatten()
            .cloned()
            .unwrap_or_else(|| "".into());
        let mut trip = Map::new();
        trip.insert("times".into(), times.into());
        trip.insert("direction".into(), direction);
        let mut line = Map::new();
        copy(&mut line, "name", c.get("lineName"));
        trip.insert("line".into(), line.into());
        copy(&mut trip, "lineName", c.get("lineName"));
        trip.insert("operator".into(), "MZK".into());
        let mut vehicle = Map::new();
        copy(&mut vehicle, "lat", c.get("latitude"));
        copy(&mut vehicle, "lon", c.get("longitude"));
        if let Some(b) = bearing {
            vehicle.insert("bearing".into(), num_value(b));
        }
        let mut out = Map::new();
        out.insert("trip".into(), trip.into());
        out.insert("vehicle".into(), vehicle.into());
        let index = c
            .get("orderInCourse")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| 0.into());
        out.insert("vehicle_trip_index".into(), index);
        if not_started {
            out.insert("not_started".into(), true.into());
        }
        out.insert("shape".into(), shape_json(shape));
        shape_ref(bb, &mut out, variant);
        return Ok(Some(out));
    }

    // not running (or a stale feed): OnTime's realCourse
    if !cid.is_finite() {
        return Ok(None);
    }
    let rc_data = bb.mzk_api().fetch_real_course(cid).await.map_err(string_err)?;
    let Some(stoppings) = rc_data
        .pointer("/realCourse/stoppings")
        .and_then(Value::as_array)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let rc = rc_data.get("realCourse");
    let meta = poller.state().course_meta.get(&(cid as i64)).cloned();
    let line_name = rc
        .and_then(|rc| rc.get("lineName"))
        .filter(|v| truthy(Some(v)))
        .cloned()
        .or_else(|| {
            meta.as_ref()
                .map(|m| m.line_name.clone())
                .filter(|s| !s.is_empty())
                .map(Value::from)
        })
        .unwrap_or_else(|| "".into());
    let variant = variant_of(
        rc.and_then(|rc| rc.get("variantLoid"))
            .filter(|v| truthy(Some(v)))
            .map(js_number_of),
    )
    .or(explicit_variant)
    .or_else(|| meta.as_ref().and_then(|m| m.variant_id));
    let direction = meta
        .as_ref()
        .map(|m| m.direction.clone())
        .filter(|s| !s.is_empty())
        .map(Value::from)
        .or_else(|| {
            stoppings
                .last()
                .and_then(|s| s.get("stopPointName"))
                .filter(|v| truthy(Some(v)))
                .cloned()
        })
        .unwrap_or_else(|| "".into());

    // ponytail: a stopping that is not an object is read as one without fields (the TS throws)
    let times: Vec<Value> = stoppings
        .iter()
        .enumerate()
        .map(|(idx, s)| {
            let sched_sec = s.get("scheduledDepartureSec").map_or(f64::NAN, js_number_of);
            let mut e = Map::new();
            copy(&mut e, "stop_name", s.get("stopPointName"));
            e.insert("designator".into(), Value::Null);
            e.insert(
                "place_id".into(),
                format!("mzk:{}", value_to_string(s.get("stopPointSymbol"))).into(),
            );
            e.insert("departure_time".into(), hh_mm_of_secs(sched_sec).into());
            e.insert("index".into(), idx.into());
            e.insert("platform".into(), Value::Null);
            if live {
                let est = s
                    .get("estimatedDeparture")
                    .filter(|v| truthy(Some(v)))
                    .map(js_number_of);
                let diff = est.map_or(0.0, |ms| est_diff(ms, sched_sec));
                e.insert("estimate".into(), json!({ "time_diff": num_value(diff) }));
            }
            Value::Object(e)
        })
        .collect();

    let shape = match variant_of(variant) {
        Some(v) => get_variant_shape(bb, v).await,
        None => None,
    };
    let mut trip = Map::new();
    trip.insert("times".into(), times.into());
    trip.insert("direction".into(), direction);
    trip.insert("line".into(), json!({ "name": line_name }));
    trip.insert("lineName".into(), line_name);
    trip.insert("operator".into(), "MZK".into());
    let mut out = Map::new();
    out.insert("trip".into(), trip.into());
    out.insert("vehicle".into(), Value::Null);
    out.insert("vehicle_trip_index".into(), 0.into());
    out.insert("shape".into(), shape_json(shape));
    shape_ref(bb, &mut out, variant);
    Ok(Some(out))
}

/// The estimate's Warsaw wall-clock seconds minus the scheduled second of day, wrapped into +-12 h.
// ponytail: an instant out of jiff's range counts as 0 s (the TS Intl call throws a RangeError)
fn est_diff(est_ms: f64, sched_sec: f64) -> f64 {
    let est_secs = Timestamp::from_millisecond(est_ms.trunc() as i64).map_or(0.0, |t| {
        let dt = WARSAW.to_datetime(t);
        f64::from(i32::from(dt.hour()) * 3600 + i32::from(dt.minute()) * 60 + i32::from(dt.second()))
    });
    let diff = est_secs - sched_sec % 86_400.0;
    if diff < -43_200.0 {
        diff + 86_400.0
    } else if diff > 43_200.0 {
        diff - 86_400.0
    } else {
        diff
    }
}
