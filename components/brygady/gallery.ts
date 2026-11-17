/** Pure logic of the fleet gallery (FleetList.svelte): states, facets, model groups, side-number search. */
import { classifyDelay, compareLineNames, type FleetSummaryItem } from "@/lib/shared/fleet";

import { yearBin, type FleetFilters, type StatusFilter } from "./fleetFilters";

export type VehicleState = "active" | "waiting" | "depot";

export function vehicleState(v: FleetSummaryItem): VehicleState {
  if (v.status !== "active") return "depot";
  return v.notStarted ? "waiting" : "active";
}

export function isLate(v: FleetSummaryItem): boolean {
  if (vehicleState(v) !== "active" || v.delaySec === undefined) return false;
  const c = classifyDelay(v.delaySec);
  return c === "late" || c === "veryLate";
}

/** drove today: a depot vehicle that came back, not one that stayed in all day */
export const droveToday = (v: FleetSummaryItem) => v.coursesCountToday > 0 || v.kmToday > 0;

/** the number painted on the vehicle (a GZM side number carries its company: "2_4293") */
export const labelOf = (v: FleetSummaryItem) => v.label ?? v.sideNumber;

/** MZK names a vehicle missing from its fleet table "MZK Bielsko-Biała #262" (backend/src/mzk_fleet.rs):
 *  that is no model, and one "model" per vehicle would make each of them a rare one. */
export const knownModels = (vehicles: FleetSummaryItem[]): FleetSummaryItem[] =>
  vehicles.map((v) => (v.model.endsWith(`#${v.sideNumber}`) ? { ...v, model: "" } : v));

/** GZM's only tram company: its vehicles without a photo get the tram glyph */
export const TRAM_COMPANY = "Tramwaje Śląskie";

export const bySide = (a: FleetSummaryItem, b: FleetSummaryItem) =>
  labelOf(a).localeCompare(labelOf(b), "pl", { numeric: true }) || a.sideNumber.localeCompare(b.sideNumber);

export const byLine = (a: FleetSummaryItem, b: FleetSummaryItem) => compareLineNames(a.lineName ?? "~", b.lineName ?? "~") || bySide(a, b);

const STATE_RANK = { active: 0, waiting: 1, depot: 2 } as const;

/** Shelf order: running (the most delayed first), waiting (the next departure first), depot (the last one in first). */
export function byShelf(a: FleetSummaryItem, b: FleetSummaryItem): number {
  const s = vehicleState(a);
  const rank = STATE_RANK[s] - STATE_RANK[vehicleState(b)];
  if (rank) return rank;
  if (s === "active") return (b.delaySec ?? -Infinity) - (a.delaySec ?? -Infinity) || bySide(a, b);
  if (s === "waiting") return (a.startTime ?? "~").localeCompare(b.startTime ?? "~") || bySide(a, b);
  return b.lastSeenAt - a.lastSeenAt || bySide(a, b);
}

/** "Rzadkie dziś w trasie": a running vehicle of a model with at most this many units in the list */
export const RARE_MAX = 3;

/** Whole list, not a filtered one: a model is rare in the fleet, not in a view. The model-less vehicles are no model. */
export function rareModels(vehicles: FleetSummaryItem[]): Set<string> {
  const n = new Map<string, number>();
  for (const v of vehicles) if (v.model) n.set(v.model, (n.get(v.model) ?? 0) + 1);
  return new Set([...n].filter(([, units]) => units <= RARE_MAX).map(([model]) => model));
}

export type Facet = "company" | "fuel" | "length" | "year";

/** A facet's value of a vehicle, as its option key ("" = no company, "none" = not in the data). */
export const FACET_KEY: Record<Facet, (v: FleetSummaryItem) => string> = {
  company: (v) => v.company ?? "",
  fuel: (v) => v.fuelType ?? "none",
  length: (v) => v.lengthCategory ?? "none",
  year: (v) => String(yearBin(v.built)),
};

/** A running vehicle matches its current line; one off duty matches the lines it served today. */
function matchesLine(v: FleetSummaryItem, line: string): boolean {
  if (!line) return true;
  return v.status === "active" ? v.lineName === line : v.lines.includes(line);
}

/** Every filter but the status. `skip` leaves one facet out: the pool that facet's own options are counted in. */
export function passFacets(v: FleetSummaryItem, f: FleetFilters, skip?: Facet): boolean {
  return (
    (skip === "company" || !f.company || v.company === f.company) &&
    (skip === "fuel" || f.fuel === "all" || FACET_KEY.fuel(v) === f.fuel) &&
    (skip === "length" || f.length === "all" || FACET_KEY.length(v) === f.length) &&
    (skip === "year" || f.year < 0 || yearBin(v.built) === f.year) &&
    matchesLine(v, f.line) &&
    (f.model === null || v.model === f.model)
  );
}

export function passStatus(v: FleetSummaryItem, status: StatusFilter, rare: Set<string>): boolean {
  if (status === "all") return true;
  if (status === "late") return isLate(v);
  if (status === "rare") return vehicleState(v) === "active" && rare.has(v.model);
  return vehicleState(v) === status;
}

export interface ModelGroup {
  /** "" = the vehicles without a model */
  model: string;
  vehicles: FleetSummaryItem[];
  active: number;
  waiting: number;
  depot: number;
  late: number;
  /** "2016-2025" from the vehicles' own years, else the fleet table's range */
  years: string;
  thumb?: string;
  /** "mixed" = the model runs on more than one */
  fuel: FleetSummaryItem["fuelType"] | "mixed";
  length: FleetSummaryItem["lengthCategory"] | "mixed";
}

const sameOr = <T>(xs: T[]): T | "mixed" => (xs.every((x) => x === xs[0]) ? xs[0] : "mixed");

/** One group per model, the most numerous first, the model-less vehicles last. */
export function groupModels(list: FleetSummaryItem[]): ModelGroup[] {
  const by = new Map<string, FleetSummaryItem[]>();
  for (const v of list) {
    const g = by.get(v.model);
    if (g) g.push(v);
    else by.set(v.model, [v]);
  }
  const out: ModelGroup[] = [];
  for (const [model, vs] of by) {
    const built = vs.flatMap((v) => (v.built ? [v.built] : []));
    const lo = Math.min(...built);
    const hi = Math.max(...built);
    const n = { active: 0, waiting: 0, depot: 0 };
    for (const v of vs) n[vehicleState(v)]++;
    out.push({
      model,
      vehicles: vs,
      ...n,
      late: vs.filter(isLate).length,
      years: built.length === 0 ? (vs[0].year ?? "") : lo === hi ? String(lo) : `${lo}-${hi}`,
      // a running vehicle's photo first: it is the one on the street today
      thumb: (vs.find((v) => v.thumb && v.status === "active") ?? vs.find((v) => v.thumb))?.thumb,
      fuel: sameOr(vs.map((v) => v.fuelType)),
      length: sameOr(vs.map((v) => v.lengthCategory)),
    });
  }
  return out.sort(
    (a, b) => Number(!a.model) - Number(!b.model) || b.vehicles.length - a.vehicles.length || a.model.localeCompare(b.model, "pl"),
  );
}

/** Side-number search: the exact number, then one ending with the query, starting with it, containing it;
 *  shorter numbers first. `total` counts every match, `hits` holds the first `max`. */
export function rankHits(list: FleetSummaryItem[], query: string, max: number): { hits: FleetSummaryItem[]; total: number } {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  if (!q) return { hits: [], total: 0 };
  const rank = (v: FleetSummaryItem) => {
    const l = labelOf(v).toLowerCase();
    return l === q ? 0 : l.endsWith(q) ? 1 : l.startsWith(q) ? 2 : 3;
  };
  const all = list
    .filter((v) => labelOf(v).toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || labelOf(a).length - labelOf(b).length || bySide(a, b));
  return { hits: all.slice(0, max), total: all.length };
}
