"use client";

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { cityOfSide, isNotFound, useVehicleDetail, type FleetSummaryItem } from "@/lib/client/fleet";
import type { FleetCurrentCourse, FleetVehicleDetail, VehicleCourseRecord } from "@/lib/shared/fleet";
import { useNow } from "../hooks";
import { CloseIcon, LineBadge, ShareButton } from "../ui";
import { CourseDelayColumns, CourseGantt, GanttLegend, type DelayColumn, type GanttCourse } from "./charts";
import {
  AlertIcon,
  ChevronDownIcon,
  DelayBadge,
  featureList,
  FLEET_CITY,
  fmtAgo,
  fmtDelay,
  fmtDelayMin,
  fmtKm,
  FUEL_LABEL,
  InfoIcon,
  LENGTH_LABEL,
  MapIcon,
  pluralPl,
  SERIES_FILL,
  useEpochNow,
} from "./common";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,summary,[tabindex]:not([tabindex="-1"])';

/** Opens a live course on the map in place (the card sits over the map); without it the link navigates. */
type ShowOnMap = (execId: string) => void;

type Operator = FleetVehicleDetail["operator"];

/** Modal sheet: bottom sheet on phones, centred dialog from md up. The city follows from the side number. */
export function VehicleSheet({
  side,
  seed,
  onClose,
  onShowOnMap,
}: {
  side: string;
  seed?: FleetSummaryItem;
  onClose: () => void;
  onShowOnMap?: ShowOnMap;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const city = cityOfSide(side);
  const brand = FLEET_CITY[city];
  const { data, error, isLoading, mutate } = useVehicleDetail(side, city);
  const close = useEffectEvent(() => onClose());

  useEffect(() => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
    };
  }, []);

  const vehicle = data?.vehicle;
  const notFound = isNotFound(error);
  const model = vehicle?.model ?? seed?.model;
  const company = vehicle?.company ?? seed?.company;
  // GZM shows the printed fleet number, not the "<company>_<fleet>" key (MZK: the side number itself)
  const label = vehicle?.label ?? seed?.label ?? side.slice(side.indexOf("_") + 1);

  return (
    <div className="fixed inset-0 z-[2000] flex items-end justify-center md:items-center md:p-6">
      <div className="absolute inset-0 animate-fade bg-black/65" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[92dvh] w-full animate-rise flex-col overflow-hidden rounded-t-3xl border border-hairline bg-bg shadow-[var(--shadow-sheet)] focus:outline-none md:max-h-[88dvh] md:max-w-3xl md:rounded-3xl"
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-tint/15 md:hidden" />
        <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 pb-3 pt-2 md:pt-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[18px] font-bold text-text tabular-nums">
              Pojazd #{label}
            </h2>
            <p className="truncate text-[13px] text-text-mute">
              {company ? `${company}${model ? ", " : ""}` : null}
              {model ?? (notFound ? "Nieznany pojazd" : " ")}
              {vehicle?.year ? <span className="text-text-faint"> ({vehicle.year})</span> : null}
            </p>
          </div>
          <ShareButton
            title={`Pojazd ${brand.short} #${label}`}
            path={`/brygady?${city === "gzm" ? "city=gzm&" : ""}tabor=${encodeURIComponent(side)}`}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij kartę pojazdu"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-tint/8 hover:text-text"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="kb-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
          {vehicle ? (
            <>
              {error && !notFound ? (
                <p className="mb-3 flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[12.5px] text-late">
                  <AlertIcon size={14} />
                  Nie udało się odświeżyć, pokazujemy ostatnie dane.
                </p>
              ) : null}
              <VehicleBody v={vehicle} onShowOnMap={onShowOnMap} />
            </>
          ) : notFound ? (
            <div className="py-12 text-center">
              <p className="text-[15px] font-medium text-text">Nie znamy pojazdu #{label}</p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
                {city === "gzm"
                  ? "Ten pojazd nie wyjechał dziś na trasę. Link mógł się zestarzeć albo numer ma literówkę."
                  : "Tego numeru nie ma we flocie MZK Bielsko-Biała. Link mógł się zestarzeć albo numer ma literówkę."}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-4 min-h-10 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text hover:bg-tint/12"
              >
                Wróć do listy
              </button>
            </div>
          ) : error && !isLoading ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-danger">Nie udało się pobrać karty pojazdu.</p>
              <button
                type="button"
                onClick={() => void mutate()}
                className="mt-3 min-h-10 rounded-full bg-brand px-4 text-[13px] font-semibold text-on-brand hover:bg-brand-hi"
              >
                Spróbuj ponownie
              </button>
            </div>
          ) : (
            <SheetSkeleton />
          )}
        </div>
      </div>
    </div>
  );
}

function SheetSkeleton() {
  return (
    <div aria-label="Ładowanie karty pojazdu" className="space-y-4">
      <div className="skeleton h-28 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-16 rounded-xl" />
        ))}
      </div>
      <div className="skeleton h-24 w-full rounded-2xl" />
      <div className="skeleton h-40 w-full rounded-2xl" />
    </div>
  );
}

function Block({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-hairline bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 id={id} className="text-[14px] font-semibold text-text">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The map's exec id of the running course: GZM keys a live vehicle by its side alone. */
function liveExec(v: FleetVehicleDetail, c: FleetCurrentCourse): string | null {
  if (v.operator === "GZM") return `gzm:${v.sideNumber}`;
  return c.courseLoid === undefined ? null : `mzk:${c.courseLoid}:${v.sideNumber}`;
}

/** "69/1" when the course has a brigade (GZM). */
function brigadeOf(c: { lineName: string; brigade?: string }): string | null {
  return c.brigade ? `${c.lineName}/${c.brigade}` : null;
}

function VehicleBody({ v, onShowOnMap }: { v: FleetVehicleDetail; onShowOnMap?: ShowOnMap }) {
  const nowSecs = useNow(30_000);
  const nowEpoch = useEpochNow(30_000);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const cur = v.currentCourse;

  const ganttCourses = useMemo<GanttCourse[]>(() => {
    const out: GanttCourse[] = v.todayCourses.map((course) => ({ course, live: false }));
    if (cur) out.push({ course: cur, live: true, notStarted: cur.notStarted });
    return out;
  }, [v.todayCourses, cur]);

  const delayColumns = useMemo<DelayColumn[]>(() => {
    const measured: { c: VehicleCourseRecord; live: boolean }[] = v.todayCourses
      .filter((c) => c.status === "completed")
      .map((c) => ({ c, live: false }));
    if (cur && !cur.notStarted) measured.push({ c: cur, live: true });
    return measured
      .sort((a, b) => a.c.startSecs - b.c.startSecs)
      .map(({ c, live }) => ({
        id: c.id,
        label: c.startTime,
        lineName: c.lineName,
        delaySec: c.delaySec,
        live,
        title: `Linia ${c.lineName}, ${c.startTime}–${c.endTime}: ${fmtDelay(c.delaySec)}${live ? " (w trakcie)" : ""}`,
      }));
  }, [v.todayCourses, cur]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reveal = (id: string) => {
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    requestAnimationFrame(() => document.getElementById(`course-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const s = v.stats;
  const roadLog: { c: VehicleCourseRecord; live: boolean }[] = [
    ...(cur ? [{ c: cur, live: true }] : []),
    ...v.todayCourses.map((c) => ({ c, live: false })),
  ];

  return (
    <div className="space-y-4">
      <StatusBlock v={v} nowEpoch={nowEpoch} onShowOnMap={onShowOnMap} />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Kursy dziś" value={String(s.totalCoursesToday)}>
          {s.cancelledCoursesToday > 0 ? (
            <span className="text-danger">
              {s.cancelledCoursesToday} {pluralPl(s.cancelledCoursesToday, "przerwany", "przerwane", "przerwanych")}
            </span>
          ) : (
            `${s.completedCoursesToday} ${pluralPl(s.completedCoursesToday, "zakończony", "zakończone", "zakończonych")}`
          )}
        </Kpi>
        <Kpi label="Przejechane dziś" value={fmtKm(s.kmToday)}>
          według długości kursów
        </Kpi>
        <Kpi label="Średnie opóźnienie" value={s.measuredCourses > 0 ? fmtDelayMin(s.averageDelaySecs) : "–"}>
          {s.measuredCourses > 0 ? `z ${s.measuredCourses} ${pluralPl(s.measuredCourses, "kursu", "kursów", "kursów")}` : "brak pomiarów"}
        </Kpi>
        <Kpi label="Punktualność" value={s.punctualityPct !== null ? `${s.punctualityPct}%` : "–"}>
          od −1 do +3 min
        </Kpi>
      </dl>

      <Block
        title="Linie dziś"
        aside={v.mainLine && v.lines.length > 1 ? <span className="text-[12px] text-text-mute">najczęściej linia {v.mainLine}</span> : null}
      >
        {v.lines.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Linie obsłużone dziś">
            {v.lines.map((l) => (
              <li key={l}>
                <LineBadge line={l} operator={v.operator} big={l === v.mainLine} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-mute">Dziś ten pojazd jeszcze nie kursował.</p>
        )}
        <p className="mt-3 flex gap-2 text-[12px] leading-snug text-text-faint">
          <InfoIcon size={14} className="mt-px shrink-0" />
          {v.operator === "GZM"
            ? "Brygady kursów i następny kurs pochodzą z rozkładu GZM."
            : "MZK nie publikuje numerów brygad, dlatego pokazujemy linie obsłużone dziś przez ten pojazd."}
        </p>
      </Block>

      {ganttCourses.length > 0 ? (
        <Block title="Przebieg dnia">
          <CourseGantt courses={ganttCourses} nowSecs={nowSecs} onSelect={reveal} />
          <div className="mt-2">
            <GanttLegend showWaiting={Boolean(cur?.notStarted)} />
          </div>
        </Block>
      ) : null}

      {delayColumns.length >= 2 ? (
        <Block title="Opóźnienie na kolejnych kursach" aside={<span className="text-[12px] text-text-mute">przyjazd na końcowy</span>}>
          <CourseDelayColumns columns={delayColumns} />
        </Block>
      ) : null}

      {v.predictedNextCourse ? <PredictionCard p={v.predictedNextCourse} operator={v.operator} /> : null}

      <Block
        title="Karta drogowa"
        aside={
          roadLog.length > 0 ? (
            <span className="text-[12px] text-text-mute tabular-nums">
              {roadLog.length} {pluralPl(roadLog.length, "kurs", "kursy", "kursów")}
            </span>
          ) : null
        }
      >
        {roadLog.length > 0 ? (
          <ul className="-mx-1 divide-y divide-hairline">
            {roadLog.map(({ c, live }) => (
              <CourseRow key={c.id} c={c} live={live} open={expanded.has(c.id)} onToggle={toggle} operator={v.operator} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-mute">Brak kursów zarejestrowanych dzisiaj.</p>
        )}
      </Block>

      <Block title="Dane techniczne">
        {v.operator === "GZM" ? (
          // GZM publishes the model only: no producer, year, length, propulsion or equipment
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
            <dt className="text-text-mute">Numer taborowy</dt>
            <dd className="font-semibold text-text tabular-nums">#{v.label ?? v.sideNumber}</dd>
            <dt className="text-text-mute">Przewoźnik</dt>
            <dd className="text-text">{v.company || "–"}</dd>
            <dt className="text-text-mute">Model</dt>
            <dd className="text-text">{v.model || "–"}</dd>
          </dl>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
            <dt className="text-text-mute">Numer boczny</dt>
            <dd className="font-semibold text-text tabular-nums">#{v.sideNumber}</dd>
            <dt className="text-text-mute">Producent</dt>
            <dd className="text-text">{v.producer || "–"}</dd>
            <dt className="text-text-mute">Model</dt>
            <dd className="text-text">{v.model || "–"}</dd>
            <dt className="text-text-mute">Rok produkcji</dt>
            <dd className="text-text tabular-nums">{v.year ?? "–"}</dd>
            <dt className="text-text-mute">Długość</dt>
            <dd className="text-text">{v.lengthCategory ? LENGTH_LABEL[v.lengthCategory] : "–"}</dd>
            <dt className="text-text-mute">Napęd</dt>
            <dd className="text-text">{v.fuelType ? FUEL_LABEL[v.fuelType] : "–"}</dd>
            <dt className="text-text-mute">Wyposażenie</dt>
            <dd className="text-text">{featureList(v.features).join(", ") || "–"}</dd>
          </dl>
        )}
      </Block>
    </div>
  );
}

function Kpi({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-3 py-2.5">
      <dt className="text-[11.5px] font-medium text-text-mute">{label}</dt>
      <dd className="mt-0.5 text-[18px] font-bold text-text tabular-nums">{value}</dd>
      <dd className="text-[11.5px] text-text-faint">{children}</dd>
    </div>
  );
}

function StatusBlock({ v, nowEpoch, onShowOnMap }: { v: FleetVehicleDetail; nowEpoch: number; onShowOnMap?: ShowOnMap }) {
  const c = v.currentCourse;
  if (c && v.status === "active") {
    const exec = liveExec(v, c);
    const brigade = brigadeOf(c);
    const driven = c.drivenMeters !== undefined ? c.drivenMeters / 1000 : null;
    const length = c.lengthMeters !== undefined ? c.lengthMeters / 1000 : null;
    return (
      <section aria-label="Bieżący kurs" className="flex flex-col rounded-2xl border border-hairline bg-surface p-4">
        <div className="flex items-center gap-2.5">
          <LineBadge line={c.lineName} operator={v.operator} big />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-text">{c.direction}</p>
            <p className="text-[12.5px] text-text-mute tabular-nums">
              Kurs {c.startTime}–{c.endTime} z {c.firstStopName}
              {brigade ? `, brygada ${brigade}` : null}
            </p>
          </div>
          {!c.notStarted ? <DelayBadge sec={c.delaySec} size="md" /> : null}
        </div>

        {c.notStarted ? (
          <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-text">
            Czeka na odjazd o <span className="font-semibold tabular-nums">{c.startTime}</span> z przystanku {c.firstStopName}.
          </p>
        ) : (
          <>
            <p className="mt-3 text-[13px] text-text">
              {c.atStop ? (
                <>
                  Na przystanku <span className="font-semibold">{c.currentStopName}</span>
                </>
              ) : c.nextStopName ? (
                <>
                  Następny przystanek: <span className="font-semibold">{c.nextStopName}</span>
                </>
              ) : (
                <>
                  Ostatni przystanek: <span className="font-semibold">{c.currentStopName}</span>
                </>
              )}
            </p>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-label="Postęp kursu"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(c.progressPct)}
            >
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, c.progressPct))}%`, background: SERIES_FILL }} />
            </div>
            <p className="mt-1.5 flex justify-between gap-3 text-[12px] text-text-mute tabular-nums">
              <span>
                {driven !== null && length !== null && length > 0
                  ? `${fmtKm(driven)} z ${fmtKm(length)}`
                  : `przystanek ${c.currentStopIndex + 1} z ${c.stopsCount}`}
              </span>
              <span>{Math.round(c.progressPct)}%</span>
            </p>
          </>
        )}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
          <span className="text-[12px] text-text-faint">Pozycja {fmtAgo(c.fixAt ?? v.lastSeenAt, nowEpoch)}</span>
          {exec ? (
            <a
              href={`/?exec=${encodeURIComponent(exec)}`}
              onClick={(e) => {
                // a modified click still opens a new tab
                if (!onShowOnMap || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onShowOnMap(exec);
              }}
              className="inline-flex min-h-10 items-center gap-2 rounded-full bg-brand px-4 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hi"
            >
              <MapIcon size={15} />
              Pokaż na mapie
            </a>
          ) : null}
        </div>
      </section>
    );
  }

  const loc = v.lastKnownLocation;
  const hasCoords = loc && Math.abs(loc.lat) > 1 && Math.abs(loc.lon) > 1;
  return (
    <section aria-label="Stan pojazdu" className="flex flex-col rounded-2xl border border-hairline bg-surface p-4">
      <p className="text-[15px] font-semibold text-text">Nie kursuje</p>
      <p className="mt-1 text-[13px] text-text-mute">
        {v.lastSeenAt > 0 ? (
          <>
            Ostatnio w trasie {fmtAgo(v.lastSeenAt, nowEpoch)}
            {loc?.name ? `. ${loc.name}` : ""}
          </>
        ) : (
          "Dziś nie wyjechał na trasę."
        )}
      </p>
      {v.lastSeenAt > 0 && hasCoords ? (
        <div className="mt-auto pt-3">
          <a
            href={`/?${v.operator === "GZM" ? "city=gzm&" : ""}map=${loc.lat.toFixed(5)},${loc.lon.toFixed(5)},16`}
            className="inline-flex min-h-10 items-center gap-2 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text transition-colors hover:bg-tint/12"
          >
            <MapIcon size={15} />
            Ostatnia pozycja na mapie
          </a>
        </div>
      ) : null}
    </section>
  );
}

function PredictionCard({ p, operator }: { p: NonNullable<FleetVehicleDetail["predictedNextCourse"]>; operator: Operator }) {
  // "high" = the brigade's next trip from the GZM schedule, not a guess
  const scheduled = p.confidence === "high";
  return (
    <section
      aria-label={scheduled ? "Następny kurs według rozkładu" : "Następny kurs, szacunek"}
      className={`rounded-2xl border p-4 ${scheduled ? "border-hairline bg-surface" : "border-dashed border-tint/15"}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-text">{scheduled ? "Następny kurs" : "Następny kurs (szacunek)"}</h3>
        <span className="rounded-full bg-tint/6 px-2 py-0.5 text-[11.5px] font-medium text-text-mute">
          {scheduled ? "według rozkładu" : p.confidence === "medium" ? "średnia pewność" : "niska pewność"}
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <LineBadge line={p.lineName} operator={operator} />
        <p className="min-w-0 flex-1 text-[13.5px] text-text">
          <span className="font-medium">{p.direction}</span>
          <span className="block text-[12.5px] text-text-mute tabular-nums">
            {scheduled
              ? `${p.departureTime} z ${p.fromStopName}, postój ${p.pauseMinutes} min`
              : `ok. ${p.departureTime} z ${p.fromStopName}, postój ok. ${p.pauseMinutes} min`}
          </span>
        </p>
      </div>
      <p className="mt-2.5 text-[12px] leading-snug text-text-faint">{p.reason}</p>
    </section>
  );
}

function CourseRow({
  c,
  live,
  open,
  onToggle,
  operator,
}: {
  c: VehicleCourseRecord | FleetCurrentCourse;
  live: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  operator: Operator;
}) {
  const panelId = useId();
  const brigade = brigadeOf(c);
  const notStarted = live && "notStarted" in c && Boolean(c.notStarted);
  const cancelled = c.status === "cancelled";
  const km = c.drivenMeters !== undefined ? c.drivenMeters / 1000 : null;
  return (
    <li id={`course-${c.id}`} className="scroll-mt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onToggle(c.id)}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-tint/5"
      >
        <span className="w-[5.5rem] shrink-0 text-[12.5px] text-text-mute tabular-nums">
          {c.startTime}–{c.endTime}
        </span>
        <LineBadge line={c.lineName} operator={operator} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text">
            {c.firstStopName} → {c.lastStopName}
          </span>
          {brigade || (km !== null && km > 0) ? (
            <span className="block text-[11.5px] text-text-faint tabular-nums">
              {[brigade ? `brygada ${brigade}` : null, km !== null && km > 0 ? fmtKm(km) : null].filter(Boolean).join(", ")}
            </span>
          ) : null}
        </span>
        {cancelled ? (
          <span className="shrink-0 rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-semibold text-danger">Przerwany</span>
        ) : notStarted ? (
          <span className="shrink-0 rounded-md bg-tint/6 px-1.5 py-0.5 text-[12px] font-medium text-text-mute">Czeka</span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5">
            {live ? <span className="text-[11.5px] font-medium text-good">teraz</span> : null}
            <DelayBadge sec={c.delaySec} />
          </span>
        )}
        <ChevronDownIcon size={16} className={`shrink-0 text-text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div id={panelId} hidden={!open} className="pb-3 pl-1 pr-1">
        {open ? (
          <>
          {cancelled && c.cancelledReason ? (
            <p className="mb-2 flex gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] leading-snug text-text">
              <AlertIcon size={14} className="mt-0.5 shrink-0 text-danger" />
              {c.cancelledReason}
            </p>
          ) : null}
          {c.stops && c.stops.length > 0 ? (
            <div className="kb-scroll max-h-80 overflow-y-auto rounded-lg border border-hairline">
              <table className="w-full text-[12.5px] tabular-nums">
                <thead className="sticky top-0 bg-surface-2 text-left text-text-mute">
                  <tr>
                    <th scope="col" className="px-3 py-1.5 font-medium">Przystanek</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Rozkład</th>
                    <th scope="col" className="px-3 py-1.5 text-right font-medium">{c.status === "in_progress" ? "Prognoza" : "Ostatnia prognoza"}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.stops.map((st, i) => (
                    <tr
                      key={`${st.symbol}-${i}`}
                      className={`border-t border-hairline ${st.status === "current" ? "bg-primary-dim" : ""}`}
                      aria-current={st.status === "current" ? "location" : undefined}
                    >
                      <th scope="row" className={`px-3 py-1.5 text-left font-normal ${st.status === "passed" ? "text-text-mute" : "text-text"}`}>
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              st.status === "current" ? "bg-primary" : st.status === "passed" ? "bg-text-faint" : "border border-text-faint"
                            }`}
                          />
                          {st.name}
                        </span>
                      </th>
                      <td className="px-2 py-1.5 text-right text-text-mute">{st.scheduledTime}</td>
                      <td className="px-3 py-1.5 text-right text-text">{st.plannedTime !== st.scheduledTime ? st.plannedTime : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[12.5px] text-text-mute">Brak listy przystanków dla tego kursu.</p>
          )}
          </>
        ) : null}
      </div>
    </li>
  );
}
