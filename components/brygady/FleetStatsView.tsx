"use client";

import { memo, useMemo, useState } from "react";
import { useFleetTimeline, type FleetApiResponse, type FleetCity, type FleetSummaryItem } from "@/lib/client/fleet";
import {
  classifyDelay,
  compareLineNames,
  foldText,
  median,
  type DelayClass,
  type FleetFuelType,
  type FleetLengthCategory,
} from "@/lib/shared/fleet";
import { LineBadge } from "../ui";
import { BarList, DelayLegend, PunctualityTimeline, TwoPartLegend, type BarRow } from "./charts";
import {
  DELAY_FILL,
  FLEET_CITY,
  FUEL_LABEL_PLURAL,
  fmtDelayMin,
  fmtInt,
  fmtKm,
  LENGTH_LABEL_PLURAL,
  pluralPl,
  SectionCard,
  SERIES_FILL,
  TRACK_FILL,
} from "./common";

const isRunning = (v: FleetSummaryItem) => v.status === "active" && !v.notStarted && v.delaySec !== undefined;

/* ── delay histogram bins (minutes; the class colour follows the shared thresholds) ── */

interface Bin {
  key: string;
  label: string;
  test: (sec: number) => boolean;
  cls: DelayClass;
}

const BINS: Bin[] = [
  { key: "e3", label: "3 min i więcej przed", test: (s) => s <= -180, cls: "early" },
  { key: "e1", label: "1 do 3 min przed", test: (s) => s > -180 && s < -60, cls: "early" },
  { key: "z", label: "do 1 min w obie strony", test: (s) => s >= -60 && s <= 60, cls: "onTime" },
  { key: "l1", label: "+1 do +3 min", test: (s) => s > 60 && s <= 180, cls: "onTime" },
  { key: "l3", label: "+3 do +5 min", test: (s) => s > 180 && s <= 300, cls: "late" },
  { key: "l5", label: "+5 do +10 min", test: (s) => s > 300 && s <= 600, cls: "late" },
  { key: "l10", label: "+10 do +15 min", test: (s) => s > 600 && s <= 900, cls: "veryLate" },
  { key: "l15", label: "ponad +15 min", test: (s) => s > 900, cls: "veryLate" },
];

interface LineRow {
  line: string;
  vehicles: number;
  measured: number;
  medianSec: number | null;
  onTimePct: number | null;
}

type LineSort = "line" | "delay";

function vehicleWord(n: number): string {
  return pluralPl(n, "pojazd", "pojazdy", "pojazdów");
}

export const FleetStatsView = memo(function FleetStatsView({
  data,
  onPickLine,
  onOpenVehicle,
  city = "bb",
}: {
  data: FleetApiResponse;
  onPickLine: (line: string) => void;
  onOpenVehicle: (side: string) => void;
  city?: FleetCity;
}) {
  const timeline = useFleetTimeline(true, city);
  const brand = FLEET_CITY[city];
  const [lineSort, setLineSort] = useState<LineSort>("line");
  const vehicles = data.vehicles;

  const histogram = useMemo(() => {
    const delays = vehicles.filter(isRunning).map((v) => v.delaySec as number);
    return { n: delays.length, counts: BINS.map((b) => delays.filter(b.test).length) };
  }, [vehicles]);

  const lines = useMemo(() => {
    const by = new Map<string, FleetSummaryItem[]>();
    for (const v of vehicles) {
      if (v.status !== "active" || !v.lineName) continue;
      const arr = by.get(v.lineName) ?? [];
      arr.push(v);
      by.set(v.lineName, arr);
    }
    const rows: LineRow[] = [...by.entries()].map(([line, vs]) => {
      const delays = vs.filter(isRunning).map((v) => v.delaySec as number);
      const onTime = delays.filter((d) => classifyDelay(d) === "onTime").length;
      return {
        line,
        vehicles: vs.length,
        measured: delays.length,
        medianSec: median(delays),
        onTimePct: delays.length ? Math.round((onTime / delays.length) * 100) : null,
      };
    });
    return rows;
  }, [vehicles]);

  const sortedLines = useMemo(() => {
    const rows = [...lines];
    if (lineSort === "line") rows.sort((a, b) => compareLineNames(a.line, b.line));
    else rows.sort((a, b) => (b.medianSec ?? -Infinity) - (a.medianSec ?? -Infinity) || compareLineNames(a.line, b.line));
    return rows;
  }, [lines, lineSort]);

  const composition = useMemo(() => {
    const fuel = new Map<FleetFuelType, { total: number; active: number }>();
    const length = new Map<FleetLengthCategory, { total: number; active: number }>();
    const companies = new Map<string, { total: number; active: number }>();
    const models = new Map<string, { total: number; active: number; years: Set<string> }>();
    for (const v of vehicles) {
      const on = v.status === "active" ? 1 : 0;
      // GZM publishes no propulsion or length: null counts in neither chart
      if (v.fuelType) {
        const f = fuel.get(v.fuelType) ?? { total: 0, active: 0 };
        f.total++;
        f.active += on;
        fuel.set(v.fuelType, f);
      }
      if (v.lengthCategory) {
        const l = length.get(v.lengthCategory) ?? { total: 0, active: 0 };
        l.total++;
        l.active += on;
        length.set(v.lengthCategory, l);
      }
      if (v.company) {
        const c = companies.get(v.company) ?? { total: 0, active: 0 };
        c.total++;
        c.active += on;
        companies.set(v.company, c);
      }
      // OnTime's model name usually starts with the producer already ("Solaris Urbino 12 IV")
      const name =
        (v.producer && !foldText(v.model).startsWith(foldText(v.producer)) ? `${v.producer} ${v.model}` : v.model).trim() ||
        "Nieznany model";
      const m = models.get(name) ?? { total: 0, active: 0, years: new Set<string>() };
      m.total++;
      m.active += on;
      if (v.year) m.years.add(v.year);
      models.set(name, m);
    }
    const twoPart = (label: string, key: string, x: { total: number; active: number }): BarRow => ({
      key,
      label,
      value: x.total,
      part: x.active,
      valueText: `${x.active} z ${x.total}`,
      ariaLabel: `${label}: ${x.active} z ${x.total} w trasie`,
    });
    const fuelOrder: FleetFuelType[] = ["diesel", "hybrid", "electric", "hydrogen"];
    const lengthOrder: FleetLengthCategory[] = ["MINI", "MIDI", "MAXI", "MEGA"];
    return {
      fuel: fuelOrder.filter((k) => fuel.has(k)).map((k) => twoPart(FUEL_LABEL_PLURAL[k], k, fuel.get(k)!)),
      length: lengthOrder.filter((k) => length.has(k)).map((k) => twoPart(LENGTH_LABEL_PLURAL[k], k, length.get(k)!)),
      companies: [...companies.entries()]
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0], "pl"))
        .map(([name, x]) => twoPart(name, name, x)),
      models: [...models.entries()]
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0], "pl"))
        .map(([name, m]): BarRow => {
          const years = [...m.years].sort();
          const yearText = years.length === 0 ? "" : years.length === 1 ? years[0] : `${years[0]}–${years[years.length - 1]}`;
          return {
            key: name,
            label: (
              <>
                <span className="truncate text-text">{name}</span>
                {yearText ? <span className="truncate text-[11.5px] text-text-faint">{yearText}</span> : null}
              </>
            ),
            value: m.total,
            part: m.active,
            valueText: `${m.active} z ${m.total}`,
            title: `${name}${yearText ? ` (${yearText})` : ""}: ${m.active} z ${m.total} w trasie`,
            ariaLabel: `${name}${yearText ? `, rocznik ${yearText}` : ""}: ${m.active} z ${m.total} w trasie`,
          };
        }),
    };
  }, [vehicles]);

  const day = useMemo(() => {
    const topKm = vehicles
      .filter((v) => v.kmToday > 0)
      .sort((a, b) => b.kmToday - a.kmToday || a.sideNumber.localeCompare(b.sideNumber, "pl", { numeric: true }))
      .slice(0, 8);
    const cancelled = vehicles
      .filter((v) => v.cancelledCoursesToday > 0)
      .sort((a, b) => b.cancelledCoursesToday - a.cancelledCoursesToday || a.sideNumber.localeCompare(b.sideNumber, "pl", { numeric: true }));
    return { topKm, cancelled };
  }, [vehicles]);

  const maxBin = Math.max(1, ...histogram.counts);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <SectionCard
          id="sec-timeline"
          title="Punktualność w ciągu dnia"
          subtitle={`${brand.Vehs} ${brand.short} w trasie, próbka co 5 minut. Przerwa w wykresie oznacza brak danych (noc albo restart serwera).`}
        >
          {timeline.data ? (
            timeline.data.points.length > 0 ? (
              <PunctualityTimeline points={timeline.data.points} slotSecs={timeline.data.slotSecs} fleetName={brand.short} />
            ) : (
              <p className="rounded-xl bg-surface-2 px-4 py-8 text-center text-[13px] text-text-mute">
                Brak próbek z dzisiaj. Wykres zapełnia się, gdy {brand.vehs} {brand.short} są w trasie.
              </p>
            )
          ) : timeline.error ? (
            <div className="rounded-xl bg-surface-2 px-4 py-8 text-center text-[13px]">
              <p className="text-danger">Nie udało się pobrać przebiegu dnia.</p>
              <button
                type="button"
                onClick={() => void timeline.mutate()}
                className="mt-3 min-h-9 rounded-full bg-surface-3 px-4 text-[12.5px] font-semibold text-text hover:bg-tint/12"
              >
                Spróbuj ponownie
              </button>
            </div>
          ) : (
            <div className="skeleton h-[230px] w-full" aria-label="Ładowanie wykresu" />
          )}
        </SectionCard>
      </div>

      <SectionCard
        id="sec-hist"
        title="Opóźnienia teraz"
        subtitle={
          histogram.n > 0
            ? `${histogram.n} ${vehicleWord(histogram.n)} w trasie z pomiarem opóźnienia`
            : `Brak ${brand.vehsGen} w trasie z pomiarem opóźnienia`
        }
      >
        {histogram.n > 0 ? (
          <>
            <div className="mb-3">
              <DelayLegend />
            </div>
            <BarList
              max={maxBin}
              rows={BINS.map((b, i) => ({
                key: b.key,
                label: b.label,
                value: histogram.counts[i],
                color: DELAY_FILL[b.cls],
                valueText: histogram.counts[i],
                ariaLabel: `${b.label}: ${histogram.counts[i]}`,
              }))}
              labelClassName="w-36 sm:w-44"
            />
          </>
        ) : (
          <p className="py-6 text-center text-[13px] text-text-mute">Wróć, gdy {brand.vehs} wyjadą na trasy.</p>
        )}
      </SectionCard>

      <SectionCard
        id="sec-lines"
        title="Linie w ruchu"
        subtitle="Kliknij linię, aby zobaczyć jej pojazdy."
        actions={
          lines.length > 1 ? (
            <div role="group" aria-label="Sortowanie linii" className="flex rounded-lg bg-surface-2 p-0.5 text-[12px] font-medium">
              {(
                [
                  ["line", "Numer"],
                  ["delay", "Opóźnienie"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={lineSort === k}
                  onClick={() => setLineSort(k)}
                  className={`min-h-8 rounded-md px-2.5 transition-colors ${
                    lineSort === k ? "bg-surface-3 text-text" : "text-text-mute hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null
        }
      >
        {sortedLines.length > 0 ? (
          <>
            <div aria-hidden className="grid grid-cols-[3rem_4rem_5.5rem_1fr] gap-3 px-1.5 pb-1.5 text-[11.5px] font-medium text-text-faint">
              <span>Linia</span>
              <span className="text-right">Pojazdy</span>
              <span className="text-right">Mediana</span>
              <span>Punktualnie</span>
            </div>
            <ul className="kb-scroll max-h-[22rem] overflow-y-auto">
              {sortedLines.map((r) => (
                <li key={r.line}>
                  <button
                    type="button"
                    onClick={() => onPickLine(r.line)}
                    aria-label={`Linia ${r.line}: ${r.vehicles} ${vehicleWord(r.vehicles)} w trasie${
                      r.medianSec !== null ? `, mediana opóźnienia ${fmtDelayMin(r.medianSec)}` : ""
                    }${r.onTimePct !== null ? `, punktualnie ${r.onTimePct}%` : ""}. Pokaż pojazdy.`}
                    className="grid min-h-10 w-full grid-cols-[3rem_4rem_5.5rem_1fr] items-center gap-3 rounded-lg px-1.5 text-left text-[12.5px] transition-colors hover:bg-tint/5"
                  >
                    <LineBadge line={r.line} operator={brand.operator} />
                    <span className="text-right text-text tabular-nums">{r.vehicles}</span>
                    <span className="text-right text-text tabular-nums">{r.medianSec !== null ? fmtDelayMin(r.medianSec) : "–"}</span>
                    <span className="flex items-center gap-2">
                      <span className="relative h-2 flex-1 overflow-hidden rounded-full" style={{ background: TRACK_FILL }}>
                        {r.onTimePct !== null ? (
                          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${r.onTimePct}%`, background: SERIES_FILL }} />
                        ) : null}
                      </span>
                      <span className="w-9 text-right text-text tabular-nums">{r.onTimePct !== null ? `${r.onTimePct}%` : "–"}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="py-6 text-center text-[13px] text-text-mute">
            Żadna linia {brand.short} nie ma teraz {brand.vehGen} w trasie.
          </p>
        )}
      </SectionCard>

      <SectionCard id="sec-fleet" title="Skład floty" subtitle={`${fmtInt(data.stats.totalFleet)} pojazdów ${brand.short}, ile z nich jest teraz w trasie`}>
        <div className="mb-3">
          <TwoPartLegend partLabel="W trasie" restLabel="Nie kursuje teraz" />
        </div>
        {composition.fuel.length > 0 ? (
          <>
            <h3 className="mb-1 text-[12px] font-semibold text-text-mute">Napęd</h3>
            <BarList rows={composition.fuel} labelClassName="w-36 sm:w-40" />
          </>
        ) : null}
        {composition.length.length > 0 ? (
          <>
            <h3 className="mb-1 mt-4 text-[12px] font-semibold text-text-mute">Długość</h3>
            <BarList rows={composition.length} labelClassName="w-36 sm:w-40" />
          </>
        ) : null}
        {composition.companies.length > 0 ? (
          <>
            <h3 className="mb-1 text-[12px] font-semibold text-text-mute">Przewoźnik</h3>
            <BarList rows={composition.companies} labelClassName="w-36 sm:w-40" />
          </>
        ) : null}
      </SectionCard>

      <SectionCard id="sec-models" title="Modele" subtitle="Liczba pojazdów danego modelu i rocznik">
        <div className="mb-3">
          <TwoPartLegend partLabel="W trasie" restLabel="Nie kursuje teraz" />
        </div>
        <div className="kb-scroll lg:max-h-[22rem] lg:overflow-y-auto lg:pr-1">
          <BarList rows={composition.models} labelClassName="w-40 sm:w-52" />
        </div>
      </SectionCard>

      <SectionCard id="sec-km" title="Najwięcej kilometrów dziś" subtitle={`Długość przejechanych kursów według odległości między przystankami ${brand.distSource}`}>
        {day.topKm.length > 0 ? (
          <BarList
            rows={day.topKm.map((v) => ({
              key: v.sideNumber,
              label: (
                <>
                  <span className="truncate font-semibold text-text tabular-nums">#{v.label ?? v.sideNumber}</span>
                  <span className="truncate text-[11.5px] text-text-faint">{v.company ?? v.model}</span>
                </>
              ),
              value: v.kmToday,
              valueText: fmtKm(v.kmToday),
              onClick: () => onOpenVehicle(v.sideNumber),
              ariaLabel: `Pojazd ${v.label ?? v.sideNumber}, ${v.company ?? v.model}: ${fmtKm(v.kmToday)}. Otwórz kartę pojazdu.`,
            }))}
            labelClassName="w-28 sm:w-40"
          />
        ) : (
          <p className="py-6 text-center text-[13px] text-text-mute">Dziś nie zakończono jeszcze żadnego odcinka kursu.</p>
        )}
      </SectionCard>

      <SectionCard
        id="sec-cancelled"
        title="Przerwane kursy"
        subtitle="Pojazd zniknął z systemu przed przystankiem końcowym przy opóźnieniu ponad 10 min (awaria, utrata GPS albo zjazd)."
      >
        {day.cancelled.length > 0 ? (
          <ul className="divide-y divide-hairline">
            {day.cancelled.map((v) => (
              <li key={v.sideNumber}>
                <button
                  type="button"
                  onClick={() => onOpenVehicle(v.sideNumber)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-1.5 text-left transition-colors hover:bg-tint/5"
                >
                  <span className="w-14 shrink-0 font-semibold text-text tabular-nums">#{v.label ?? v.sideNumber}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-mute">{v.company ?? v.model}</span>
                  <span className="shrink-0 text-[12.5px] font-semibold text-danger tabular-nums">
                    {v.cancelledCoursesToday} {pluralPl(v.cancelledCoursesToday, "kurs", "kursy", "kursów")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-[13px] text-text-mute">Dziś nie odnotowano przerwanego kursu.</p>
        )}
      </SectionCard>
    </div>
  );
});
