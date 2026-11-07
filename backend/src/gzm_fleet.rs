//! Metropolia GZM fleet ("brygady", lib/gzm-fleet.ts): a `FleetTracker` fed with the GZM poller's vehicles. GZM has
//! no static fleet list, so a vehicle exists from its first live sighting of the day; the GTFS brigade gives the next
//! course instead of a guess. History: `GZM_DIR/fleet-history-<YYYY-MM-DD>.json`, kept GZM_FLEET_HISTORY_DAYS days.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::config::{GZM_DIR, GZM_FLEET_HISTORY_DAYS};
use crate::fleet_tracker::{
    FleetRunningInput, FleetSighting, FleetStopPoint, FleetTracker, FleetTrackerOptions, FleetVehicleInfo, blocking_io,
};
use crate::gzm::{GzmFleetSource, GzmLiveVehicle};
use crate::js;
use crate::logger;
use crate::phototrans::pt_vehicle;
use crate::shared::fleet::{
    FleetFeatures, FleetFuelType, FleetOperator, FleetStats, FleetSummaryItem, FleetVehicleDetail,
};

/// Operating companies by the code before "_" in the vehicle key: the `organization` of the same keys in SDIP
/// (sdip.transportgzm.pl), captured 2026-10-28 (all 1 342 SDIP keys were in the feed).
/// ponytail: static list of 18; a new company shows as "Przewoźnik <code>" until added here.
fn company_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "2" => "ZTM",
        "104" => "PKM Świerklaniec",
        "107" => "Kłosok",
        "108" => "PKM Katowice",
        "109" => "SimKol",
        "110" => "Transgór",
        "114" => "Nowak Transport",
        "116" => "Lazar",
        "117" => "PKS Grodzisk",
        "118" => "METEOR",
        "119" => "PKM Sosnowiec",
        "120" => "PKM Gliwice",
        "122" => "Pawelec",
        "125" => "Tramwaje Śląskie",
        "131" => "PKS Południe",
        "134" => "PKS Gostynin",
        "283" => "PKM Tychy",
        "284" => "TLT",
        _ => return None,
    })
}

pub fn gzm_company(side: &str) -> String {
    let code = side.split('_').next().unwrap_or(side);
    company_name(code).map_or_else(|| format!("Przewoźnik {code}"), str::to_owned)
}

/// `GZM_SIDE_RE` (`/^\d{1,4}_\d{1,6}$/`): a GZM vehicle key as the fleet routes accept it, "<company code>_<fleet number>".
pub fn is_gzm_side(s: &str) -> bool {
    let digits = |p: &str, max: usize| (1..=max).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit());
    s.split_once('_').is_some_and(|(a, b)| digits(a, 4) && digits(b, 6))
}

/// `TRIP_KEY_RE` (`/^[0-9a-f]{12}/i`): the first 12 hex digits key the course, a trip id without them cannot be tracked.
fn has_trip_key(trip_id: &str) -> bool {
    trip_id.len() >= 12 && trip_id.bytes().take(12).all(|b| b.is_ascii_hexdigit())
}

/// `Math.max(0, x)`: NaN stays NaN.
fn max0(x: f64) -> f64 {
    if x.is_nan() { x } else { x.max(0.0) }
}

/// One GZM vehicle as the tracker reads it. Along-route metres become per-stop segments only when every stop has one.
pub fn gzm_fleet_input(src: &GzmFleetSource) -> FleetRunningInput {
    let measured = !src.stops.is_empty() && src.stops.iter().all(|s| s.dist_m.is_some_and(f64::is_finite));
    let first = src.stops.first().and_then(|s| s.dist_m);
    let mut prev: Option<f64> = None;
    let stop_points = src
        .stops
        .iter()
        .map(|s| {
            let distance = match (measured, prev, s.dist_m) {
                (true, Some(p), Some(d)) => max0(d - p),
                _ => 0.0,
            };
            prev = s.dist_m;
            // scheduled/planned unused: stop_secs carries the schedule
            FleetStopPoint {
                symbol: s.id.clone(),
                name: s.name.clone(),
                distance,
                scheduled_departure: 0.0,
                planned_departure: 0.0,
            }
        })
        .collect();
    // ponytail: 48 of the trip_id's 64 bits (exact in a double); two trips of a day sharing their first 12 hex digits
    // would merge into one course (~1 in 2^49 per pair). Upgrade: a string course key. Leading hex digits only, like
    // parseInt: a trip id without any (never fed, see has_trip_key) gets 0 where the TS gets NaN.
    let hex: String = src
        .trip_id
        .chars()
        .take(12)
        .take_while(char::is_ascii_hexdigit)
        .collect();
    FleetRunningInput {
        vehicle_id: src.side.clone(),
        line_name: src.line.clone(),
        course_loid: i64::from_str_radix(&hex, 16).unwrap_or(0),
        direction: src.headsign.clone(),
        // ponytail: an unknown delay counts as on time; the 2026-10-28 sample had 0 of 1 363 null.
        // Add a "delay unknown" flag to the course if the feed starts sending nulls.
        delay_sec: src.delay_sec.unwrap_or(0.0),
        latitude: src.lat,
        longitude: src.lon,
        angle: src.bearing,
        last_ping_date: src.fix_at.map(|s| s * 1000.0),
        reached_meters: match (measured, src.reached_m, first) {
            (true, Some(r), Some(d0)) => Some(max0(r - d0)),
            _ => None,
        },
        on_stop_point: src.at_stop,
        stop_points,
        not_started: Some(src.not_started),
        served_idx: src.served_idx,
        next_idx: src.next_idx,
        stop_secs: Some(src.stops.iter().map(|s| i64::from(s.dep)).collect()),
        brigade: src.brigade.clone(),
        next_trips: src.next_trips.clone(),
        label: Some(src.label.clone()),
        model: src.model.clone(),
        company: Some(gzm_company(&src.side)),
        ..FleetRunningInput::default()
    }
}

/// GZM publishes the model only: producer, year, length and propulsion come from phototrans when it lists the vehicle.
fn gzm_info(side: &str, label: Option<&str>, model: Option<&str>) -> FleetVehicleInfo {
    let pt = pt_vehicle("gzm", side);
    let year = pt.as_ref().and_then(|p| p.tech.built.or(p.tech.since));
    let fuel = pt.as_ref().and_then(|p| p.fuel);
    let pt_model = pt.as_ref().map(|p| p.group.model.as_str());
    let mut features = FleetFeatures::default();
    match fuel {
        Some(FleetFuelType::Electric) => features.electric = Some(true),
        Some(FleetFuelType::Hydrogen) => features.hydrogen = Some(true),
        Some(FleetFuelType::Hybrid) => features.hybrid = Some(true),
        _ => {}
    }
    FleetVehicleInfo {
        side_number: side.to_owned(),
        label: Some(
            label
                .unwrap_or_else(|| side.split_once('_').map_or(side, |(_, n)| n))
                .to_owned(),
        ),
        company: Some(gzm_company(side)),
        model: [pt_model, model]
            .into_iter()
            .flatten()
            .find(|m| !m.is_empty())
            .unwrap_or("")
            .to_owned(),
        producer: pt.as_ref().map(|p| p.group.producer.clone()).unwrap_or_default(),
        year: year.map(|y| y.to_string()),
        length_category: pt.as_ref().and_then(|p| p.len),
        fuel_type: fuel,
        features,
    }
}

/// The card of a vehicle on the map that the tracker never saw on a course: off a trip since the server started
/// (about half the fleet late in the evening). Without it the card says "unknown vehicle".
pub fn gzm_idle_detail(side: &str, live: &GzmLiveVehicle) -> FleetVehicleDetail {
    idle_detail_of(get_gzm_fleet_tracker(), side, live)
}

/// `gzm_idle_detail` on a given tracker.
pub fn idle_detail_of(tracker: &FleetTracker, side: &str, live: &GzmLiveVehicle) -> FleetVehicleDetail {
    tracker.idle_detail(
        gzm_info(side, Some(&live.label), live.model.as_deref()),
        FleetSighting {
            at: live.fix_at as i64,
            lat: live.lat,
            lon: live.lon,
            name: format!("Na mapie bez kursu, linia {}", live.line),
        },
    )
}

/// The GZM tracker's options (TS createGzmFleetTracker); `history_dir` None = memory only. Tests override `now`.
pub fn gzm_fleet_options(history_dir: Option<PathBuf>) -> FleetTrackerOptions {
    FleetTrackerOptions {
        operator: FleetOperator::Gzm,
        history_dir,
        keep_days: *GZM_FLEET_HISTORY_DAYS,
        // ponytail: 14 days x ~27 000 courses x 48 B ~ 18 MB of packed history; no successor index (the brigades
        // are in the GTFS)
        history_days: 14,
        // ponytail: the day file is written in one piece. An estimated ~27 000 courses a day x ~25 stops would make it
        // ~90 MB, so finished courses keep no stop table (~12 MB, plus the running courses' stops) and 2 min between
        // writes bounds the serialization; a crash loses at most 2 min. Upgrade: an append log.
        save_debounce_ms: 120_000,
        archive_stops: false,
        static_fleet: None,
        details: Arc::new(|v, _| gzm_info(&v.vehicle_id, v.label.as_deref(), v.model.as_deref())),
        restore_info: Arc::new(|info| gzm_info(&info.side_number, info.label.as_deref(), Some(&info.model))),
        ..FleetTrackerOptions::default()
    }
}

/// The GZM-configured tracker; production goes through `get_gzm_fleet_tracker()`, tests pass None.
pub fn create_gzm_fleet_tracker(history_dir: Option<PathBuf>) -> FleetTracker {
    FleetTracker::new(gzm_fleet_options(history_dir))
}

static TRACKER: OnceLock<FleetTracker> = OnceLock::new();

/// The process-wide GZM tracker (created on first use, history in GZM_DIR).
pub fn get_gzm_fleet_tracker() -> &'static FleetTracker {
    TRACKER.get_or_init(|| create_gzm_fleet_tracker(Some(PathBuf::from(&*GZM_DIR))))
}

/// Graceful shutdown: writes a pending debounced save. Does not create the tracker.
pub fn flush_gzm_fleet() {
    if let Some(t) = TRACKER.get() {
        t.flush_sync();
    }
}

/// Feeds one GZM poll to the tracker. Call ONLY after a successful, non-empty poll: an empty list reads as every
/// vehicle leaving service and closes all running courses. Never panics, so a tracker bug cannot abort the poll.
/// Runs on the caller's task through `block_in_place` (a few ms per poll), so polls update the tracker in order.
pub fn feed_gzm_fleet(sources: &[GzmFleetSource]) {
    feed_fleet_with(get_gzm_fleet_tracker, sources);
}

/// `feed_gzm_fleet` into a given tracker.
pub fn feed_fleet(tracker: &FleetTracker, sources: &[GzmFleetSource]) {
    feed_fleet_with(|| tracker, sources);
}

fn feed_fleet_with<'a>(tracker: impl FnOnce() -> &'a FleetTracker, sources: &[GzmFleetSource]) {
    let run = || {
        let running: Vec<FleetRunningInput> = sources
            .iter()
            .filter(|s| has_trip_key(&s.trip_id))
            .map(gzm_fleet_input)
            .collect();
        tracker().update_from_running_vehicles(&running, None, None);
    };
    if let Err(panic) = catch_unwind(AssertUnwindSafe(|| blocking_io(run))) {
        let msg = panic
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        logger::warn("gzm-fleet", format_args!("FleetTracker update failed: {msg}"));
    }
}

/// The /api/fleet?city=gzm body and its ETag.
#[derive(Debug, PartialEq, Eq)]
pub struct GzmFleetList {
    pub body: String,
    pub etag: String,
}

#[derive(Serialize)]
struct ListBody<'a> {
    stats: &'a FleetStats,
    count: usize,
    vehicles: &'a [FleetSummaryItem],
}

static LIST_CACHE: Mutex<Option<(FleetTracker, u64, Arc<GzmFleetList>)>> = Mutex::new(None);

/// The /api/fleet?city=gzm body (~1 350 rows), serialized and hashed at most once per tracker update instead of once
/// per request. No serverNow inside: a cached body would carry a stale one, so the route sends the server clock as
/// the X-Server-Time header.
pub fn gzm_fleet_list_body() -> Arc<GzmFleetList> {
    fleet_list_body(get_gzm_fleet_tracker())
}

/// `gzm_fleet_list_body` of a given tracker (one cache entry, keyed by tracker and version like the TS).
pub fn fleet_list_body(tracker: &FleetTracker) -> Arc<GzmFleetList> {
    let version = tracker.version();
    let mut cache = LIST_CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((t, v, list)) = cache.as_ref()
        && t.ptr_eq(tracker)
        && *v == version
    {
        return Arc::clone(list);
    }
    let (version, vehicles, stats) = tracker.list_snapshot();
    let body = serde_json::to_string(&ListBody {
        stats: &stats,
        count: vehicles.len(),
        vehicles: &vehicles,
    })
    .unwrap_or_default();
    let etag = format!(
        "\"{}\"",
        js::to_base64url(&Sha1::digest(body.as_bytes()))
            .chars()
            .take(22)
            .collect::<String>()
    );
    let list = Arc::new(GzmFleetList { body, etag });
    *cache = Some((tracker.clone(), version, Arc::clone(&list)));
    list
}
