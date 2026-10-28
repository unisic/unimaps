"use client";

import { memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLines, useVehicles, type GeoPos } from "@/components/hooks";
import {
  BusIcon,
  CheckIcon,
  DropIcon,
  EyeIcon,
  EyeSlashIcon,
  FunnelSimpleXIcon,
  GpsFixIcon,
  LeafIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PathIcon,
  PersonSimpleWalkIcon,
  StarIcon,
  SunIcon,
  XCircleIcon,
  XIcon,
} from "@/components/icons";
import { LineBadge } from "@/components/ui";
import { CityContext, withCity } from "@/lib/client/city";
import { useFavorites } from "@/lib/client/favorites";
import { delayTxt, displayStopName, normalizeText, wozPlural } from "@/lib/client/format";
import { formatDistance, haversineMeters } from "@/lib/client/geo";
import { getAllFleetVehicles, type FleetVehicleSummary } from "@/lib/mzk-fleet";
import type { BaseLayerId } from "@/components/TopBar";
import type { LineInfo, Stop, Vehicle, VehicleFeatures } from "@/lib/client/types";

export interface TopBarSearchHandle {
  focus: () => void;
  blur: () => void;
  clear: () => void;
}

export interface TopBarSearchProps {
  stops: Stop[];
  geoPos: GeoPos | null;
  onLocate: () => void;
  onPickStop: (s: Stop) => void;
  onPickVehicle: (v: Vehicle) => void;
  lineFilter: ReadonlySet<string> | null;
  onToggleLine: (line: string) => void;
  onClearLineFilter: () => void;
  onToggleStops: () => void;
  stopsVisible: boolean;
  baseLayer: BaseLayerId;
  onBaseLayer: (id: BaseLayerId) => void;
  onClearView: () => void;
  onOpenNearby: () => void;
  onOpenConnections?: () => void;
  /** Pass-through handle to allow parent / sibling buttons to focus search */
  searchRef?: React.RefObject<TopBarSearchHandle | null>;
  /** Notifies parent when dropdown opens/closes (e.g. to close settings menu) */
  onDropdownChange?: (open: boolean) => void;
  onShowToast?: (msg: string) => void;
}

/* ---------- result model ---------- */

interface ActionDef {
  id: string;
  label: string;
  keywords: string;
  icon: React.ReactNode;
  run: () => void;
}

type Item =
  | { kind: "line"; l: LineInfo; live: number; active: boolean }
  | { kind: "veh"; v: Vehicle }
  | { kind: "fleet"; f: FleetVehicleSummary; liveVeh?: Vehicle }
  | { kind: "stop"; s: Stop; fav: boolean; dist: number | null }
  | { kind: "action"; a: ActionDef };

interface Section {
  title: string;
  items: Item[];
  best: number;
}

const itemKey = (it: Item): string =>
  it.kind === "action" ? `a-${it.a.id}`
  : it.kind === "line" ? `l-${it.l.id}`
  : it.kind === "veh" ? `v-${it.v.id}`
  : it.kind === "fleet" ? `f-${it.f.sideNumber}`
  : `s-${it.s.id}`;

const CAP = { lines: 4, vehs: 5, fleet: 5, actions: 3, stops: 6 } as const;

/* ---------- glyphs ---------- */

/** Leading tile, as wide as a LineBadge so every row's text starts on one column. */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-7 w-9 shrink-0 place-items-center rounded-lg bg-white/6 text-[15px] text-text-mute" aria-hidden>
      {children}
    </span>
  );
}

const OPERATOR_LABEL = { KB: "KB", MZK: "MZK", GZM: "Metropolia GZM", BOTH: "KB i MZK" } as const;

/** The map's stop marker in miniature: disc for a stop, rounded square for a station, operator colour. */
function StopGlyph({ operator = "KB", station = false }: { operator?: "KB" | "MZK" | "GZM" | "BOTH"; station?: boolean }) {
  const fill =
    operator === "BOTH"
      ? "bg-[linear-gradient(90deg,var(--color-kb)_50%,var(--color-mzk)_50%)]"
      : operator === "MZK"
        ? "bg-mzk"
        : operator === "GZM"
          ? "bg-gzm"
          : "bg-kb";
  return (
    <span className="grid h-7 w-9 shrink-0 place-items-center" aria-hidden>
      <span
        className={`grid place-items-center text-white ${fill} ${
          station ? "h-[22px] w-[22px] rounded-[7px] text-[14px]" : "h-[20px] w-[20px] rounded-full text-[12px]"
        }`}
      >
        <BusIcon weight="fill" />
      </span>
    </span>
  );
}

function Tag({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/6 px-1.5 py-px text-[10.5px] font-medium text-text-mute">
      {icon}
      {children}
    </span>
  );
}

function FuelTag({ fuel }: { fuel: FleetVehicleSummary["fuelType"] }) {
  if (fuel === "hydrogen") return <Tag icon={<DropIcon />}>Wodór</Tag>;
  if (fuel === "electric") return <Tag icon={<LightningIcon />}>Elektryczny</Tag>;
  if (fuel === "hybrid") return <Tag icon={<LeafIcon />}>Hybryda</Tag>;
  return <Tag>Diesel</Tag>;
}

function matchesFleetKeywords(
  q: string,
  f: { model: string; producer: string; fuelType: string; lengthCategory: string; features: VehicleFeatures },
): boolean {
  const nm = normalizeText(f.model);
  const np = normalizeText(f.producer);
  if (nm.includes(q) || np.includes(q)) return true;

  if (
    (q === "wodor" || q === "wodorowy" || q === "wodorowe" || q === "wodorowych" || q === "hydrogen" || q === "h2") &&
    (f.fuelType === "hydrogen" || f.features.hydrogen)
  ) {
    return true;
  }
  if (
    (q === "elektryk" || q === "elektryczny" || q === "elektryczne" || q === "elektrycznych" || q === "electric" || q === "ev") &&
    (f.fuelType === "electric" || f.features.electric)
  ) {
    return true;
  }
  if (
    (q === "hybryda" || q === "hybrydowy" || q === "hybrydowe" || q === "hybrid") &&
    (f.fuelType === "hybrid" || f.features.hybrid)
  ) {
    return true;
  }
  if (
    (q === "przegub" || q === "przegubowy" || q === "przegubowe" || q === "przegubowiec" || q === "mega" || q === "dlugi") &&
    (f.lengthCategory === "MEGA" || f.features.longVehicle)
  ) {
    return true;
  }
  if (q === "mini" && f.lengthCategory === "MINI") return true;
  if (q === "midi" && f.lengthCategory === "MIDI") return true;
  if (q === "maxi" && f.lengthCategory === "MAXI") return true;
  if ((q === "klima" || q === "klimatyzacja" || q === "klimatyzowany") && f.features.airCondition) return true;
  if ((q === "niska podloga" || q === "niskopodlogowy") && f.features.lowFloor) return true;

  return false;
}

function matchesVehicleKeywords(q: string, v: Vehicle): boolean {
  if (v.model && normalizeText(v.model).includes(q)) return true;
  const feat = v.features;
  if (!feat) return false;
  if (
    (q === "wodor" || q === "wodorowy" || q === "wodorowe" || q === "wodorowych" || q === "hydrogen" || q === "h2") &&
    feat.hydrogen
  ) {
    return true;
  }
  if (
    (q === "elektryk" || q === "elektryczny" || q === "elektryczne" || q === "elektrycznych" || q === "electric" || q === "ev") &&
    feat.electric
  ) {
    return true;
  }
  if ((q === "hybryda" || q === "hybrydowy" || q === "hybrydowe" || q === "hybrid") && feat.hybrid) return true;
  if (
    (q === "przegub" || q === "przegubowy" || q === "przegubowe" || q === "przegubowiec" || q === "mega" || q === "dlugi") &&
    feat.longVehicle
  ) {
    return true;
  }
  if ((q === "klima" || q === "klimatyzacja" || q === "klimatyzowany") && feat.airCondition) return true;
  if ((q === "niska podloga" || q === "niskopodlogowy") && feat.lowFloor) return true;
  return false;
}

function TopBarSearch({
  stops,
  geoPos,
  onLocate,
  onPickStop,
  onPickVehicle,
  lineFilter,
  onToggleLine,
  onClearLineFilter,
  onToggleStops,
  stopsVisible,
  baseLayer,
  onBaseLayer,
  onClearView,
  onOpenNearby,
  onOpenConnections,
  searchRef,
  onDropdownChange,
  onShowToast: _onShowToast,
}: TopBarSearchProps) {
  const { data: vehData } = useVehicles();
  const { data: linesData } = useLines();
  const { favSet } = useFavorites();

  const vehicles = useMemo(() => vehData?.vehicles ?? [], [vehData]);
  const lines = useMemo(() => linesData?.lines ?? [], [linesData]);
  const city = useContext(CityContext);
  // the depot fleet list is MZK Bielsko-Biała's: nothing to search in GZM
  const allFleet = useMemo(() => (city === "gzm" ? [] : getAllFleetVehicles()), [city]);

  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [hi, setHi] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Expose focus handle via searchRef
  useEffect(() => {
    if (!searchRef) return;
    searchRef.current = {
      focus: () => {
        inputRef.current?.focus();
        setIsFocused(true);
      },
      blur: () => {
        inputRef.current?.blur();
        setIsFocused(false);
      },
      clear: () => {
        setQuery("");
        setHi(0);
      },
    };
    return () => {
      searchRef.current = null;
    };
  }, [searchRef]);

  // Global Ctrl/Cmd + K shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setIsFocused(true);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Dropdown shows when there's text typed and the input is focused / interacting
  const showDropdown = isFocused && query.trim().length > 0;

  useEffect(() => {
    onDropdownChange?.(showDropdown);
  }, [showDropdown, onDropdownChange]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!showDropdown) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        inputRef.current && !inputRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setIsFocused(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showDropdown]);

  // Pre-normalized stop names for quick matching
  const stopIndex = useMemo(() => stops.map((s) => ({ s, n: normalizeText(s.name) })), [stops]);

  // Live vehicles count per line
  const liveByLine = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vehicles) if (v.line) m.set(v.line, (m.get(v.line) ?? 0) + 1);
    return m;
  }, [vehicles]);

  // Fast lookup of currently running vehicles by side number
  const liveSideNumbers = useMemo(() => {
    const s = new Set<string>();
    for (const v of vehicles) {
      if (v.side_number) s.add(normalizeText(v.side_number));
    }
    return s;
  }, [vehicles]);

  // Available quick actions
  const actions = useMemo<ActionDef[]>(() => {
    const list: ActionDef[] = [
      {
        id: "route",
        label: "Wyznacz trasę",
        keywords: "trasa polaczenie jak dojechac dojazd planuj wyszukaj polaczenia",
        icon: <PathIcon />,
        run: () => {
          onOpenConnections?.();
        },
      },
      {
        id: "locate",
        label: "Moja lokalizacja",
        keywords: "gdzie jestem gps znajdz mnie lokalizacja",
        icon: <GpsFixIcon />,
        run: onLocate,
      },
      {
        id: "nearby",
        label: "Odjazdy w pobliżu",
        keywords: "w poblizu najblizszy przystanek odjazdy obok blisko",
        icon: <PersonSimpleWalkIcon />,
        run: onOpenNearby,
      },
      {
        id: "stops-toggle",
        label: stopsVisible ? "Ukryj przystanki" : "Pokaż przystanki",
        keywords: "przystanki ukryj pokaz widocznosc mapa",
        icon: stopsVisible ? <EyeSlashIcon /> : <EyeIcon />,
        run: onToggleStops,
      },
      {
        id: "map-style",
        label: baseLayer === "dark" ? "Jasna mapa" : "Ciemna mapa",
        keywords: "ciemna jasna mapa styl motyw dark light",
        icon: baseLayer === "dark" ? <SunIcon /> : <MoonIcon />,
        run: () => onBaseLayer(baseLayer === "dark" ? "kb" : "dark"),
      },
      {
        id: "clear",
        label: "Wyczyść widok",
        keywords: "wyczysc zamknij widok reset",
        icon: <XCircleIcon />,
        run: onClearView,
      },
      {
        id: "brigades",
        label: "Brygady i rozkłady taboru",
        keywords: "brygady brygada tabor woz wozy flota pojazdy kursy gdzie pojedzie historia",
        icon: <BusIcon />,
        run: () => {
          window.location.href = `/brygady${withCity("", city)}`;
        },
      },
    ];
    if (lineFilter && lineFilter.size > 0) {
      list.push({
        id: "clear-filter",
        label: "Wyczyść filtr linii",
        keywords: "wyczysc filtr linie pokaz wszystkie",
        icon: <FunnelSimpleXIcon />,
        run: onClearLineFilter,
      });
    }
    return list;
  }, [onOpenConnections, onLocate, onOpenNearby, stopsVisible, onToggleStops, baseLayer, onBaseLayer, onClearView, lineFilter, onClearLineFilter, city]);

  // Compute matched sections
  const sections = useMemo<Section[]>(() => {
    const q = normalizeText(query.trim());
    if (!q) return [];
    const cleanQ = q.replace(/^#/, "").replace(/^nr\s*/, "").replace(/^tabor\s*/, "").trim();

    const stopDist = (s: Stop) =>
      geoPos ? haversineMeters(geoPos.lat, geoPos.lon, s.lat, s.lon) : null;

    type Scored = { item: Item; rank: number; label: string; dist: number };

    // 1. Lines
    const lineHits: Scored[] = [];
    for (const l of lines) {
      const nl = normalizeText(l.name);
      const nt = normalizeText(l.terminus);
      let rank = -1;
      if (nl === q) rank = 0;
      else if (nl.startsWith(q)) rank = 1;
      else if (nl.includes(q)) rank = 4;
      else if (nt && nt.includes(q)) rank = 4.2;
      if (rank < 0) continue;
      lineHits.push({
        item: { kind: "line", l, live: liveByLine.get(l.name) ?? 0, active: !!lineFilter?.has(l.name) },
        rank,
        label: l.name,
        dist: Infinity,
      });
    }

    // 2. Vehicles
    const vehHits: Scored[] = [];
    const seenVehKeys = new Set<string>();
    for (const v of vehicles) {
      const nl = normalizeText(v.line || "");
      const nh = normalizeText(v.headsign || "");
      const ns = v.side_number ? normalizeText(v.side_number) : "";
      const nm = v.model ? normalizeText(v.model) : "";

      const isExactSide = Boolean(ns && (ns === cleanQ || ns === q));
      const isSidePrefix = Boolean(ns && cleanQ.length >= 2 && ns.startsWith(cleanQ));
      const isModelMatch = Boolean(nm && (nm.includes(q) || (cleanQ.length >= 2 && nm.includes(cleanQ))));
      const isFeatureMatch = matchesVehicleKeywords(cleanQ, v) || matchesVehicleKeywords(q, v);

      let rank = -1;
      if (isExactSide) rank = 0;
      else if (nl && nl === q) rank = 0.5;
      else if (isSidePrefix) rank = 1.1;
      else if (nl && nl.startsWith(q)) rank = 1.5;
      else if (isModelMatch) rank = 2.0;
      else if (isFeatureMatch) rank = 2.4;
      else if (nl && nl.includes(q)) rank = 4.5;
      else if (nh && nh.includes(q)) rank = 5;

      if (rank < 0) continue;

      const isTaborHit = isExactSide || isSidePrefix || isModelMatch || isFeatureMatch;
      const key = isTaborHit ? (v.side_number ? `side-${v.side_number}` : `veh-${v.id}`) : `${v.line} ${v.headsign}`;
      if (seenVehKeys.has(key)) continue;
      seenVehKeys.add(key);

      vehHits.push({
        item: { kind: "veh", v },
        rank,
        label: v.side_number ? `#${v.side_number} ${v.line} ${v.headsign}` : `${v.line} ${v.headsign}`,
        dist: Infinity,
      });
    }

    // 3. Fleet vehicles (depot / offline)
    const fleetHits: Scored[] = [];
    for (const f of allFleet) {
      const ns = normalizeText(f.sideNumber);
      // Skip if currently live on road (it's already in vehHits)
      if (liveSideNumbers.has(ns)) continue;

      const isExactSide = ns === cleanQ || ns === q;
      const isSidePrefix = cleanQ.length >= 2 && ns.startsWith(cleanQ);
      const isModelOrFeature = matchesFleetKeywords(cleanQ, f) || matchesFleetKeywords(q, f);

      let rank = -1;
      if (isExactSide) rank = 0.1;
      else if (isSidePrefix) rank = 1.2;
      else if (isModelOrFeature) rank = 2.2;

      if (rank < 0) continue;

      fleetHits.push({
        item: { kind: "fleet", f },
        rank,
        label: `#${f.sideNumber} ${f.model}`,
        dist: Infinity,
      });
    }

    // 4. Actions
    const actionHits: Scored[] = [];
    for (const a of actions) {
      const nl = normalizeText(a.label);
      let rank = -1;
      if (nl.startsWith(q)) rank = 2.2;
      else if (nl.includes(q) || a.keywords.includes(q)) rank = 2.5;
      if (rank < 0) continue;
      actionHits.push({ item: { kind: "action", a }, rank, label: a.label, dist: Infinity });
    }

    // 5. Stops
    const stopHits: Scored[] = [];
    for (const { s, n } of stopIndex) {
      let rank = -1;
      if (n.startsWith(q)) rank = 2;
      else if (n.includes(q)) rank = 3;
      if (rank < 0) continue;
      const fav = favSet.has(s.designator);
      if (fav) rank -= 0.5; // favorites float higher
      const d = stopDist(s);
      stopHits.push({
        item: { kind: "stop", s, fav, dist: d },
        rank,
        label: s.name,
        dist: d ?? Infinity,
      });
    }

    const finish = (hits: Scored[], cap: number, dedupeByName = false): { items: Item[]; best: number } => {
      hits.sort(
        (a, b) => a.rank - b.rank || a.dist - b.dist || a.label.localeCompare(b.label, "pl"),
      );
      if (!dedupeByName) {
        return { items: hits.slice(0, cap).map((h) => h.item), best: hits[0]?.rank ?? Infinity };
      }
      const seen = new Set<string>();
      const deduped: Item[] = [];
      for (const h of hits) {
        const key = normalizeText(h.label);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(h.item);
        if (deduped.length >= cap) break;
      }
      return { items: deduped, best: hits[0]?.rank ?? Infinity };
    };

    const groups: Section[] = [
      { title: "Linie", ...finish(lineHits, CAP.lines) },
      { title: "Pojazdy na żywo", ...finish(vehHits, CAP.vehs) },
      { title: "Tabor MZK", ...finish(fleetHits, CAP.fleet) },
      { title: "Przystanki", ...finish(stopHits, CAP.stops, true) },
      { title: "Akcje", ...finish(actionHits, CAP.actions) },
    ]
      .filter((g) => g.items.length > 0)
      .sort((a, b) => a.best - b.best);

    return groups;
  }, [query, lines, liveByLine, lineFilter, vehicles, allFleet, liveSideNumbers, actions, stopIndex, favSet, geoPos]);

  // Flat array of items for keyboard navigation index
  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  // the live vehicle hits can shrink under the highlight between polls: clamp at use
  const hiIdx = Math.min(hi, Math.max(0, flatItems.length - 1));


  // Scroll active item into view
  useEffect(() => {
    if (!showDropdown || flatItems.length === 0) return;
    const activeEl = document.getElementById(`${listId}-opt-${hiIdx}`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [hiIdx, showDropdown, flatItems.length, listId]);

  // Pick / execute item
  const pick = useCallback(
    (it: Item) => {
      if (it.kind === "stop") {
        onPickStop(it.s);
        setIsFocused(false);
      } else if (it.kind === "veh") {
        onPickVehicle(it.v);
        setIsFocused(false);
      } else if (it.kind === "fleet") {
        window.location.href = `/brygady?tabor=${it.f.sideNumber}`;
        setIsFocused(false);
      } else if (it.kind === "line") {
        onToggleLine(it.l.name);
        setIsFocused(false);
      } else if (it.kind === "action") {
        it.a.run();
        setIsFocused(false);
      }
    },
    [onPickStop, onPickVehicle, onToggleLine],
  );

  // Keyboard navigation on input
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        setQuery("");
        setHi(0);
      } else {
        setIsFocused(false);
        inputRef.current?.blur();
      }
      return;
    }

    if (!showDropdown || flatItems.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((hiIdx + 1) % flatItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((hiIdx - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const current = flatItems[hiIdx];
      if (current) pick(current);
    }
  };

  const optionId = (index: number) => `${listId}-opt-${index}`;

  return (
    <>
      {/* Search Input inline in TopBar pill */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-2">
        <MagnifyingGlassIcon className="ml-0.5 shrink-0 text-[17px] text-text-faint" />

        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={showDropdown ? listId : undefined}
          aria-activedescendant={showDropdown && flatItems.length > 0 ? optionId(hiIdx) : undefined}
          aria-autocomplete="list"
          aria-label="Szukaj przystanku, linii lub taboru"
          placeholder="Szukaj przystanku, linii lub taboru (#230, Solaris)…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHi(0);
            setIsFocused(true);
          }}
          onFocus={() => setIsFocused(true)}
          onKeyDown={onKeyDown}
          className="no-focus-ring h-full min-w-0 flex-1 bg-transparent text-base md:text-[13.5px] text-text placeholder:text-text-faint focus:outline-none"
        />

        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setHi(0);
              inputRef.current?.focus();
            }}
            aria-label="Wyczyść wyszukiwanie"
            className="tap grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/6 text-[13px] text-text-mute hover:bg-white/10 hover:text-text"
          >
            <XIcon />
          </button>
        )}
      </div>

      {/* Dropdown Results list */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="surface absolute left-0 top-full mt-2 flex max-h-[min(65vh,460px)] w-full flex-col overflow-y-auto overscroll-contain rounded-[20px] p-1.5 animate-drop z-[1003]"
        >
          {flatItems.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-faint">
              Brak wyników dla „<span className="font-medium text-text">{query}</span>”
            </div>
          ) : (
            <ul id={listId} role="listbox" className="flex flex-col gap-0.5">
              {(() => {
                let globalIdx = 0;
                return sections.map((section) => (
                  <li key={section.title} className="flex flex-col">
                    <div className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-text-faint">
                      {section.title}
                    </div>
                    <ul className="flex flex-col gap-0.5">
                      {section.items.map((it) => {
                        const itemIndex = globalIdx++;
                        const isSelected = itemIndex === hiIdx;
                        return (
                          <li
                            key={itemKey(it)}
                            id={optionId(itemIndex)}
                            role="option"
                            aria-selected={isSelected}
                          >
                            <button
                              type="button"
                              tabIndex={-1}
                              onMouseEnter={() => setHi(itemIndex)}
                              onPointerDown={(e) => {
                                e.preventDefault();
                              }}
                              onClick={() => pick(it)}
                              className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[13px] transition-[background-color,color,scale] duration-150 active:scale-[0.99] ${
                                isSelected ? "bg-white/8 text-text" : "text-text-mute hover:bg-white/6"
                              }`}
                            >
                              {it.kind === "stop" && (
                                <>
                                  <StopGlyph operator={it.s.operator} station={it.s.isStation} />
                                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                    <span className="sr-only">{OPERATOR_LABEL[it.s.operator ?? "KB"]}: </span>
                                    <span className="truncate font-medium text-text">{displayStopName(it.s.name)}</span>
                                    {it.s.symbol && (
                                      <span className="shrink-0 text-[11.5px] tabular-nums text-text-faint">{it.s.symbol}</span>
                                    )}
                                  </span>
                                  {it.fav && <StarIcon weight="fill" className="shrink-0 text-[13px] text-primary" />}
                                  {it.dist != null && (
                                    <span className="shrink-0 text-[11.5px] tabular-nums text-text-faint">
                                      {formatDistance(it.dist)}
                                    </span>
                                  )}
                                </>
                              )}

                              {it.kind === "line" && (
                                <>
                                  <LineBadge line={it.l.name} operator={it.l.operator} />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium text-text">
                                      {it.l.terminus ? `→ ${displayStopName(it.l.terminus)}` : `Linia ${it.l.name}`}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11.5px] tabular-nums text-text-faint">
                                      {OPERATOR_LABEL[it.l.operator || "KB"]} ·{" "}
                                      {it.active
                                        ? "filtr aktywny, kliknij, aby wyłączyć"
                                        : it.live > 0
                                          ? `${it.live} ${wozPlural(it.live)} na trasie`
                                          : "brak wozów na trasie"}
                                    </span>
                                  </span>
                                  {it.active && <CheckIcon className="shrink-0 text-[15px] text-primary" />}
                                </>
                              )}

                              {it.kind === "veh" && (
                                <>
                                  <LineBadge line={it.v.line || "?"} operator={it.v.operator} />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-baseline gap-1.5">
                                      <span className="truncate font-medium text-text">
                                        {it.v.headsign ? `→ ${displayStopName(it.v.headsign)}` : `Linia ${it.v.line || "?"}`}
                                      </span>
                                      {it.v.side_number && (
                                        <span className="shrink-0 text-[11.5px] font-medium tabular-nums text-text-mute">
                                          #{it.v.side_number}
                                        </span>
                                      )}
                                    </span>
                                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] tabular-nums text-text-faint">
                                      <span
                                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                          it.v.not_started ? "bg-text-faint" : "animate-pulse-dot bg-good"
                                        }`}
                                        aria-hidden
                                      />
                                      <span className="truncate">
                                        {OPERATOR_LABEL[it.v.operator || "KB"]} ·{" "}
                                        {it.v.not_started
                                          ? "czeka na odjazd"
                                          : `na żywo${it.v.delay != null ? ` · ${delayTxt(it.v.delay)}` : ""}`}
                                        {it.v.model ? ` · ${it.v.model}` : ""}
                                      </span>
                                      {it.v.features?.hydrogen && <Tag icon={<DropIcon />}>Wodór</Tag>}
                                      {it.v.features?.electric && <Tag icon={<LightningIcon />}>Elektryczny</Tag>}
                                    </span>
                                  </span>
                                </>
                              )}

                              {it.kind === "fleet" && (
                                <>
                                  <Glyph>
                                    <BusIcon />
                                  </Glyph>
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-baseline gap-1.5">
                                      <span className="shrink-0 font-semibold tabular-nums text-text">#{it.f.sideNumber}</span>
                                      <span className="truncate text-text-mute">{it.f.model}</span>
                                    </span>
                                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] tabular-nums text-text-faint">
                                      <span className="truncate">
                                        MZK{it.f.year ? ` · ${it.f.year}` : ""} · w zajezdni
                                      </span>
                                      <Tag>{it.f.lengthCategory}</Tag>
                                      <FuelTag fuel={it.f.fuelType} />
                                    </span>
                                  </span>
                                </>
                              )}

                              {it.kind === "action" && (
                                <>
                                  <Glyph>{it.a.icon}</Glyph>
                                  <span className="min-w-0 flex-1 truncate font-medium text-text">{it.a.label}</span>
                                </>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ));
              })()}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export default memo(TopBarSearch);
