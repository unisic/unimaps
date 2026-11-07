//! lib/poller.ts vehiclePositionsFeed bytes (protobufjs via gtfs-realtime-bindings) from scripts/dump-vectors.ts.

use serde_json::Value;
use unimaps::gtfs_rt::{FeedVehicle, vehicle_positions_feed};

#[test]
fn golden_vehicle_positions_feed() {
    let v: Value = serde_json::from_str(include_str!("vectors/gtfs_rt.json")).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    for c in cases {
        let vehicles: Vec<FeedVehicle> = c["vehicles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| FeedVehicle {
                exec_id: x["execId"].as_str().unwrap(),
                trip_id: x["tripId"].as_str().unwrap(),
                route_id: x["routeId"].as_str().unwrap(),
                line: x["line"].as_str().unwrap(),
                lat: x["lat"].as_f64().unwrap(),
                lon: x["lon"].as_f64().unwrap(),
                bearing: x["bearing"].as_f64(),
                timestamp: x["timestamp"].as_f64().unwrap(),
                current_stop_sequence: x["currentStopSequence"].as_f64(),
                at_stop: x["atStop"].as_bool().unwrap(),
            })
            .collect();
        let hex: String = vehicle_positions_feed(&vehicles, c["timestamp"].as_f64().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hex, c["hex"].as_str().unwrap(), "{} vehicles", vehicles.len());
    }
}
