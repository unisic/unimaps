//! lib/osrm.ts: server-side OSRM routing and map matching. Pure helpers plus a transport trait, so tests never touch
//! the network. The public demo server (router.project-osrm.org) is shared and policed: callers throttle (<= 1
//! request/s), send an identifying User-Agent and stop on block/config errors.

use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

use crate::geo::bearing;
use crate::js;
use crate::shared::polyline::{LatLng, decode_polyline, prepare_polyline, project_on_polyline, seg_meters};

/// Max waypoints per request (matches the browser fallback in lib/client/api.ts).
pub const OSRM_CHUNK: usize = 12;

/// Overlapping chunks of <= size points (consecutive chunks share one point).
pub fn chunk_waypoints(pts: &[LatLng], size: usize) -> Vec<Vec<LatLng>> {
    if pts.len() <= size {
        return if pts.len() >= 2 { vec![pts.to_vec()] } else { vec![] };
    }
    (0..pts.len() - 1)
        .step_by(size - 1)
        .map(|i| pts[i..(i + size).min(pts.len())].to_vec())
        .filter(|c| c.len() >= 2)
        .collect()
}

/// Concatenate chunk geometries, dropping the duplicated joint point.
pub fn merge_chunk_geometries(parts: &[Vec<LatLng>]) -> Vec<LatLng> {
    let mut out: Vec<LatLng> = Vec::new();
    for part in parts {
        let Some(first) = part.first() else { continue };
        let joint = out
            .last()
            .is_some_and(|l| (first[0] - l[0]).abs() < 1e-6 && (first[1] - l[1]).abs() < 1e-6);
        out.extend_from_slice(&part[usize::from(joint)..]);
    }
    out
}

/// OSRM snaps a waypoint only to a road heading within +- this of the bus's direction: never the opposite
/// carriageway, nor the side street of a junction stop (Buczkowice Zylica: Wczasowa, 10 m away, runs 62 deg off).
const BEARING_RANGE: i32 = 45;
/// Neighbours closer than this give no usable direction.
const BEARING_MIN_M: f64 = 25.0;

/// The bus's direction at each waypoint (previous to next waypoint, the ends along their one leg); None = can't tell.
pub fn waypoint_bearings(wps: &[LatLng]) -> Vec<Option<i32>> {
    (0..wps.len())
        .map(|i| {
            let a = wps[i.saturating_sub(1)];
            let b = wps[(i + 1).min(wps.len() - 1)];
            if seg_meters(a[0], a[1], b[0], b[1]) < BEARING_MIN_M {
                return None;
            }
            bearing(a[0], a[1], b[0], b[1]).map(|d| js::round(d) as i32 % 360)
        })
        .collect()
}

fn coords(pts: &[LatLng]) -> String {
    pts.iter()
        .map(|p| format!("{},{}", js::to_fixed(p[1], 6), js::to_fixed(p[0], 6)))
        .collect::<Vec<_>>()
        .join(";")
}

pub fn osrm_route_url(base: &str, pts: &[LatLng], continue_straight: bool, bearings: Option<&[Option<i32>]>) -> String {
    let cs = if continue_straight {
        "&continue_straight=true"
    } else {
        ""
    };
    let br = bearings.map_or(String::new(), |b| {
        let parts: Vec<String> = b
            .iter()
            .map(|x| x.map_or(String::new(), |d| format!("{d},{BEARING_RANGE}")))
            .collect();
        format!("&bearings={}", parts.join(";"))
    });
    format!(
        "{}/{}?overview=full&geometries=polyline6&steps=false&alternatives=false{cs}{br}",
        base.trim_end_matches('/'),
        coords(pts)
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsrmFailure {
    /// this geometry can't be routed: fall back to straight lines for it
    Unroutable,
    /// transient (5xx, network, timeout, garbage): retry later, commit nothing
    Unavailable,
    /// our request/config is wrong (Invalid*, 404, 414): stop the worker
    Config,
    /// 401/403: we are blocked; back off for a long time
    Blocked,
    /// 429: honour Retry-After
    Ratelimited,
}

impl OsrmFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unroutable => "unroutable",
            Self::Unavailable => "unavailable",
            Self::Config => "config",
            Self::Blocked => "blocked",
            Self::Ratelimited => "ratelimited",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub kind: OsrmFailure,
    pub detail: String,
    pub retry_after_sec: Option<f64>,
}

fn fail(kind: OsrmFailure, detail: impl Into<String>) -> Failure {
    Failure {
        kind,
        detail: detail.into(),
        retry_after_sec: None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Routed {
    pub pts: Vec<LatLng>,
    /// NaN for a leg without a numeric distance
    pub legs: Vec<f64>,
    /// summed distance from each waypoint to where OSRM snapped it
    pub snap_m: f64,
}

pub type OsrmOutcome = Result<Routed, Failure>;

/// JS `x && typeof x === "object"`: an object or an array.
fn as_record(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| v.is_object() || v.is_array())
}

fn num_field(v: &Value, key: &str) -> Option<f64> {
    as_record(Some(v)).and_then(|r| r.get(key)).and_then(Value::as_f64)
}

/// Classify an OSRM HTTP response (status + parsed JSON body or None).
pub fn classify_osrm_response(status: u16, body: Option<&Value>, retry_after: Option<&str>) -> OsrmOutcome {
    let rec = as_record(body);
    let code = rec.and_then(|r| r.get("code")).and_then(Value::as_str).unwrap_or("");
    if status == 429 {
        // Number(null) = 0 and Number(undefined) = NaN: both fall back to 60
        let ra = retry_after.map_or(f64::NAN, js::number);
        return Err(Failure {
            kind: OsrmFailure::Ratelimited,
            detail: "HTTP 429".into(),
            retry_after_sec: Some(if ra.is_finite() && ra > 0.0 { ra } else { 60.0 }),
        });
    }
    if status == 401 || status == 403 {
        return Err(fail(OsrmFailure::Blocked, format!("HTTP {status}")));
    }
    if status == 404 || status == 414 {
        return Err(fail(OsrmFailure::Config, format!("HTTP {status}")));
    }
    if matches!(code, "NoRoute" | "NoSegment" | "NoMatch") {
        return Err(fail(OsrmFailure::Unroutable, code));
    }
    if code.starts_with("Invalid") || code == "NotImplemented" || code == "TooBig" {
        let kind = if code == "TooBig" {
            OsrmFailure::Unroutable
        } else {
            OsrmFailure::Config
        };
        return Err(fail(kind, code));
    }
    let Some(rec) = rec.filter(|_| status < 500) else {
        let tail = if rec.is_some() { "" } else { " (no JSON)" };
        return Err(fail(OsrmFailure::Unavailable, format!("HTTP {status}{tail}")));
    };
    if status != 200 || code != "Ok" {
        return Err(fail(OsrmFailure::Unavailable, format!("HTTP {status} {code}")));
    }
    // /match answers `matchings` (one per matched piece of the trace) where /route answers `routes`
    let routes = match (rec.get("routes"), rec.get("matchings")) {
        (Some(Value::Array(r)), _) | (_, Some(Value::Array(r))) => r.as_slice(),
        _ => &[],
    };
    let r0 = as_record(routes.first());
    let geom = r0.and_then(|r| r.get("geometry")).and_then(Value::as_str).unwrap_or("");
    let pts = if geom.is_empty() {
        vec![]
    } else {
        decode_polyline(geom, 6)
    };
    if pts.len() < 2 {
        return Err(fail(OsrmFailure::Unroutable, "empty geometry"));
    }
    let legs = match r0.and_then(|r| r.get("legs")) {
        Some(Value::Array(l)) => l.iter().map(|l| num_field(l, "distance").unwrap_or(f64::NAN)).collect(),
        _ => vec![],
    };
    let snap_m = match rec.get("waypoints") {
        Some(Value::Array(w)) => w.iter().filter_map(|w| num_field(w, "distance")).sum(),
        _ => 0.0,
    };
    Ok(Routed { pts, legs, snap_m })
}

fn long_legs(legs: &[f64], wps: &[LatLng], ratio: f64, extra_m: f64) -> Vec<usize> {
    (0..legs.len().min(wps.len().saturating_sub(1)))
        .filter(|&i| {
            let straight = seg_meters(wps[i][0], wps[i][1], wps[i + 1][0], wps[i + 1][1]);
            let d = legs[i];
            d.is_finite() && d > ratio * straight && d - straight > extra_m
        })
        .collect()
}

/// Indices of implausible legs: a stop-to-stop leg more than 2x the straight distance AND over 400 m longer, the
/// signature of a wrong-carriageway snap sending OSRM around the block, so another way of asking is tried. Not
/// proof: a mountain serpentine (Szczyrk: 934 m apart, 2.4 km by road) looks the same.
pub fn implausible_legs(legs: &[f64], wps: &[LatLng]) -> Vec<usize> {
    long_legs(legs, wps, 2.0, 400.0)
}

/// Indices of legs too long to draw: over 3x the straight distance AND over 3 km longer. Anything shorter is drawn
/// on the road, a detour on real streets beats a straight line through buildings (the longest real one: +1.5 km).
pub fn absurd_legs(legs: &[f64], wps: &[LatLng]) -> Vec<usize> {
    long_legs(legs, wps, 3.0, 3000.0)
}

/// One HTTP answer of an OSRM server.
pub struct OsrmHttp {
    pub status: u16,
    /// None when the body is not JSON
    pub body: Option<Value>,
    pub retry_after: Option<String>,
}

/// How a client reaches OSRM (`OsrmClientOpts` minus the base URL).
pub trait OsrmTransport {
    /// Resolves when the next request may be sent (counts every attempt).
    fn throttle(&self) -> impl Future<Output = ()> + Send;
    /// GET `url` as JSON; Err = network failure or timeout.
    fn get(&self, url: &str) -> impl Future<Output = Result<OsrmHttp, String>> + Send;
}

/// The real server, unthrottled (the caller paces itself), 15 s per request.
pub struct HttpOsrm;

impl OsrmTransport for HttpOsrm {
    async fn throttle(&self) {}

    async fn get(&self, url: &str) -> Result<OsrmHttp, String> {
        let res = crate::fetch::client()
            .get(url)
            .header("User-Agent", crate::config::OSRM_USER_AGENT.as_str())
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        // a body that fails to arrive or to parse is "no JSON", like a throwing res.json()
        let body = res.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok());
        Ok(OsrmHttp {
            status,
            body,
            retry_after,
        })
    }
}

/// Request slots shared by every client of one OSRM server: the public demo allows <= 1 request/s in total.
/// Holds the next free slot, epoch ms.
pub type OsrmPace = Mutex<i64>;

/// The process-wide pace: the road-shape store and the GZM shape matcher draw from it.
pub static OSRM_PACE: OsrmPace = Mutex::new(0);

/// Books the next free slot of `pace` at or after `now`; the ms to wait for it.
pub fn book_slot(pace: &OsrmPace, min_interval_ms: i64, now: i64) -> i64 {
    let mut next = pace.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let at = now.max(*next);
    *next = at + min_interval_ms;
    at - now
}

/// Wait for the next free slot of `pace`, booking it.
pub async fn pace_request(pace: &OsrmPace, min_interval_ms: i64) {
    let wait = book_slot(pace, min_interval_ms, jiff::Timestamp::now().as_millisecond());
    if wait > 0 {
        tokio::time::sleep(Duration::from_millis(wait as u64)).await;
    }
}

async fn request_osrm(url: &str, t: &(impl OsrmTransport + Sync)) -> OsrmOutcome {
    t.throttle().await;
    match t.get(url).await {
        Ok(r) => classify_osrm_response(r.status, r.body.as_ref(), r.retry_after.as_deref()),
        Err(e) => Err(fail(OsrmFailure::Unavailable, e)),
    }
}

fn total(legs: &[f64]) -> f64 {
    legs.iter().filter(|d| d.is_finite()).sum()
}

/// Route one chunk with continue_straight, once without and once with the bus's direction at each stop (`bearings`:
/// a stop next to a side street or the opposite carriageway snaps to the bus's road), plain only when neither is
/// plausible. The answer with the fewest implausible legs wins, then the shortest counting each stop's way to its
/// snap: a stop on a bend that the directions push 60 m along the road must not buy a shorter route (Janowice
/// Lesniczowka).
pub async fn route_chunk(
    base: &str,
    pts: &[LatLng],
    t: &(impl OsrmTransport + Sync),
    bearings: Option<&[Option<i32>]>,
) -> OsrmOutcome {
    let mut tries: Vec<(bool, Option<&[Option<i32>]>)> = vec![(true, None)];
    if let Some(b) = bearings.filter(|b| b.iter().any(Option::is_some)) {
        tries.push((true, Some(b)));
    }
    tries.push((false, None));
    let mut best: Option<OsrmOutcome> = None;
    let mut best_bad = usize::MAX;
    for (cs, br) in tries {
        if best_bad == 0 && !cs {
            break;
        }
        let r = request_osrm(&osrm_route_url(base, pts, cs, br), t).await;
        let ok = match r {
            Err(ref f) if f.kind != OsrmFailure::Unroutable => return r,
            Err(_) => {
                best.get_or_insert(r);
                continue;
            }
            Ok(ref ok) => ok,
        };
        let bad = implausible_legs(&ok.legs, pts).len();
        let better = match &best {
            Some(Ok(b)) => {
                bad < best_bad || (bad == best_bad && total(&ok.legs) + ok.snap_m < total(&b.legs) + b.snap_m)
            }
            _ => true,
        };
        if better {
            best = Some(r);
            best_bad = bad;
        }
    }
    best.expect("at least one try")
}

#[derive(Debug, Clone, PartialEq)]
pub struct RouteOk {
    pub pts: Vec<LatLng>,
    pub straight_legs: usize,
    pub total_legs: usize,
}

/// Road geometry through all waypoints. Hard failures abort the whole build (nothing is committed; the kind is never
/// Unroutable). A chunk that is unroutable or has an absurd leg is routed pair by pair, so one bad stop costs one
/// straight leg, not eleven.
pub async fn route_waypoints(base: &str, wps: &[LatLng], t: &(impl OsrmTransport + Sync)) -> Result<RouteOk, Failure> {
    let mut parts: Vec<Vec<LatLng>> = Vec::new();
    let mut straight_legs = 0;
    let bearings = waypoint_bearings(wps);
    let mut start = 0;
    for chunk in chunk_waypoints(wps, OSRM_CHUNK) {
        let br = &bearings[start..start + chunk.len()];
        start += chunk.len() - 1;
        let r = route_chunk(base, &chunk, t, Some(br)).await;
        match r {
            Err(f) if f.kind != OsrmFailure::Unroutable => return Err(f),
            Ok(ok) if absurd_legs(&ok.legs, &chunk).is_empty() => {
                parts.push(ok.pts);
                continue;
            }
            _ => {}
        }
        if chunk.len() == 2 {
            parts.push(chunk);
            straight_legs += 1;
            continue;
        }
        for i in 0..chunk.len() - 1 {
            let pair = vec![chunk[i], chunk[i + 1]];
            match route_chunk(base, &pair, t, Some(&[br[i], br[i + 1]][..])).await {
                Err(f) if f.kind != OsrmFailure::Unroutable => return Err(f),
                Ok(ok) if absurd_legs(&ok.legs, &pair).is_empty() => parts.push(ok.pts),
                _ => {
                    parts.push(pair);
                    straight_legs += 1;
                }
            }
        }
    }
    Ok(RouteOk {
        pts: merge_chunk_geometries(&parts),
        straight_legs,
        total_legs: wps.len().saturating_sub(1),
    })
}

/* ---------------------------------------------------------------- map matching */

/// Max trace points per /match request on the public demo (12 answers TooBig); OSRM's own default is 100.
pub const MATCH_CHUNK_PUBLIC: usize = 10;
pub const MATCH_CHUNK: usize = 100;
/// How far OSRM may move a trace point onto a road.
const MATCH_RADIUS_M: u32 = 25;
/// A matched chunk straying further than this from its trace took another road.
const MATCH_DEV_M: f64 = 60.0;

/// The /match service of a /route base URL; None when the base is not a /route/v1/ one.
pub fn osrm_match_base(route_base: &str) -> Option<String> {
    route_base
        .contains("/route/v1/")
        .then(|| route_base.replacen("/route/v1/", "/match/v1/", 1))
}

pub fn osrm_match_url(base: &str, pts: &[LatLng]) -> String {
    let radiuses = vec![MATCH_RADIUS_M.to_string(); pts.len()].join(";");
    format!(
        "{}/{}?overview=full&geometries=polyline6&steps=false&gaps=ignore&tidy=false&radiuses={radiuses}",
        base.trim_end_matches('/'),
        coords(pts)
    )
}

fn path_m(pts: &[LatLng]) -> f64 {
    pts.windows(2)
        .map(|w| seg_meters(w[0][0], w[0][1], w[1][0], w[1][1]))
        .sum()
}

/// A match that follows its trace: within MATCH_DEV_M of it everywhere and not much longer (no loop around a block).
pub fn plausible_match(matched: &[LatLng], trace: &[LatLng]) -> bool {
    let Some(pl) = prepare_polyline(trace) else {
        return false;
    };
    if matched.len() < 2 || path_m(matched) > 1.3 * pl.length + 50.0 {
        return false;
    }
    matched.iter().all(|p| {
        project_on_polyline(&pl, p[0], p[1], 0.0, f64::INFINITY, None, 15.0).map_or(f64::INFINITY, |x| x.d)
            <= MATCH_DEV_M
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkMatch {
    pub pts: Vec<LatLng>,
    /// OSRM's answer was no use: the chunk keeps its own points
    pub kept: bool,
}

/// Snap one chunk of a trace (at most MATCH_CHUNK / MATCH_CHUNK_PUBLIC points, see chunk_waypoints) to the roads. A
/// chunk OSRM can't match as one piece, or matches implausibly (Siemianowice, line 27: one chunk came back 2.1 km
/// long for a 557 m trace), keeps its own points. Err is a hard failure, never Unroutable.
pub async fn match_chunk(base: &str, chunk: &[LatLng], t: &(impl OsrmTransport + Sync)) -> Result<ChunkMatch, Failure> {
    match request_osrm(&osrm_match_url(base, chunk), t).await {
        Err(f) if f.kind != OsrmFailure::Unroutable => Err(f),
        // one matching over every point: a split or a dropped point leaves a piece of the trace unmatched
        Ok(r) if r.legs.len() + 1 == chunk.len() && plausible_match(&r.pts, chunk) => Ok(ChunkMatch {
            pts: r.pts,
            kept: false,
        }),
        _ => Ok(ChunkMatch {
            pts: chunk.to_vec(),
            kept: true,
        }),
    }
}
