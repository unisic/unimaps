"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { localUpdatedAt, useFleet, type FleetStats } from "@/lib/client/fleet";
import { BackIcon } from "./ui";
import { DEFAULT_FILTERS, FleetList, type FleetFilters } from "./brygady/FleetList";
import { FleetStatsView } from "./brygady/FleetStatsView";
import { VehicleSheet } from "./brygady/VehicleSheet";
import { AlertIcon, ArrowUpIcon, clockFromEpoch, fmtDelayMin, fmtInt, fmtKm, pluralPl, useEpochNow } from "./brygady/common";

/*
 * /brygady: the MZK Bielsko-Biała fleet, live. View state lives in the URL
 * (`?tabor=<side>` opens a vehicle, `?widok=statystyki` the charts) and is written with
 * the plain History API; Next keeps useSearchParams in sync with pushState/replaceState
 * and preserves our own history.state fields. Opening a vehicle pushes an entry (Android
 * back closes the sheet); a deep-linked sheet closes with replaceState instead, so "close"
 * never navigates away from the page.
 */

type Tab = "pojazdy" | "statystyki";

const TABS: { key: Tab; label: string }[] = [
  { key: "pojazdy", label: "Pojazdy" },
  { key: "statystyki", label: "Statystyki" },
];

/** Data older than this is called out in the header (the poller writes every ~5 s). */
const STALE_AFTER_SEC = 90;

function cleanSide(raw: string | null): string | null {
  const s = raw?.replace(/^#/, "").trim();
  return s && s.length <= 16 ? s : null;
}

function urlWith(mutate: (p: URLSearchParams) => void): string {
  const u = new URL(window.location.href);
  mutate(u.searchParams);
  return `${u.pathname}${u.search}${u.hash}`;
}

function sheetEntry(): boolean {
  return Boolean((window.history.state as { kbTabor?: boolean } | null)?.kbTabor);
}

export default function BrigadesApp() {
  return (
    <Suspense fallback={<PageFrame header={<HeaderBar />} body={<LoadingBody />} />}>
      <Brigades />
    </Suspense>
  );
}

function Brigades() {
  const params = useSearchParams();
  const side = cleanSide(params.get("tabor"));
  const tab: Tab = params.get("widok") === "statystyki" ? "statystyki" : "pojazdy";
  const { data, error, isLoading, mutate } = useFleet(side !== null);
  const [filters, setFilters] = useState<FleetFilters>(DEFAULT_FILTERS);
  const nowEpoch = useEpochNow(30_000);
  const tabsRef = useRef<HTMLDivElement>(null);

  const patchFilters = useCallback((patch: Partial<FleetFilters>) => setFilters((f) => ({ ...f, ...patch })), []);

  const openVehicle = useCallback((s: string) => {
    const url = urlWith((p) => p.set("tabor", s));
    if (sheetEntry()) window.history.replaceState({ kbTabor: true }, "", url);
    else window.history.pushState({ kbTabor: true }, "", url);
  }, []);

  const closeVehicle = useCallback(() => {
    if (sheetEntry()) window.history.back();
    else window.history.replaceState({}, "", urlWith((p) => p.delete("tabor")));
  }, []);

  const setTab = useCallback((t: Tab) => {
    window.history.replaceState(
      {},
      "",
      urlWith((p) => (t === "statystyki" ? p.set("widok", "statystyki") : p.delete("widok"))),
    );
  }, []);

  const pickLine = useCallback(
    (line: string) => {
      setFilters((f) => ({ ...f, q: "", status: "all", fuel: "all", line }));
      setTab("pojazdy");
      requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ block: "start" }));
    },
    [setTab],
  );

  const seed = useMemo(() => (side ? data?.vehicles.find((v) => v.sideNumber === side) : undefined), [data, side]);

  let body: React.ReactNode;
  if (data) {
    body = (
      <>
        {error ? (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-late/30 bg-late/8 px-4 py-2.5 text-[13px] text-text">
            <AlertIcon size={15} className="shrink-0 text-late" />
            <span className="flex-1">
              Nie udało się odświeżyć danych.
              {data.stats.updatedAt > 0 ? ` Ostatnia aktualizacja o ${clockFromEpoch(data.stats.updatedAt)}.` : ""}
            </span>
            <button type="button" onClick={() => void mutate()} className="min-h-8 rounded-lg px-2 font-semibold text-primary hover:bg-primary-dim">
              Odśwież
            </button>
          </div>
        ) : null}
        <KpiStrip stats={data.stats} />
        <div ref={tabsRef} className="scroll-mt-[calc(env(safe-area-inset-top)+4.5rem)]">
          <Tabs tab={tab} onChange={setTab} />
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="mt-4 animate-fade">
          {tab === "pojazdy" ? (
            <FleetList vehicles={data.vehicles} filters={filters} onFiltersChange={patchFilters} onOpen={openVehicle} nowEpoch={nowEpoch} />
          ) : (
            <FleetStatsView data={data} onPickLine={pickLine} onOpenVehicle={openVehicle} />
          )}
        </div>
      </>
    );
  } else if (error && !isLoading) {
    body = (
      <div className="rounded-2xl border border-hairline bg-surface px-4 py-14 text-center">
        <p className="text-[15px] font-medium text-text">Nie udało się pobrać danych floty</p>
        <p className="mt-1 text-[13px] text-text-mute">Sprawdź połączenie. Strona spróbuje ponownie sama.</p>
        <button
          type="button"
          onClick={() => void mutate()}
          className="mt-4 min-h-10 rounded-full bg-brand px-5 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hi"
        >
          Spróbuj ponownie
        </button>
      </div>
    );
  } else {
    body = <LoadingBody />;
  }

  return (
    <>
      <PageFrame inert={side !== null} header={<HeaderBar updatedAt={data ? localUpdatedAt(data) : undefined} />} body={body} />
      {side ? <VehicleSheet key={side} side={side} seed={seed} onClose={closeVehicle} /> : null}
      {side === null ? <ScrollTopButton /> : null}
    </>
  );
}

function PageFrame({ header, body, inert = false }: { header: React.ReactNode; body: React.ReactNode; inert?: boolean }) {
  return (
    <div inert={inert} className="min-h-dvh bg-bg text-text">
      {header}
      <main className="mx-auto w-full max-w-6xl px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-4">
        {body}
        <footer className="mt-10 border-t border-hairline pt-4 text-[12px] leading-relaxed text-text-faint">
          Dane na żywo z systemu MZK Bielsko-Biała. Kursy, opóźnienia i kilometry zbieramy od rana, gdy pojazd jest w trasie.
          MZK nie publikuje numerów brygad ani rozkładów pracy pojazdów, więc następny kurs jest tylko szacunkiem.
        </footer>
      </main>
    </div>
  );
}

function HeaderBar({ updatedAt }: { updatedAt?: number }) {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-bg pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-2 sm:px-4">
        <Link
          href="/"
          aria-label="Wróć do mapy"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-white/8 hover:text-text"
        >
          <BackIcon />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-bold leading-tight text-text">Brygady i tabor</h1>
          <p className="truncate text-[12.5px] text-text-mute">MZK Bielsko-Biała, na żywo</p>
        </div>
        {updatedAt !== undefined ? <LiveClock updatedAt={updatedAt} /> : null}
      </div>
    </header>
  );
}

/** Own 1 s timer, so the ticking clock re-renders only itself. */
function LiveClock({ updatedAt }: { updatedAt: number }) {
  const now = useEpochNow(1000);
  const age = updatedAt > 0 ? now - updatedAt : null;
  const stale = age !== null && age > STALE_AFTER_SEC;
  return (
    <div className="shrink-0 pr-2 text-right">
      <p className="text-[15px] font-semibold leading-tight text-text tabular-nums">{clockFromEpoch(now, true)}</p>
      <p className={`flex items-center justify-end gap-1.5 text-[11.5px] ${stale ? "text-late" : "text-text-faint"}`}>
        {age === null ? (
          "czekam na dane"
        ) : stale ? (
          `dane sprzed ${Math.max(2, Math.round(age / 60))} min`
        ) : (
          <>
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good" />
            dane aktualne
          </>
        )}
      </p>
    </div>
  );
}

function KpiStrip({ stats }: { stats: FleetStats }) {
  const running = stats.activeCount - stats.waitingCount;
  const measured = stats.measuredCount > 0;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Tile label="W trasie" value={fmtInt(running)} note={`z ${fmtInt(stats.totalFleet)} pojazdów${stats.waitingCount > 0 ? `, ${stats.waitingCount} czeka` : ""}`} />
      <Tile
        label="Punktualność"
        value={measured ? `${stats.onTimePercentage}%` : "–"}
        note={measured ? `od −1 do +3 min, ${stats.measuredCount} ${pluralPl(stats.measuredCount, "pojazd", "pojazdy", "pojazdów")}` : "brak pomiarów"}
      />
      <Tile
        label="Mediana opóźnienia"
        value={stats.medianDelaySec !== null ? fmtDelayMin(stats.medianDelaySec) : "–"}
        note={measured ? `średnio ${fmtDelayMin(stats.averageDelaySec)}` : "brak pomiarów"}
      />
      <Tile
        label="Linie w ruchu"
        value={fmtInt(stats.activeLines.length)}
        note={`${fmtInt(stats.seenTodayCount)} ${pluralPl(stats.seenTodayCount, "pojazd wyjechał", "pojazdy wyjechały", "pojazdów wyjechało")} dziś`}
      />
      <div className="col-span-2 sm:col-span-1">
        <Tile
          label="Dziś"
          value={fmtKm(stats.kmToday)}
          note={
            <>
              {fmtInt(stats.coursesCompletedToday)} {pluralPl(stats.coursesCompletedToday, "kurs", "kursy", "kursów")}
              {stats.coursesCancelledToday > 0 ? (
                <span className="text-danger">
                  , {fmtInt(stats.coursesCancelledToday)}{" "}
                  {pluralPl(stats.coursesCancelledToday, "przerwany", "przerwane", "przerwanych")}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </dl>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: React.ReactNode }) {
  return (
    <div className="h-full rounded-2xl border border-hairline bg-surface px-4 py-3">
      <dt className="text-[12px] font-medium text-text-mute">{label}</dt>
      <dd className="mt-0.5 text-[22px] font-bold leading-tight text-text tabular-nums">{value}</dd>
      <dd className="mt-0.5 text-[12px] leading-snug text-text-faint">{note}</dd>
    </div>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.key === tab);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    onChange(TABS[next].key);
    document.getElementById(`tab-${TABS[next].key}`)?.focus();
  };
  return (
    <div role="tablist" aria-label="Widok" onKeyDown={onKeyDown} className="mt-5 flex gap-1 border-b border-hairline">
      {TABS.map((t) => {
        const on = t.key === tab;
        return (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={on ? `panel-${t.key}` : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`-mb-px min-h-11 border-b-2 px-4 text-[14px] font-semibold transition-colors ${
              on ? "border-primary text-text" : "border-transparent text-text-mute hover:text-text"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function LoadingBody() {
  return (
    <div aria-label="Ładowanie floty" role="status">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`skeleton h-[5.75rem] rounded-2xl ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`} />
        ))}
      </div>
      <div className="skeleton mt-5 h-11 w-56 rounded-lg" />
      <div className="skeleton mt-4 h-11 w-full rounded-xl" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton h-40 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

function ScrollTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 900);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0 })}
      aria-label="Przewiń na górę"
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-20 grid h-12 w-12 animate-pop place-items-center rounded-full border border-hairline bg-surface-2 text-text shadow-[var(--shadow-float)] transition-colors hover:bg-surface-3"
    >
      <ArrowUpIcon size={18} />
    </button>
  );
}
