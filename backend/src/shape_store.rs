//! Road-shape store, port of `lib/shape-store.ts` in progress: so far the types and the pure `finalizeShape` the
//! GZM feed builder needs. The store itself (persistence, lock, OSRM worker) comes with the BB pollers.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::js;
use crate::shared::polyline::{
    LatLng, Polyline, decode_polyline, encode_polyline, prepare_polyline, project_stops_along,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShapeSrc {
    Osrm,
    Partial,
    Straight,
    Mzk,
    Gtfs,
}

impl ShapeSrc {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Osrm => "osrm",
            Self::Partial => "partial",
            Self::Straight => "straight",
            Self::Mzk => "mzk",
            Self::Gtfs => "gtfs",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShapeGeometry {
    pub pl: Polyline,
    pub stops: Vec<Option<f64>>,
    pub rev: String,
    pub src: ShapeSrc,
}

/// `finalizeShape`'s answer: the wire fields of an entry.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalShape {
    /// encoded polyline, precision 6
    pub poly: String,
    pub len: f64,
    pub stops: Vec<Option<f64>>,
    pub rev: String,
    pub src: ShapeSrc,
}

/// `revOf`: sha1 of `src|poly|len.toFixed(1)|JSON.stringify(stops)`, first 6 hex digits. Part of the wire id, so it
/// must hash the exact bytes the TS wrote (a different rev = every client refetches, every stored id misses).
pub fn rev_of(src: ShapeSrc, poly: &str, len: f64, stops: &[Option<f64>]) -> String {
    // JSON.stringify: a number as String() writes it, a non-finite one as null
    let stops_json = format!(
        "[{}]",
        stops
            .iter()
            .map(|s| s
                .filter(|x| x.is_finite())
                .map_or_else(|| "null".to_owned(), js::number_to_string))
            .collect::<Vec<_>>()
            .join(",")
    );
    // len is already rounded to 0.1, so `{:.1}` and toFixed(1) cannot meet a tie
    let digest = Sha1::digest(format!("{}|{poly}|{len:.1}|{stops_json}", src.as_str()));
    digest[..3].iter().fold(String::with_capacity(6), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// `finalizeShape`: quantize to the wire format, prepare, place the stops.
pub fn finalize_shape(pts: &[LatLng], stop_refs: &[Option<LatLng>], src: ShapeSrc) -> Option<FinalShape> {
    let poly = encode_polyline(pts, 6);
    let pl = prepare_polyline(&decode_polyline(&poly, 6))?;
    let stops: Vec<Option<f64>> = project_stops_along(&pl, stop_refs, 80.0)
        .into_iter()
        .map(|s| s.map(js::round1))
        .collect();
    let len = js::round1(pl.length);
    let rev = rev_of(src, &poly, len, &stops);
    Some(FinalShape {
        poly,
        len,
        stops,
        rev,
        src,
    })
}
