/**
 * MZK Bielsko-Biała fleet table for the fleet search (components/TopBarSearch.svelte); the per-vehicle matcher
 * lives in backend/src/mzk_fleet.rs, which reads the same mzk-fleet.json.
 * Source data: https://komunikacja.bielsko-biala.pl/index.php/flota/
 */

import data from "./mzk-fleet.json" with { type: "json" };

export interface VehicleFeatures {
  airCondition?: boolean;
  lowFloor?: boolean;
  electric?: boolean;
  hydrogen?: boolean;
  hybrid?: boolean;
  longVehicle?: boolean;
  ticketMachine?: boolean;
  ecoVehicle?: boolean;
}

/** One model of the fleet; `numbers` holds side numbers and inclusive [first, last] ranges. The table lives in
 * mzk-fleet.json: the Rust backend (backend/src/mzk_fleet.rs) reads the same file. */
interface FleetModelDef {
  model: string;
  producer: string;
  year: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  numbers: Array<number | [number, number]>;
  defaultFeatures?: Partial<VehicleFeatures>;
}

const FLEET_DEFINITIONS = data as FleetModelDef[];

function sideNumbers(def: FleetModelDef): number[] {
  const res: number[] = [];
  for (const n of def.numbers) {
    if (typeof n === "number") res.push(n);
    else for (let i = n[0]; i <= n[1]; i++) res.push(i);
  }
  return res;
}

export interface FleetVehicleSummary {
  sideNumber: string;
  model: string;
  producer: string;
  year?: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  features: VehicleFeatures;
}

export function getAllFleetVehicles(): FleetVehicleSummary[] {
  const list: FleetVehicleSummary[] = [];
  for (const def of FLEET_DEFINITIONS) {
    for (const num of sideNumbers(def)) {
      const sideNumber = String(num);
      list.push({
        sideNumber,
        model: def.model,
        producer: def.producer,
        year: def.year,
        lengthCategory: def.lengthCategory,
        fuelType: def.fuelType,
        features: {
          airCondition: Boolean(def.defaultFeatures?.airCondition),
          lowFloor: Boolean(def.defaultFeatures?.lowFloor ?? true),
          electric: def.fuelType === "electric",
          hydrogen: def.fuelType === "hydrogen",
          hybrid: def.fuelType === "hybrid",
          longVehicle: def.lengthCategory === "MEGA",
        },
      });
    }
  }
  list.sort((a, b) => parseInt(a.sideNumber, 10) - parseInt(b.sideNumber, 10));
  return list;
}

