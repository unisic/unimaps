/**
 * MZK Bielsko-Biała fleet database and model matcher.
 * Source data: https://komunikacja.bielsko-biala.pl/index.php/flota/
 * combined with per-vehicle features from https://rozklady.bielsko.pl/getVehicles.json
 */

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

interface FleetModelDef {
  model: string;
  producer: string;
  year: string;
  lengthCategory: "MINI" | "MIDI" | "MAXI" | "MEGA";
  fuelType: "diesel" | "electric" | "hydrogen" | "hybrid";
  numbers: number[];
  defaultFeatures?: Partial<VehicleFeatures>;
}

function expandRange(start: number, end: number): number[] {
  const res: number[] = [];
  for (let i = start; i <= end; i++) res.push(i);
  return res;
}

const FLEET_DEFINITIONS: FleetModelDef[] = [
  {
    model: "Solaris Urbino 12 hydrogen",
    producer: "Solaris",
    year: "2026",
    lengthCategory: "MAXI",
    fuelType: "hydrogen",
    numbers: expandRange(256, 259),
    defaultFeatures: { hydrogen: true, lowFloor: true, airCondition: true },
  },
  {
    model: "Solaris Urbino 18 hydrogen",
    producer: "Solaris",
    year: "2026",
    lengthCategory: "MEGA",
    fuelType: "hydrogen",
    numbers: expandRange(254, 255),
    defaultFeatures: { hydrogen: true, longVehicle: true, lowFloor: true, airCondition: true },
  },
  {
    model: "Solaris Urbino 18 electric",
    producer: "Solaris",
    year: "2026",
    lengthCategory: "MEGA",
    fuelType: "electric",
    numbers: expandRange(250, 253),
    defaultFeatures: { electric: true, longVehicle: true, lowFloor: true, airCondition: true },
  },
  {
    model: "Irizar ie bus 12",
    producer: "Irizar",
    year: "2026",
    lengthCategory: "MAXI",
    fuelType: "electric",
    numbers: expandRange(238, 249),
    defaultFeatures: { electric: true, lowFloor: true, airCondition: true },
  },
  {
    model: "Karsan e-Atak",
    producer: "Karsan",
    year: "2026",
    lengthCategory: "MIDI",
    fuelType: "electric",
    numbers: [237],
    defaultFeatures: { electric: true, lowFloor: true, airCondition: true },
  },
  {
    model: "Isuzu Novociti Life",
    producer: "Isuzu",
    year: "2025",
    lengthCategory: "MINI",
    fuelType: "diesel",
    numbers: expandRange(229, 232),
    defaultFeatures: { lowFloor: true, airCondition: true },
  },
  {
    model: "Solaris Urbino 9LE electric",
    producer: "Solaris",
    year: "2023",
    lengthCategory: "MIDI",
    fuelType: "electric",
    numbers: expandRange(227, 228),
    defaultFeatures: { electric: true, lowFloor: true, airCondition: true },
  },
  {
    model: "Solaris Urbino 18 IV",
    producer: "Solaris",
    year: "2016/2022/2025",
    lengthCategory: "MEGA",
    fuelType: "diesel",
    numbers: [...expandRange(168, 177), ...expandRange(223, 226), 233],
    defaultFeatures: { longVehicle: true, lowFloor: true, airCondition: true },
  },
  {
    model: "Solaris Urbino 12 IV",
    producer: "Solaris",
    year: "2016-2025",
    lengthCategory: "MAXI",
    fuelType: "diesel",
    numbers: [...expandRange(178, 215), ...expandRange(218, 222), ...expandRange(234, 236)],
    defaultFeatures: { lowFloor: true, airCondition: true },
  },
  {
    model: "Iveco Daily 70C17 / SKD Stratos LF38",
    producer: "Iveco / Stratos",
    year: "2015/2017",
    lengthCategory: "MINI",
    fuelType: "diesel",
    numbers: [157, 216, 217],
    defaultFeatures: { lowFloor: true, airCondition: true },
  },
  {
    model: "Scania CN230UB 4x2EB",
    producer: "Scania",
    year: "2015",
    lengthCategory: "MAXI",
    fuelType: "diesel",
    numbers: [167],
    defaultFeatures: { lowFloor: true, airCondition: true },
  },
  {
    model: "Mercedes-Benz Conecto LF",
    producer: "Mercedes-Benz",
    year: "2011",
    lengthCategory: "MAXI",
    fuelType: "diesel",
    numbers: expandRange(147, 156),
    defaultFeatures: { lowFloor: true, airCondition: false },
  },
  {
    model: "Mercedes-Benz Citaro G",
    producer: "Mercedes-Benz",
    year: "2010/2011",
    lengthCategory: "MEGA",
    fuelType: "diesel",
    numbers: [138, 139, 141, 143, 144, 145, 146],
    defaultFeatures: { longVehicle: true, lowFloor: true, airCondition: false },
  },
  {
    model: "Autosan A8V.03.01",
    producer: "Autosan",
    year: "2009",
    lengthCategory: "MINI",
    fuelType: "diesel",
    numbers: expandRange(134, 136),
    defaultFeatures: { lowFloor: false, airCondition: false },
  },
  {
    model: "Solaris Urbino 12 III",
    producer: "Solaris",
    year: "2006/2009",
    lengthCategory: "MAXI",
    fuelType: "diesel",
    numbers: [92, ...expandRange(94, 101), ...expandRange(129, 133)],
    defaultFeatures: { lowFloor: true, airCondition: false },
  },
  {
    model: "Mercedes-Benz Citaro",
    producer: "Mercedes-Benz",
    year: "2008",
    lengthCategory: "MAXI",
    fuelType: "diesel",
    numbers: expandRange(119, 128),
    defaultFeatures: { lowFloor: true, airCondition: false },
  },
  {
    model: "Mercedes-Benz Citaro K",
    producer: "Mercedes-Benz",
    year: "2007",
    lengthCategory: "MIDI",
    fuelType: "diesel",
    numbers: [109, ...expandRange(111, 118)],
    defaultFeatures: { lowFloor: true, airCondition: false },
  },
];

// Pre-index by integer side number
const MODEL_BY_NUMBER = new Map<number, FleetModelDef>();
for (const def of FLEET_DEFINITIONS) {
  for (const num of def.numbers) {
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
