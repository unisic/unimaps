//! server/api/shapes/route.ts: store shapes (kb:, mzk:) from `bb.shapes()`, zbiorkom shapes from their cities'
//! feeds (a `near` box re-aims their running road matches).

use std::sync::Arc;

use bytes::Bytes;
use hyper::header::{CACHE_CONTROL, HeaderValue};
use hyper::{Response, StatusCode};
use indexmap::IndexMap;
use serde::Serialize;

use super::{ApiRequest, batch_ids, json_cached, zb_live};
use crate::api_helpers::{bad_request, etag_matches, is_valid_shape_id, query_param, zb_enabled};
use crate::gzm::{GzmLive, ZbTransport};
use crate::gzm_feed::{ShapeLookup, ShapePayload};
use crate::http::{Body, full, header_str};
use crate::js;
use crate::poller_singleton::{Bb, BbKinds};
use crate::rate_limit::{allow_request, too_many_requests};
use crate::shared::cities::zb_city_of;
use crate::shared::polyline::LatLonBox;

const MAX_IDS: usize = 50;
const MAX_IDS_PARAM: usize = 1300;
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

#[derive(Serialize)]
struct ShapesBody {
    precision: u8,
    shapes: IndexMap<String, ShapePayload>,
    missing: Vec<String>,
}

/// parseBox: `s,w,n,e` in range with s < n and w < e; None = invalid.
fn parse_box(v: &str) -> Option<LatLonBox> {
    let p: Vec<f64> = v.split(',').map(js::number).collect();
    if v.encode_utf16().count() > 100 || !p.iter().all(|x| x.is_finite()) {
        return None;
    }
    let [s, w, n, e] = p[..] else {
        return None;
    };
    (s < n && w < e && s >= -90.0 && n <= 90.0 && w >= -180.0 && e <= 180.0).then_some(LatLonBox { s, w, n, e })
}

/// A request past the TS checks: zbiorkom ids per city in first-seen order, store ids, the `near` box, and
/// `etag_hit` = a one-id batch whose If-None-Match names it.
struct Batch {
    by_city: IndexMap<&'static str, Vec<String>>,
    store: Vec<String>,
    focus: Option<LatLonBox>,
    etag_hit: bool,
}

/// The rate-limit gate and the TS checks in their order; Err = the 429 / 400.
fn checked(req: &ApiRequest) -> Result<Batch, Response<Body>> {
    if !allow_request(&req.ip(), 1.0) {
        return Err(too_many_requests());
    }
    let param = query_param(&req.query, "ids").unwrap_or_default();
    let focus = match query_param(&req.query, "near") {
        None => None,
        Some(near) => match parse_box(&near) {
            None => return Err(bad_request("Invalid near box")),
            focus => focus,
        },
    };
    if param.is_empty() {
        return Err(bad_request("Missing ?ids= query parameter"));
    }
    if param.encode_utf16().count() > MAX_IDS_PARAM {
        return Err(bad_request("ids parameter too long"));
    }
    let ids = batch_ids(&param);
    if ids.is_empty() {
        return Err(bad_request("ids list cannot be empty"));
    }
    if ids.len() > MAX_IDS {
        return Err(bad_request(&format!("Exceeded maximum of {MAX_IDS} ids")));
    }
    if !ids.iter().all(|id| is_valid_shape_id(id)) {
        return Err(bad_request("Invalid shape id"));
    }
    let etag_hit = match &ids[..] {
        [id] => etag_matches(
            header_str(&req.headers, "if-none-match").as_deref(),
            &format!("\"{id}\""),
        ),
        _ => false,
    };
    let mut by_city: IndexMap<&'static str, Vec<String>> = IndexMap::new();
    let mut store = Vec::new();
    for id in ids {
        match zb_city_of(&id) {
            Some(slug) => by_city.entry(slug).or_default().push(id),
            None => store.push(id),
        }
    }
    Ok(Batch {
        by_city,
        store,
        focus,
        etag_hit,
    })
}

/// GET /api/shapes?ids=<any batch>[&near=s,w,n,e]: store ids from `bb.shapes()` (read-only, never routes or
/// fetches), then each zbiorkom city's feed shapes.
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
    let b = match checked(req) {
        Ok(b) => b,
        Err(res) => return res,
    };
    let mut out = ShapeLookup {
        exact: true,
        ..ShapeLookup::default()
    };
    if !b.store.is_empty() {
        // lazy start like every other route (`void startPoller().catch(() => {})`); its call loads the store, the
        // lookup never waits on upstream
        let start = bb.start_poller();
        tokio::spawn(async move {
            let _ = start.await;
        });
        out = bb.shapes().lookup(&b.store);
    }
    let zb = zb_shapes(&b.by_city, b.focus, live);
    out.shapes.extend(zb.shapes);
    out.missing.extend(zb.missing);
    answer(out.shapes, out.missing, out.exact && zb.exact, b.etag_hit)
}

/// The TS loop over `byCity`: each enabled city's feed shapes (a disabled city's ids are missing, never exact).
fn zb_shapes<T: ZbTransport>(
    by_city: &IndexMap<&'static str, Vec<String>>,
    focus: Option<LatLonBox>,
    live: impl Fn(&'static str) -> Arc<GzmLive<T>>,
) -> ShapeLookup {
    let mut out = ShapeLookup {
        exact: true,
        ..ShapeLookup::default()
    };
    for (&slug, ids) in by_city {
        if !zb_enabled(slug) {
            out.missing.extend(ids.iter().cloned());
            out.exact = false;
            continue;
        }
        let city = live(slug);
        if let Some(focus) = focus {
            city.focus_match(ids, focus);
        }
        let r = city.shapes(ids);
        out.shapes.extend(r.shapes);
        out.missing.extend(r.missing);
        out.exact &= r.exact;
    }
    out
}

/// The TS answer: immutable when every id is an exact hit (then a one-id `etag_hit` is a bodiless 304), else
/// short-lived.
fn answer(shapes: IndexMap<String, ShapePayload>, missing: Vec<String>, exact: bool, etag_hit: bool) -> Response<Body> {
    let cache = if exact { IMMUTABLE } else { "public, max-age=30" };
    if exact && etag_hit {
        let mut res = Response::new(full(Bytes::new()));
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static(cache));
        return res;
    }
    json_cached(
        &ShapesBody {
            precision: 6,
            shapes,
            missing,
        },
        cache,
    )
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;

    use super::*;
    use crate::js::JsNum;
    use crate::shape_store::ShapeSrc;

    fn zb(exact: bool) -> ShapeLookup {
        let mut shapes = IndexMap::new();
        let payload = ShapePayload {
            id: "gzm:s1.abcdef".into(),
            src: ShapeSrc::Gtfs,
            poly: "_p~iF".into(),
            len: JsNum(120.0),
            stops: vec![Some(JsNum(0.0)), None],
        };
        shapes.insert(payload.id.clone(), payload);
        ShapeLookup {
            shapes,
            missing: vec!["gzm:nope".into()],
            exact,
        }
    }

    const ZB: &str = r#""gzm:s1.abcdef":{"id":"gzm:s1.abcdef","src":"gtfs","poly":"_p~iF","len":120,"stops":[0,null]}"#;

    async fn parts(res: Response<Body>) -> (StatusCode, String, String) {
        let cc = res
            .headers()
            .get(CACHE_CONTROL)
            .map_or("", |v| v.to_str().unwrap())
            .to_owned();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, cc, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn answer_follows_the_ts_route() {
        let r = parts(answer(zb(true).shapes, zb(true).missing, true, false)).await;
        assert_eq!((r.0, r.1.as_str()), (StatusCode::OK, IMMUTABLE));
        assert_eq!(
            r.2,
            format!(r#"{{"precision":6,"shapes":{{{ZB}}},"missing":["gzm:nope"]}}"#)
        );

        let r = parts(answer(zb(true).shapes, zb(true).missing, true, true)).await;
        assert_eq!(
            (r.0, r.1.as_str(), r.2.as_str()),
            (StatusCode::NOT_MODIFIED, IMMUTABLE, "")
        );
        let r = parts(answer(zb(false).shapes, zb(false).missing, false, true)).await;
        assert_eq!((r.0, r.1.as_str()), (StatusCode::OK, "public, max-age=30"));
    }

    #[test]
    fn near_box() {
        assert_eq!(
            parse_box("50.1, 18.9,50.3,19.2"),
            Some(LatLonBox {
                s: 50.1,
                w: 18.9,
                n: 50.3,
                e: 19.2
            })
        );
        for bad in [
            "50.3,18.9,50.1,19.2",
            "50.1,18.9,50.3",
            "50.1,18.9,50.3,19.2,1",
            "a,18.9,50.3,19.2",
            "-91,0,1,1",
        ] {
            assert_eq!(parse_box(bad), None, "{bad}");
        }
    }
}
