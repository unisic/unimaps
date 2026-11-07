/**
 * MZK Bielsko-Biała fleet database and model matcher.
 * Source data: https://komunikacja.bielsko-biala.pl/index.php/flota/
 * combined with per-vehicle features from https://rozklady.bielsko.pl/getVehicles.json
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

export interface VehicleFleetInfo {
  sideNumber: string;
  model: string;
  producer: string;
  year?: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  features: VehicleFeatures;
}

export interface MzkVehicleStatic {
  sideNumber: string;
  operator: string;
  longVehicle: boolean;
  airCondition: boolean;
  lowFloor: boolean;
  ecoVehicle: boolean;
  ticketmachineCashCard: boolean;
  ticketmachineCash: boolean;
  ticketmachineCard: boolean;
  overStandard: boolean;
  electric: boolean;
  hybrid: boolean;
  active: boolean;
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

// Pre-index by integer side number
const MODEL_BY_NUMBER = new Map<number, FleetModelDef>();
for (const def of FLEET_DEFINITIONS) {
  for (const num of sideNumbers(def)) {
    MODEL_BY_NUMBER.set(num, def);
  }
}

/**
 * Resolves fleet information for an MZK vehicle by its side number.
 * Combines official fleet specs with live static features from OnTime getVehicles.json.
 */
export function getFleetDetails(
  sideNumber: string,
  staticInfo?: Partial<MzkVehicleStatic>,
): VehicleFleetInfo {
  const num = parseInt(sideNumber, 10);
  const def = Number.isFinite(num) ? MODEL_BY_NUMBER.get(num) : undefined;

  const hasTicketMachine = Boolean(
    staticInfo?.ticketmachineCard ||
      staticInfo?.ticketmachineCash ||
      staticInfo?.ticketmachineCashCard,
  );

  const isElectric = Boolean(staticInfo?.electric || def?.fuelType === "electric");
  const isHydrogen = Boolean(def?.fuelType === "hydrogen");
  const isHybrid = Boolean(staticInfo?.hybrid || def?.fuelType === "hybrid");

  const fuelType = isHydrogen
    ? "hydrogen"
    : isElectric
      ? "electric"
      : isHybrid
        ? "hybrid"
        : (def?.fuelType ?? "diesel");

  const longVehicle = Boolean(
    staticInfo?.longVehicle ?? (def?.lengthCategory === "MEGA" || false),
  );
  const airCondition = Boolean(staticInfo?.airCondition ?? def?.defaultFeatures?.airCondition);
  const lowFloor = Boolean(staticInfo?.lowFloor ?? def?.defaultFeatures?.lowFloor ?? true);
  const ecoVehicle = Boolean(staticInfo?.ecoVehicle);

  return {
    sideNumber,
    model: def ? def.model : `MZK Bielsko-Biała #${sideNumber}`,
    producer: def ? def.producer : "MZK",
    year: def?.year,
    lengthCategory: def ? def.lengthCategory : longVehicle ? "MEGA" : "MAXI",
    fuelType,
    features: {
      airCondition,
      lowFloor,
      electric: isElectric,
      hydrogen: isHydrogen,
      hybrid: isHybrid,
      longVehicle,
      ticketMachine: hasTicketMachine,
      ecoVehicle,
    },
  };
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

