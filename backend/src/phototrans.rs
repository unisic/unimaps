//! lib/phototrans.ts, the lookup half: vehicle data and photos from phototrans.eu for the GZM and MZK fleet cards.
//! phototrans' Cloudflare refuses datacenter IPs, so the server never contacts it: `npm run build:phototrans` crawls
//! the fleets from a home connection into lib/phototrans.json, compiled in here. The page parsers stay with that
//! offline script.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::shared::fleet::{FleetFuelType, FleetLengthCategory, VehiclePhoto, VehicleTech};

pub const PT_BASE: &str = "https://phototrans.eu/";

/// One phototrans vehicle group (a model series of one operator).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PtGroup {
    /// phototrans operator id
    pub op: i64,
    pub model: String,
    pub producer: String,
    pub body: String,
    pub engine: String,
    pub gearbox: String,
    pub doors: String,
    /// "Year Of Get" of the group: the year the operator took it over
    pub since: Option<i64>,
    /// fleet section: "Bus", "Tram" or "Trolleybus"
    pub kind: String,
    pub modules: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PtVehicle {
    /// index into `groups`
    pub g: usize,
    /// phototrans vehicle page id
    pub v: i64,
    /// production year
    pub b: Option<i64>,
    /// newest photos first: (thumbnail path "<dir>/<photo id>", author, date YYYY-MM-DD or "")
    pub p: Vec<(String, String, String)>,
}

#[derive(Debug, Deserialize)]
pub struct PtIndex {
    pub generated: String,
    pub groups: Vec<PtGroup>,
    /// key `<city>:<side number>`: "gzm:108_410", "bb:123" (leading zeros dropped)
    pub vehicles: HashMap<String, PtVehicle>,
}

static INDEX: LazyLock<PtIndex> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../lib/phototrans.json")).expect("lib/phototrans.json"));

/// The index key of a side number, `city` "bb" or "gzm": leading zeros dropped at the start and after each "_"
/// (a lone "0" stays).
pub fn pt_key(city: &str, side: &str) -> String {
    let parts: Vec<&str> = side
        .split('_')
        .map(|seg| {
            let zeros = seg.bytes().take_while(|&b| b == b'0').count();
            let digit_follows = seg.as_bytes().get(zeros).is_some_and(u8::is_ascii_digit);
            &seg[if digit_follows { zeros } else { zeros.saturating_sub(1) }..]
        })
        .collect();
    format!("{city}:{}", parts.join("_"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct PtLookup {
    pub group: &'static PtGroup,
    pub len: Option<FleetLengthCategory>,
    pub fuel: Option<FleetFuelType>,
    pub tech: VehicleTech,
    pub photos: Vec<VehiclePhoto>,
}

/// The index entry of one fleet vehicle (`city` "bb" or "gzm"), None when phototrans has none.
pub fn pt_vehicle(city: &str, side: &str) -> Option<PtLookup> {
    let index: &'static PtIndex = &INDEX;
    let v = index.vehicles.get(&pt_key(city, side))?;
    let group = index.groups.get(v.g)?;
    let some = |s: &String| (!s.is_empty()).then(|| s.clone());
    Some(PtLookup {
        group,
        len: length_of(&group.model, group.modules, &group.kind),
        fuel: fuel_of(&group.model, &group.engine, &group.kind),
        tech: VehicleTech {
            body: some(&group.body),
            engine: some(&group.engine),
            gearbox: some(&group.gearbox),
            doors: some(&group.doors),
            built: v.b,
            since: group.since,
            page: format!("{PT_BASE}15,{},{}.html", v.v, group.op),
        },
        photos: v
            .p
            .iter()
            .map(|(thumb, author, date)| VehiclePhoto {
                thumb: format!("{PT_BASE}images/photos/thumbnail/{thumb}.jpg"),
                page: format!(
                    "{PT_BASE}14,{},0.html",
                    thumb.split_once('/').map_or(thumb.as_str(), |(_, id)| id)
                ),
                author: author.clone(),
                date: some(date),
            })
            .collect(),
    })
}

/// JS regex `[\w.,]` without the u flag.
fn word_dot_comma(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ',')
}

/// The first match of `(?<![\w.,])(\d{1,2}(?:[.,]\d{1,2})?)(?:m|M|LF)?(?![\w.,])`, group 1, with the regex's
/// backtracking order.
fn length_token(model: &str) -> Option<String> {
    let c: Vec<char> = model.chars().collect();
    let digit = |i: usize| c.get(i).is_some_and(char::is_ascii_digit);
    let starts_with = |i: usize, s: &str| s.chars().enumerate().all(|(k, ch)| c.get(i + k) == Some(&ch));
    for i in 0..c.len() {
        if i > 0 && c.get(i - 1).is_some_and(|&p| word_dot_comma(p)) {
            continue;
        }
        for n in [2, 1] {
            if !(i..i + n).all(digit) {
                continue;
            }
            let int_end = i + n;
            let mut ends = Vec::with_capacity(3);
            if matches!(c.get(int_end), Some('.' | ',')) {
                ends.extend(
                    [2, 1]
                        .into_iter()
                        .filter(|&f| (1..=f).all(|k| digit(int_end + k)))
                        .map(|f| int_end + 1 + f),
                );
            }
            ends.push(int_end);
            for end in ends {
                for suffix in ["m", "M", "LF", ""] {
                    if !starts_with(end, suffix) {
                        continue;
                    }
                    let after = end + suffix.chars().count();
                    if !c.get(after).is_some_and(|&ch| word_dot_comma(ch)) {
                        return Some(c[i..end].iter().collect());
                    }
                }
            }
        }
    }
    None
}

/// Length class from the model name and module count.
/// ponytail: reads the first standalone 1-2 digit length in the name ("Urbino 12", "Sancity 9LF"); a name without
/// one stays None. A length field on phototrans would replace this.
pub fn length_of(model: &str, modules: Option<i64>, kind: &str) -> Option<FleetLengthCategory> {
    if kind == "Tram" {
        return None;
    }
    if modules.is_some_and(|m| m >= 2) {
        return Some(FleetLengthCategory::Mega);
    }
    let len = length_token(model).map_or(f64::NAN, |t| crate::js::number(&t.replacen(',', ".", 1)));
    if !(6.0..=25.0).contains(&len) {
        return None;
    }
    Some(if len < 9.5 {
        FleetLengthCategory::Mini
    } else if len < 11.5 {
        FleetLengthCategory::Midi
    } else if len <= 15.0 {
        FleetLengthCategory::Maxi
    } else {
        FleetLengthCategory::Mega
    })
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `/\b<word>\b/i` for an ASCII lowercase `word`: JS without the u flag folds ASCII only, so a lowercased haystack
/// is exact.
fn has_word_ci(lower: &str, word: &str) -> bool {
    let b = lower.as_bytes();
    lower.match_indices(word).any(|(i, _)| {
        let before = i.checked_sub(1).and_then(|j| b.get(j)).is_some_and(|&x| is_word(x));
        let after = b.get(i + word.len()).is_some_and(|&x| is_word(x));
        !before && !after
    })
}

/// `/\be-?[A-Z]/` ("eCitaro", "e-Atak"), case-sensitive.
fn has_e_prefix(model: &str) -> bool {
    let b = model.as_bytes();
    model.match_indices('e').any(|(i, _)| {
        let boundary = !i.checked_sub(1).and_then(|j| b.get(j)).is_some_and(|&x| is_word(x));
        let next = if b.get(i + 1) == Some(&b'-') { i + 2 } else { i + 1 };
        boundary && b.get(next).is_some_and(u8::is_ascii_uppercase)
    })
}

/// Propulsion from the model name and engine (a tram or trolleybus runs on the wire).
pub fn fuel_of(model: &str, engine: &str, kind: &str) -> Option<FleetFuelType> {
    let s = format!("{model} {engine}").to_ascii_lowercase();
    if s.contains("hydrogen") || s.contains("wodor") || has_word_ci(&s, "h2") {
        return Some(FleetFuelType::Hydrogen);
    }
    // "eCitaro", "e-Atak", "Irizar ie bus"
    if kind == "Tram"
        || kind == "Trolleybus"
        || s.contains("electric")
        || s.contains("elektr")
        || has_word_ci(&s, "ie")
        || has_e_prefix(model)
    {
        return Some(FleetFuelType::Electric);
    }
    if s.contains("hybrid") {
        return Some(FleetFuelType::Hybrid);
    }
    if has_word_ci(&s, "cng") || has_word_ci(&s, "lng") {
        return Some(FleetFuelType::Cng);
    }
    (!engine.is_empty()).then_some(FleetFuelType::Diesel)
}
