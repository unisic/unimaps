"use client";

import { memo, useEffect, useId, useRef, useState } from "react";
import TopBarSearch, { type TopBarSearchHandle } from "@/components/TopBarSearch";
import {
  ArrowRightIcon,
  CardsIcon,
  MegaphoneSimpleIcon,
  MoonIcon,
  NavigationArrowIcon,
  SlidersHorizontalIcon,
  SunIcon,
  XIcon,
} from "@/components/icons";
import { useAnnouncements } from "@/lib/client/announcements";
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
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={checked}
      aria-describedby={hint ? hintId : undefined}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/5"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-text">{label}</span>
        {hint && (
          <span id={hintId} className="text-[12px] leading-snug text-text-faint">
            {hint}
          </span>
        )}
      </span>
      <span
        className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full px-[3px] transition-colors duration-200 ${
          checked ? "bg-primary" : "bg-white/12"
        }`}
        aria-hidden
      >
        <span
          className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-spring ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

/** Radio group drawn as one pill track; the checked segment lifts onto surface-3. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; title?: string; lead?: React.ReactNode }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex rounded-full bg-white/5 p-1" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={`tap inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-medium ${
              on ? "bg-surface-3 text-text shadow-sm" : "text-text-mute hover:text-text"
            }`}
          >
            {o.lead}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function OperatorDot({ op }: { op: "kb" | "mzk" }) {
  return (
    <span className={`h-2 w-2 shrink-0 rounded-full ${op === "kb" ? "bg-kb" : "bg-mzk"}`} aria-hidden />
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-1.5 pt-2 text-[12px] font-medium text-text-faint">{children}</p>;
}

const OPERATOR_OPTIONS: { id: "all" | "kb" | "mzk"; label: string; title?: string; lead?: React.ReactNode }[] = [
  { id: "all", label: "Wszyscy" },
  { id: "kb", label: "KB", title: "Komunikacja Beskidzka", lead: <OperatorDot op="kb" /> },
  { id: "mzk", label: "MZK", title: "MZK Bielsko-Biała", lead: <OperatorDot op="mzk" /> },
];

const LAYER_LEAD: Record<BaseLayerId, React.ReactNode> = {
  kb: <SunIcon />,
  dark: <MoonIcon />,
};

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
      <div className="surface flex h-12 items-center gap-1 rounded-full pl-3.5 pr-1.5">
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

        {/* Active operator filter: visible only while it hides part of the fleet */}
        {operatorFilter !== "all" && (
          <button
            type="button"
            onClick={() => onOperatorFilter("all")}
            aria-label={`Filtr przewoźnika: ${operatorFilter.toUpperCase()}. Pokaż wszystkich`}
            title="Pokaż wszystkich przewoźników"
            className="tap flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/8 pl-2.5 pr-2 text-[12px] font-semibold text-text hover:bg-white/12"
          >
            <OperatorDot op={operatorFilter} />
            {operatorFilter.toUpperCase()}
            <XIcon className="text-[11px] text-text-mute" />
          </button>
        )}

        {/* Online vehicles count */}
        <span
          className="flex shrink-0 items-center gap-1.5 px-2 text-[12.5px] font-semibold tabular-nums text-text-mute"
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
          title="Utrudnienia w ruchu"
          onClick={() => {
            setMenu(false);
            searchRef?.current?.blur();
            onOpenAnnouncements();
          }}
          className="tap relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-[19px] text-text-mute hover:bg-white/8 hover:text-text md:h-9 md:w-9 md:text-[18px]"
        >
          <MegaphoneSimpleIcon />
          {unseen && (
            <span
              className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-surface animate-pop md:right-1.5 md:top-1.5"
              aria-hidden
            />
          )}
        </button>

        {/* Map settings button */}
        <button
          type="button"
          aria-label="Ustawienia mapy"
          aria-expanded={menu}
          title="Ustawienia mapy"
          onClick={() => {
            setMenu((v) => !v);
            searchRef?.current?.blur();
          }}
          className={`tap grid h-10 w-10 shrink-0 place-items-center rounded-full text-[19px] md:h-9 md:w-9 md:text-[18px] ${
            menu ? "bg-white/10 text-text" : "text-text-mute hover:bg-white/8 hover:text-text"
          }`}
        >
          <SlidersHorizontalIcon />
        </button>
      </div>

      {/* Settings dropdown menu */}
      {menu && (
        <div className="surface mt-2 rounded-[20px] p-2 text-[13.5px] animate-drop">
          <MenuLabel>Przewoźnik</MenuLabel>
          <div className="px-1">
            <Segmented
              label="Wybór przewoźnika"
              value={operatorFilter}
              options={OPERATOR_OPTIONS}
              onChange={onOperatorFilter}
            />
          </div>

          {Object.keys(BASE_LAYERS).length > 1 && (
            <>
              <MenuLabel>Mapa</MenuLabel>
              <div className="px-1">
                <Segmented
                  label="Styl mapy"
                  value={baseLayer}
                  options={(Object.keys(BASE_LAYERS) as BaseLayerId[]).map((id) => ({
                    id,
                    label: BASE_LAYERS[id].name,
                    lead: LAYER_LEAD[id],
                  }))}
                  onChange={onBaseLayer}
                />
              </div>
            </>
          )}

          <div className="mt-2 border-t border-hairline pt-1">
            <SwitchRow checked={stopsVisible} onToggle={onToggleStops} label="Przystanki na mapie" />
            <SwitchRow
              checked={smoothMotion}
              onToggle={() => setSmoothMotion(!smoothMotion)}
              label="Płynny ruch pojazdów"
              hint="Szacuje pozycję autobusu między aktualizacjami"
            />
          </div>

          <a
            href="/brygady"
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-text transition-colors hover:bg-white/5"
          >
            <CardsIcon className="text-[17px] text-text-mute" />
            <span className="flex-1">Karty brygad i tabor na żywo</span>
            <ArrowRightIcon className="text-[14px] text-text-faint transition-transform duration-200 group-hover:translate-x-0.5" />
          </a>

          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-hairline px-3 pb-1.5 pt-3 text-[12px] text-text-mute">
            <span className="inline-flex items-center gap-1.5">
              <OperatorDot op="kb" />
              KB
            </span>
            <span className="inline-flex items-center gap-1.5">
              <OperatorDot op="mzk" />
              MZK
            </span>
            <span className="inline-flex items-center gap-1.5">
              <NavigationArrowIcon weight="fill" className="rotate-45 text-[11px]" />
              kierunek jazdy
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(TopBar);
