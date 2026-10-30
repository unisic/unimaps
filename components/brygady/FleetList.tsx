"use client";

import { memo, useDeferredValue, useId, useMemo, useState } from "react";
import type { FleetCity, FleetSummaryItem } from "@/lib/client/fleet";
import { compareLineNames, matchesFleetQuery, type FleetFuelType } from "@/lib/shared/fleet";
import { LineBadge } from "../ui";
import {
  clockFromEpoch,
  DelayBadge,
  FLEET_CITY,
  FUEL_LABEL,
  FUEL_LABEL_PLURAL,
  FuelIcon,
  fmtInt,
  fmtKm,
  pluralPl,
  SearchIcon,
  SERIES_FILL,
} from "./common";

export type StatusFilter = "all" | "active" | "waiting" | "depot";
export type FleetSort = "line" | "side" | "delay" | "km";

export interface FleetFilters {
  q: string;
  status: StatusFilter;
  fuel: "all" | FleetFuelType;
  /** "" = every line */
  line: string;
  sort: FleetSort;
}

export const DEFAULT_FILTERS: FleetFilters = { q: "", status: "all", fuel: "all", line: "", sort: "line" };

export function hasActiveFilters(f: FleetFilters): boolean {
  return f.q.trim() !== "" || f.status !== "all" || f.fuel !== "all" || f.line !== "";
}

function vehicleState(v: FleetSummaryItem): Exclude<StatusFilter, "all"> {
  if (v.status !== "active") return "depot";
  return v.notStarted ? "waiting" : "active";
}

const STATE_RANK = { active: 0, waiting: 1, depot: 2 } as const;

const bySide = (a: FleetSummaryItem, b: FleetSummaryItem) => a.sideNumber.localeCompare(b.sideNumber, "pl", { numeric: true });

/** A running vehicle matches its current line; one off duty matches the lines it served today. */
function matchesLine(v: FleetSummaryItem, line: string): boolean {
  if (!line) return true;
  if (v.status === "active") return v.lineName === line;
  return v.lines.includes(line);
}

function sortVehicles(list: FleetSummaryItem[], sort: FleetSort): FleetSummaryItem[] {
  const out = [...list];
  switch (sort) {
    case "side":
      return out.sort(bySide);
    case "km":
      return out.sort((a, b) => b.kmToday - a.kmToday || bySide(a, b));
    case "delay":
      // the most delayed first; vehicles without a measured delay at the end
      return out.sort((a, b) => (b.delaySec ?? -Infinity) - (a.delaySec ?? -Infinity) || bySide(a, b));
    default:
      return out.sort(
        (a, b) =>
          STATE_RANK[vehicleState(a)] - STATE_RANK[vehicleState(b)] ||
          compareLineNames(a.lineName ?? a.lastLineName ?? "~", b.lineName ?? b.lastLineName ?? "~") ||
          bySide(a, b),
      );
  }
}

const STATUS_CHIPS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "Wszystkie" },
  { key: "active", label: "W trasie" },
  { key: "waiting", label: "Czeka na odjazd" },
  { key: "depot", label: "Nie kursuje" },
];

/** ponytail: GZM lists ~1 400 vehicles; 200 cards per step keep the DOM small. Upgrade: a virtual list. */
const PAGE_ROWS = 200;

const SORT_LABEL: Record<FleetSort, string> = {
  line: "Linia",
  side: "Numer boczny",
  delay: "Opóźnienie",
  km: "Km dziś",
};

export const FleetList = memo(function FleetList({
  vehicles,
  filters,
  onFiltersChange,
  onOpen,
  nowEpoch,
  city = "bb",
}: {
  vehicles: FleetSummaryItem[];
  filters: FleetFilters;
  onFiltersChange: (patch: Partial<FleetFilters>) => void;
  onOpen: (side: string) => void;
  nowEpoch: number;
  city?: FleetCity;
}) {
  const searchId = useId();
  const q = useDeferredValue(filters.q);
  const brand = FLEET_CITY[city];
  // "Pokaż więcej" counts for the filters it was pressed under; any filter change starts over
  const filterKey = `${q}\n${filters.status}\n${filters.fuel}\n${filters.line}\n${filters.sort}`;
  const [more, setMore] = useState({ key: "", rows: PAGE_ROWS });
  const limit = more.key === filterKey ? more.rows : PAGE_ROWS;

  const lineOptions = useMemo(() => {
    const set = new Set<string>();
    for (const v of vehicles) {
      if (v.lineName) set.add(v.lineName);
      for (const l of v.lines) set.add(l);
    }
    return [...set].sort(compareLineNames);
  }, [vehicles]);

  const fuelOptions = useMemo(() => {
    const set = new Set(vehicles.map((v) => v.fuelType));
    return (["diesel", "hybrid", "electric", "hydrogen"] as const).filter((f) => set.has(f));
  }, [vehicles]);

  // filters other than the status chip, so each chip can show its own count
  const base = useMemo(
    () =>
      vehicles.filter(
        (v) => (filters.fuel === "all" || v.fuelType === filters.fuel) && matchesLine(v, filters.line) && matchesFleetQuery(v, q),
      ),
    [vehicles, filters.fuel, filters.line, q],
  );

  const counts = useMemo(() => {
    const c = { all: base.length, active: 0, waiting: 0, depot: 0 };
    for (const v of base) c[vehicleState(v)]++;
    return c;
  }, [base]);

  const shown = useMemo(
    () => sortVehicles(filters.status === "all" ? base : base.filter((v) => vehicleState(v) === filters.status), filters.sort),
    [base, filters.status, filters.sort],
  );

  const runningNow = useMemo(() => vehicles.filter((v) => v.status === "active").length, [vehicles]);
  const filtered = hasActiveFilters(filters);
  const stale = q !== filters.q;

  return (
    <div>
      <div className="space-y-3">
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            Szukaj pojazdu
          </label>
          <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-text-faint">
            <SearchIcon size={16} />
          </span>
          <input
            id={searchId}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            value={filters.q}
            onChange={(e) => onFiltersChange({ q: e.target.value })}
            placeholder={city === "gzm" ? "Numer taborowy, linia, brygada, kierunek" : "Numer boczny, linia, model, kierunek"}
            className="h-11 w-full rounded-xl border border-hairline bg-surface pl-10 pr-11 text-[14px] text-text placeholder:text-text-faint focus:border-primary/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {filters.q ? (
            <button
              type="button"
              onClick={() => onFiltersChange({ q: "" })}
              aria-label="Wyczyść wyszukiwanie"
              className="absolute inset-y-0 right-1 my-auto grid h-9 w-9 place-items-center rounded-lg text-text-mute hover:bg-tint/8 hover:text-text"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>

        <div role="group" aria-label="Stan pojazdu" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0">
          {STATUS_CHIPS.map((c) => {
            const on = filters.status === c.key;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => onFiltersChange({ status: c.key })}
                className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors ${
                  on ? "border-primary/50 bg-primary-dim text-text" : "border-hairline bg-surface text-text-mute hover:text-text"
                }`}
              >
                {c.label}
                <span className={`tabular-nums ${on ? "text-text" : "text-text-faint"}`}>{counts[c.key]}</span>
              </button>
            );
          })}
        </div>

        {/* GZM publishes no propulsion data: no "Napęd" filter without a single known value */}
        <div className={`grid gap-2 ${fuelOptions.length > 0 ? "grid-cols-3" : "grid-cols-2"}`}>
          {fuelOptions.length > 0 ? (
            <Select
              label="Napęd"
              value={filters.fuel}
              onChange={(v) => onFiltersChange({ fuel: v as FleetFilters["fuel"] })}
              options={[["all", "Wszystkie"], ...fuelOptions.map((f) => [f, FUEL_LABEL_PLURAL[f]] as [string, string])]}
            />
          ) : null}
          <Select
            label="Linia"
            value={filters.line}
            onChange={(v) => onFiltersChange({ line: v })}
            options={[
              ["", "Wszystkie"],
              ...(filters.line && !lineOptions.includes(filters.line) ? [filters.line, ...lineOptions] : lineOptions).map(
                (l) => [l, `Linia ${l}`] as [string, string],
              ),
            ]}
          />
          <Select
            label="Sortuj"
            value={filters.sort}
            onChange={(v) => onFiltersChange({ sort: v as FleetSort })}
            options={(Object.keys(SORT_LABEL) as FleetSort[]).map((k) => [k, SORT_LABEL[k]])}
          />
        </div>

        <div className="flex min-h-8 items-center justify-between gap-3 text-[12.5px] text-text-mute">
          <p aria-live="polite" className="tabular-nums">
            {filtered ? `Pokazano ${fmtInt(shown.length)} z ${fmtInt(vehicles.length)}` : `${fmtInt(vehicles.length)} pojazdów ${brand.short}`}
          </p>
          {filtered ? (
            <button
              type="button"
              onClick={() => onFiltersChange({ q: "", status: "all", fuel: "all", line: "" })}
              className="min-h-8 rounded-lg px-2 font-medium text-primary hover:bg-primary-dim"
            >
              Wyczyść filtry
            </button>
          ) : null}
        </div>
      </div>

      {runningNow === 0 && !filtered ? (
        <p className="mb-3 rounded-xl border border-hairline bg-surface px-4 py-3 text-[13px] text-text-mute">
          Żaden {brand.veh} {brand.short} nie jest teraz w trasie, nocą to normalne. Karta pojazdu pokazuje jego dzisiejsze kursy.
        </p>
      ) : null}

      {shown.length > 0 ? (
        <>
          <ul className={`grid gap-3 sm:grid-cols-2 xl:grid-cols-3 ${stale ? "opacity-70" : ""}`} aria-label="Pojazdy">
            {shown.slice(0, limit).map((v) => (
              <li key={v.sideNumber}>
                <VehicleCard v={v} onOpen={onOpen} nowEpoch={nowEpoch} operator={brand.operator} />
              </li>
            ))}
          </ul>
          {shown.length > limit ? (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => setMore({ key: filterKey, rows: limit + PAGE_ROWS })}
                className="min-h-10 rounded-full bg-surface-3 px-5 text-[13px] font-semibold text-text hover:bg-tint/12"
              >
                Pokaż więcej
                <span className="ml-1.5 font-normal text-text-mute tabular-nums">
                  ({fmtInt(limit)} z {fmtInt(shown.length)})
                </span>
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-2xl border border-hairline bg-surface px-4 py-12 text-center">
          <p className="text-[14px] font-medium text-text">Brak pojazdów dla tych filtrów</p>
          <p className="mt-1 text-[13px] text-text-mute">
            {filters.q.trim() ? `Nic nie pasuje do „${filters.q.trim()}”.` : "Zmień stan, napęd albo linię."}
          </p>
          <button
            type="button"
            onClick={() => onFiltersChange({ q: "", status: "all", fuel: "all", line: "" })}
            className="mt-4 min-h-10 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text hover:bg-tint/12"
          >
            Wyczyść filtry
          </button>
        </div>
      )}
    </div>
  );
});

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[11.5px] font-medium text-text-faint">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full appearance-none truncate rounded-lg border border-hairline bg-surface pl-3 pr-8 text-[13px] text-text focus:border-primary/60 focus:outline-none"
        >
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-2.5 my-auto text-text-faint"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    </div>
  );
}

function StatusPill({ v }: { v: FleetSummaryItem }) {
  const s = vehicleState(v);
  if (s === "active")
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-good">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-good" />W trasie
      </span>
    );
  if (s === "waiting")
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-text-mute">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full border border-text-mute" />
        Czeka
      </span>
    );
  return <span className="shrink-0 text-[12px] font-medium text-text-faint">Nie kursuje</span>;
}

function VehicleCard({
  v,
  onOpen,
  nowEpoch,
  operator,
}: {
  v: FleetSummaryItem;
  onOpen: (side: string) => void;
  nowEpoch: number;
  operator: "MZK" | "GZM";
}) {
  const s = vehicleState(v);
  const courses = v.coursesCountToday;
  const lastSeenToday = v.lastSeenAt > 0 && nowEpoch - v.lastSeenAt < 86400;
  // "0,0 km, 0 kursów" under "Dziś nie wyjechał na trasę" only repeats it
  const drove = courses > 0 || v.kmToday > 0;
  const fuel = v.fuelType !== null && v.fuelType !== "diesel" ? v.fuelType : null;
  const hasTags = fuel !== null || v.lengthCategory === "MEGA";
  return (
    <button
      type="button"
      onClick={() => onOpen(v.sideNumber)}
      className={`flex h-full w-full flex-col gap-2.5 rounded-2xl border p-3.5 text-left transition-[background-color,border-color] ${
        s === "depot" ? "border-hairline bg-surface/60 hover:bg-surface" : "border-hairline bg-surface hover:border-tint/15 hover:bg-surface-2"
      }`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold text-text tabular-nums">#{v.label ?? v.sideNumber}</span>
          <span className="block truncate text-[12.5px] text-text-mute">
            {v.company ? `${v.company}${v.model ? `, ${v.model}` : ""}` : v.model}
            {v.year ? <span className="text-text-faint"> ({v.year})</span> : null}
          </span>
        </span>
        <StatusPill v={v} />
      </span>

      {s === "active" && v.lineName ? (
        <>
          <span className="flex min-w-0 items-center gap-2">
            <LineBadge line={v.lineName} operator={operator} />
            <Brigade v={v} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">{v.direction}</span>
            {v.delaySec !== undefined ? <DelayBadge sec={v.delaySec} /> : null}
          </span>
          <span className="block truncate text-[12.5px] text-text-mute">
            {v.atStop && v.currentStopName
              ? `Na przystanku ${v.currentStopName}`
              : v.nextStopName
                ? `Następny: ${v.nextStopName}`
                : v.currentStopName
                  ? `Przy ${v.currentStopName}`
                  : "Pozycja nieznana"}
          </span>
          <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-surface-3">
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, v.progressPct ?? 0))}%`, background: SERIES_FILL }}
            />
          </span>
        </>
      ) : s === "waiting" && v.lineName ? (
        <>
          <span className="flex min-w-0 items-center gap-2">
            <LineBadge line={v.lineName} operator={operator} />
            <Brigade v={v} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">{v.direction}</span>
          </span>
          <span className="block truncate text-[12.5px] text-text-mute">
            {v.startTime ? `Odjazd o ${v.startTime}` : "Czeka na odjazd"}
            {v.firstStopName ? ` z ${v.firstStopName}` : ""}
          </span>
        </>
      ) : (
        <span className="block truncate text-[12.5px] text-text-mute">
          {lastSeenToday
            ? `Ostatnio w trasie o ${clockFromEpoch(v.lastSeenAt)}${v.lastLineName ? `, linia ${v.lastLineName}` : ""}`
            : "Dziś nie wyjechał na trasę"}
        </span>
      )}

      {drove || hasTags ? (
        <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline pt-2.5 text-[12px] text-text-mute">
          {fuel ? (
            <span className="inline-flex items-center gap-1 text-text">
              <FuelIcon fuel={fuel} size={13} />
              {FUEL_LABEL[fuel]}
            </span>
          ) : null}
          {v.lengthCategory === "MEGA" ? <span>Przegubowy</span> : null}
          {drove ? (
            <>
              <span className="tabular-nums">{fmtKm(v.kmToday)}</span>
              <span className="tabular-nums">
                {courses} {pluralPl(courses, "kurs", "kursy", "kursów")}
                {v.cancelledCoursesToday > 0 ? (
                  <span className="text-danger">
                    , {v.cancelledCoursesToday} {pluralPl(v.cancelledCoursesToday, "przerwany", "przerwane", "przerwanych")}
                  </span>
                ) : null}
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** GZM: the trip's brigade next to the line badge ("69" + "bryg. 1" reads as 69/1). */
function Brigade({ v }: { v: FleetSummaryItem }) {
  if (!v.brigade) return null;
  return (
    <span title={`Brygada ${v.lineName}/${v.brigade}`} className="shrink-0 text-[12px] text-text-mute tabular-nums">
      bryg. {v.brigade}
    </span>
  );
}
