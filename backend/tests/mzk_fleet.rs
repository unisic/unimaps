//! Port of test/mzk-fleet.test.ts plus the mzk_fleet vectors from scripts/dump-vectors.ts.

use serde_json::{Value, json};
use unimaps::mzk_fleet::{all_fleet_vehicles, fleet_details};

#[test]
fn golden_fleet_table_and_details() {
    let v: Value = serde_json::from_str(include_str!("vectors/mzk_fleet.json")).unwrap();
    assert_eq!(serde_json::to_value(all_fleet_vehicles()).unwrap(), v["all"]);
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 600);
    for c in cases {
        let side = c["side"].as_str().unwrap();
        let st = Some(&c["static"]).filter(|s| !s.is_null());
        assert_eq!(serde_json::to_value(fleet_details(side, st)).unwrap(), c["out"], "{c}");
    }
}

#[test]
fn resolves_models_by_side_number() {
    let info = fleet_details("250", Some(&json!({"electric": true, "longVehicle": true})));
    assert_eq!(
        (
            info.model.as_str(),
            info.length_category.as_str(),
            info.fuel_type.as_str()
        ),
        ("Solaris Urbino 18 electric", "MEGA", "electric")
    );
    assert!(info.features.long_vehicle && info.features.electric);

    let info = fleet_details("256", None);
    assert_eq!(
        (
            info.model.as_str(),
            info.fuel_type.as_str(),
            info.length_category.as_str()
        ),
        ("Solaris Urbino 12 hydrogen", "hydrogen", "MAXI")
    );
    assert!(info.features.hydrogen);

    let info = fleet_details("238", None);
    assert_eq!(
        (info.model.as_str(), info.fuel_type.as_str()),
        ("Irizar ie bus 12", "electric")
    );
    assert!(info.features.electric);

    let info = fleet_details("230", Some(&json!({"airCondition": true, "lowFloor": true})));
    assert_eq!(
        (info.model.as_str(), info.length_category.as_str()),
        ("Isuzu Novociti Life", "MINI")
    );
    assert!(info.features.air_condition && info.features.low_floor);

    let info = fleet_details("178", None);
    assert_eq!(
        (info.model.as_str(), info.length_category.as_str()),
        ("Solaris Urbino 12 IV", "MAXI")
    );

    let info = fleet_details("999", None);
    assert_eq!(
        (info.model.as_str(), info.side_number.as_str()),
        ("MZK Bielsko-Biała #999", "999")
    );
}

#[test]
fn lists_the_whole_fleet_in_side_number_order() {
    let fleet = all_fleet_vehicles();
    assert!(fleet.len() >= 140, "{}", fleet.len());
    let nums: Vec<i64> = fleet.iter().map(|f| f.side_number.parse().unwrap()).collect();
    assert!(nums.windows(2).all(|w| w[0] <= w[1]));
    let find = |s: &str| fleet.iter().find(|f| f.side_number == s).unwrap();
    assert_eq!(
        (find("258").model.as_str(), find("258").fuel_type.as_str()),
        ("Solaris Urbino 12 hydrogen", "hydrogen")
    );
    assert_eq!(
        (find("230").model.as_str(), find("230").length_category.as_str()),
        ("Isuzu Novociti Life", "MINI")
    );
    assert_eq!(
        (find("146").model.as_str(), find("146").length_category.as_str()),
        ("Mercedes-Benz Citaro G", "MEGA")
    );
}
