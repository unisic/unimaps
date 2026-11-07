//! lib/gzm-feed.ts: a zbiorkom GTFS zip (GZM and the other cities) parsed into one immutable [`GzmFeed`]: stops,
//! lines, trips with brigades and dates, road shapes, and the RAPTOR index over them.
//!
//! The zip is ~19 MB packed / ~115 MB of CSV for GZM, so no member is unzipped whole: each CSV is inflated and
//! consumed line by line. Ids carry the `<slug>:` prefix everywhere (stops, trips, shapes), so they can never collide
//! with KB/MZK ones or another city's.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::fmt::rfc2822::DateTimePrinter;
use serde::Serialize;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::config;
use crate::gtfs_csv::{DROP_OFF_ON_REQUEST, PICKUP_ON_REQUEST, col, field, parse_csv_line, pickup_flags};
use crate::gzm_match::MATCHER;
use crate::js::{self, JsNum};
use crate::logger::{info, warn};
use crate::router::{CallPool, RouterIndex, RouterInput, RouterStopInput, TripEntry, TripStopEntry, call_columns};
use crate::shape_store::{ShapeGeometry, ShapeSrc, finalize_shape};
use crate::shared::gzm_stop_key::gzm_stop_key;
use crate::shared::polyline::{LatLng, decode_polyline, prepare_polyline};
use crate::time::agency_clock;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GzmStop {
    /// `<slug>:<stop_id>`
    pub id: String,
    /// with the post number, e.g. "Pszczelnik Park 02"
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

/// What a GZM trip has beyond the router's [`TripEntry`]; `GzmFeed::extra[i]` belongs to `router.trips[i]`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GzmTripExtra {
    /// `<slug>:<shape_id>`
    pub shape_id: Option<String>,
    pub brigade: String,
    /// `Number(direction_id) || 0`
    pub dir: f64,
    /// per call stop_headsign, None where the trip headsign applies; None when the trip has none
    pub stop_headsigns: Option<Arc<[Option<String>]>>,
    /// the brigade's next trip of the same route and service, by first departure (an index into `router.trips`)
    pub next: Option<u32>,
}

/// One trip of the feed: the router's entry and the GZM extras.
#[derive(Clone, Copy)]
pub struct GzmTrip<'a> {
    pub idx: u32,
    pub t: &'a TripEntry,
    pub x: &'a GzmTripExtra,
}

impl<'a> GzmTrip<'a> {
    /// per call pickup bits (gtfs_csv), always present in a GZM trip
    pub fn flags(&self) -> &'a [u8] {
        self.t.flags.as_deref().unwrap_or(&[])
    }

    /// the Warsaw dates the trip runs on; empty = never
    pub fn runs_on(&self, date: &str) -> bool {
        self.t.dates.as_ref().is_some_and(|d| d.contains(date))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GzmLine {
    pub id: String,
    pub name: String,
    pub terminus: String,
    /// GTFS route_type: "0" tram, "11" trolleybus, "3" bus
    #[serde(rename = "type")]
    pub kind: String,
}

/// A lat/lon box (degrees).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FeedArea {
    pub lat_min: f64,
    pub lat_max: f64,
    pub lon_min: f64,
    pub lon_max: f64,
}

pub struct GzmFeed {
    /// zbiorkom slug: the prefix of every id in the feed
    pub slug: String,
    /// the stops' extent + 0.05 deg (median-filtered: a misplaced stop does not stretch it): the positions bbox
    pub area: FeedArea,
    pub version: String,
    /// ISO dates from feed_info ("" when absent)
    pub start_date: String,
    pub end_date: String,
    /// stops served by at least one trip, by `<slug>:<stop_id>`, in stops.txt order
    pub stops: IndexMap<String, GzmStop>,
    /// GET /api/stops?city=<slug> body and its ETag
    pub stops_body: String,
    pub stops_etag: String,
    pub lines: Vec<GzmLine>,
    /// RAPTOR index; its `trips` are the feed's trips (no MZK variants here, so `extra` lines up by index)
    pub router: RouterIndex,
    pub extra: Vec<GzmTripExtra>,
    /// by trip line (= the live feed's routeName), indices into `router.trips`
    pub trips_by_line: HashMap<String, Vec<u32>>,
    pub shapes: Arc<GzmShapes>,
    pub built_at: i64,
    pub build_ms: i64,
    pub zip_bytes: u64,
}

impl GzmFeed {
    pub fn trip_at(&self, idx: u32) -> GzmTrip<'_> {
        GzmTrip {
            idx,
            t: &self.router.trips[idx as usize],
            x: &self.extra[idx as usize],
        }
    }

    pub fn trip(&self, id: &str) -> Option<GzmTrip<'_>> {
        self.router.trips.get_index_of(id).map(|i| self.trip_at(i as u32))
    }

    pub fn trips(&self) -> impl Iterator<Item = GzmTrip<'_>> {
        (0..self.router.trips.len() as u32).map(|i| self.trip_at(i))
    }

    pub fn trips_of_line(&self, line: &str) -> impl Iterator<Item = GzmTrip<'_>> {
        self.trips_by_line
            .get(line)
            .into_iter()
            .flatten()
            .map(|&i| self.trip_at(i))
    }
}

/* ---------------- shapes ---------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct GzmShapeEntry {
    pub poly: String,
    pub len: f64,
    pub stops: Vec<Option<f64>>,
    pub rev: String,
    /// snapped to the roads by OSRM (gzm_match): rawKey of the zbiorkom polyline
    pub raw: Option<String>,
}

/// `/api/shapes` payload of one shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShapePayload {
    pub id: String,
    pub src: ShapeSrc,
    pub poly: String,
    pub len: JsNum,
    pub stops: Vec<Option<JsNum>>,
}

#[derive(Debug, Default)]
pub struct ShapeLookup {
    pub shapes: IndexMap<String, ShapePayload>,
    pub missing: Vec<String>,
    pub exact: bool,
}

// ponytail: ~10 KB per prepared shape, so <= 12 MB; the live fleet touches ~800 shapes at peak
const GEOM_LRU: usize = 1200;

struct ShapesInner {
    entries: IndexMap<String, GzmShapeEntry>,
    /// matches in progress, by shape key: the matched part of the route on the raw rest; gone with the full match
    partial: HashMap<String, GzmShapeEntry>,
    /// prepared geometries, least recently used first
    geom: IndexMap<String, Arc<ShapeGeometry>>,
}

impl ShapesInner {
    /// The geometry served for shape `key`: a partial match in progress over the feed's own.
    fn current(&self, key: &str) -> Option<(&GzmShapeEntry, ShapeSrc)> {
        if let Some(p) = self.partial.get(key) {
            return Some((p, ShapeSrc::Partial));
        }
        self.entries.get(key).map(|e| {
            (
                e,
                if e.raw.is_some() {
                    ShapeSrc::Osrm
                } else {
                    ShapeSrc::Gtfs
                },
            )
        })
    }
}

/// The feed's road shapes, served like the shape store's (same wire ids, same /api/shapes payload). Matches swap in
/// while the feed is in use, hence the lock; every call holds it for a map lookup or one polyline decode.
pub struct GzmShapes(Mutex<ShapesInner>);

impl GzmShapes {
    pub fn new(entries: IndexMap<String, GzmShapeEntry>) -> Self {
        Self(Mutex::new(ShapesInner {
            entries,
            partial: HashMap::new(),
            geom: IndexMap::new(),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, ShapesInner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn size(&self) -> usize {
        self.lock().entries.len()
    }

    pub fn geometry(&self, key: &str) -> Option<Arc<ShapeGeometry>> {
        let mut s = self.lock();
        s.current(key)?;
        if let Some(i) = s.geom.get_index_of(key) {
            let last = s.geom.len() - 1;
            s.geom.move_index(i, last);
            return Some(s.geom[last].clone());
        }
        let (e, src) = s.current(key)?;
        let pl = prepare_polyline(&decode_polyline(&e.poly, 6))?;
        let g = Arc::new(ShapeGeometry {
            pl,
            stops: e.stops.clone(),
            rev: e.rev.clone(),
            src,
        });
        s.geom.insert(key.to_owned(), g.clone());
        if s.geom.len() > GEOM_LRU {
            s.geom.shift_remove_index(0);
        }
        Some(g)
    }

    /// A shape still on its raw zbiorkom geometry.
    pub fn unmatched(&self, key: &str) -> Option<GzmShapeEntry> {
        self.lock().entries.get(key).filter(|e| e.raw.is_none()).cloned()
    }

    /// rawKey of every shape's zbiorkom polyline, matched or not.
    pub fn raw_keys(&self) -> HashSet<String> {
        self.lock()
            .entries
            .values()
            .map(|e| e.raw.clone().unwrap_or_else(|| raw_key(&e.poly)))
            .collect()
    }

    /// Swaps in the road-matched geometry of shape `key` while it is still at raw rev `rev`; a `partial` one (part of
    /// the route matched) is served until the full match replaces it.
    pub fn upgrade(&self, key: &str, rev: &str, pts: &[LatLng], refs: &[Option<LatLng>], partial: bool) -> bool {
        let mut s = self.lock();
        let Some(e) = s.entries.get(key) else { return false };
        if e.raw.is_some() || e.rev != rev || refs.len() != e.stops.len() {
            return false;
        }
        let Some(m) = finalize_shape(pts, refs, if partial { ShapeSrc::Partial } else { ShapeSrc::Osrm }) else {
            return false;
        };
        let raw = raw_key(&e.poly);
        let mut next = GzmShapeEntry {
            poly: m.poly,
            len: m.len,
            stops: m.stops,
            rev: m.rev,
            raw: None,
        };
        if partial {
            s.partial.insert(key.to_owned(), next);
        } else {
            next.raw = Some(raw);
            s.entries.insert(key.to_owned(), next);
            s.partial.remove(key);
        }
        s.geom.shift_remove(key);
        true
    }

    pub fn wire_id(&self, key: &str) -> Option<String> {
        self.lock().current(key).map(|(e, _)| format!("{key}.{}", e.rev))
    }

    /// "road" for a shape of the feed, else "none"
    pub fn status(&self, key: Option<&str>) -> &'static str {
        match key {
            Some(k) if !k.is_empty() && self.lock().entries.contains_key(k) => "road",
            _ => "none",
        }
    }

    pub fn lookup(&self, ids: &[String]) -> ShapeLookup {
        let s = self.lock();
        let mut out = ShapeLookup {
            exact: true,
            ..ShapeLookup::default()
        };
        for id in ids {
            // `<key>.<rev6>`: lastIndexOf(".") > 0 and /\.[0-9a-f]{6}$/
            let dot = id.rfind('.').filter(|&d| d > 0);
            let tail = id.len().checked_sub(6).map(|i| &id.as_bytes()[i..]);
            let rev_tail = id.len() >= 7
                && id.as_bytes()[id.len() - 7] == b'.'
                && tail.is_some_and(|t| t.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));
            let key = match dot {
                Some(d) if rev_tail => &id[..d],
                _ => id.as_str(),
            };
            let Some((e, src)) = s.current(key) else {
                out.missing.push(id.clone());
                out.exact = false;
                continue;
            };
            // id.slice(dot + 1): the whole id when it has no dot
            let given = id.rfind('.').map_or(id.as_str(), |d| &id[d + 1..]);
            if key == id || given != e.rev {
                out.exact = false;
            }
            out.shapes.insert(
                id.clone(),
                ShapePayload {
                    id: format!("{key}.{}", e.rev),
                    src,
                    poly: e.poly.clone(),
                    len: JsNum(e.len),
                    stops: e.stops.iter().map(|x| x.map(JsNum)).collect(),
                },
            );
        }
        out
    }
}

/// Store key of a zbiorkom polyline (gzm-match `rawKey`): sha1 hex, 16 digits.
pub fn raw_key(poly: &str) -> String {
    hex(&Sha1::digest(poly.as_bytes())[..8])
}

fn hex(b: &[u8]) -> String {
    use std::fmt::Write as _;
    b.iter().fold(String::with_capacity(b.len() * 2), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })
}

/* ---------------- time ---------------- */

/// "YYYYMMDD" -> "YYYY-MM-DD", else "".
fn iso_date(s: Option<&str>) -> String {
    match s {
        Some(s) if s.len() == 8 && s.bytes().all(|c| c.is_ascii_digit()) => {
            format!("{}-{}-{}", &s[..4], &s[4..6], &s[6..])
        }
        _ => String::new(),
    }
}

/// "HH:MM:SS" (hours may exceed 24) -> secs, or -1.
fn hms(s: Option<&str>) -> f64 {
    let Some(s) = s.filter(|s| !s.is_empty()) else {
        return -1.0;
    };
    let Some(a) = s.find(':') else { return -1.0 };
    let b = s[a + 1..].find(':').map(|i| i + a + 1);
    let mins = js::number(&s[a + 1..b.unwrap_or(s.len())]);
    let secs = b.map_or(0.0, |b| js::number(&s[b + 1..]));
    let v = js::number(&s[..a]) * 3600.0 + mins * 60.0 + secs;
    if v.is_finite() && v >= 0.0 { v } else { -1.0 }
}

/* ---------------- parse ---------------- */

struct TimesAcc {
    /// (stop gid number, seq, arr, dep)
    stops: Vec<(u32, f64, f64, f64)>,
    flags: Vec<u8>,
    /// (row index, stop_headsign)
    hs: Option<Vec<(usize, String)>>,
}

struct TripRow {
    route_id: String,
    service_id: String,
    shape_id: Option<String>,
    headsign: String,
    dir: f64,
    brigade: String,
}

/// frequencies.txt of one template trip: the raw trip_id and its (start, end, headway) runs
struct Freq {
    raw: String,
    runs: Vec<(f64, f64, f64)>,
}

struct Calendar {
    svc: String,
    days: [bool; 7],
    start: String,
    end: String,
}

// ponytail: a calendar row spanning more than this is clipped; the zbiorkom feed spans 4 days
const MAX_CALENDAR_DAYS: i64 = 400;
// ponytail: decompressed-size guard against a hostile zip; the real feed is ~115 MB
const MAX_UNZIPPED_BYTES: u64 = 512 * 1024 * 1024;
/* frequencies.txt expansion: Warsaw's metro is 16 templates -> 3976 trips; the cap bounds a feed with absurd
headways */
const MIN_HEADWAY_SECS: f64 = 60.0;
const MAX_FREQ_TRIPS: usize = 20_000;

#[derive(Clone, Copy)]
enum Member {
    Routes,
    Trips,
    Stops,
    StopTimes,
    Shapes,
    Calendar,
    CalendarDates,
    Frequencies,
    FeedInfo,
}

impl Member {
    fn of(basename: &str) -> Option<Self> {
        Some(match basename {
            "routes.txt" => Self::Routes,
            "trips.txt" => Self::Trips,
            "stops.txt" => Self::Stops,
            "stop_times.txt" => Self::StopTimes,
            "shapes.txt" => Self::Shapes,
            "calendar.txt" => Self::Calendar,
            "calendar_dates.txt" => Self::CalendarDates,
            "frequencies.txt" => Self::Frequencies,
            "feed_info.txt" => Self::FeedInfo,
            _ => return None,
        })
    }
}

/// The column indices a member's rows are read with; None = the member is skipped (a required column is missing).
enum Cols {
    Routes {
        id: usize,
        short: Option<usize>,
        long: Option<usize>,
        kind: Option<usize>,
    },
    Trips {
        trip: usize,
        route: usize,
        svc: usize,
        shape: Option<usize>,
        head: Option<usize>,
        dir: Option<usize>,
        brig: Option<usize>,
    },
    Stops {
        id: usize,
        name: usize,
        lat: usize,
        lon: usize,
        kind: Option<usize>,
    },
    StopTimes {
        trip: usize,
        arr: Option<usize>,
        dep: usize,
        stop: usize,
        seq: usize,
        pick: Option<usize>,
        drop: Option<usize>,
        hs: Option<usize>,
    },
    Shapes {
        id: usize,
        lat: usize,
        lon: usize,
        seq: usize,
    },
    Calendar {
        svc: usize,
        days: [Option<usize>; 7],
        start: usize,
        end: usize,
    },
    CalendarDates {
        svc: usize,
        date: usize,
        kind: usize,
    },
    Frequencies {
        trip: usize,
        start: usize,
        end: usize,
        hw: usize,
    },
    FeedInfo {
        ver: Option<usize>,
        start: Option<usize>,
        end: Option<usize>,
    },
}

fn cols(m: Member, h: &[String]) -> Option<Cols> {
    let c = |n: &str| col(h, n);
    Some(match m {
        Member::Routes => Cols::Routes {
            id: c("route_id")?,
            short: c("route_short_name"),
            long: c("route_long_name"),
            kind: c("route_type"),
        },
        Member::Trips => Cols::Trips {
            trip: c("trip_id")?,
            route: c("route_id")?,
            svc: c("service_id")?,
            shape: c("shape_id"),
            head: c("trip_headsign"),
            dir: c("direction_id"),
            brig: c("brigade"),
        },
        Member::Stops => Cols::Stops {
            id: c("stop_id")?,
            name: c("stop_name")?,
            lat: c("stop_lat")?,
            lon: c("stop_lon")?,
            kind: c("location_type"),
        },
        Member::StopTimes => Cols::StopTimes {
            trip: c("trip_id")?,
            arr: c("arrival_time"),
            dep: c("departure_time")?,
            stop: c("stop_id")?,
            seq: c("stop_sequence")?,
            pick: c("pickup_type"),
            drop: c("drop_off_type"),
            hs: c("stop_headsign"),
        },
        Member::Shapes => Cols::Shapes {
            id: c("shape_id")?,
            lat: c("shape_pt_lat")?,
            lon: c("shape_pt_lon")?,
            seq: c("shape_pt_sequence")?,
        },
        Member::Calendar => Cols::Calendar {
            svc: c("service_id")?,
            days: [
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
            ]
            .map(c),
            start: c("start_date")?,
            end: c("end_date")?,
        },
        Member::CalendarDates => Cols::CalendarDates {
            svc: c("service_id")?,
            date: c("date")?,
            kind: c("exception_type")?,
        },
        Member::Frequencies => Cols::Frequencies {
            trip: c("trip_id")?,
            start: c("start_time")?,
            end: c("end_time")?,
            hw: c("headway_secs")?,
        },
        Member::FeedInfo => Cols::FeedInfo {
            ver: c("feed_version"),
            start: c("feed_start_date"),
            end: c("feed_end_date"),
        },
    })
}

/// `Number(f[i])`: NaN for a missing field
fn num(f: &[String], i: Option<usize>) -> f64 {
    field(f, i).map_or(f64::NAN, js::number)
}

/// a JS-truthy number: not 0, not NaN
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// `f[i]` as a non-empty string (JS truthy)
fn some(f: &[String], i: Option<usize>) -> Option<&str> {
    field(f, i).filter(|s| !s.is_empty())
}

#[derive(Default)]
struct FeedInfo {
    version: String,
    start: String,
    end: String,
}

#[derive(Default)]
struct FeedBuilder {
    slug: String,
    ids: HashMap<String, String>,
    routes: IndexMap<String, GzmLine>,
    trip_rows: HashMap<String, TripRow>,
    stops: IndexMap<String, GzmStop>,
    times: IndexMap<String, TimesAcc>,
    /// stop gids of stop_times by number (one String per stop, not per call)
    call_stop: Vec<String>,
    call_stop_num: HashMap<String, u32>,
    shape_pts: IndexMap<String, Vec<(f64, f64, f64)>>,
    calendar: Vec<Calendar>,
    exceptions: Vec<(String, String, bool)>,
    freqs: HashMap<String, Freq>,
    freq_trips: usize,
    info: FeedInfo,
}

impl FeedBuilder {
    /// raw GTFS id -> `<slug>:<id>`, kept inside the API id charset (isValidId): a char outside [A-Za-z0-9_.-]
    /// becomes "_", an id too long for 64 keeps its head plus a hash of the raw id
    fn gid(&mut self, raw: &str) -> String {
        if let Some(v) = self.ids.get(raw) {
            return v.clone();
        }
        let v = gid(&self.slug, raw);
        self.ids.insert(raw.to_owned(), v.clone());
        v
    }

    fn call_stop(&mut self, raw: &str) -> u32 {
        if let Some(&n) = self.call_stop_num.get(raw) {
            return n;
        }
        let id = self.gid(raw);
        let n = self.call_stop.len() as u32;
        self.call_stop.push(id);
        self.call_stop_num.insert(raw.to_owned(), n);
        n
    }

    fn row(&mut self, c: &Cols, f: &[String], last: &mut Option<String>) {
        match *c {
            Cols::Routes { id, short, long, kind } => {
                let Some(rid) = some(f, Some(id)) else { return };
                let r = GzmLine {
                    id: rid.to_owned(),
                    name: some(f, short).unwrap_or(rid).to_owned(),
                    terminus: field(f, long).unwrap_or("").to_owned(),
                    kind: some(f, kind).unwrap_or("3").to_owned(),
                };
                self.routes.insert(r.id.clone(), r);
            }
            Cols::Trips {
                trip,
                route,
                svc,
                shape,
                head,
                dir,
                brig,
            } => {
                let Some(raw) = some(f, Some(trip)) else { return };
                let id = self.gid(raw);
                let shape_id = some(f, shape).map(|s| self.gid(s));
                let d = num(f, dir);
                self.trip_rows.insert(
                    id,
                    TripRow {
                        route_id: field(f, Some(route)).unwrap_or("").to_owned(),
                        service_id: field(f, Some(svc)).unwrap_or("").to_owned(),
                        shape_id,
                        headsign: field(f, head).unwrap_or("").to_owned(),
                        dir: if truthy(d) { d } else { 0.0 },
                        brigade: field(f, brig).unwrap_or("").to_owned(),
                    },
                );
            }
            Cols::Stops {
                id,
                name,
                lat,
                lon,
                kind,
            } => {
                let (la, lo) = (num(f, Some(lat)), num(f, Some(lon)));
                let (Some(raw), Some(nm)) = (some(f, Some(id)), some(f, Some(name))) else {
                    return;
                };
                if !truthy(la) || !truthy(lo) || !la.is_finite() || !lo.is_finite() {
                    return;
                }
                if some(f, kind).is_some_and(|k| k != "0") {
                    return;
                }
                let id = self.gid(raw);
                self.stops.insert(
                    id.clone(),
                    GzmStop {
                        id,
                        name: nm.to_owned(),
                        lat: la,
                        lon: lo,
                    },
                );
            }
            Cols::StopTimes {
                trip,
                arr,
                dep,
                stop,
                seq,
                pick,
                drop,
                hs,
            } => {
                let (Some(raw), Some(stop_raw)) = (some(f, Some(trip)), some(f, Some(stop))) else {
                    return;
                };
                if last.as_deref() != Some(raw) {
                    *last = Some(raw.to_owned());
                    let id = self.gid(raw);
                    self.times.entry(id).or_insert_with(|| TimesAcc {
                        stops: Vec::new(),
                        flags: Vec::new(),
                        hs: None,
                    });
                }
                let d = hms(field(f, Some(dep)));
                let a = match some(f, arr) {
                    Some(s) => hms(Some(s)),
                    None => d,
                };
                let sq = num(f, Some(seq));
                if d < 0.0 || a < 0.0 || !sq.is_finite() {
                    return;
                }
                let sn = self.call_stop(stop_raw);
                let flags = pickup_flags(field(f, pick), field(f, drop));
                let head = some(f, hs).map(str::to_owned);
                let id = self.ids[raw].clone();
                let acc = self.times.get_mut(&id).expect("created above");
                if let Some(h) = head {
                    acc.hs.get_or_insert_with(Vec::new).push((acc.stops.len(), h));
                }
                acc.stops.push((sn, sq, a, d));
                acc.flags.push(flags);
            }
            Cols::Shapes { id, lat, lon, seq } => {
                let Some(raw) = some(f, Some(id)) else { return };
                if last.as_deref() != Some(raw) {
                    *last = Some(raw.to_owned());
                    let id = self.gid(raw);
                    self.shape_pts.entry(id).or_default();
                }
                let (sq, la, lo) = (num(f, Some(seq)), num(f, Some(lat)), num(f, Some(lon)));
                if sq.is_finite() && truthy(la) && truthy(lo) {
                    let id = self.ids[raw].clone();
                    self.shape_pts.get_mut(&id).expect("created above").push((sq, la, lo));
                }
            }
            Cols::Calendar { svc, days, start, end } => {
                let Some(s) = some(f, Some(svc)) else { return };
                self.calendar.push(Calendar {
                    svc: s.to_owned(),
                    days: days.map(|i| field(f, i) == Some("1")),
                    start: iso_date(field(f, Some(start))),
                    end: iso_date(field(f, Some(end))),
                });
            }
            Cols::CalendarDates { svc, date, kind } => {
                let d = iso_date(field(f, Some(date)));
                let k = field(f, Some(kind));
                let Some(s) = some(f, Some(svc)) else { return };
                if d.is_empty() || !matches!(k, Some("1" | "2")) {
                    return;
                }
                self.exceptions.push((s.to_owned(), d, k == Some("1")));
            }
            Cols::Frequencies { trip, start, end, hw } => {
                let (s, e, h) = (hms(field(f, Some(start))), hms(field(f, Some(end))), num(f, Some(hw)));
                let Some(raw) = some(f, Some(trip)) else { return };
                if s < 0.0 || e <= s || h.is_nan() || h < MIN_HEADWAY_SECS {
                    return;
                }
                let id = self.gid(raw);
                self.freqs
                    .entry(id)
                    .or_insert_with(|| Freq {
                        raw: raw.to_owned(),
                        runs: Vec::new(),
                    })
                    .runs
                    .push((s, e, h));
            }
            Cols::FeedInfo { ver, start, end } => {
                self.info = FeedInfo {
                    version: field(f, ver).unwrap_or("").to_owned(),
                    start: iso_date(field(f, start)),
                    end: iso_date(field(f, end)),
                };
            }
        }
    }

    /// One CSV member: the first non-empty line is the header (trimmed), every later one a row.
    fn member(&mut self, m: Member, r: impl BufRead) -> std::io::Result<()> {
        let mut c: Option<Option<Cols>> = None;
        let mut last: Option<String> = None;
        let mut first = true;
        for line in r.split(b'\n') {
            let mut line = line?;
            // TextDecoder drops a leading BOM
            if first && line.starts_with(b"\xEF\xBB\xBF") {
                line.drain(..3);
            }
            first = false;
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            let s = String::from_utf8_lossy(&line);
            let f: Vec<String> = if s.contains('"') {
                parse_csv_line(&s)
            } else {
                s.split(',').map(str::to_owned).collect()
            };
            match &c {
                None => {
                    let h: Vec<String> = f.iter().map(|x| x.trim_matches(js::is_space).to_owned()).collect();
                    c = Some(cols(m, &h));
                }
                Some(Some(cs)) => self.row(cs, &f, &mut last),
                Some(None) => return Ok(()),
            }
        }
        Ok(())
    }

    fn service_dates(&self) -> HashMap<String, HashSet<String>> {
        let mut out: HashMap<String, HashSet<String>> = HashMap::new();
        for c in &self.calendar {
            let set = out.entry(c.svc.clone()).or_default();
            if c.start.is_empty() || c.end.is_empty() {
                continue;
            }
            let p = |a: usize, b: usize| c.start[a..b].parse::<i64>().unwrap_or(0);
            for i in 0..MAX_CALENDAR_DAYS {
                let Some(dt) = utc_date(p(0, 4), p(5, 7) - 1, p(8, 10) + i) else {
                    break;
                };
                let iso = format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day());
                if iso > c.end {
                    break;
                }
                if c.days[dt.weekday().to_monday_zero_offset() as usize] {
                    set.insert(iso);
                }
            }
        }
        for (svc, date, add) in &self.exceptions {
            if *add {
                out.entry(svc.clone()).or_default().insert(date.clone());
            } else if let Some(s) = out.get_mut(svc) {
                s.remove(date);
            }
        }
        out
    }

    fn build_trips(&mut self) -> (IndexMap<String, TripEntry>, Vec<GzmTripExtra>) {
        let dates: HashMap<String, Arc<HashSet<String>>> = self
            .service_dates()
            .into_iter()
            .map(|(k, v)| (k, Arc::new(v)))
            .collect();
        let empty: Arc<HashSet<String>> = Arc::default();
        let mut trips: IndexMap<String, TripEntry> = IndexMap::new();
        let mut extra: Vec<GzmTripExtra> = Vec::new();
        // stop_ids / seqs and flags shared by every trip with the same ones (2026-10-31: 3062 and 1995 for 38799)
        let mut pool: CallPool = HashMap::new();
        let mut flag_pool: HashMap<Vec<u8>, Arc<[u8]>> = HashMap::new();
        let times = std::mem::take(&mut self.times);
        for (trip_id, acc) in times {
            let n = acc.stops.len();
            let Some(row) = self.trip_rows.get(&trip_id) else {
                continue;
            };
            if n < 2 {
                continue;
            }
            let mut order: Option<Vec<usize>> = None;
            if (1..n).any(|i| acc.stops[i].1 <= acc.stops[i - 1].1) {
                let mut o: Vec<usize> = (0..n).collect();
                // seqs are finite (checked per row); partial_cmp keeps -0 == 0 like the JS comparator
                o.sort_by(|&a, &b| acc.stops[a].1.partial_cmp(&acc.stops[b].1).unwrap_or(Ordering::Equal));
                order = Some(o);
            }
            let pos: Option<Vec<usize>> = order.as_ref().map(|o| {
                let mut p = vec![0; n];
                for (i, &x) in o.iter().enumerate() {
                    p[x] = i;
                }
                p
            });
            let at = |i: usize| order.as_ref().map_or(i, |o| o[i]);
            let stop_headsigns = acc.hs.as_ref().and_then(|hs| {
                let mut v: Vec<Option<String>> = vec![None; n];
                for (r, h) in hs {
                    if *h != row.headsign {
                        v[pos.as_ref().map_or(*r, |p| p[*r])] = Some(h.clone());
                    }
                }
                v.iter().any(Option::is_some).then(|| Arc::from(v))
            });
            let own: Vec<u8> = (0..n).map(|i| acc.flags[at(i)]).collect();
            let flags = flag_pool
                .entry(own)
                .or_insert_with_key(|k| Arc::from(k.as_slice()))
                .clone();
            let mut t = TripEntry {
                trip_id: trip_id.clone(),
                service_id: row.service_id.clone(),
                route_id: row.route_id.clone(),
                line: self
                    .routes
                    .get(&row.route_id)
                    .map(|r| r.name.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| row.route_id.clone()),
                headsign: row.headsign.clone(),
                dates: Some(dates.get(&row.service_id).cloned().unwrap_or_else(|| empty.clone())),
                flags: Some(flags),
                ..TripEntry::default()
            };
            let calls = (0..n)
                .map(|i| {
                    let (sn, seq, arr, dep) = acc.stops[at(i)];
                    TripStopEntry {
                        stop_id: self.call_stop[sn as usize].clone(),
                        seq,
                        arr,
                        dep,
                    }
                })
                .collect();
            call_columns(&mut t, calls, &mut pool);
            let x = GzmTripExtra {
                shape_id: row.shape_id.clone(),
                brigade: row.brigade.clone(),
                dir: row.dir,
                stop_headsigns,
                next: None,
            };
            if let Some(freq) = self.freqs.get(&trip_id) {
                let (raw, runs) = (freq.raw.clone(), freq.runs.clone());
                self.expand(&t, &x, &raw, &runs, &mut trips, &mut extra);
            } else {
                put(&mut trips, &mut extra, t, x);
            }
        }
        self.freqs.clear();
        (trips, extra)
    }

    /// A frequencies.txt trip is a template: its stop_times give the run times from the first stop, and every
    /// start_time + k * headway_secs < end_time is a trip of its own (`<trip_id>.<start secs>`). Both exact_times
    /// kinds get exact times: a headway-based run shows its nominal departures.
    fn expand(
        &mut self,
        t: &TripEntry,
        x: &GzmTripExtra,
        raw: &str,
        runs: &[(f64, f64, f64)],
        out: &mut IndexMap<String, TripEntry>,
        extra: &mut Vec<GzmTripExtra>,
    ) {
        let base = f64::from(t.dep[0]);
        let same = Arc::ptr_eq(&t.arr, &t.dep);
        for &(start, end, headway) in runs {
            let mut at = start;
            while at < end && self.freq_trips < MAX_FREQ_TRIPS {
                let d = at - base;
                let trip_id = self.gid(&format!("{raw}.{}", js::number_to_string(at)));
                let shift =
                    |v: &Arc<[i32]>| -> Arc<[i32]> { v.iter().map(|&s| js::to_int32(f64::from(s) + d)).collect() };
                let dep = shift(&t.dep);
                let arr = if same { dep.clone() } else { shift(&t.arr) };
                put(
                    out,
                    extra,
                    TripEntry {
                        trip_id,
                        arr,
                        dep,
                        ..t.clone()
                    },
                    x.clone(),
                );
                at += headway;
                self.freq_trips += 1;
            }
        }
    }

    fn finish(mut self, zip_bytes: u64, t0: Instant, matched: &dyn Fn(&str) -> Option<String>) -> GzmFeed {
        let (trips, mut extra) = self.build_trips();
        self.trip_rows = HashMap::new();
        self.call_stop = Vec::new();
        self.call_stop_num = HashMap::new();

        let mut trips_by_line: HashMap<String, Vec<u32>> = HashMap::new();
        let mut chains: IndexMap<String, Vec<u32>> = IndexMap::new();
        let mut shape_trip: HashMap<String, u32> = HashMap::new();
        let mut used: HashSet<&str> = HashSet::new();
        // per stop: calls flagged on request minus the others; > 0 = mostly a request stop ("na żądanie")
        let mut request: HashMap<&str, i64> = HashMap::new();
        for (i, (t, x)) in trips.values().zip(&extra).enumerate() {
            let i = i as u32;
            trips_by_line.entry(t.line.clone()).or_default().push(i);
            if !x.brigade.is_empty() {
                chains
                    .entry(format!("{}|{}|{}", t.route_id, x.brigade, t.service_id))
                    .or_default()
                    .push(i);
            }
            if let Some(s) = &x.shape_id {
                shape_trip.entry(s.clone()).or_insert(i);
            }
            let flags = t.flags.as_deref().unwrap_or(&[]);
            for (p, id) in t.stop_ids.iter().enumerate() {
                used.insert(id);
                *request.entry(id).or_default() += if flags[p] & (PICKUP_ON_REQUEST | DROP_OFF_ON_REQUEST) != 0 {
                    1
                } else {
                    -1
                };
            }
        }
        for chain in chains.values_mut() {
            chain.sort_by_key(|&i| trips[i as usize].dep[0]);
            for w in chain.windows(2) {
                extra[w[0] as usize].next = Some(w[1]);
            }
        }

        let stops: IndexMap<String, GzmStop> = std::mem::take(&mut self.stops)
            .into_iter()
            .filter(|(id, _)| used.contains(id.as_str()))
            .collect();
        let wire: Vec<serde_json::Value> = stops
            .values()
            .map(|s| {
                let mut o = serde_json::json!({
                    "id": s.id,
                    "designator": s.id,
                    "name": s.name,
                    "lat": js::num_value(s.lat),
                    "lon": js::num_value(s.lon),
                    "operator": "GZM",
                    "operators": ["GZM"],
                });
                if request.get(s.id.as_str()).is_some_and(|&r| r > 0) {
                    o["onRequest"] = true.into();
                }
                o
            })
            .collect();
        let stops_body = serde_json::json!({ "count": wire.len(), "stops": wire }).to_string();
        drop(request);
        drop(used);

        // one stop pattern per shape in this feed, so the first trip's stops place every trip's stops
        let gzm = self.slug == "gzm";
        let mut shape_entries: IndexMap<String, GzmShapeEntry> = IndexMap::new();
        for (key, mut pts) in std::mem::take(&mut self.shape_pts) {
            let Some(&ti) = shape_trip.get(&key) else { continue };
            if pts.len() < 2 {
                continue;
            }
            if pts.windows(2).any(|w| w[1].0 <= w[0].0) {
                pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
            }
            let line: Vec<LatLng> = pts.iter().map(|p| [p.1, p.2]).collect();
            let refs: Vec<Option<LatLng>> = trips[ti as usize]
                .stop_ids
                .iter()
                .map(|id| stops.get(id).map(|s| [s.lat, s.lon]))
                .collect();
            let Some(e) = finalize_shape(&line, &refs, ShapeSrc::Gtfs) else {
                continue;
            };
            let raw = raw_key(&e.poly);
            let road = gzm
                .then(|| matched(&raw))
                .flatten()
                .and_then(|m| finalize_shape(&decode_polyline(&m, 6), &refs, ShapeSrc::Osrm));
            let entry = match road {
                Some(m) => GzmShapeEntry {
                    poly: m.poly,
                    len: m.len,
                    stops: m.stops,
                    rev: m.rev,
                    raw: Some(raw),
                },
                None => GzmShapeEntry {
                    poly: e.poly,
                    len: e.len,
                    stops: e.stops,
                    rev: e.rev,
                    raw: None,
                },
            };
            shape_entries.insert(key, entry);
        }

        let mut lines: Vec<GzmLine> = std::mem::take(&mut self.routes).into_values().collect();
        lines.sort_by(|a, b| js::compare_pl_numeric(&a.name, &b.name));
        let router = crate::router::build_router_index(RouterInput {
            stops: stops
                .values()
                .map(|s| RouterStopInput {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    lat: s.lat,
                    lon: s.lon,
                    key: Some(gzm_stop_key(&s.name).to_owned()),
                })
                .collect(),
            trips,
            services: HashMap::new(),
            mzk_day_types: HashMap::new(),
        });
        let stops_etag = format!("\"{}\"", &js::to_base64url(&Sha1::digest(stops_body.as_bytes()))[..22]);
        GzmFeed {
            area: feed_area(stops.values().map(|s| (s.lat, s.lon))),
            slug: self.slug,
            version: self.info.version,
            start_date: self.info.start,
            end_date: self.info.end,
            stops,
            stops_body,
            stops_etag,
            lines,
            router,
            extra,
            trips_by_line,
            shapes: Arc::new(GzmShapes::new(shape_entries)),
            built_at: Timestamp::now().as_second(),
            build_ms: js::round(t0.elapsed().as_secs_f64() * 1000.0) as i64,
            zip_bytes,
        }
    }
}

/// `trips.set(id, t)`: a repeated id keeps its place and takes the new trip
fn put(trips: &mut IndexMap<String, TripEntry>, extra: &mut Vec<GzmTripExtra>, t: TripEntry, x: GzmTripExtra) {
    match trips.get_index_of(&t.trip_id) {
        Some(i) => {
            trips[i] = t;
            extra[i] = x;
        }
        None => {
            trips.insert(t.trip_id.clone(), t);
            extra.push(x);
        }
    }
}

/// `new Date(Date.UTC(y, m, d))`: month and day overflow into the next ones like the JS; None out of jiff's range.
fn utc_date(y: i64, m0: i64, d: i64) -> Option<Date> {
    // MakeFullYear: Date.UTC reads years 0..99 as 1900..1999
    let y = if (0..=99).contains(&y) { y + 1900 } else { y };
    let ym = y * 12 + m0;
    let first = Date::new(i16::try_from(ym.div_euclid(12)).ok()?, (ym.rem_euclid(12) + 1) as i8, 1).ok()?;
    first.checked_add(jiff::Span::new().days(d - 1)).ok()
}

/// `FeedBuilder.gid` without the memo.
pub fn gid(slug: &str, raw: &str) -> String {
    let mut id: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // JS length counts UTF-16 units; after the replacement every char is ASCII, so bytes = units
    let room = 64usize.saturating_sub(slug.len() + 1);
    if id.len() > room {
        let digest = hex(&Sha1::digest(raw.as_bytes()));
        id = format!("{}_{}", &id[..room.saturating_sub(7)], &digest[..6]);
    }
    format!("{slug}:{id}")
}

/// The stops' extent + 0.05 deg. A stop > 1.5 deg from the median is a misplaced one (Bolesławiec keeps 8 at lat
/// 25), not the network: skipped.
pub fn feed_area(stops: impl Iterator<Item = (f64, f64)>) -> FeedArea {
    let (lats, lons): (Vec<f64>, Vec<f64>) = stops.unzip();
    let median = |a: &[f64]| {
        let mut s = a.to_vec();
        s.sort_by(f64::total_cmp);
        s.get(s.len() >> 1).copied().unwrap_or(0.0)
    };
    let (m_lat, m_lon) = (median(&lats), median(&lons));
    let mut b = FeedArea {
        lat_min: f64::INFINITY,
        lat_max: f64::NEG_INFINITY,
        lon_min: f64::INFINITY,
        lon_max: f64::NEG_INFINITY,
    };
    for (&la, &lo) in lats.iter().zip(&lons) {
        if (la - m_lat).abs() > 1.5 || (lo - m_lon).abs() > 1.5 {
            continue;
        }
        b.lat_min = b.lat_min.min(la);
        b.lat_max = b.lat_max.max(la);
        b.lon_min = b.lon_min.min(lo);
        b.lon_max = b.lon_max.max(lo);
    }
    let r4 = |v: f64| js::round(v * 1e4) / 1e4;
    FeedArea {
        lat_min: r4(b.lat_min - 0.05),
        lat_max: r4(b.lat_max + 0.05),
        lon_min: r4(b.lon_min - 0.05),
        lon_max: r4(b.lon_max + 0.05),
    }
}

/// Reads a GTFS zip from disk into a [`GzmFeed`] whose ids carry `<slug>:`. `matched` maps a zbiorkom polyline's
/// rawKey to its stored road match (gzm_match); only the `gzm` slug reads it. Errors on a broken zip or a feed without trips or stops.
/// CPU-bound for seconds on a big feed: run it on a blocking thread.
pub fn parse_gzm_zip(file: &Path, slug: &str, matched: &dyn Fn(&str) -> Option<String>) -> Result<GzmFeed, String> {
    let t0 = Instant::now();
    let zip_bytes = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(file).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())?;
    let mut b = FeedBuilder {
        slug: slug.to_owned(),
        ..FeedBuilder::default()
    };
    let mut unzipped: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // ponytail: a member nobody reads is never inflated, so it neither costs CPU nor counts toward the cap
        let name = entry.name().map_err(|e| e.to_string())?;
        let Some(m) = Member::of(name.rsplit('/').next().unwrap_or("")) else {
            continue;
        };
        let left = MAX_UNZIPPED_BYTES - unzipped;
        let mut capped = entry.take(left + 1);
        let mut counted = CountingReader {
            inner: &mut capped,
            n: 0,
        };
        b.member(m, BufReader::with_capacity(256 * 1024, &mut counted))
            .map_err(|e| e.to_string())?;
        // a member cut off by the cap is still read to its end above; the cap is checked on the bytes it produced
        unzipped += counted.n;
        if unzipped > MAX_UNZIPPED_BYTES {
            return Err("GZM zip expands past the size cap".into());
        }
    }
    let feed = b.finish(zip_bytes, t0, matched);
    if feed.router.trips.is_empty() || feed.stops.is_empty() {
        return Err("GZM feed has no trips or stops".into());
    }
    Ok(feed)
}

struct CountingReader<'a, R> {
    inner: &'a mut R,
    n: u64,
}

impl<R: Read> Read for CountingReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let k = self.inner.read(buf)?;
        self.n += k as u64;
        Ok(k)
    }
}

/* ---------------- refresh schedule ---------------- */

const REFRESH_FROM_SECS: i32 = 4 * 3600;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RefreshState {
    pub has_feed: bool,
    /// Warsaw date of the last good check made after 04:00 ("" = none)
    pub checked_day: String,
    /// epoch ms; no attempt before (set after a failure)
    pub retry_at: i64,
}

fn clock_ms(ms: i64) -> (String, i32) {
    let (d, s) = agency_clock(Timestamp::from_millisecond(ms).unwrap_or(Timestamp::UNIX_EPOCH));
    (d.to_string(), s)
}

/// A download is due without a feed, or once per Warsaw day after 04:00.
pub fn gzm_refresh_due(s: &RefreshState, now_ms: i64) -> bool {
    if now_ms < s.retry_at {
        return false;
    }
    if !s.has_feed {
        return true;
    }
    let (date, secs) = clock_ms(now_ms);
    date != s.checked_day && secs >= REFRESH_FROM_SECS
}

/// Day a check at `ms` counts for: a check before 04:00 doesn't spare that day's refresh.
pub fn checked_day_at(ms: i64) -> String {
    let (date, secs) = clock_ms(ms);
    if secs >= REFRESH_FROM_SECS { date } else { String::new() }
}

/* ---------------- download ---------------- */

pub const MAX_ZIP_BYTES: u64 = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, PartialEq)]
pub struct Downloaded {
    pub tmp: PathBuf,
    pub bytes: u64,
}

fn size_cap() -> String {
    "GZM GTFS zip exceeds the size cap".to_owned()
}

/// Downloads the zip next to `file` as `<file>.tmp`; `None` on 304. `if_modified_since` = the kept zip's mtime.
pub async fn download_gzm_zip(
    file: &Path,
    url: &str,
    if_modified_since: Option<Timestamp>,
    max_bytes: u64,
) -> Result<Option<Downloaded>, String> {
    let mut req = crate::fetch::client()
        .get(url)
        .header("User-Agent", config::USER_AGENT.as_str())
        .header("Accept", "application/zip, */*")
        .timeout(DOWNLOAD_TIMEOUT);
    if let Some(t) = if_modified_since {
        let date = DateTimePrinter::new()
            .timestamp_to_rfc9110_string(&t)
            .map_err(|e| e.to_string())?;
        req = req.header("If-Modified-Since", date);
    }
    let mut res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if status == 304 {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("GZM GTFS HTTP {status}"));
    }
    if res.content_length().is_some_and(|n| n > max_bytes) {
        return Err(size_cap());
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // page-cache writes behind a 64 KB buffer: short enough to stay on the async thread
    let mut out = BufWriter::with_capacity(64 * 1024, File::create(&tmp).map_err(|e| e.to_string())?);
    let mut bytes = 0u64;
    let body: Result<(), String> = async {
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            bytes += chunk.len() as u64;
            if bytes > max_bytes {
                return Err(size_cap());
            }
            out.write_all(&chunk).map_err(|e| e.to_string())?;
        }
        out.flush().map_err(|e| e.to_string())
    }
    .await;
    drop(out);
    match body {
        Ok(()) => Ok(Some(Downloaded { tmp, bytes })),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/* ---------------- refresh ---------------- */

const CHECK: Duration = Duration::from_secs(10 * 60);
const RETRY_MS: i64 = 30 * 60_000;

/// One city's feed. `epoch` tells a stopped city's refresh task apart from a restarted one's.
#[derive(Default)]
struct FeedState {
    epoch: u64,
    feed: Option<Arc<GzmFeed>>,
    refresh: RefreshState,
    last_error: Option<String>,
    downloads: u64,
    download_bytes: u64,
    task: Option<tokio::task::JoinHandle<()>>,
}

/// one state per zbiorkom slug, created on start (bounded by the registry), dropped by [`stop_gzm_feed`]
static STATES: LazyLock<Mutex<HashMap<String, FeedState>>> = LazyLock::new(Mutex::default);
static EPOCH: AtomicU64 = AtomicU64::new(0);

fn states() -> MutexGuard<'static, HashMap<String, FeedState>> {
    STATES.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `f` on the state of `slug` while it still belongs to the task of `epoch`; `None` once the city was stopped.
fn with_state<R>(slug: &str, epoch: u64, f: impl FnOnce(&mut FeedState) -> R) -> Option<R> {
    states().get_mut(slug).filter(|s| s.epoch == epoch).map(f)
}

/// The kept zip: GZM's stays where it was, every other city's sits beside it under its slug.
pub fn gzm_zip_path(slug: &str) -> PathBuf {
    let dir = Path::new(config::GZM_DIR.as_str());
    if slug == "gzm" {
        dir.join("gtfs.zip")
    } else {
        dir.join(slug).join("gtfs.zip")
    }
}

fn feed_url(slug: &str) -> String {
    if slug == "gzm" {
        config::GZM_GTFS_URL.clone()
    } else {
        format!(
            "{}/{}/gtfs/default",
            config::ZB_API_URL.as_str(),
            js::encode_uri_component(slug)
        )
    }
}

/// A city's current feed, or `None` while the first one loads (or after it was dropped). Never starts anything.
pub fn get_gzm_feed(slug: &str) -> Option<Arc<GzmFeed>> {
    states().get(slug)?.feed.clone()
}

fn mtime(file: &Path) -> Option<Timestamp> {
    let t = std::fs::metadata(file).ok()?.modified().ok()?;
    Timestamp::try_from(t).ok()
}

async fn parse_off_loop(file: PathBuf, slug: &str) -> Result<GzmFeed, String> {
    let slug = slug.to_owned();
    tokio::task::spawn_blocking(move || parse_gzm_zip(&file, &slug, &|raw| MATCHER.stored(raw)))
        .await
        .map_err(|e| e.to_string())?
}

/// Publishes a parsed feed; false = the city was stopped meanwhile.
fn set_feed(slug: &str, epoch: u64, feed: GzmFeed, checked_day: Option<String>) -> bool {
    let feed = Arc::new(feed);
    let set = with_state(slug, epoch, |s| {
        s.feed = Some(feed.clone());
        s.refresh.has_feed = true;
        if let Some(day) = checked_day {
            s.refresh.checked_day = day;
        }
    });
    if set.is_none() {
        return false;
    }
    if slug == "gzm" {
        MATCHER.prune(&feed.shapes);
    }
    info(
        "gzm-feed",
        format!(
            "{slug}: feed {} ({}..{}): {} stops, {} trips, {} shapes, built in {} ms",
            feed.version,
            feed.start_date,
            feed.end_date,
            feed.stops.len(),
            feed.router.trips.len(),
            feed.shapes.size(),
            feed.build_ms
        ),
    );
    true
}

/// Downloads (If-Modified-Since the kept zip), parses, then swaps the zip in; `Ok(false)` = stopped meanwhile.
async fn download_and_install(slug: &str, epoch: u64, zip: &Path, has_feed: bool) -> Result<bool, String> {
    let since = if has_feed { mtime(zip) } else { None };
    let Some(got) = download_gzm_zip(zip, &feed_url(slug), since, MAX_ZIP_BYTES).await? else {
        return Ok(true);
    };
    with_state(slug, epoch, |s| {
        s.downloads += 1;
        s.download_bytes += got.bytes;
    });
    let installed = match parse_off_loop(got.tmp.clone(), slug).await {
        Ok(feed) => std::fs::rename(&got.tmp, zip).map(|()| feed).map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    match installed {
        Ok(feed) => Ok(set_feed(slug, epoch, feed, None)),
        Err(e) => {
            let _ = std::fs::remove_file(&got.tmp);
            Err(e)
        }
    }
}

async fn refresh(slug: &str, epoch: u64) {
    let zip = gzm_zip_path(slug);
    let Some(has_feed) = with_state(slug, epoch, |s| s.feed.is_some()) else {
        return;
    };
    if !has_feed && zip.exists() {
        match parse_off_loop(zip.clone(), slug).await {
            Ok(feed) => {
                let day = mtime(&zip).map_or_else(String::new, |t| checked_day_at(t.as_millisecond()));
                if !set_feed(slug, epoch, feed, Some(day)) {
                    return;
                }
            }
            Err(e) => warn(
                "gzm-feed",
                format!("{slug}: kept zip unreadable, downloading again: {e}"),
            ),
        }
    }
    // stopped while it parsed: a city nobody holds must not download
    let Some((due, has_feed)) = with_state(slug, epoch, |s| {
        (
            gzm_refresh_due(&s.refresh, Timestamp::now().as_millisecond()),
            s.feed.is_some(),
        )
    }) else {
        return;
    };
    if !due {
        return;
    }
    let r = download_and_install(slug, epoch, &zip, has_feed).await;
    let now = Timestamp::now().as_millisecond();
    with_state(slug, epoch, |s| match r {
        Ok(_) => {
            s.refresh.checked_day = checked_day_at(now);
            s.last_error = None;
        }
        Err(e) => {
            s.refresh.retry_at = now + RETRY_MS;
            warn(
                "gzm-feed",
                format!("{slug}: refresh failed, keeping the current feed, retry in 30 min: {e}"),
            );
            s.last_error = Some(e);
        }
    });
}

/// Loads a city's kept zip and checks for a new one now and every 10 min, on one task. Idempotent.
/// ponytail: a repeated start does not force a check (Node's did, deduped); both callers start once per city.
pub fn start_gzm_feed(slug: &str) {
    let mut all = states();
    let s = all.entry(slug.to_owned()).or_default();
    if s.task.is_some() {
        return;
    }
    let epoch = EPOCH.fetch_add(1, AtomicOrdering::Relaxed) + 1;
    s.epoch = epoch;
    let slug = slug.to_owned();
    s.task = Some(tokio::spawn(async move {
        loop {
            refresh(&slug, epoch).await;
            tokio::time::sleep(CHECK).await;
        }
    }));
}

/// Drops a city's feed and refresh task (idle eviction); the kept zip stays for the next start.
pub fn stop_gzm_feed(slug: &str) {
    if let Some(s) = states().remove(slug)
        && let Some(t) = s.task
    {
        t.abort();
    }
}

pub fn gzm_feed_health(slug: &str) -> Value {
    let all = states();
    let s = all.get(slug);
    let f = s.and_then(|s| s.feed.as_deref());
    json!({
        "version": f.map(|f| &f.version),
        "start_date": f.map(|f| &f.start_date),
        "end_date": f.map(|f| &f.end_date),
        "stops": f.map_or(0, |f| f.stops.len()),
        "trips": f.map_or(0, |f| f.router.trips.len()),
        "shapes": f.map_or(0, |f| f.shapes.size()),
        "built_at": f.map_or(0, |f| f.built_at),
        "build_ms": f.map(|f| f.build_ms),
        "zip_bytes": f.map_or(0, |f| f.zip_bytes),
        "checked_day": s.map(|s| s.refresh.checked_day.as_str()).filter(|d| !d.is_empty()),
        "downloads": s.map_or(0, |s| s.downloads),
        "download_bytes": s.map_or(0, |s| s.download_bytes),
        "last_error": s.and_then(|s| s.last_error.as_deref()),
    })
}
