//! lib/mzk-fleet.ts: the MZK Bielsko-Biała fleet table (lib/mzk-fleet.json, shared with the TS) and the model
//! matcher that mixes it with OnTime's per-vehicle flags from getVehicles.json, an unvalidated upstream record.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js::{parse_int, truthy};

#[derive(Deserialize)]
#[serde(untagged)]
enum Side {
    One(i64),
    /// inclusive
    Range([i64; 2]),
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Defaults {
    air_condition: Option<bool>,
    low_floor: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelDef {
    model: String,
    producer: String,
    year: String,
    length_category: String,
    fuel_type: String,
    numbers: Vec<Side>,
    #[serde(default)]
    default_features: Defaults,
}

impl ModelDef {
    fn sides(&self) -> impl Iterator<Item = i64> + '_ {
        self.numbers.iter().flat_map(|n| match *n {
            Side::One(a) => a..=a,
            Side::Range([a, b]) => a..=b,
        })
    }
}

static DEFS: LazyLock<Vec<ModelDef>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../lib/mzk-fleet.json")).expect("lib/mzk-fleet.json"));

/// side number -> its model; a number listed twice belongs to the later model, like the TS Map
static BY_NUMBER: LazyLock<HashMap<i64, &'static ModelDef>> =
    LazyLock::new(|| DEFS.iter().flat_map(|d| d.sides().map(move |n| (n, d))).collect());

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleFeatures {
    pub air_condition: bool,
    pub low_floor: bool,
    pub electric: bool,
    pub hydrogen: bool,
    pub hybrid: bool,
    pub long_vehicle: bool,
    /// absent in the table-only summaries of `all_fleet_vehicles`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket_machine: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eco_vehicle: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleFleetInfo {
    pub side_number: String,
    pub model: String,
    pub producer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    pub length_category: String,
    pub fuel_type: String,
    pub features: VehicleFeatures,
}

/// `getFleetDetails`: the table's model for `side_number` with OnTime's record (`static_info`) overriding the
/// flags it carries; an unknown number gets a generic MZK entry.
pub fn fleet_details(side_number: &str, static_info: Option<&Value>) -> VehicleFleetInfo {
    let num = parse_int(side_number);
    let def = num.is_finite().then(|| BY_NUMBER.get(&(num as i64)).copied()).flatten();
    let flag = |k: &str| static_info.and_then(|s| s.get(k));
    // `staticInfo?.k ?? fallback`
    let given = |k: &str| flag(k).filter(|v| !v.is_null());
    let fuel = def.map(|d| d.fuel_type.as_str());

    let ticket_machine =
        truthy(flag("ticketmachineCard")) || truthy(flag("ticketmachineCash")) || truthy(flag("ticketmachineCashCard"));
    let electric = truthy(flag("electric")) || fuel == Some("electric");
    let hydrogen = fuel == Some("hydrogen");
    let hybrid = truthy(flag("hybrid")) || fuel == Some("hybrid");
    let fuel_type = if hydrogen {
        "hydrogen"
    } else if electric {
        "electric"
    } else if hybrid {
        "hybrid"
    } else {
        fuel.unwrap_or("diesel")
    };
    let long_vehicle = match given("longVehicle") {
        Some(v) => truthy(Some(v)),
        None => def.is_some_and(|d| d.length_category == "MEGA"),
    };
    let defaults = def.map(|d| &d.default_features);
    let air_condition = match given("airCondition") {
        Some(v) => truthy(Some(v)),
        None => defaults.and_then(|f| f.air_condition).unwrap_or(false),
    };
    let low_floor = match given("lowFloor") {
        Some(v) => truthy(Some(v)),
        None => defaults.and_then(|f| f.low_floor).unwrap_or(true),
    };

    VehicleFleetInfo {
        side_number: side_number.into(),
        model: def.map_or_else(|| format!("MZK Bielsko-Biała #{side_number}"), |d| d.model.clone()),
        producer: def.map_or("MZK", |d| &d.producer).into(),
        year: def.map(|d| d.year.clone()),
        length_category: match def {
            Some(d) => d.length_category.clone(),
            None if long_vehicle => "MEGA".into(),
            None => "MAXI".into(),
        },
        fuel_type: fuel_type.into(),
        features: VehicleFeatures {
            air_condition,
            low_floor,
            electric,
            hydrogen,
            hybrid,
            long_vehicle,
            ticket_machine: Some(ticket_machine),
            eco_vehicle: Some(truthy(flag("ecoVehicle"))),
        },
    }
}

/// `getAllFleetVehicles`: every side number of the table with its model's defaults, in side number order.
pub fn all_fleet_vehicles() -> Vec<VehicleFleetInfo> {
    let mut list: Vec<(i64, VehicleFleetInfo)> = DEFS
        .iter()
        .flat_map(|d| {
            d.sides().map(move |n| {
                let fuel = d.fuel_type.as_str();
                let info = VehicleFleetInfo {
                    side_number: n.to_string(),
                    model: d.model.clone(),
                    producer: d.producer.clone(),
                    year: Some(d.year.clone()),
                    length_category: d.length_category.clone(),
                    fuel_type: d.fuel_type.clone(),
                    features: VehicleFeatures {
                        air_condition: d.default_features.air_condition.unwrap_or(false),
                        low_floor: d.default_features.low_floor.unwrap_or(true),
                        electric: fuel == "electric",
                        hydrogen: fuel == "hydrogen",
                        hybrid: fuel == "hybrid",
                        long_vehicle: d.length_category == "MEGA",
                        ticket_machine: None,
                        eco_vehicle: None,
                    },
                };
                (n, info)
            })
        })
        .collect();
    list.sort_by_key(|e| e.0);
    list.into_iter().map(|e| e.1).collect()
}
