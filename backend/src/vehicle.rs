//! lib/types.ts `VehiclePos` (one live vehicle as a poller holds it) and lib/poller.ts `vehicleToJson`, the
//! Python-parity wire object every `/api/vehicles` entry starts from.

use serde_json::{Map, Value};

use crate::js::{num_value, to_fixed};
use crate::kb_progress::{DelaySrc, KbArrivals, KbProgState};
use crate::mzk_fleet::VehicleFeatures;

#[derive(Debug, Clone, Default)]
pub struct VehiclePos {
    pub exec_id: String,
    pub trip_id: String,
    pub route_id: String,
    pub line: String,
    pub headsign: String,
    pub lat: f64,
    pub lon: f64,
    /// GTFS route_type
    pub vehicle_type: i32,
    pub current_stop_sequence: Option<i64>,
    pub at_stop: bool,
    /// seconds, + = late
    pub delay: Option<f64>,
    /// epoch seconds of upstream's fix
    pub timestamp: f64,
    /// epoch seconds of our fetch
    pub updated_at: f64,
    pub bearing: Option<f64>,
    pub next_stop_name: Option<String>,
    pub next_stop_lat: Option<f64>,
    pub next_stop_lon: Option<f64>,
    pub last_moved_at: f64,
    pub anchor_lat: f64,
    pub anchor_lon: f64,
    pub finished: bool,
    pub not_started: bool,
    /// None = "KB"
    pub operator: Option<&'static str>,
    pub side_number: Option<String>,
    pub model: Option<String>,
    pub features: Option<VehicleFeatures>,
    pub agency: Option<String>,
    pub scheduled: bool,
    /// epoch seconds the position was taken
    pub fix_at: Option<f64>,
    pub shape_key: Option<String>,
    /// along-route metres on `shape_key` at revision `dist_rev`
    pub dist_m: Option<f64>,
    pub dist_rev: Option<String>,
    pub next_stop_seq: Option<i64>,
    /// cruise speed m/s and when it was measured (epoch seconds)
    pub speed: Option<f64>,
    pub speed_at: Option<f64>,
    pub sched_speed: Option<f64>,
    /// along-route metres of the last move
    pub move_ds: Option<f64>,
    /// upstream's raw delay (`Some(None)` = upstream sent none)
    pub delay_up: Option<Option<f64>>,
    pub delay_src: Option<DelaySrc>,
    pub geo_last_seq: Option<i64>,
    pub geo_next_seq: Option<i64>,
    pub prog: Option<KbProgState>,
    pub arrivals: Option<KbArrivals>,
    pub sched_trip_id: Option<String>,
}

/// `roundTo`: `Number(x.toFixed(digits))`
fn round_to(x: f64, digits: usize) -> Value {
    num_value(to_fixed(x, digits).parse().unwrap_or(f64::NAN))
}

fn opt_num(x: Option<f64>) -> Value {
    x.map_or(Value::Null, num_value)
}

/// `vehicleToJson`, keys in its order.
pub fn vehicle_to_json(v: &VehiclePos) -> Map<String, Value> {
    let mut o = Map::new();
    o.insert("id".into(), v.exec_id.clone().into());
    o.insert("trip_id".into(), v.trip_id.clone().into());
    o.insert("route_id".into(), v.route_id.clone().into());
    o.insert("line".into(), v.line.clone().into());
    o.insert("headsign".into(), v.headsign.clone().into());
    o.insert("lat".into(), round_to(v.lat, 6));
    o.insert("lon".into(), round_to(v.lon, 6));
    o.insert("vehicle_type".into(), v.vehicle_type.into());
    o.insert("current_stop_sequence".into(), v.current_stop_sequence.into());
    o.insert("at_stop".into(), v.at_stop.into());
    o.insert("delay".into(), opt_num(v.delay));
    o.insert("bearing".into(), v.bearing.map_or(Value::Null, |b| round_to(b, 1)));
    o.insert("next_stop_name".into(), v.next_stop_name.clone().into());
    o.insert(
        "next_stop_lat".into(),
        v.next_stop_lat.map_or(Value::Null, |x| round_to(x, 6)),
    );
    o.insert(
        "next_stop_lon".into(),
        v.next_stop_lon.map_or(Value::Null, |x| round_to(x, 6)),
    );
    o.insert("timestamp".into(), num_value(v.timestamp));
    o.insert("updated_at".into(), round_to(v.updated_at, 1));
    o.insert("operator".into(), v.operator.unwrap_or("KB").into());
    if let Some(s) = v.side_number.as_ref().filter(|s| !s.is_empty()) {
        o.insert("side_number".into(), s.clone().into());
    }
    if let Some(m) = v.model.as_ref().filter(|m| !m.is_empty()) {
        o.insert("model".into(), m.clone().into());
    }
    if let Some(f) = &v.features {
        o.insert("features".into(), serde_json::to_value(f).unwrap_or(Value::Null));
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_keys_and_rounding() {
        let v = VehiclePos {
            exec_id: "gzm:3_1".into(),
            lat: 50.123_456_7,
            lon: 19.0,
            bearing: Some(-0.04),
            updated_at: 1_700_000_000.25,
            timestamp: 1_700_000_000.0,
            delay: Some(60.0),
            operator: Some("GZM"),
            side_number: Some(String::new()),
            ..Default::default()
        };
        let s = serde_json::to_string(&vehicle_to_json(&v)).unwrap();
        assert_eq!(
            s,
            r#"{"id":"gzm:3_1","trip_id":"","route_id":"","line":"","headsign":"","lat":50.123457,"lon":19,"vehicle_type":0,"current_stop_sequence":null,"at_stop":false,"delay":60,"bearing":0,"next_stop_name":null,"next_stop_lat":null,"next_stop_lon":null,"timestamp":1700000000,"updated_at":1700000000.3,"operator":"GZM"}"#
        );
    }
}
