import type { FleetCity } from "@/lib/client/fleet";
import type { DelayClass, FleetFuelType, FleetLengthCategory, VehicleFeatures } from "@/lib/shared/fleet";

/** Brand and wording of each city's fleet: MZK runs buses only, GZM buses, trams and trolleybuses. */
export const FLEET_CITY = {
  bb: {
    operator: "MZK",
    name: "MZK Bielsko-Biała",
    short: "MZK",
    veh: "autobus",
    vehGen: "autobusu",
    vehs: "autobusy",
    Vehs: "Autobusy",
    vehsGen: "autobusów",
    distSource: "z systemu MZK",
  },
  gzm: {
    operator: "GZM",
    name: "Metropolia GZM",
    short: "GZM",
    veh: "pojazd",
    vehGen: "pojazdu",
    vehs: "pojazdy",
    Vehs: "Pojazdy",
    vehsGen: "pojazdów",
    distSource: "z rozkładu GZM",
  },
} as const satisfies Record<FleetCity, { operator: "MZK" | "GZM" } & Record<string, string>>;

/* ── punctuality palette (charts) ────────────────────────────────────────────
 * Diverging around a neutral midpoint, following the map's semantics (cyan = early,
 * orange = late; blue-orange stays apart under every CVD type). Early on surface: 5.50:1 dark,
 * 3.26:1 light. The gray midpoint is deliberately low
 * chroma/contrast, so every chart that uses it also labels it (legend + values/table).
 */
export const DELAY_FILL: Record<DelayClass, string> = {
  early: "#1f9bb8",
  onTime: "#545b64",
  late: "#a65c1c",
  veryLate: "#f0703c",
};

export const DELAY_ORDER: readonly DelayClass[] = ["early", "onTime", "late", "veryLate"];

export const DELAY_LABEL: Record<DelayClass, string> = {
  early: "Przed czasem",
  onTime: "Punktualnie",
  late: "Opóźnione",
  veryLate: "Mocno opóźnione",
};

export const DELAY_RANGE: Record<DelayClass, string> = {
  early: "ponad 1 min wcześniej",
  onTime: "od −1 do +3 min",
  late: "od +3 do +10 min",
  veryLate: "ponad +10 min",
};

/** Status text tokens (readable on every surface) for the same classes. */
export const DELAY_TEXT: Record<DelayClass, string> = {
  early: "text-early",
  onTime: "text-good",
  late: "text-late",
  veryLate: "text-danger",
};

/** One-series bars (magnitude) and their track. */
export const SERIES_FILL = "#7a6be8";
export const TRACK_FILL = "var(--color-surface-3)";
export const SURFACE = "var(--color-surface)";

/* ── formatting ──────────────────────────────────────────────────────────── */

const nf1 = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });

export function fmtInt(n: number): string {
  return nf0.format(n);
}

export function fmtKm(km: number): string {
  return `${km >= 100 ? nf0.format(km) : nf1.format(km)} km`;
}

/** "+1,5 min" / "−0,5 min" / "0 min": one decimal for aggregates (median, mean). */
export function fmtDelayMin(sec: number): string {
  const m = Math.round((sec / 60) * 10) / 10;
  if (m === 0) return "0 min";
  return `${m > 0 ? "+" : "−"}${nf1.format(Math.abs(m))} min`;
}

/** One course's / vehicle's delay: whole minutes, "o czasie" inside ±30 s. */
export function fmtDelay(sec: number): string {
  const m = Math.sign(sec) * Math.round(Math.abs(sec) / 60);
  if (m === 0) return "o czasie";
  return `${m > 0 ? "+" : "−"}${Math.abs(m)} min`;
}

const warsawHHMM = new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });
const warsawHHMMSS = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Epoch seconds as agency wall-clock "HH:MM". */
export function clockFromEpoch(sec: number, withSeconds = false): string {
  return (withSeconds ? warsawHHMMSS : warsawHHMM).format(new Date(sec * 1000));
}

/** Agency seconds since midnight as "HH:MM" (wraps past midnight). */
export function clockFromSecs(secs: number): string {
  const s = ((Math.round(secs) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** "przed chwilą" / "5 min temu" / "o 14:05" (older than an hour). */
export function fmtAgo(epochSec: number, nowEpoch: number): string {
  const d = Math.max(0, nowEpoch - epochSec);
  if (d < 90) return "przed chwilą";
  if (d < 3600) return `${Math.round(d / 60)} min temu`;
  return `o ${clockFromEpoch(epochSec)}`;
}

export function pluralPl(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

export const FUEL_LABEL: Record<FleetFuelType, string> = {
  diesel: "Diesel",
  electric: "Elektryczny",
  hydrogen: "Wodorowy",
  hybrid: "Hybrydowy",
  cng: "CNG (gaz)",
};

export const FUEL_LABEL_PLURAL: Record<FleetFuelType, string> = {
  diesel: "Diesel",
  electric: "Elektryczne",
  hydrogen: "Wodorowe",
  hybrid: "Hybrydowe",
  cng: "CNG (gaz)",
};

export const LENGTH_LABEL: Record<FleetLengthCategory, string> = {
  MINI: "Mini (do 9 m)",
  MIDI: "Midi (ok. 10 m)",
  MAXI: "Maxi (12 m)",
  MEGA: "Przegubowy (18 m)",
};

export const LENGTH_LABEL_PLURAL: Record<FleetLengthCategory, string> = {
  MINI: "Mini (do 9 m)",
  MIDI: "Midi (ok. 10 m)",
  MAXI: "Maxi (12 m)",
  MEGA: "Przegubowe (18 m)",
};

export function featureList(f: VehicleFeatures): string[] {
  const out: string[] = [];
  if (f.lowFloor) out.push("Niskopodłogowy");
  if (f.airCondition) out.push("Klimatyzowany");
  if (f.ticketMachine) out.push("Biletomat");
  if (f.ecoVehicle) out.push("Ekologiczny");
  return out;
}

const dayFmt = new Intl.DateTimeFormat("pl-PL", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });

/** "pon., 03.11" for a Warsaw date "2026-11-03". */
export function fmtDay(date: string): string {
  return dayFmt.format(new Date(`${date}T12:00:00Z`));
}
