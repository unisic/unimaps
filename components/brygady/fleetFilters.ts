import type { FleetFuelType, FleetLengthCategory } from "@/lib/shared/fleet";

/** "late" and "rare" are subsets of "active": late = at least 3 min behind (classifyDelay late or veryLate),
 *  rare = a running vehicle of a model with at most RARE_MAX units in the list */
export type StatusFilter = "all" | "active" | "late" | "waiting" | "depot" | "rare";

export interface FleetFilters {
  status: StatusFilter;
  /** "" = every company (only GZM names one) */
  company: string;
  /** "none" = the vehicles whose data lacks the value */
  fuel: "all" | FleetFuelType | "none";
  length: "all" | FleetLengthCategory | "none";
  /** index into YEAR_BINS, -1 = every year */
  year: number;
  /** "" = every line, else the line name in upper case */
  line: string;
  /** null = every model, "" = the vehicles without one */
  model: string | null;
}

export const DEFAULT_FILTERS: FleetFilters = { status: "all", company: "", fuel: "all", length: "all", year: -1, line: "", model: null };

export function hasActiveFilters(f: FleetFilters): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof FleetFilters)[]).some((k) => f[k] !== DEFAULT_FILTERS[k]);
}

/** Year of production, oldest first. The last dated bin is open-ended so its label never goes stale. */
export const YEAR_BINS = [
  { slug: "do-1989", label: "do 1989", short: "do 89", to: 1989 },
  { slug: "1990-2009", label: "1990-2009", short: "90-09", to: 2009 },
  { slug: "2010-2014", label: "2010-2014", short: "10-14", to: 2014 },
  { slug: "2015-2019", label: "2015-2019", short: "15-19", to: 2019 },
  { slug: "2020-2024", label: "2020-2024", short: "20-24", to: 2024 },
  { slug: "od-2025", label: "od 2025", short: "25+", to: Infinity },
  { slug: "brak", label: "brak danych", short: "brak", to: NaN },
];

export function yearBin(built: number | undefined): number {
  return built ? YEAR_BINS.findIndex((b) => built <= b.to) : YEAR_BINS.length - 1;
}

const STATUS_SLUG: Record<StatusFilter, string> = {
  all: "",
  active: "w-trasie",
  late: "spoznione",
  waiting: "czeka",
  depot: "w-zajezdni",
  rare: "rzadkie",
};
const FUEL_SLUG: Record<FleetFilters["fuel"], string> = {
  all: "",
  diesel: "diesel",
  electric: "elektryczny",
  hydrogen: "wodorowy",
  hybrid: "hybrydowy",
  cng: "cng",
  none: "brak",
};
const LENGTH_SLUG: Record<FleetFilters["length"], string> = { all: "", MINI: "mini", MIDI: "midi", MAXI: "maxi", MEGA: "przegubowy", none: "brak" };
/** `model=` value for the vehicles without a model */
const NO_MODEL = "nieustalony";
/** a query value is free text until it matches the data: cap what ends up in a chip */
const MAX_TEXT = 80;

function keyOf<K extends string>(slugs: Record<K, string>, slug: string | null, fallback: K): K {
  return (Object.keys(slugs) as K[]).find((k) => slugs[k] === slug) ?? fallback;
}

/** The gallery view from a page URL; anything unknown reads as "no filter". */
export function filtersFromParams(p: URLSearchParams): FleetFilters {
  const text = (k: string) => (p.get(k) ?? "").trim().slice(0, MAX_TEXT);
  return {
    status: keyOf(STATUS_SLUG, p.get("status"), "all"),
    company: text("przewoznik"),
    fuel: keyOf(FUEL_SLUG, p.get("naped"), "all"),
    length: keyOf(LENGTH_SLUG, p.get("dlugosc"), "all"),
    year: YEAR_BINS.findIndex((b) => b.slug === p.get("rocznik")),
    line: text("linia").toUpperCase(),
    model: !p.has("model") ? null : text("model") === NO_MODEL ? "" : text("model"),
  };
}

/** Writes the view into `p`, dropping the params of unset filters. */
export function filtersToParams(f: FleetFilters, p: URLSearchParams): void {
  const put = (k: string, v: string) => (v ? p.set(k, v) : p.delete(k));
  put("status", STATUS_SLUG[f.status]);
  put("przewoznik", f.company);
  put("naped", FUEL_SLUG[f.fuel]);
  put("dlugosc", LENGTH_SLUG[f.length]);
  put("rocznik", YEAR_BINS[f.year]?.slug ?? "");
  put("linia", f.line);
  put("model", f.model === null ? "" : f.model || NO_MODEL);
}
