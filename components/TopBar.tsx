"use client";

import { memo, useEffect, useId, useRef, useState } from "react";
import TopBarSearch, { type TopBarSearchHandle } from "@/components/TopBarSearch";
import { useAnnouncements } from "@/lib/client/announcements";
import {
  BRAND,
  BRAND_MZK,
  COLOR_AT_STOP,
  COLOR_EARLY,
  COLOR_LATE,
} from "@/lib/client/format";
import { useSmoothMotion } from "@/lib/client/smoothMotion";
import type { GeoPos } from "@/components/hooks";
import type { Stop, Vehicle } from "@/lib/client/types";

export type BaseLayerId = "kb" | "dark";

export type BaseLayer =
  | {
      /** MapLibre GL vector style (OpenFreeMap) — crisp, keyless, like zbiorkom */
      kind: "vector";
      name: string;
      style: string;
      /** optional CSS filter on the basemap canvas to tune brightness/contrast */
      filter?: string;
    }
  | {
      /** classic raster XYZ tiles */
      kind: "raster";
      name: string;
      url: string;
      attribution: string;
    };

const OFM = (style: string) => `https://tiles.openfreemap.org/styles/${style}`;

export const BASE_LAYERS: Record<BaseLayerId, BaseLayer> = {
  kb: {
    kind: "vector",
    name: "Jasna",
    style: OFM("liberty"),
  },
  dark: {
    kind: "vector",
    name: "Ciemna",
    style: OFM("dark"),
  },
};

export const RASTER_FALLBACK: Record<BaseLayerId, { url: string; attribution: string; className?: string }> = {
  kb: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  dark: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: "raster-dark-filter",
  },
};

export interface TopBarProps {
  count: number | null;
  offline: boolean;
  stopsVisible: boolean;
  onToggleStops: () => void;
  baseLayer: BaseLayerId;
  onBaseLayer: (id: BaseLayerId) => void;
  /** opens the service-announcements sheet ("Utrudnienia") */
  onOpenAnnouncements: () => void;
  // Search props
  stops: Stop[];
  geoPos: GeoPos | null;
  onLocate: () => void;
  onPickStop: (s: Stop) => void;
  onPickVehicle: (v: Vehicle) => void;
  lineFilter: ReadonlySet<string> | null;
  onToggleLine: (line: string) => void;
  onClearLineFilter: () => void;
  onClearView: () => void;
  onOpenConnections?: () => void;
  searchRef?: React.RefObject<TopBarSearchHandle | null>;
  operatorFilter: "all" | "kb" | "mzk";
  onOperatorFilter: (op: "all" | "kb" | "mzk") => void;
  onShowToast?: (msg: string) => void;
}

/** One settings toggle row (role="switch"), optionally with a hint line. */
function SwitchRow({
  checked,
  onToggle,
  label,
  hint,
  className = "",
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
  className?: string;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={checked}
      aria-describedby={hint ? hintId : undefined}
      className={`flex w-full items-center justify-between gap-3 rounded-xl bg-white/4 px-3 py-2.5 text-left transition-colors hover:bg-white/8 ${className}`}
    >
      <span className="flex flex-col">
        <span className="text-text">{label}</span>
        {hint && (
          <span id={hintId} className="text-[11px] leading-snug text-text-faint">
            {hint}
          </span>
        )}
      </span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          checked ? "bg-brand" : "bg-white/15"
        }`}
        aria-hidden
      >
        <span
          className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-text-mute">
      <span className="inline-block h-[10px] w-[10px] rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function TopBar({
  count,
  offline,
  stopsVisible,
  onToggleStops,
  baseLayer,
  onBaseLayer,
  onOpenAnnouncements,
  stops,
  geoPos,
  onLocate,
  onPickStop,
  onPickVehicle,
  lineFilter,
  onToggleLine,
  onClearLineFilter,
  onClearView,
  onOpenConnections,
  searchRef,
  operatorFilter,
  onOperatorFilter,
  onShowToast,
}: TopBarProps) {
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /* per-browser preference; only this component re-renders on toggle */
  const [smoothMotion, setSmoothMotion] = useSmoothMotion();
  /* store notifies at most once per 15 min — no extra work in the 5 s cycle */
  const { unseen } = useAnnouncements();

  /* close the menu on outside tap */
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  return (
    <div
      ref={rootRef}
      className="absolute left-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[1002] w-[min(440px,calc(100vw-24px))] md:left-1/2 md:-translate-x-1/2"
    >
      {/* Search pill with live inline search input */}
      <div className="surface flex h-12 items-center gap-2 rounded-full pl-3.5 pr-1.5 shadow-lg">
        <TopBarSearch
          stops={stops}
          geoPos={geoPos}
          onLocate={onLocate}
          onPickStop={onPickStop}
          onPickVehicle={onPickVehicle}
          lineFilter={lineFilter}
          onToggleLine={onToggleLine}
          onClearLineFilter={onClearLineFilter}
          onToggleStops={onToggleStops}
          stopsVisible={stopsVisible}
          baseLayer={baseLayer}
          onBaseLayer={onBaseLayer}
          onClearView={onClearView}
          onOpenConnections={onOpenConnections}
          searchRef={searchRef}
          onShowToast={onShowToast}
          onDropdownChange={(isOpen) => {
            if (isOpen) setMenu(false);
          }}
        />

        {/* Operator switcher button */}
        <button
          type="button"
          onClick={() => {
            const next = operatorFilter === "all" ? "kb" : operatorFilter === "kb" ? "mzk" : "all";
            onOperatorFilter(next);
          }}
          className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-bold transition-all active:scale-95 border ${
            operatorFilter === "mzk"
              ? "bg-blue-600 text-white border-blue-500/40 shadow-sm"
              : operatorFilter === "kb"
                ? "bg-[#a6192e] text-white border-red-500/40 shadow-sm"
                : "bg-white/6 text-text-mute hover:bg-white/10 hover:text-text border-hairline"
          }`}
          title="Filtruj przewoźnika: Wszyscy / KB / MZK"
        >
          {operatorFilter === "mzk" && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src="/mzk-logo.svg" alt="" className="h-2.5 w-auto filter brightness-0 invert" />
          )}
          {operatorFilter === "kb" && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src="/brand.svg" alt="" className="h-2.5 w-auto filter brightness-0 invert" />
          )}
          <span className="text-[11px]">{operatorFilter === "all" ? "Wszyscy" : operatorFilter.toUpperCase()}</span>
        </button>

        {/* Online vehicles count badge */}
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/8 px-2.5 py-1 text-xs font-bold tabular-nums text-text border border-hairline"
          title={offline ? "Brak połączenia" : "Pojazdy online"}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${offline ? "bg-danger" : "animate-pulse-dot bg-good"}`}
            aria-hidden
          />
          {count ?? "…"}
        </span>

        {/* Announcements button */}
        <button
          type="button"
          aria-label={unseen ? "Utrudnienia w ruchu (nowe komunikaty)" : "Utrudnienia w ruchu"}
          onClick={() => {
            setMenu(false);
            searchRef?.current?.blur();
            onOpenAnnouncements();
          }}
          className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-white/8 hover:text-text md:h-9 md:w-9"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          {unseen && (
            <span
              className="absolute right-2 top-2 h-2 w-2 rounded-full bg-danger md:right-1.5 md:top-1.5"
              aria-hidden
            />
          )}
        </button>

        {/* Brigades & Fleet button */}
        <a
          href="/brygady"
          aria-label="Brygady i tabor"
          title="Brygady i śledzenie taboru na żywo"
          className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-white/8 hover:text-text md:h-9 md:w-9"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4.5" width="18" height="11" rx="2.5" />
            <path d="M3 10.5h18M8 4.5v6M12 4.5v6M16 4.5v6" />
            <circle cx="7.5" cy="16.6" r="1.4" fill="currentColor" />
            <circle cx="16.5" cy="16.6" r="1.4" fill="currentColor" />
          </svg>
        </a>

        {/* Map settings button */}
        <button
          type="button"
          aria-label="Ustawienia mapy"
          aria-expanded={menu}
          onClick={() => {
            setMenu((v) => !v);
            searchRef?.current?.blur();
          }}
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors md:h-9 md:w-9 ${
            menu ? "bg-primary-dim text-primary" : "text-text-mute hover:bg-white/8 hover:text-text"
          }`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
            <circle cx="16" cy="8" r="2" />
            <circle cx="8" cy="16" r="2" />
          </svg>
        </button>
      </div>

      {/* Settings dropdown menu */}
      {menu && (
        <div className="surface mt-2 rounded-2xl p-4 text-[13px] animate-drop">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">Przewoźnik</p>
          <div className="mt-2 mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Wybór przewoźnika">
            {[
              { id: "all", label: "Wszyscy", icon: null },
              { id: "kb", label: "Komunikacja Beskidzka", icon: "/brand.svg" },
              { id: "mzk", label: "MZK Bielsko-Biała", icon: "/mzk-logo.svg" },
            ].map((op) => (
              <button
                key={op.id}
                type="button"
                role="radio"
                aria-checked={operatorFilter === op.id}
                onClick={() => onOperatorFilter(op.id as "all" | "kb" | "mzk")}
                className={`flex-1 basis-[calc(33.333%-4px)] rounded-full px-2.5 py-1.5 text-xs font-semibold transition-all active:scale-95 inline-flex items-center justify-center gap-1 ${
                  operatorFilter === op.id
                    ? op.id === "mzk"
                      ? "bg-blue-600 text-white"
                      : "bg-brand text-on-brand"
                    : "bg-white/6 text-text-mute hover:bg-white/10 hover:text-text"
                }`}
              >
                {op.icon && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={op.icon}
                    alt=""
                    className="h-3 w-auto filter brightness-0 invert"
                  />
                )}
                {op.label}
              </button>
            ))}
          </div>

          {Object.keys(BASE_LAYERS).length > 1 && (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">Mapa</p>
              <div className="mt-2 mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Styl mapy">
                {(Object.keys(BASE_LAYERS) as BaseLayerId[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={baseLayer === id}
                    onClick={() => onBaseLayer(id)}
                    className={`flex-1 basis-[calc(33.333%-4px)] rounded-full px-2.5 py-1.5 text-xs font-semibold transition-all active:scale-95 ${
                      baseLayer === id
                        ? "bg-brand text-on-brand"
                        : "bg-white/6 text-text-mute hover:bg-white/10 hover:text-text"
                    }`}
                  >
                    {BASE_LAYERS[id].name}
                  </button>
                ))}
              </div>
            </>
          )}

          <SwitchRow
            checked={stopsVisible}
            onToggle={onToggleStops}
            label="Przystanki na mapie"
            className="mt-3"
          />
          <SwitchRow
            checked={smoothMotion}
            onToggle={() => setSmoothMotion(!smoothMotion)}
            label="Płynny ruch pojazdów"
            hint="Szacuje pozycję autobusu między aktualizacjami"
            className="mt-2"
          />

          <a
            href="/brygady"
            className="mt-2.5 flex w-full items-center justify-between rounded-xl bg-white/4 px-3 py-2.5 transition-colors hover:bg-white/8 text-text font-semibold text-xs"
          >
            <span className="flex items-center gap-2">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4.5" width="18" height="11" rx="2.5" />
                <path d="M3 10.5h18M8 4.5v6M12 4.5v6M16 4.5v6" />
                <circle cx="7.5" cy="16.6" r="1.4" fill="currentColor" />
                <circle cx="16.5" cy="16.6" r="1.4" fill="currentColor" />
              </svg>
              Karty brygad i tabor na żywo
            </span>
            <span className="text-primary font-bold">&rarr;</span>
          </a>

          <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
            Kolory pojazdów
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs">
            <LegendDot color={BRAND} label="KB w trasie" />
            <LegendDot color={BRAND_MZK} label="MZK w trasie" />
            <LegendDot color={COLOR_AT_STOP} label="na przystanku" />
            <LegendDot color={COLOR_LATE} label="opóźniony" />
            <LegendDot color={COLOR_EARLY} label="przed czasem" />
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(TopBar);
