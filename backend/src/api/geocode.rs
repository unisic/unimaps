//! server/api/geocode/route.ts: streets, addresses and places within the city from Photon (KB_GEOCODER_URL), for a
//! connection search from a point. Proxy mode answers the zbiorkom cities (Node the BB one), owned mode every city
//! through the same memo and in-flight counter.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use hyper::{Method, Response};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use super::{ApiRequest, json_cached};
use crate::api_helpers::{City, bad_request, not_found, parse_city, query_param, upstream_error, warming};
use crate::config::{GEOCODER_URL, USER_AGENT};
use crate::gzm::{HttpZb, ZbTransport};
use crate::gzm_feed::get_gzm_feed;
use crate::http::Body;
use crate::js::{self, JsNum};
use crate::rate_limit::{allow_request, too_many_requests};

const MAX_HITS: usize = 6;
/// ~1 KB per answer; a street's coordinates don't change within a day
const MEMO_MAX: usize = 1000;
const MEMO_TTL_MS: i64 = 86_400_000;
/// the public Photon host is fair-use only: past this many requests in flight the rest get 429
const MAX_IN_FLIGHT: usize = 4;
/// per-IP tokens per search: the client sends one per typing pause
const COST: f64 = 5.0;
const TIMEOUT: Duration = Duration::from_secs(5);
/// ponytail: Photon answers limit=10 in ~10 KB; a body past 1 MB is a failed request (the TS reads any size)
const MAX_BODY: usize = 1 << 20;

#[derive(Debug, Clone, Serialize)]
struct GeoHit {
    name: String,
    detail: String,
    lat: JsNum,
    lon: JsNum,
}

type Hits = Arc<Vec<GeoHit>>;

/// `<slug>|<lowercased q>` -> (epoch ms fetched, hits), insertion ordered: the oldest goes first past MEMO_MAX
static MEMO: LazyLock<Mutex<IndexMap<String, (i64, Hits)>>> = LazyLock::new(Mutex::default);
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// One of the MAX_IN_FLIGHT Photon requests, given back on drop.
pub struct Slot;

impl Slot {
    fn take() -> Option<Self> {
        IN_FLIGHT
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_IN_FLIGHT).then_some(n + 1)
            })
            .ok()
            .map(|_| Slot)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

fn memo() -> std::sync::MutexGuard<'static, IndexMap<String, (i64, Hits)>> {
    MEMO.lock().unwrap_or_else(PoisonError::into_inner)
}

/// minLon, minLat, maxLon, maxLat: each city's stops plus the 800 m a search from a point walks; any other zbiorkom
/// city uses its feed's stop extent (None while that feed loads)
fn bbox_of(city: &str) -> Option<[f64; 4]> {
    match city {
        "bb" => return Some([18.8, 49.65, 19.37, 50.06]),
        "gzm" => return Some([18.39, 49.96, 19.49, 50.59]),
        _ => {}
    }
    let a = get_gzm_feed(city)?.area;
    Some([a.lon_min, a.lat_min, a.lon_max, a.lat_max])
}

/// A Photon feature as a hit: "Sportowa" / "Czeladź", "Sportowa 2" / "Czeladź", "Hala MOSIR" / "Sportowa 2,
/// Czeladź". None for one without a name or outside the city.
fn to_hit(f: &Value, [x0, y0, x1, y1]: [f64; 4]) -> Option<GeoHit> {
    let c = f.get("geometry")?.get("coordinates")?.as_array()?;
    let (lon, lat) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
    if !(lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1) {
        return None;
    }
    let p = f.get("properties");
    let s = |k: &str| {
        p.and_then(|p| p.get(k))
            .and_then(Value::as_str)
            .map_or("", |v| v.trim_matches(js::is_space))
    };
    let join = |parts: &[&str], sep: &str| {
        parts
            .iter()
            .filter(|p| !p.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(sep)
    };
    let street = join(&[s("street"), s("housenumber")], " ");
    let name = Some(s("name"))
        .filter(|n| !n.is_empty())
        .map_or_else(|| street.clone(), str::to_owned);
    if name.is_empty() {
        return None;
    }
    let place = [s("city"), s("locality"), s("county")]
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or("");
    let detail = join(&[if name != street { street.as_str() } else { "" }, place], ", ");
    Some(GeoHit {
        name,
        detail,
        lat: JsNum(lat),
        lon: JsNum(lon),
    })
}

fn answer(hits: &[GeoHit]) -> Response<Body> {
    #[derive(Serialize)]
    struct Results<'a> {
        results: &'a [GeoHit],
    }
    json_cached(&Results { results: hits }, "public, max-age=3600")
}

/// `?q=` with its whitespace runs collapsed, None unless 3 to 80 UTF-16 units long.
fn search_text(query: &str) -> Option<String> {
    let q = query_param(query, "q").unwrap_or_default();
    let q = q
        .split(js::is_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (3..=80).contains(&q.encode_utf16().count()).then_some(q)
}

/// A BB geocode that Node may send to Photon holds a slot until Node's answer arrives (Node has made its Photon
/// request by then: the TS answer is one Response.json): the TS counter covered every city of one process, Node's
/// now counts only BB. Err = the 429 the TS gives past MAX_IN_FLIGHT.
/// ponytail: Node's memo is out of sight here, so while MAX_IN_FLIGHT geocodes are out a BB search Node would answer
/// from it gets 429 too, and a refused one costs no per-IP tokens in Node; gone when stage 4 removes Node.
pub fn node_slot(method: &Method, path: &str, query: &str) -> Result<Option<Slot>, Response<Body>> {
    let photon = (method == Method::GET || method == Method::HEAD)
        && path == "/api/geocode"
        && GEOCODER_URL.is_some()
        && matches!(parse_city(query), Ok(City::Bb))
        && search_text(query).is_some();
    if !photon {
        return Ok(None);
    }
    Slot::take().map(Some).ok_or_else(too_many_requests)
}

/// GET /api/geocode?q=<address or place>&city=<zbiorkom slug>; None = a BB request (Node answers it).
pub async fn get(req: &ApiRequest) -> Option<Response<Body>> {
    handle(req, &HttpZb).await
}

/// The route with Photon behind `photon` (HttpZb, or a stub in a test); None = a BB request.
pub async fn handle<T: ZbTransport>(req: &ApiRequest, photon: &T) -> Option<Response<Body>> {
    Some(match req.zb_city() {
        Err(None) => return None,
        Ok(slug) => search(req, photon, Ok(slug)).await,
        Err(Some(res)) => search(req, photon, Err(res)).await,
    })
}

/// Owned mode: GET /api/geocode?q=<address or place>[&city=<slug>] of every city, BB included.
pub async fn get_owned(req: &ApiRequest) -> Response<Body> {
    handle_owned(req, &HttpZb).await
}

/// `get_owned` with Photon behind `photon`.
pub async fn handle_owned<T: ZbTransport>(req: &ApiRequest, photon: &T) -> Response<Body> {
    let city = match parse_city(&req.query) {
        Ok(City::Bb) => Ok("bb"),
        Ok(City::Zb(slug)) => Ok(slug),
        Err(res) => Err(res),
    };
    search(req, photon, city).await
}

/// The TS GET from its rate-limit gate on, `city` = parseCity's answer ("bb" or a zbiorkom slug, Err = its 400 /
/// 404, which the TS returns after the gate).
async fn search<T: ZbTransport>(req: &ApiRequest, photon: &T, city: Result<&str, Response<Body>>) -> Response<Body> {
    if !allow_request(&req.ip(), COST) {
        return too_many_requests();
    }
    let slug = match city {
        Ok(slug) => slug,
        Err(res) => return res,
    };
    let Some(base) = GEOCODER_URL.as_deref() else {
        return not_found("Not found");
    };
    let Some(q) = search_text(&req.query) else {
        return bad_request("Invalid 'q' parameter (3 to 80 characters)");
    };

    let key = format!("{slug}|{}", q.to_lowercase());
    let now = jiff::Timestamp::now().as_millisecond();
    let cached = memo().get(&key).cloned();
    if let Some((at, hits)) = cached
        && now - at < MEMO_TTL_MS
    {
        return answer(&hits);
    }
    let Some(_slot) = Slot::take() else {
        return too_many_requests();
    };
    let Some(bbox) = bbox_of(slug) else {
        return warming();
    };
    let bbox_param = bbox.map(js::number_to_string).join(",");
    let params = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", &q)
        .append_pair("limit", "10")
        .append_pair("lang", "default")
        .append_pair("bbox", &bbox_param)
        .finish();
    let res = match photon
        .get(
            &format!("{base}?{params}"),
            &[("User-Agent", USER_AGENT.as_str())],
            TIMEOUT,
            MAX_BODY,
        )
        .await
    {
        Ok(r) if r.ok() => r,
        Ok(r) => return upstream_error("geocode", format_args!("HTTP {}", r.status)),
        Err(err) => return upstream_error("geocode", err),
    };
    let body: Value = match crate::js::json_parse(&res.body) {
        Ok(v) => v,
        Err(err) => return upstream_error("geocode", err),
    };

    let mut hits = Vec::new();
    let mut seen = HashSet::new();
    let features = body
        .get("features")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for f in features {
        // Photon lists a street once per OSM way: one hit per name and place
        let Some(h) = to_hit(f, bbox) else { continue };
        if !seen.insert(format!("{}|{}", h.name, h.detail)) {
            continue;
        }
        hits.push(h);
        if hits.len() == MAX_HITS {
            break;
        }
    }
    let hits = Arc::new(hits);
    {
        let mut m = memo();
        m.shift_remove(&key);
        m.insert(key, (now, hits.clone()));
        if m.len() > MEMO_MAX {
            m.shift_remove_index(0);
        }
    }
    answer(&hits)
}
