//! lib/gzm.ts lines 1-357 (records, the trip join, the timetable position, the poll constants, the upstream
//! requests) and `GzmFleetSource` of lib/gzm-fleet.ts.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::fetch::fetch_error;
use crate::geo::RAD;
use crate::gzm_feed::{FeedArea, GzmFeed, GzmTrip};
use crate::js::{number_to_string, round};
use crate::shared::polyline::{LatLonBox, project_on_polyline};
use crate::vehicle::VehiclePos;

/* ---------------- zbiorkom records ---------------- */

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZbCall {
    /// GTFS stop_sequence (0-based, = call index in the trip)
    pub seq: usize,
    /// scheduled departure, epoch secs
    pub dep: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ZbRecord {
    /// "<op>_<fleet>" from the record url, unique across companies (another city: `zb_key`)
    pub key: String,
    /// display fleet number (95 of them collide across companies, so never a key)
    pub label: String,
    /// GTFS route_type as sent: "0" tram, "11" trolleybus, "3" bus
    pub kind: String,
    pub model: Option<String>,
    /// zbiorkom agency of another operator's vehicle mixed into a city (Warsaw: OTWOCK, MINSK, ...); None for the
    /// city's own ("default") and for every GZM record. Its line names are its own and its trips are not in the feed.
    pub agency: Option<String>,
    pub line: String,
    pub brigade: Option<String>,
    pub lat: f64,
    pub lon: f64,
    /// epoch ms of zbiorkom's snapshot
    pub ts: f64,
    pub bearing: Option<f64>,
    pub delay_ms: Option<f64>,
    pub headsign: String,
    /// sorted by seq
    pub upcoming: Vec<ZbCall>,
}

// ponytail: fixed GZM bbox (stop extent +-0.05 deg, 2026-10-28); widen if the network grows
pub const AREA: FeedArea = FeedArea {
    lat_min: 49.9728,
    lat_max: 50.5791,
    lon_min: 18.4043,
    lon_max: 19.4763,
};
/// a zbiorkom city's bbox until its feed parsed: the slug alone scopes the answer (Krakow, Lodz, Warsaw: 2026-10-30)
pub const POLAND: FeedArea = FeedArea {
    lat_min: 49.0,
    lat_max: 55.0,
    lon_min: 14.0,
    lon_max: 24.2,
};
// ponytail: a record older than 10 min is a vehicle zbiorkom forgot to drop, not a live one
const RECORD_MAX_AGE_MS: f64 = 600_000.0;

/// `finite`: a JSON number (serde_json never holds NaN or an infinity).
fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// `str`: a string as is, a number as `String(n)`, anything else "".
fn js_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(String::new, number_to_string),
        _ => String::new(),
    }
}

fn in_area(a: &FeedArea, lat: f64, lon: f64) -> bool {
    !(lat < a.lat_min || lat > a.lat_max || lon < a.lon_min || lon > a.lon_max)
}

fn all_digits(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// `KEY_RE = /(?:%3A|:)(\d{1,4}_\d{1,6})$/i` on a record url: its `<op>_<fleet>`.
fn url_key(url: &str) -> Option<String> {
    let (head, fleet) = url.rsplit_once('_')?;
    let op_len = head.bytes().rev().take_while(u8::is_ascii_digit).count();
    let (pre, op) = head.split_at(head.len() - op_len);
    let pre = pre.as_bytes();
    let sep = pre.ends_with(b":")
        || pre
            .len()
            .checked_sub(3)
            .and_then(|i| pre.get(i..))
            .is_some_and(|t| t.eq_ignore_ascii_case(b"%3A"));
    (sep && all_digits(op, 4) && all_digits(fleet, 6)).then(|| format!("{op}_{fleet}"))
}

/// `<type>_[<agency>_]<vehicle id>` (kept to the exec-id charset) for a city without `<op>_<fleet>` keys. zbiorkom
/// mixes other operators into a city (Warsaw: Otwock, Minsk Maz., ...) whose ids collide with the main one's, so
/// any agency but "default" is part of the key, as in zbiorkom's own vehicle url.
pub fn zb_key(veh: &Map<String, Value>) -> Option<String> {
    let kind = js_str(veh.get("type"));
    let agency = js_str(veh.get("agency"));
    let vid = js_str(veh.get("id"));
    let raw = if !agency.is_empty() && agency != "default" {
        format!("{agency}_{vid}")
    } else {
        vid.clone()
    };
    // the regex runs per UTF-16 unit: a character outside the BMP becomes two underscores
    let mut id = String::with_capacity(raw.len().min(36));
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            id.push(c);
        } else {
            id.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
        if id.len() >= 36 {
            break;
        }
    }
    id.truncate(36);
    (all_digits(&kind, 4) && !vid.is_empty()).then(|| format!("{kind}_{id}"))
}

/// Validated records of one positions response, one per vehicle key (the newest wins). Err on a foreign shape.
/// GZM keys come from the record url, any other city's (`generic`) from `zb_key`; `area` is `AREA` for GZM.
pub fn parse_zbiorkom(body: &Value, now_ms: i64, area: &FeedArea, generic: bool) -> Result<Vec<ZbRecord>, String> {
    let Some(list) = body
        .as_object()
        .and_then(|o| o.get("positions"))
        .and_then(Value::as_array)
    else {
        return Err("zbiorkom: response has no positions array".into());
    };
    let no_vehicle = Map::new();
    let mut by_key: IndexMap<String, ZbRecord> = IndexMap::new();
    for r in list {
        let Some(r) = r.as_object() else { continue };
        let veh = r.get("vehicle").and_then(Value::as_object).unwrap_or(&no_vehicle);
        let key = if generic {
            zb_key(veh)
        } else {
            url_key(&js_str(r.get("url")))
        };
        let loc = r
            .get("location")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        let lon = finite(loc.first());
        let lat = finite(loc.get(1));
        let ts = finite(r.get("timestamp"));
        let (Some(key), Some(lat), Some(lon), Some(ts)) = (key, lat, lon, ts) else {
            continue;
        };
        if now_ms as f64 - ts > RECORD_MAX_AGE_MS || !in_area(area, lat, lon) {
            continue;
        }
        if by_key.get(&key).is_some_and(|p| p.ts >= ts) {
            continue;
        }
        let mut upcoming: Vec<ZbCall> = r
            .get("upcomingStops")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter_map(|u| {
                let seq = finite(u.get("sequence"))?;
                let dep = finite(u.get("scheduledDeparture"))?;
                (seq.fract() == 0.0 && seq >= 0.0).then(|| ZbCall {
                    seq: seq as usize,
                    dep: round(dep / 1000.0),
                })
            })
            .collect();
        upcoming.sort_by_key(|c| c.seq);
        let agency = if generic {
            js_str(veh.get("agency"))
        } else {
            String::new()
        };
        let label = js_str(veh.get("id"));
        let rec = ZbRecord {
            label: if label.is_empty() { key.clone() } else { label },
            kind: js_str(veh.get("type")),
            model: Some(js_str(veh.get("model"))).filter(|s| !s.is_empty()),
            agency: (!agency.is_empty() && agency != "default").then_some(agency),
            line: js_str(r.get("routeName")),
            brigade: Some(js_str(r.get("brigade"))).filter(|s| !s.is_empty()),
            lat,
            lon,
            ts,
            bearing: finite(r.get("bearing")).map(|b| ((b % 360.0) + 360.0) % 360.0),
            delay_ms: finite(r.get("delay")),
            headsign: js_str(r.get("headsign")),
            upcoming,
            key: key.clone(),
        };
        by_key.insert(key, rec);
    }
    Ok(by_key.into_values().collect())
}

/// A vehicle position from SDIP `planner/v` (bearing sent in compass radians).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SdipPos {
    pub lat: f64,
    pub lon: f64,
    pub bearing: Option<f64>,
}

/// SDIP vehicles keyed like zbiorkom (`<op>_<fleet>`), in list order. Err on a foreign shape (an expired session
/// sends HTML).
pub fn parse_sdip(body: &Value) -> Result<IndexMap<String, SdipPos>, String> {
    let Some(list) = body.as_array() else {
        return Err("SDIP: response is not a vehicle list".into());
    };
    let mut out = IndexMap::new();
    for v in list {
        let Some(v) = v.as_object() else { continue };
        let Some(id) = v.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some((op, fleet)) = id.split_once('_') else {
            continue;
        };
        if !all_digits(op, 4) || !all_digits(fleet, 6) {
            continue;
        }
        let (Some(lat), Some(lon)) = (finite(v.get("lat")), finite(v.get("lon"))) else {
            continue;
        };
        if !in_area(&AREA, lat, lon) {
            continue;
        }
        let bearing =
            finite(v.get("bearing")).map(|rad| ((rad * 180.0 / std::f64::consts::PI) % 360.0 + 360.0) % 360.0);
        out.insert(id.to_owned(), SdipPos { lat, lon, bearing });
    }
    Ok(out)
}

/* ---------------- join ---------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct GzmMatch {
    /// index into the feed's `router.trips`
    pub trip: u32,
    /// the trip's service date
    pub date: String,
    /// `service_day_base(date)`, epoch secs
    pub base: i64,
}

/// zbiorkom's live calls may time a departure a few seconds off its own GTFS export (Tczew: +5 s on every call, 2026-10-30)
pub const MATCH_SLACK_SEC: f64 = 30.0;

/// Every call is the trip's call `seq` departing at `dep` (within `slack` s) on the service day at `base`.
pub fn fits(trip: GzmTrip<'_>, base: i64, calls: &[ZbCall], slack: f64) -> bool {
    calls.iter().all(|c| {
        trip.t.seqs.get(c.seq).is_some_and(|&s| usize::try_from(s) == Ok(c.seq))
            && trip
                .t
                .dep
                .get(c.seq)
                .is_some_and(|&d| (base as f64 + f64::from(d) - c.dep).abs() <= slack)
    })
}

/// The one trip of the record's line whose calls match every upcoming (seq, scheduled departure) pair, or None.
/// `days` are the candidate service days as (Warsaw date, `service_day_base` of it).
pub fn match_trip(feed: &GzmFeed, rec: &ZbRecord, days: &[(String, i64)]) -> Option<GzmMatch> {
    if rec.upcoming.is_empty() {
        return None;
    }
    let cands = feed.trips_by_line.get(&rec.line)?;
    let brigade = rec.brigade.as_deref().filter(|b| !b.is_empty());
    // exact first: the slack pass would tie two trips seconds apart that exact times tell apart
    for slack in [0.0, MATCH_SLACK_SEC] {
        let mut hits: Vec<GzmMatch> = Vec::new();
        for (date, base) in days {
            for &i in cands {
                let trip = feed.trip_at(i);
                if trip.runs_on(date) && fits(trip, *base, &rec.upcoming, slack) {
                    hits.push(GzmMatch {
                        trip: i,
                        date: date.clone(),
                        base: *base,
                    });
                }
            }
        }
        if hits.is_empty() {
            continue;
        }
        if hits.len() > 1
            && let Some(b) = brigade
        {
            let same = |h: &GzmMatch| feed.trip_at(h.trip).x.brigade == b;
            if hits.iter().any(same) {
                hits.retain(same);
            }
        }
        return if hits.len() == 1 { hits.pop() } else { None };
    }
    None
}

/// zbiorkom names the first stop as next while the bus drives there from the depot: off the trip's shape = not begun
pub const OFF_ROUTE_M: f64 = 200.0;

pub fn off_route(feed: &GzmFeed, trip: GzmTrip<'_>, lat: f64, lon: f64) -> bool {
    trip.x
        .shape_id
        .as_deref()
        .filter(|k| !k.is_empty())
        .and_then(|k| feed.shapes.geometry(k))
        .and_then(|g| project_on_polyline(&g.pl, lat, lon, 0.0, f64::INFINITY, None, 15.0))
        .is_some_and(|p| p.d > OFF_ROUTE_M)
}

/* ---------------- scheduled metro ---------------- */

/// GTFS route_type of the lines placed by the timetable: Warsaw's metro (zbiorkom sends no metro positions, 2026-10-30)
pub const SCHED_ROUTE_TYPE: &str = "1";

/// Where a trip is by its timetable at service-day `t`: the leg from stop `i` (fraction `f`) and the next call's index.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SchedAt {
    pub i: usize,
    pub f: f64,
    /// i while the train stands at stop i, i + 1 once it left
    pub next: usize,
}

/// The timetable position of a trip (its `arr` / `dep`) at service-day secs `t`; None before its first departure
/// or from its last arrival.
pub fn schedule_position(arr: &[i32], dep: &[i32], t: f64) -> Option<SchedAt> {
    let last = dep.len().checked_sub(1)?;
    if last < 1 || t < f64::from(*dep.first()?) || t >= f64::from(*arr.get(last)?) {
        return None;
    }
    let mut i = 0;
    while arr.get(i + 1).is_some_and(|&a| f64::from(a) <= t) {
        i += 1;
    }
    let d = f64::from(*dep.get(i)?);
    if t < d {
        return Some(SchedAt { i, f: 0.0, next: i });
    }
    let a = f64::from(*arr.get(i + 1)?);
    Some(SchedAt {
        i,
        f: (t - d) / (a - d),
        next: i + 1,
    })
}

/* ---------------- live state ---------------- */

#[derive(Clone)]
pub struct Track {
    pub rec: ZbRecord,
    pub pos: VehiclePos,
    pub feed: Option<Arc<GzmFeed>>,
    /// the join result, revalidated each poll (TS `match`)
    pub matched: Option<GzmMatch>,
    /// the trip shown, an index into `feed`'s trips: the matched one, or its brigade successor while the vehicle
    /// lays over (a timetable-placed train always has one: TS `SchedTrack`)
    pub trip: Option<u32>,
    pub date: String,
    pub base: i64,
    /// call index in trip of the next call
    pub next: usize,
    pub not_started: bool,
    /// fix time of zbiorkom's position, epoch secs (pos may carry SDIP's newer one)
    pub zb_fix_at: f64,
}

/// A position with its fix time (epoch secs), from either source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fix {
    pub lat: f64,
    pub lon: f64,
    pub bearing: Option<f64>,
    pub fix_at: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SdipSample {
    pub lat: f64,
    pub lon: f64,
    pub bearing: Option<f64>,
    /// our receive time (epoch secs) of the poll that last saw it
    pub recv: f64,
    /// None until the position was seen changing between two close polls: before that its age is unknown
    pub fix_at: Option<f64>,
}

pub const POLL_MS: i64 = 10_000;
pub const POLL_PHASE_MS: i64 = 3_000;
pub const TIMEOUT: Duration = Duration::from_millis(10_000);
pub const MAX_BODY: usize = 16 * 1024 * 1024;
/// a poll older than this empties the map and the live overlay (the MZK stale rule)
pub const STALE_SEC: f64 = 180.0;
pub const AT_STOP_M: f64 = 40.0;
/// mirrors isMzkNotStarted: a bus further than this from its first stop has begun the course
pub const NOT_STARTED_M: f64 = 400.0;
pub const LAYOVER_GRACE_SEC: f64 = 120.0;
/// zbiorkom never closes some trips (the bus parks short of the last stop's zone, or at a depot mid-route): the
/// delay then grows with the clock while the bus stands still. At 2026-10-29 00:00 all 64 delays over 20 min were
/// such vehicles. Standing this long with at least this much delay = the trip is over.
pub const STUCK_SEC: f64 = 600.0;
pub const BOARD_ROWS: usize = 40;
/// whole-stop board: the same-name poles this close (a few GZM names are two places km apart), nearest first
pub const GROUP_M: f64 = 600.0;
pub const GROUP_MAX: usize = 12;
pub const SDIP_MS: i64 = 5_000;
pub const SDIP_PHASE_MS: i64 = 2_500;
pub const SDIP_TIMEOUT: Duration = Duration::from_millis(4_000);
pub const SDIP_MAX_BODY: usize = 4 * 1024 * 1024;
/// SDIP runs only while a vehicles request came in this recently
pub const WATCH_MS: i64 = 120_000;
/// two SDIP polls further apart than this can't date a change; an SDIP sample older than this yields to zbiorkom
pub const SDIP_GAP_SEC: f64 = 15.0;
pub const SDIP_PAUSE_MS: i64 = 300_000;
/// added to a poll's predicted end in X-Next-Update: a poll a little slower than the last one still lands before it
pub const BODY_SLACK_MS: i64 = 250;
pub const CONN_MEMO: usize = 256;
pub const CONN_MEMO_MS: i64 = 60_000;
/// a tapped vehicle opens at zoom 16 (~0.6 x 1.2 km on a phone): its road match starts with this much around it
pub const FOCUS_M: f64 = 800.0;

/// The box `m` metres around a point, each way.
pub fn around(lat: f64, lon: f64, m: f64) -> LatLonBox {
    let d_lat = m / 111_320.0;
    let d_lon = d_lat / (lat * RAD).cos();
    LatLonBox {
        s: lat - d_lat,
        w: lon - d_lon,
        n: lat + d_lat,
        e: lon + d_lon,
    }
}

/// ms until `phase` past the next `every` grid point (epoch ms), never under 1 s (TS defaults: POLL_MS, POLL_PHASE_MS).
pub fn next_poll_delay(now_ms: i64, every: i64, phase: i64) -> i64 {
    let d = (phase - (now_ms % every) + every) % every;
    if d < 1000 { d + every } else { d }
}

/// "HH:MM" of GTFS service-day secs (may exceed 24 h).
pub fn clock(secs: i32) -> String {
    format!("{:02}:{:02}", secs.div_euclid(3600) % 24, (secs % 3600).div_euclid(60))
}

/* ---------------- upstream ---------------- */

/// A query answer the feed may not hold yet: TS `null` = Loading (the feed is still parsing), `"unknown"` = Unknown.
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup<T> {
    Loading,
    Unknown,
    Found(T),
}

/// One HTTP answer of zbiorkom or SDIP.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ZbResponse {
    pub status: u16,
    /// every Set-Cookie header value (`getSetCookie()`)
    pub set_cookies: Vec<String>,
    pub content_length: Option<u64>,
    /// "" unless the status is 2xx and `max_body` > 0
    pub body: String,
}

impl ZbResponse {
    /// `res.ok`
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// How the live layer reaches zbiorkom and SDIP (the TS `fetchImpl`).
pub trait ZbTransport {
    /// GET `url` with `headers`; the body (a 2xx one only, as text) is refused past `max_body` bytes and not read
    /// at all when `max_body` is 0. Err = network failure, timeout or a body over the cap: a bare message is a thrown
    /// `Error`'s, a failure of another class names it first (`TypeError: fetch failed`), as `String(err)` reads.
    fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        timeout: Duration,
        max_body: usize,
    ) -> impl Future<Output = Result<ZbResponse, String>> + Send;
}

/// The real network, through the shared client.
pub struct HttpZb;

const SIZE_CAP: &str = "response body exceeds the size cap";

impl ZbTransport for HttpZb {
    async fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        timeout: Duration,
        max_body: usize,
    ) -> Result<ZbResponse, String> {
        let mut req = crate::fetch::client().get(url).timeout(timeout);
        for &(k, v) in headers {
            req = req.header(k, v);
        }
        let mut res = req
            .send()
            .await
            .map_err(|e| fetch_error(&e, "TypeError: fetch failed"))?;
        let mut out = ZbResponse {
            status: res.status().as_u16(),
            set_cookies: res
                .headers()
                .get_all(reqwest::header::SET_COOKIE)
                .iter()
                .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
                .collect(),
            content_length: res.content_length(),
            body: String::new(),
        };
        if max_body == 0 || !out.ok() {
            return Ok(out);
        }
        if out.content_length.is_some_and(|n| n > max_body as u64) {
            return Err(SIZE_CAP.into());
        }
        // ponytail: the cap counts bytes where cappedText counts UTF-16 units, ~0.4 % fewer on zbiorkom's Polish
        // names: a body that close under 16 / 4 MB passes the TS only; stream to 3x the cap and count units then
        let mut buf = Vec::new();
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| fetch_error(&e, "TypeError: terminated"))?
        {
            if buf.len() + chunk.len() > max_body {
                return Err(SIZE_CAP.into());
            }
            buf.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&buf);
        // `res.text()` drops a byte order mark
        out.body = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
        Ok(out)
    }
}

/// The JSESSIONID pair a Set-Cookie value starts with (`/^JSESSIONID=[^;]+/`).
fn jsessionid(cookie: &str) -> Option<&str> {
    let pair = cookie.split(';').next()?;
    (pair.len() > "JSESSIONID=".len() && pair.starts_with("JSESSIONID=")).then_some(pair)
}

/// A fresh SDIP session: the JSESSIONID cookie its map page `url` sets.
pub async fn sdip_session<T: ZbTransport>(t: &T, url: &str) -> Result<String, String> {
    let res = t
        .get(
            url,
            &[("User-Agent", crate::config::USER_AGENT.as_str())],
            SDIP_TIMEOUT,
            0,
        )
        .await?;
    let id = res.set_cookies.iter().find_map(|c| jsessionid(c));
    match id {
        Some(id) if res.ok() => Ok(id.to_owned()),
        _ => Err(format!(
            "SDIP session: HTTP {}{}",
            res.status,
            if id.is_some() { "" } else { ", no JSESSIONID" }
        )),
    }
}

/// SDIP's vehicle list body: JSON, or its expired-session page.
pub async fn sdip_list_text<T: ZbTransport>(t: &T, url: &str, cookie: &str) -> Result<String, String> {
    let res = t
        .get(
            &format!("{url}?command=planner&action=v"),
            &[
                ("User-Agent", crate::config::USER_AGENT.as_str()),
                ("Accept", "application/json"),
                ("Cookie", cookie),
                ("X-Requested-With", "XMLHttpRequest"),
            ],
            SDIP_TIMEOUT,
            SDIP_MAX_BODY,
        )
        .await?;
    if !res.ok() {
        return Err(format!("SDIP vehicles: HTTP {}", res.status));
    }
    Ok(res.body)
}

/* ---------------- fleet tracker input (lib/gzm-fleet.ts) ---------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct GzmFleetStop {
    pub id: String,
    pub name: String,
    /// service-day seconds (may exceed 86 400)
    pub dep: i32,
    /// along-route metres
    pub dist_m: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GzmNextTrip {
    pub line: String,
    pub headsign: String,
    pub first_stop_name: String,
    pub first_stop_id: String,
    /// service-day seconds
    pub dep: i32,
}

/// One running GZM vehicle as the fleet tracker reads it (`GzmFleetSource`; never serialized).
#[derive(Debug, Clone, PartialEq)]
pub struct GzmFleetSource {
    /// "<op>_<fleet>", e.g. "283_4285"; the map vehicle id is `gzm:<side>`
    pub side: String,
    /// display fleet number, e.g. "4285" (95 labels collide across companies, so `side` is the key)
    pub label: String,
    pub model: Option<String>,
    /// GTFS route_type: "0" tram, "11" trolleybus, "3" bus
    pub vehicle_type: String,
    /// route_short_name
    pub line: String,
    pub brigade: Option<String>,
    /// raw 16-hex GTFS trip_id
    pub trip_id: String,
    pub headsign: String,
    pub stops: Vec<GzmFleetStop>,
    /// index in stops of the last stop served
    pub served_idx: Option<usize>,
    pub next_idx: Option<usize>,
    /// along-route distance driven
    pub reached_m: Option<f64>,
    pub at_stop: bool,
    pub not_started: bool,
    pub delay_sec: Option<f64>,
    pub lat: f64,
    pub lon: f64,
    /// compass degrees
    pub bearing: Option<f64>,
    /// epoch s of the GPS fix
    pub fix_at: Option<f64>,
    /// the brigade's next GTFS trips in order (at most 5)
    pub next_trips: Vec<GzmNextTrip>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_key_is_the_trailing_op_fleet_after_a_colon() {
        assert_eq!(url_key("https://x/v/0%3A283_4285").as_deref(), Some("283_4285"));
        assert_eq!(url_key("https://x/v/0%3a1_1").as_deref(), Some("1_1"));
        assert_eq!(url_key("gzm:12_123456").as_deref(), Some("12_123456"));
        assert_eq!(url_key("gzm:12345_1"), None);
        assert_eq!(url_key("gzm:1_1234567"), None);
        assert_eq!(url_key("gzm/1_1"), None);
        assert_eq!(url_key("gzm:1_1x"), None);
        assert_eq!(url_key("\u{e9}1_1"), None);
    }

    #[test]
    fn clock_wraps_past_24_h() {
        assert_eq!(clock(8 * 3600 + 5 * 60 + 59), "08:05");
        assert_eq!(clock(25 * 3600 + 10 * 60), "01:10");
    }

    struct Fake(ZbResponse);

    impl ZbTransport for Fake {
        async fn get(&self, _: &str, _: &[(&str, &str)], _: Duration, _: usize) -> Result<ZbResponse, String> {
            Ok(self.0.clone())
        }
    }

    #[tokio::test]
    async fn sdip_session_takes_the_jsessionid_pair() {
        let res = |status, cookies: &[&str]| {
            Fake(ZbResponse {
                status,
                set_cookies: cookies.iter().map(|c| (*c).to_owned()).collect(),
                ..Default::default()
            })
        };
        let ok = res(200, &["lang=pl; Path=/", "JSESSIONID=ab12; Path=/vm; HttpOnly"]);
        assert_eq!(sdip_session(&ok, "u").await.as_deref(), Ok("JSESSIONID=ab12"));
        let none = res(200, &["JSESSIONID=; Path=/"]);
        assert_eq!(
            sdip_session(&none, "u").await,
            Err("SDIP session: HTTP 200, no JSESSIONID".into())
        );
        let down = res(503, &["JSESSIONID=x"]);
        assert_eq!(sdip_session(&down, "u").await, Err("SDIP session: HTTP 503".into()));
    }
}
