//! test/benchmark.test.ts: the corridor invariants on the fixture feed without an MZK timetable, pinned weekday.
//! Its sub-50 ms latency case timed the TS router and has no Rust counterpart.

use std::path::Path;
use std::sync::LazyLock;

use unimaps::router::{ConnectionItinerary, RouteQuery, RouterIndex, find_connections, load_index_from};

const GTFS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/gtfs");
const NO_MZK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/no-mzk-timetable.json");
const DATE: &str = "2026-09-30";

static KB: LazyLock<RouterIndex> = LazyLock::new(|| load_index_from(Path::new(GTFS), Path::new(NO_MZK)).unwrap());

fn validate_itinerary(it: &ConnectionItinerary) {
    assert!(
        it.departure_secs < it.arrival_secs,
        "departure ({}) must be before arrival ({})",
        it.departure_time,
        it.arrival_time
    );
    assert_eq!(
        it.legs.len() as i32,
        it.transfers_count + 1,
        "legs count must equal transfersCount + 1"
    );
    for (i, leg) in it.legs.iter().enumerate() {
        let n = i + 1;
        assert!(leg.departure_secs < leg.arrival_secs, "leg {n} departure < arrival");
        assert!(leg.stops.len() >= 2, "leg {n} must have >= 2 stops");
        assert_eq!(
            leg.from_stop_name, leg.stops[0].stop_name,
            "leg {n} fromStopName matches stops[0]"
        );
        assert_eq!(
            leg.to_stop_name,
            leg.stops[leg.stops.len() - 1].stop_name,
            "leg {n} toStopName matches stops[last]"
        );
        if let Some(next) = it.legs.get(i + 1) {
            assert!(
                next.departure_secs >= leg.arrival_secs,
                "transfer leg {} departure >= leg {n} arrival",
                n + 1
            );
            let walk = next.walk_mins.unwrap_or(0);
            let min_required = 180.max(if walk > 0 { walk * 60 + 60 } else { 0 });
            assert!(
                next.departure_secs - leg.arrival_secs >= min_required,
                "transfer wait time satisfies buffer"
            );
        }
    }
}

fn corridor(from: &str, to: &str, after_secs: i32, expected: &str) {
    let q = RouteQuery {
        from,
        to,
        after_secs: Some(after_secs),
        limit: Some(3),
        date: Some(DATE),
        ..Default::default()
    };
    let res = find_connections(&q, Some(&KB));
    assert!(!res.is_empty(), "must find connections for {from} -> {to}");
    assert!(res.iter().any(|r| r.kind == expected), "must contain {expected} option");
    for it in &res {
        validate_itinerary(it);
    }
}

#[test]
fn validates_corridor_bielsko_biala_da_to_szczyrk_skalite() {
    corridor("BIELSKO-BIAŁA D.A.", "SZCZYRK SKALITE", 12 * 3600, "direct");
}

#[test]
fn validates_corridor_szczyrk_skalite_to_bielsko_biala_da() {
    corridor("SZCZYRK SKALITE", "BIELSKO-BIAŁA D.A.", 14 * 3600, "direct");
}

#[test]
fn validates_corridor_bielsko_biala_da_to_kety_da() {
    corridor("BIELSKO-BIAŁA D.A.", "KĘTY D.A.", 10 * 3600, "direct");
}

#[test]
fn validates_corridor_bielsko_biala_da_to_czechowice_dziedzice_da() {
    corridor("BIELSKO-BIAŁA D.A.", "CZECHOWICE-DZIEDZICE D.A.", 12 * 3600, "direct");
}

#[test]
fn validates_corridor_bielsko_biala_da_to_jaworze_nalecze() {
    corridor("BIELSKO-BIAŁA D.A.", "JAWORZE NAŁĘŻE", 13 * 3600, "direct");
}

#[test]
fn validates_corridor_bielsko_biala_da_to_wilkowice_urzad_gminy() {
    corridor("BIELSKO-BIAŁA D.A.", "WILKOWICE URZĄD GMINY", 12 * 3600, "direct");
}

#[test]
fn validates_corridor_wapienica_centrum_to_szczyrk_skalite() {
    corridor(
        "BIELSKO-BIAŁA WAPIENICA CENTRUM",
        "SZCZYRK SKALITE",
        9 * 3600,
        "transfer",
    );
}

#[test]
fn validates_corridor_szczyrk_skalite_to_kety_da() {
    corridor("SZCZYRK SKALITE", "KĘTY D.A.", 11 * 3600, "transfer");
}

#[test]
fn validates_corridor_czechowice_dziedzice_da_to_szczyrk_skalite() {
    corridor("CZECHOWICE-DZIEDZICE D.A.", "SZCZYRK SKALITE", 10 * 3600, "transfer");
}

#[test]
fn validates_corridor_jasienica_to_buczkowice_centrum() {
    corridor("JASIENICA", "BUCZKOWICE CENTRUM", 10 * 3600, "transfer");
}

#[test]
fn validates_corridor_pietrzykowice_kosciol_to_kety_da() {
    corridor("PIETRZYKOWICE, KOŚCIÓŁ", "KĘTY, D.A.", 15 * 3600, "transfer");
}
