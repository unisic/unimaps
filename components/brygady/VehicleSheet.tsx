"use client";

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { isNotFound, useVehicleDetail, useVehiclePhotos, type FleetSummaryItem } from "@/lib/client/fleet";
import { prefersReducedMotion } from "@/lib/client/motion";
import type { FleetCurrentCourse, FleetVehicleDetail, VehicleCourseRecord, VehiclePhoto } from "@/lib/shared/fleet";
import { useNow } from "../hooks";
import { CaretLeftIcon, CaretRightIcon } from "../icons";
import { CloseIcon, LineBadge, ShareButton } from "../ui";
import { CourseDelayColumns, CourseGantt, GanttLegend, type DelayColumn, type GanttCourse } from "./charts";
import {
  AlertIcon,
  ChevronDownIcon,
  DelayBadge,
  featureList,
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

/** Modal sheet: bottom sheet on phones, centred dialog from md up. */
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
  const { data, error, isLoading, mutate } = useVehicleDetail(side);
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
        <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/15 md:hidden" />
        <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 pb-3 pt-2 md:pt-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[18px] font-bold text-text tabular-nums">
              Pojazd #{side}
            </h2>
            <p className="truncate text-[13px] text-text-mute">
              {model ?? (notFound ? "Nieznany pojazd" : " ")}
              {vehicle?.year ? <span className="text-text-faint"> ({vehicle.year})</span> : null}
            </p>
          </div>
          <ShareButton title={`Pojazd MZK #${side}`} path={`/brygady?tabor=${encodeURIComponent(side)}`} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij kartę pojazdu"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-white/8 hover:text-text"
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
              <p className="text-[15px] font-medium text-text">Nie znamy pojazdu #{side}</p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
                Tego numeru nie ma we flocie MZK Bielsko-Biała. Link mógł się zestarzeć albo numer ma literówkę.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-4 min-h-10 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text hover:bg-white/12"
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

function liveExec(v: FleetVehicleDetail, c: FleetCurrentCourse): string | null {
  return c.courseLoid === undefined ? null : `mzk:${c.courseLoid}:${v.sideNumber}`;
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
      <div className="space-y-4 md:flex md:gap-4 md:space-y-0">
        <PhotoGallery side={v.sideNumber} />
        <StatusBlock v={v} nowEpoch={nowEpoch} onShowOnMap={onShowOnMap} />
      </div>

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
                <LineBadge line={l} operator="MZK" big={l === v.mainLine} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-mute">Dziś ten pojazd jeszcze nie kursował.</p>
        )}
        <p className="mt-3 flex gap-2 text-[12px] leading-snug text-text-faint">
          <InfoIcon size={14} className="mt-px shrink-0" />
          MZK nie publikuje numerów brygad, dlatego pokazujemy linie obsłużone dziś przez ten pojazd.
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

      {v.predictedNextCourse ? <PredictionCard p={v.predictedNextCourse} /> : null}

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
              <CourseRow key={c.id} c={c} live={live} open={expanded.has(c.id)} onToggle={toggle} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-mute">Brak kursów zarejestrowanych dzisiaj.</p>
        )}
      </Block>

      <Block title="Dane techniczne">
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
          <dd className="text-text">{LENGTH_LABEL[v.lengthCategory]}</dd>
          <dt className="text-text-mute">Napęd</dt>
          <dd className="text-text">{FUEL_LABEL[v.fuelType]}</dd>
          <dt className="text-text-mute">Wyposażenie</dt>
          <dd className="text-text">{featureList(v.features).join(", ") || "–"}</dd>
        </dl>
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
    const driven = c.drivenMeters !== undefined ? c.drivenMeters / 1000 : null;
    const length = c.lengthMeters !== undefined ? c.lengthMeters / 1000 : null;
    return (
      <section aria-label="Bieżący kurs" className="flex flex-col rounded-2xl border border-hairline bg-surface p-4 md:min-w-0 md:flex-1">
        <div className="flex items-center gap-2.5">
          <LineBadge line={c.lineName} operator="MZK" big />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-text">{c.direction}</p>
            <p className="text-[12.5px] text-text-mute tabular-nums">
              Kurs {c.startTime}–{c.endTime} z {c.firstStopName}
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
          <span className="text-[12px] text-text-faint">Pozycja {fmtAgo(v.lastSeenAt, nowEpoch)}</span>
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
    <section aria-label="Stan pojazdu" className="flex flex-col rounded-2xl border border-hairline bg-surface p-4 md:min-w-0 md:flex-1">
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
            href={`/?map=${loc.lat.toFixed(5)},${loc.lon.toFixed(5)},16`}
            className="inline-flex min-h-10 items-center gap-2 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text transition-colors hover:bg-white/12"
          >
            <MapIcon size={15} />
            Ostatnia pozycja na mapie
          </a>
        </div>
      ) : null}
    </section>
  );
}

const STRIP = "flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const ARROW =
  "absolute top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-[15px] text-white transition-opacity hover:bg-black/75 disabled:pointer-events-none disabled:opacity-0 pointer-coarse:hidden";

const slideAt = (el: HTMLElement) => Math.round(el.scrollLeft / el.clientWidth);

function slideTo(el: HTMLElement | null, k: number) {
  el?.scrollTo({ left: k * el.clientWidth, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** The newest phototrans photos as a swipeable strip (scroll snap), hot-linked and credited; a tap
 *  opens the photo's page on phototrans, the only place its original shows (phototrans answers a
 *  foreign Referer with an empty page). Nothing when the vehicle has none. */
function PhotoGallery({ side }: { side: string }) {
  const { data, isLoading } = useVehiclePhotos(side);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [index, setIndex] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  if (isLoading) return <div className="skeleton aspect-[3/2] w-full rounded-2xl md:w-[300px] md:shrink-0 md:self-start" />;
  const photos = (data?.photos ?? []).filter((ph) => !failed.has(ph.thumb));
  if (photos.length === 0) return null;
  const n = photos.length;
  const i = Math.min(index, n - 1);
  return (
    <figure
      aria-label={`Zdjęcia pojazdu #${side}`}
      className="overflow-hidden rounded-2xl border border-hairline bg-surface md:w-[300px] md:shrink-0 md:self-start"
    >
      <div className="relative">
        <div ref={stripRef} onScroll={(e) => setIndex(slideAt(e.currentTarget))} className={STRIP}>
          {photos.map((ph, k) => (
            <a
              key={ph.thumb}
              href={ph.page}
              target="_blank"
              rel="noopener"
              title="Pełna rozdzielczość na phototrans"
              className="block w-full shrink-0 snap-center"
            >
              {/* the photos stay on phototrans: next/image would re-host them through our server */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={ph.thumb}
                alt={`Pojazd #${side}, zdjęcie ${k + 1} z ${n}, fot. ${ph.author}`}
                width={300}
                height={200}
                loading={k === 0 ? "eager" : "lazy"}
                draggable={false}
                className="aspect-[3/2] w-full bg-surface-2 object-cover"
                onError={() => setFailed((prev) => new Set(prev).add(ph.thumb))}
              />
            </a>
          ))}
        </div>
        {n > 1 ? (
          <>
            <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-white">
              {i + 1} / {n}
            </span>
            <SlideArrows i={i} n={n} go={(k) => slideTo(stripRef.current, k)} />
          </>
        ) : null}
      </div>
      <PhotoCredit p={photos[i]} className="px-3 py-2" />
    </figure>
  );
}

function SlideArrows({ i, n, go }: { i: number; n: number; go: (k: number) => void }) {
  return (
    <>
      <button type="button" aria-label="Poprzednie zdjęcie" disabled={i === 0} onClick={() => go(i - 1)} className={`${ARROW} left-2`}>
        <CaretLeftIcon size="1em" weight="bold" aria-hidden />
      </button>
      <button type="button" aria-label="Następne zdjęcie" disabled={i === n - 1} onClick={() => go(i + 1)} className={`${ARROW} right-2`}>
        <CaretRightIcon size="1em" weight="bold" aria-hidden />
      </button>
    </>
  );
}

function PhotoCredit({ p, className }: { p: VehiclePhoto; className: string }) {
  return (
    <figcaption className={`flex items-baseline gap-1.5 text-[12px] text-text-mute ${className}`}>
      <span className="min-w-0 truncate">
        Fot.{" "}
        <a href={p.authorPage} target="_blank" rel="noopener" className="font-medium text-text hover:underline">
          {p.author}
        </a>
        {p.date ? <span className="tabular-nums"> · {fmtPhotoDate(p.date)}</span> : null}
      </span>
      <a href={p.page} target="_blank" rel="noopener" className="ml-auto shrink-0 text-text-faint hover:text-text">
        phototrans
      </a>
    </figcaption>
  );
}

function fmtPhotoDate(date: NonNullable<VehiclePhoto["date"]>): string {
  const [y, m, d] = date.split("-");
  return `${Number(d)}.${m}.${y}`;
}

function PredictionCard({ p }: { p: NonNullable<FleetVehicleDetail["predictedNextCourse"]> }) {
  return (
    <section aria-label="Następny kurs, szacunek" className="rounded-2xl border border-dashed border-white/15 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-text">Następny kurs (szacunek)</h3>
        <span className="rounded-full bg-white/6 px-2 py-0.5 text-[11.5px] font-medium text-text-mute">
          {p.confidence === "medium" ? "średnia pewność" : "niska pewność"}
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <LineBadge line={p.lineName} operator="MZK" />
        <p className="min-w-0 flex-1 text-[13.5px] text-text">
          <span className="font-medium">{p.direction}</span>
          <span className="block text-[12.5px] text-text-mute tabular-nums">
            ok. {p.departureTime} z {p.fromStopName}, postój ok. {p.pauseMinutes} min
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
}: {
  c: VehicleCourseRecord | FleetCurrentCourse;
  live: boolean;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const panelId = useId();
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
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-white/5"
      >
        <span className="w-[5.5rem] shrink-0 text-[12.5px] text-text-mute tabular-nums">
          {c.startTime}–{c.endTime}
        </span>
        <LineBadge line={c.lineName} operator="MZK" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text">
            {c.firstStopName} → {c.lastStopName}
          </span>
          {km !== null && km > 0 ? <span className="block text-[11.5px] text-text-faint tabular-nums">{fmtKm(km)}</span> : null}
        </span>
        {cancelled ? (
          <span className="shrink-0 rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-semibold text-danger">Przerwany</span>
        ) : notStarted ? (
          <span className="shrink-0 rounded-md bg-white/6 px-1.5 py-0.5 text-[12px] font-medium text-text-mute">Czeka</span>
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
