//! server/api/trips/route.ts: zbiorkom ids from their cities' feeds, KB ids from `bb.api()`, MZK ids from
//! mzk_trip, in one batch.

use std::sync::Arc;

use hyper::Response;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use super::trip::{mzk_trip_body, spread};
use super::{ApiRequest, batch_ids, json_cached, zb_live};
use crate::api_helpers::{bad_request, is_valid_id, query_param, upstream_error, zb_enabled};
use crate::gzm::{GzmLive, Lookup, ZbTransport};
use crate::http::Body;
use crate::js;
use crate::kb_api::{KbSource, join_all};
use crate::mzk_trip::resolve_mzk_trip;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shape_store::ShapePrio;
use crate::shared::cities::zb_city_of;

const MAX_BATCH_IDS: usize = 300;

/// The zbiorkom half of a batch: trips found in the feeds; `loading` = a city's feed is still parsing (its ids are
/// absent and the answer is not cached).
#[derive(Debug, Default)]
struct ZbTrips {
    trips: IndexMap<String, Value>,
    loading: bool,
}

#[derive(Serialize)]
struct TripsBody {
    count: usize,
    trips: IndexMap<String, Value>,
}

/// The batch's ids after the TS checks (present, non-empty, at most 300, each `is_valid_id`); Err = the 400.
fn checked_ids(req: &ApiRequest) -> Result<Vec<String>, Response<Body>> {
    let param = query_param(&req.query, "ids").unwrap_or_default();
    if param.is_empty() {
        return Err(bad_request("Missing ?ids= query parameter"));
    }
    let ids = batch_ids(&param);
    if ids.is_empty() {
        return Err(bad_request("ids list cannot be empty"));
    }
    if ids.len() > MAX_BATCH_IDS {
        return Err(bad_request(&format!("Exceeded maximum of {MAX_BATCH_IDS} ids")));
    }
    if let Some(bad) = ids.iter().find(|id| !is_valid_id(id)) {
        return Err(bad_request(&format!("Invalid trip id: {bad}")));
    }
    Ok(ids)
}

/// GET /api/trips?ids=<any batch>: zbiorkom ids from their cities' feeds, KB ids from `bb.api()` (cached shared
/// objects spread, never mutated, with a background road-shape ref), MZK ids from mzk_trip.
pub async fn get_owned<T: BbKinds>(req: &ApiRequest, bb: &'static Bb<T>) -> Response<Body> {
    handle(req, bb, zb_live).await
}

/// The route with each city's live layer from `live` (the started registry entry in `get_owned`, a rigged one in a
/// test).
pub async fn handle<T: BbKinds, Z: ZbTransport>(
    req: &ApiRequest,
    bb: &'static Bb<T>,
    live: impl Fn(&'static str) -> Arc<GzmLive<Z>>,
) -> Response<Body> {
    let ids = match checked_ids(req) {
        Ok(ids) => ids,
        Err(res) => return res,
    };
    let api = bb.api();
    let (zb_ids, rest): (Vec<String>, Vec<String>) = ids.iter().cloned().partition(|id| zb_city_of(id).is_some());
    let (mzk_ids, kb_ids): (Vec<String>, Vec<String>) = rest.into_iter().partition(|id| id.starts_with("mzk:"));
    // one token per id that costs an upstream fetch (MZK ids always do), so a batch is not a 300x amplifier
    let cost = (mzk_ids.len() + kb_ids.iter().filter(|id| !api.has_cached_trip(id, 0)).count()).max(1);
    if !allow_request(&req.ip(), cost as f64) {
        return too_many_requests();
    }
    // a zbiorkom-only batch needs neither BB poller
    if !(kb_ids.is_empty() && mzk_ids.is_empty())
        && let Err(err) = bb.start_poller().await
    {
        return upstream_error("trips", err);
    }
    let zb = zb_trips(&zb_ids, live);
    let mut trips = zb.trips;
    let mut failed = 0;
    if !kb_ids.is_empty() {
        let kb = api.fetch_trips_batch(&kb_ids, 0).await;
        failed += kb.failed;
        for (id, t) in kb.trips {
            let t = if t.is_object() || t.is_array() {
                let mut o = spread(Some(&t));
                o.extend(bb.kb_shape_ref(&t, ShapePrio::Background));
                Value::Object(o)
            } else {
                Value::clone(&t)
            };
            trips.insert(id, t);
        }
    }
    if !mzk_ids.is_empty() {
        let res = join_all(mzk_ids.iter().map(|id| resolve_mzk_trip(bb, id, false))).await;
        for (id, r) in mzk_ids.into_iter().zip(res) {
            match r {
                Ok(Some(m)) if js::truthy(m.get("trip")) => {
                    trips.insert(id, Value::Object(mzk_trip_body(&m)));
                }
                Ok(_) => {}
                Err(_) => failed += 1,
            }
        }
    }
    // a failed fetch is not "no such trip": never cache it, and with nothing resolved let the client fall back
    if failed == ids.len() {
        return upstream_error("trips", format_args!("all {failed} trip fetches failed"));
    }
    let pending = trips.values().any(is_pending);
    answer(trips, failed > 0 || zb.loading, pending)
}

fn is_pending(t: &Value) -> bool {
    t.get("shape_status").and_then(Value::as_str) == Some("pending")
}

/// The TS answer: keys in `Object.keys` order (index-like ids ascending first), `no_store` = a fetch failed or a
/// feed is loading, `pending` = a road shape is still being built.
fn answer(mut trips: IndexMap<String, Value>, no_store: bool, pending: bool) -> Response<Body> {
    js::sort_object_keys(&mut trips);
    let cache = match (no_store, pending) {
        (true, _) => "no-store",
        (false, true) => "public, max-age=300",
        (false, false) => "public, max-age=3600",
    };
    json_cached(
        &TripsBody {
            count: trips.len(),
            trips,
        },
        cache,
    )
}

/// Each zbiorkom id's static trip, the TS loop over `zbIds` (a disabled city's ids are skipped).
fn zb_trips<T: ZbTransport>(ids: &[String], live: impl Fn(&'static str) -> Arc<GzmLive<T>>) -> ZbTrips {
    let mut out = ZbTrips::default();
    for id in ids {
        let Some(slug) = zb_city_of(id).filter(|s| zb_enabled(s)) else {
            continue;
        };
        match live(slug).trip(id, false) {
            Lookup::Loading => out.loading = true,
            Lookup::Unknown => {}
            Lookup::Found(t) => {
                out.trips.insert(id.clone(), t);
            }
        }
    }
    out
}
