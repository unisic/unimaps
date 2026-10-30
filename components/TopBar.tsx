"use client";

import { memo, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import TopBarSearch, { type TopBarSearchHandle } from "@/components/TopBarSearch";
import { Segmented } from "@/components/ui";
import {
  ArrowRightIcon,
  BugIcon,
  CardsIcon,
  MegaphoneSimpleIcon,
  MoonIcon,
  NavigationArrowIcon,
  SlidersHorizontalIcon,
  SunIcon,
  XIcon,
} from "@/components/icons";
import { useAnnouncements } from "@/lib/client/announcements";
import { CITY, CityContext, saveCity, withCity, type City } from "@/lib/client/city";
import { useSmoothMotion } from "@/lib/client/smoothMotion";
import { setThemePref, useThemePref, type ThemePref } from "@/lib/client/theme";
import type { GeoPos } from "@/components/hooks";
import type { LineInfo, Stop, Vehicle } from "@/lib/client/types";

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
  onOpenLine: (l: LineInfo) => void;
  onClearLineFilter: () => void;
  onClearView: () => void;
  onOpenNearby: () => void;
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
  badge,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
  badge?: string;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={checked}
      aria-describedby={hint ? hintId : undefined}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-tint/5"
    >
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-text">
          {label}
          {badge && (
            <span className="shrink-0 rounded-full bg-tint/6 px-1.5 py-px text-[10.5px] font-medium text-text-mute">
              {badge}
            </span>
          )}
        </span>
        {hint && (
          <span id={hintId} className="text-[12px] leading-snug text-text-faint">
            {hint}
          </span>
        )}
      </span>
      <span
        className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full px-[3px] transition-colors duration-200 ${
          checked ? "bg-primary" : "bg-tint/12"
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

const OP_DOT = { kb: "bg-kb", mzk: "bg-mzk", gzm: "bg-gzm" } as const;

function OperatorDot({ op }: { op: keyof typeof OP_DOT }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${OP_DOT[op]}`} aria-hidden />;
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-1.5 pt-2 text-[12px] font-medium text-text-faint">{children}</p>;
}

const OPERATOR_OPTIONS: { id: "all" | "kb" | "mzk"; label: string; title?: string; lead?: React.ReactNode }[] = [
  { id: "all", label: "Wszyscy" },
  { id: "kb", label: "KB", title: "Komunikacja Beskidzka", lead: <OperatorDot op="kb" /> },
  { id: "mzk", label: "MZK", title: "MZK Bielsko-Biała", lead: <OperatorDot op="mzk" /> },
];

const CITY_OPTIONS: { id: City; label: string }[] = [
  { id: "bb", label: CITY.bb.name },
  { id: "gzm", label: CITY.gzm.name },
];

/* a full navigation: every store, poll and cache of the page is keyed to one city */
function switchCity(next: City): void {
  saveCity(next);
  window.location.assign(next === "gzm" ? "/?city=gzm" : "/");
}

/** Its own component so the announcements store (and its poll) only runs where it is rendered: never in GZM. */
function AnnouncementsButton({ onClick }: { onClick: () => void }) {
  /* store notifies at most once per 15 min: no extra work in the 5 s cycle */
  const { unseen } = useAnnouncements();
  return (
    <button
      type="button"
      aria-label={unseen ? "Utrudnienia w ruchu (nowe komunikaty)" : "Utrudnienia w ruchu"}
      title="Utrudnienia w ruchu"
      onClick={onClick}
      className="tap relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-[19px] text-text-mute hover:bg-tint/8 hover:text-text md:h-9 md:w-9 md:text-[18px]"
    >
      <MegaphoneSimpleIcon />
      {unseen && (
        <span
          className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-surface animate-pop md:right-1.5 md:top-1.5"
          aria-hidden
        />
      )}
    </button>
  );
}

const THEME_OPTIONS: Array<{ id: ThemePref; label: string }> = [
  { id: "system", label: "Auto" },
  { id: "light", label: "Jasny" },
  { id: "dark", label: "Ciemny" },
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
  onOpenLine,
  onClearLineFilter,
  onClearView,
  onOpenNearby,
  onOpenConnections,
  searchRef,
  operatorFilter,
  onOperatorFilter,
  onShowToast,
}: TopBarProps) {
  const [menu, setMenu] = useState(false);
  const closeMenuOnDropdown = useCallback((isOpen: boolean) => {
    if (isOpen) setMenu(false);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  /* per-browser preference; only this component re-renders on toggle */
  const [smoothMotion, setSmoothMotion] = useSmoothMotion();
  const themePref = useThemePref();
  const city = useContext(CityContext);
  const gzm = city === "gzm";

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
          onOpenLine={onOpenLine}
          onClearLineFilter={onClearLineFilter}
          onToggleStops={onToggleStops}
          stopsVisible={stopsVisible}
          baseLayer={baseLayer}
          onBaseLayer={onBaseLayer}
          onClearView={onClearView}
          onOpenNearby={onOpenNearby}
          onOpenConnections={onOpenConnections}
          searchRef={searchRef}
          onShowToast={onShowToast}
          onDropdownChange={closeMenuOnDropdown}
        />

        {/* Active operator filter: visible only while it hides part of the fleet */}
        {operatorFilter !== "all" && (
          <button
            type="button"
            onClick={() => onOperatorFilter("all")}
            aria-label={`Filtr przewoźnika: ${operatorFilter.toUpperCase()}. Pokaż wszystkich`}
            title="Pokaż wszystkich przewoźników"
            className="tap flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-tint/8 pl-2.5 pr-2 text-[12px] font-semibold text-text hover:bg-tint/12"
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

        {/* Announcements button: KB/MZK only, GZM has no announcements feed */}
        {!gzm && (
          <AnnouncementsButton
            onClick={() => {
              setMenu(false);
              searchRef?.current?.blur();
              onOpenAnnouncements();
            }}
          />
        )}

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
            menu ? "bg-tint/10 text-text" : "text-text-mute hover:bg-tint/8 hover:text-text"
          }`}
        >
          <SlidersHorizontalIcon />
        </button>
      </div>

      {/* Settings dropdown menu */}
      {menu && (
        <div className="surface mt-2 rounded-[20px] p-2 text-[13.5px] animate-drop">
          <MenuLabel>Miasto</MenuLabel>
          <div className="px-1">
            <Segmented label="Wybór miasta" value={city} options={CITY_OPTIONS} onChange={switchCity} />
          </div>

          {!gzm && (
            <>
              <MenuLabel>Przewoźnik</MenuLabel>
              <div className="px-1">
                <Segmented
                  label="Wybór przewoźnika"
                  value={operatorFilter}
                  options={OPERATOR_OPTIONS}
                  onChange={onOperatorFilter}
                />
              </div>
            </>
          )}

          <MenuLabel>Motyw</MenuLabel>
          <div className="px-1">
            <Segmented label="Motyw aplikacji" value={themePref} options={THEME_OPTIONS} onChange={setThemePref} />
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
              badge="wczesna wersja"
              hint="Szacuje pozycję autobusu między aktualizacjami"
            />
          </div>

          <a
            href={`/brygady${withCity("", city)}`}
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-text transition-colors hover:bg-tint/5"
          >
            <CardsIcon className="text-[17px] text-text-mute" />
            <span className="flex-1">Karty brygad i tabor na żywo</span>
            <ArrowRightIcon className="text-[14px] text-text-faint transition-transform duration-200 group-hover:translate-x-0.5" />
          </a>
          <a
            href="https://github.com/unisic/unimaps/issues/new"
            target="_blank"
            rel="noopener"
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-text transition-colors hover:bg-tint/5"
          >
            <BugIcon className="text-[17px] text-text-mute" />
            <span className="flex-1">Zgłoś błąd lub pomysł</span>
            <ArrowRightIcon className="text-[14px] text-text-faint transition-transform duration-200 group-hover:translate-x-0.5" />
          </a>

          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-hairline px-3 pb-1.5 pt-3 text-[12px] text-text-mute">
            {gzm ? (
              <span className="inline-flex items-center gap-1.5">
                <OperatorDot op="gzm" />
                Metropolia GZM
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <OperatorDot op="kb" />
                  KB
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <OperatorDot op="mzk" />
                  MZK
                </span>
              </>
            )}
            <span className="inline-flex items-center gap-1.5">
              <NavigationArrowIcon weight="fill" className="rotate-45 text-[11px]" />
              kierunek jazdy
            </span>
          </div>
          <p className="px-3 pb-1.5 text-[11px] leading-snug text-text-faint [&_a]:text-text-mute [&_a:hover]:text-text">
            Mapa: ©{" "}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">
              OpenStreetMap
            </a>
            ,{" "}
            <a href="https://openfreemap.org" target="_blank" rel="noopener">
              OpenFreeMap
            </a>
            , ©{" "}
            <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">
              OpenMapTiles
            </a>
            . Trasy:{" "}
            <a href="https://project-osrm.org/" target="_blank" rel="noopener">
              OSRM
            </a>
            {CITY[city].attribution && <>. Dane: {CITY[city].attribution}</>}
          </p>
        </div>
      )}
    </div>
  );
}

export default memo(TopBar);
