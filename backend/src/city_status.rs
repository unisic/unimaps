//! lib/city-status.ts, /status: is each city's live data flowing right now. Bielsko-Biała from the in-process
//! pollers, every zbiorkom city from one positions request of its own (whether or not the city is resident here: a
//! resident city's state is in /api/health), GZM also from SDIP, the operator's own map, so an outage upstream of
//! both shows as such. One sweep serves every viewer for STATUS_TTL_MS and a sweep in flight is shared: at most ~55
//! requests per 2 min (~600 KB gzip, ~5 MB of JSON parsed 8 at a time), and none while nobody opens the page.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Semaphore, watch};

use crate::config;
use crate::gzm::{HttpZb, POLAND, ZbTransport, parse_sdip, parse_zbiorkom, sdip_list_text, sdip_session};
use crate::js::{self, encode_uri_component, number_to_string};
use crate::kb_api::join_all;
use crate::poller_singleton::{Bb, BbKinds};
use crate::shared::cities::ZB_CITIES;

/// ok = positions coming in, empty = upstream answers with no vehicle (normal at night), down = no valid answer
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceState {
    Ok,
    Empty,
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SourceStatus {
    pub name: &'static str,
    pub state: SourceState,
    pub vehicles: usize,
    /// seconds since the newest position (zbiorkom) or the last good poll (BB); None = not known
    pub age: Option<i64>,
    /// why it is down: "HTTP <code>", "timeout", "network error", "invalid response" or "no good poll"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CityStatus {
    /// "bb" or a zbiorkom slug
    pub city: String,
    pub name: String,
    pub sources: Vec<SourceStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StatusBody {
    /// epoch seconds of the sweep
    pub checked_at: i64,
    pub cities: Vec<CityStatus>,
}

const STATUS_TTL_MS: i64 = 120_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
// ponytail: 8 at a time keeps a full zbiorkom outage (every probe timing out) under ~45 s
const PROBE_CONCURRENCY: usize = 8;
const MAX_BODY: usize = 16 * 1024 * 1024;

/// The TS `reason` over a `String(err)`-style error: a timeout, the first `/HTTP \d{3}/`, a fetch TypeError (DNS,
/// refused or reset connection), else an answer that did not parse.
fn reason(err: &str) -> String {
    if err.starts_with("TimeoutError") {
        return "timeout".into();
    }
    let http = err.match_indices("HTTP ").find_map(|(i, m)| {
        let code = err.get(i + m.len()..i + m.len() + 3)?;
        code.bytes().all(|b| b.is_ascii_digit()).then(|| format!("HTTP {code}"))
    });
    if let Some(http) = http {
        return http;
    }
    if err.starts_with("TypeError") {
        "network error"
    } else {
        "invalid response"
    }
    .into()
}

fn down(name: &'static str, err: &str) -> SourceStatus {
    SourceStatus {
        name,
        state: SourceState::Down,
        vehicles: 0,
        age: None,
        error: Some(reason(err)),
    }
}

fn parse_json(text: &str) -> Result<Value, String> {
    crate::js::json_parse(text).map_err(|e| format!("SyntaxError: {e}"))
}

/// `probeZb`: one zbiorkom positions request over all of Poland (the slug alone scopes the answer).
pub async fn probe_zb<Z: ZbTransport + Sync>(slug: &str, t: &Z, now_ms: i64) -> SourceStatus {
    let url = format!(
        "{}/{}/positions/{},{},{},{}",
        *config::ZB_API_URL,
        encode_uri_component(slug),
        number_to_string(POLAND.lon_min),
        number_to_string(POLAND.lat_min),
        number_to_string(POLAND.lon_max),
        number_to_string(POLAND.lat_max)
    );
    let headers = [
        ("User-Agent", config::USER_AGENT.as_str()),
        ("Accept", "application/json"),
    ];
    let recs = async {
        let res = t.get(&url, &headers, PROBE_TIMEOUT, MAX_BODY).await?;
        if !res.ok() {
            return Err(format!("HTTP {}", res.status));
        }
        parse_zbiorkom(&parse_json(&res.body)?, now_ms, &POLAND, slug != "gzm")
    };
    match recs.await {
        Ok(recs) => {
            let newest = recs.iter().fold(0.0, |m: f64, r| m.max(r.ts));
            let n = recs.len();
            SourceStatus {
                name: "zbiorkom",
                state: if n > 0 { SourceState::Ok } else { SourceState::Empty },
                vehicles: n,
                age: (n > 0).then(|| js::round((now_ms as f64 - newest) / 1000.0).max(0.0) as i64),
                error: None,
            }
        }
        Err(e) => down("zbiorkom", &e),
    }
}

/// `probeSdip`: SDIP's vehicle count, a fresh session, then the list.
pub async fn probe_sdip<Z: ZbTransport + Sync>(t: &Z, url: &str) -> SourceStatus {
    let n = async {
        let cookie = sdip_session(t, url).await?;
        Ok::<_, String>(parse_sdip(&parse_json(&sdip_list_text(t, url, &cookie).await?)?)?.len())
    };
    match n.await {
        Ok(n) => SourceStatus {
            name: "SDIP",
            state: if n > 0 { SourceState::Ok } else { SourceState::Empty },
            vehicles: n,
            age: None,
            error: None,
        },
        Err(e) => down("SDIP", &e),
    }
}

fn poller_source(name: &'static str, vehicles: usize, last_good: f64, now_s: f64) -> SourceStatus {
    let age = js::round(now_s - last_good).max(0.0) as i64;
    // the /api/health rule: no good upstream poll for this long = the feed is gone, whatever the map still shows
    let (state, error) = if age > *config::HEALTH_STALE_SEC {
        (SourceState::Down, Some("no good poll".into()))
    } else if vehicles > 0 {
        (SourceState::Ok, None)
    } else {
        (SourceState::Empty, None)
    };
    SourceStatus {
        name,
        state,
        vehicles,
        age: Some(age),
        error,
    }
}

fn bb_sources<T: BbKinds>(bb: &Bb<T>) -> Vec<SourceStatus> {
    let list = bb.combined_vehicles(None);
    let count = |op: &str| {
        list.vehicles
            .iter()
            .filter(|v| v.get("operator").and_then(Value::as_str) == Some(op))
            .count()
    };
    let now_s = bb.now_ms() as f64 / 1000.0;
    let kb_good = bb.poller().state().last_good_refresh;
    let mzk_good = bb.mzk_poller().state().last_good_refresh;
    vec![
        poller_source("KB", count("KB"), kb_good, now_s),
        poller_source("MZK", count("MZK"), mzk_good, now_s),
    ]
}

async fn sweep<T: BbKinds, Z: ZbTransport + Sync>(bb: &Bb<T>, t: &Z, now_ms: i64) -> StatusBody {
    let limit = Semaphore::new(PROBE_CONCURRENCY);
    let on: Vec<_> = ZB_CITIES
        .iter()
        .filter(|(s, _)| {
            if s == "gzm" {
                *config::GZM_ENABLED
            } else {
                *config::ZB_ENABLED
            }
        })
        .collect();
    // polled first, so it takes the first slot as the TS limit() call order does
    let sdip = async {
        if !(*config::GZM_ENABLED && *config::GZM_SDIP_ENABLED) {
            return None;
        }
        let _slot = limit.acquire().await;
        Some(probe_sdip(t, &config::GZM_SDIP_URL).await)
    };
    let zb = join_all(on.iter().map(|(s, _)| async {
        let _slot = limit.acquire().await;
        probe_zb(s, t, now_ms).await
    }));
    let (sdip, zb) = tokio::join!(sdip, zb);
    let mut cities = vec![CityStatus {
        city: "bb".into(),
        name: "Bielsko-Biała".into(),
        sources: bb_sources(bb),
    }];
    for ((slug, city), z) in on.into_iter().zip(zb) {
        let mut sources = vec![z];
        if slug == "gzm"
            && let Some(s) = &sdip
        {
            sources.push(s.clone());
        }
        cities.push(CityStatus {
            city: slug.clone(),
            name: city.name.clone(),
            sources,
        });
    }
    StatusBody {
        checked_at: js::round(now_ms as f64 / 1000.0) as i64,
        cities,
    }
}

type Body = watch::Receiver<Option<Arc<StatusBody>>>;

struct Memo {
    at: i64,
    body: Body,
}

static MEMO: Mutex<Option<Memo>> = Mutex::new(None);

/// `cityStatus`: the status of every city, swept at most once per STATUS_TTL_MS for everyone (`now_ms` = the TS
/// `Date.now()` default). The sweep runs in its own task, as the memoized TS Promise runs on whoever stops waiting:
/// a viewer leaving mid-sweep neither cancels it nor makes the next one start over. None = the sweep task panicked
/// (the TS rejection, answered by the route's `upstreamError`); the memo is cleared so the next request sweeps again.
pub async fn city_status<T: BbKinds>(bb: &'static Bb<T>, now_ms: i64) -> Option<Arc<StatusBody>> {
    city_status_with(bb, &HttpZb, now_ms).await
}

/// `city_status` over another transport (tests).
pub async fn city_status_with<T: BbKinds, Z: ZbTransport + Sync + 'static>(
    bb: &'static Bb<T>,
    t: &'static Z,
    now_ms: i64,
) -> Option<Arc<StatusBody>> {
    let mut rx = {
        let mut memo = MEMO.lock().unwrap_or_else(PoisonError::into_inner);
        match &*memo {
            Some(m) if now_ms - m.at <= STATUS_TTL_MS => m.body.clone(),
            _ => {
                let (tx, rx) = watch::channel(None);
                *memo = Some(Memo {
                    at: now_ms,
                    body: rx.clone(),
                });
                tokio::spawn(async move {
                    tx.send_replace(Some(Arc::new(sweep(bb, t, now_ms).await)));
                });
                rx
            }
        }
    };
    let body = rx.wait_for(Option::is_some).await.ok().and_then(|v| (*v).clone());
    if body.is_none() {
        let mut memo = MEMO.lock().unwrap_or_else(PoisonError::into_inner);
        if memo.as_ref().is_some_and(|m| m.body.same_channel(&rx)) {
            *memo = None;
        }
    }
    body
}
