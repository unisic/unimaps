//! lib/poller.ts `vehiclePositionsFeed`: the GTFS-Realtime VehiclePositions FeedMessage of /api/gtfs-rt.pb, written
//! field by field in tag order like protobufjs (proto2: a field set to its default is still written).
//! ponytail: a hand-written writer for the six messages this feed uses; a TripUpdates or Alerts feed, or decoding,
//! is the point to switch to prost.

use crate::js::to_int32;

/// The `VehiclePos` fields the feed reads; an empty `trip_id`, `route_id` or `line` is left out.
pub struct FeedVehicle<'a> {
    pub exec_id: &'a str,
    pub trip_id: &'a str,
    pub route_id: &'a str,
    pub line: &'a str,
    pub lat: f64,
    pub lon: f64,
    pub bearing: Option<f64>,
    /// epoch seconds
    pub timestamp: f64,
    pub current_stop_sequence: Option<f64>,
    pub at_stop: bool,
}

fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// every field number here is below 16, so a key is one byte
fn uint(out: &mut Vec<u8>, field: u8, v: u64) {
    out.push(field << 3);
    varint(out, v);
}

fn float(out: &mut Vec<u8>, field: u8, x: f64) {
    out.push(field << 3 | 5);
    out.extend_from_slice(&(x as f32).to_le_bytes());
}

fn bytes(out: &mut Vec<u8>, field: u8, body: &[u8]) {
    out.push(field << 3 | 2);
    varint(out, body.len() as u64);
    out.extend_from_slice(body);
}

/// protobufjs `uint64` of a JS number: truncated, two's complement when negative (exact below 2^63)
fn uint64(x: f64) -> u64 {
    x as i64 as u64
}

/// FULL_DATASET feed with header `timestamp`, one entity per vehicle keyed by its execution id.
pub fn vehicle_positions_feed(vehicles: &[FeedVehicle], timestamp: f64) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + vehicles.len() * 112);
    let mut header = Vec::with_capacity(16);
    bytes(&mut header, 1, b"2.0");
    uint(&mut header, 2, 0); // FULL_DATASET
    uint(&mut header, 3, uint64(timestamp));
    bytes(&mut out, 1, &header);

    let (mut entity, mut vp, mut sub) = (Vec::new(), Vec::new(), Vec::new());
    for v in vehicles {
        vp.clear();
        sub.clear();
        if !v.trip_id.is_empty() {
            bytes(&mut sub, 1, v.trip_id.as_bytes());
        }
        uint(&mut sub, 4, 0); // SCHEDULED
        if !v.route_id.is_empty() {
            bytes(&mut sub, 5, v.route_id.as_bytes());
        }
        bytes(&mut vp, 1, &sub);

        sub.clear();
        float(&mut sub, 1, v.lat);
        float(&mut sub, 2, v.lon);
        if let Some(b) = v.bearing {
            float(&mut sub, 3, b);
        }
        bytes(&mut vp, 2, &sub);

        if let Some(s) = v.current_stop_sequence {
            uint(&mut vp, 3, u64::from(to_int32(s) as u32));
        }
        uint(&mut vp, 4, if v.at_stop { 1 } else { 2 }); // STOPPED_AT, IN_TRANSIT_TO
        uint(&mut vp, 5, uint64(v.timestamp));

        sub.clear();
        bytes(&mut sub, 1, v.exec_id.as_bytes());
        if !v.line.is_empty() {
            bytes(&mut sub, 2, v.line.as_bytes());
        }
        bytes(&mut vp, 8, &sub);

        entity.clear();
        bytes(&mut entity, 1, v.exec_id.as_bytes());
        bytes(&mut entity, 4, &vp);
        bytes(&mut out, 2, &entity);
    }
    out
}
