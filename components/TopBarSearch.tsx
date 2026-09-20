"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLines, useVehicles, type GeoPos } from "@/components/hooks";
import { LineBadge, StarIcon } from "@/components/ui";
import { useFavorites } from "@/lib/client/favorites";
import { delayTxt, displayStopName, normalizeText, wozPlural } from "@/lib/client/format";
import { formatDistance, haversineMeters } from "@/lib/client/geo";
import type { BaseLayerId } from "@/components/TopBar";
import type { LineInfo, Stop, Vehicle } from "@/lib/client/types";

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
  onOpenConnections?: () => void;
  /** Pass-through handle to allow parent / sibling buttons to focus search */
  searchRef?: React.RefObject<TopBarSearchHandle | null>;
  /** Notifies parent when dropdown opens/closes (e.g. to close settings menu) */
  onDropdownChange?: (open: boolean) => void;
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
  : `s-${it.s.id}`;

const CAP = { lines: 4, vehs: 4, actions: 3, stops: 6 } as const;

/* ---------- glyphs ---------- */

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-7 w-8 shrink-0 place-items-center rounded-lg bg-white/6 text-text-mute" aria-hidden>
      {children}
    </span>
  );
}

function BusGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="11" rx="2.5" />
      <path d="M3 10.5h18M8 4.5v6M12 4.5v6M16 4.5v6" />
      <circle cx="7.5" cy="16.6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="16.6" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LocateGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function RouteGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="19" r="3" />
      <path d="M9 19h8.5a4.5 4.5 0 0 0 0-9H7a4 4 0 0 1 0-8h11" />
      <polyline points="15 5 18 2 21 5" />
    </svg>
  );
}

function EyeGlyph({ off = false }: { off?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function ThemeGlyph({ dark }: { dark: boolean }) {
  return dark ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.5 14A8.5 8.5 0 1 1 10 3.5a7 7 0 0 0 10.5 10.5z" />
    </svg>
  );
}

function ClearGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}

function FilterOffGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h18l-7 8v5.5l-4 2V13L3 5z" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="text-primary" aria-hidden>
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
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
  onOpenConnections,
  searchRef,
  onDropdownChange,
}: TopBarSearchProps) {
  const { data: vehData } = useVehicles();
  const { data: linesData } = useLines();
  const { favSet } = useFavorites();

  const vehicles = useMemo(() => vehData?.vehicles ?? [], [vehData]);
  const lines = useMemo(() => linesData?.lines ?? [], [linesData]);

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

  // Available quick actions
  const actions = useMemo<ActionDef[]>(() => {
    const list: ActionDef[] = [
      {
        id: "route",
        label: "Wyznacz trasę",
        keywords: "trasa polaczenie jak dojechac dojazd planuj wyszukaj polaczenia",
        icon: <RouteGlyph />,
        run: () => {
          onOpenConnections?.();
        },
      },
      {
        id: "locate",
        label: "Moja lokalizacja",
        keywords: "gdzie jestem gps znajdz mnie lokalizacja",
        icon: <LocateGlyph />,
        run: onLocate,
      },
      {
        id: "stops-toggle",
        label: stopsVisible ? "Ukryj przystanki" : "Pokaż przystanki",
        keywords: "przystanki ukryj pokaz widocznosc mapa",
        icon: <EyeGlyph off={stopsVisible} />,
        run: onToggleStops,
      },
      {
        id: "map-style",
        label: baseLayer === "dark" ? "Jasna mapa" : "Ciemna mapa",
        keywords: "ciemna jasna mapa styl motyw dark light",
        icon: <ThemeGlyph dark={baseLayer === "dark"} />,
        run: () => onBaseLayer(baseLayer === "dark" ? "kb" : "dark"),
      },
      {
        id: "clear",
        label: "Wyczyść widok",
        keywords: "wyczysc zamknij widok reset",
        icon: <ClearGlyph />,
        run: onClearView,
      },
    ];
    if (lineFilter && lineFilter.size > 0) {
      list.push({
        id: "clear-filter",
        label: "Wyczyść filtr linii",
        keywords: "wyczysc filtr linie pokaz wszystkie",
        icon: <FilterOffGlyph />,
        run: onClearLineFilter,
      });
    }
    return list;
  }, [onOpenConnections, onLocate, stopsVisible, onToggleStops, baseLayer, onBaseLayer, onClearView, lineFilter, onClearLineFilter]);

  // Compute matched sections
  const sections = useMemo<Section[]>(() => {
    const q = normalizeText(query.trim());
    if (!q) return [];

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
    const seenDir = new Set<string>();
    for (const v of vehicles) {
      const nl = normalizeText(v.line || "");
      const nh = normalizeText(v.headsign || "");
      let rank = -1;
      if (nl && nl === q) rank = 0.5;
      else if (nl && nl.startsWith(q)) rank = 1.5;
      else if (nl && nl.includes(q)) rank = 4.5;
      else if (nh && nh.includes(q)) rank = 5;
      if (rank < 0) continue;
      const key = `${v.line} ${v.headsign}`;
      if (seenDir.has(key)) continue;
      seenDir.add(key);
      vehHits.push({ item: { kind: "veh", v }, rank, label: `${v.line} ${v.headsign}`, dist: Infinity });
    }

    // 3. Actions
    const actionHits: Scored[] = [];
    for (const a of actions) {
      const nl = normalizeText(a.label);
      let rank = -1;
      if (nl.startsWith(q)) rank = 2.2;
      else if (nl.includes(q) || a.keywords.includes(q)) rank = 2.5;
      if (rank < 0) continue;
      actionHits.push({ item: { kind: "action", a }, rank, label: a.label, dist: Infinity });
    }

    // 4. Stops
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
      { title: "Przystanki", ...finish(stopHits, CAP.stops, true) },
      { title: "Akcje", ...finish(actionHits, CAP.actions) },
    ]
      .filter((g) => g.items.length > 0)
      .sort((a, b) => a.best - b.best);

    return groups;
  }, [query, lines, liveByLine, lineFilter, vehicles, actions, stopIndex, favSet, geoPos]);

  // Flat array of items for keyboard navigation index
  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);


  // Scroll active item into view
  useEffect(() => {
    if (!showDropdown || flatItems.length === 0) return;
    const activeEl = document.getElementById(`${listId}-opt-${hi}`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [hi, showDropdown, flatItems.length, listId]);

  // Pick / execute item
  const pick = useCallback(
    (it: Item) => {
      if (it.kind === "stop") {
        onPickStop(it.s);
        setIsFocused(false);
      } else if (it.kind === "veh") {
        onPickVehicle(it.v);
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
      setHi((prev) => (prev + 1) % flatItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((prev) => (prev - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const current = flatItems[hi];
      if (current) pick(current);
    }
  };

  const optionId = (index: number) => `${listId}-opt-${index}`;

  return (
    <>
      {/* Search Input inline in TopBar pill */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-2">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="shrink-0 text-text-faint ml-0.5"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>

        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={showDropdown ? listId : undefined}
          aria-activedescendant={showDropdown && flatItems.length > 0 ? optionId(hi) : undefined}
          aria-autocomplete="list"
          aria-label="Szukaj przystanku lub linii"
          placeholder="Szukaj przystanku lub linii…"
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
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-white/10 hover:text-text"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Dropdown Results list */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="surface absolute left-0 top-full mt-2 w-full max-h-[min(65vh,460px)] overflow-y-auto overscroll-contain rounded-2xl p-1.5 shadow-2xl border border-white/10 animate-drop flex flex-col z-[1003]"
        >
          {flatItems.length === 0 ? (
            <div className="py-7 px-4 text-center text-[13px] text-text-faint">
              Brak wyników dla „<span className="font-medium text-text">{query}</span>”
            </div>
          ) : (
            <ul id={listId} role="listbox" className="flex flex-col gap-0.5">
              {(() => {
                let globalIdx = 0;
                return sections.map((section) => (
                  <li key={section.title} className="flex flex-col">
                    <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-text-faint">
                      {section.title}
                    </div>
                    <ul className="flex flex-col gap-0.5">
                      {section.items.map((it) => {
                        const itemIndex = globalIdx++;
                        const isSelected = itemIndex === hi;
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
                              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] transition-colors active:scale-[0.99] ${
                                isSelected ? "bg-white/10 text-text" : "text-text-mute hover:bg-white/6"
                              }`}
                            >
                              {it.kind === "stop" && (
                                <>
                                  {it.fav ? (
                                    <span className="grid h-7 w-8 shrink-0 place-items-center rounded-lg bg-white/6 text-primary" aria-hidden>
                                      <StarIcon filled />
                                    </span>
                                  ) : (
                                    <Glyph><BusGlyph /></Glyph>
                                  )}
                                  <span className="min-w-0 flex-1 truncate text-text font-medium flex items-center gap-1.5">
                                    <span
                                      className={`rounded px-1 text-[10px] font-bold text-white ${
                                        it.s.operator === "BOTH"
                                          ? "bg-gradient-to-r from-red-600 to-blue-600"
                                          : it.s.operator === "MZK"
                                            ? "bg-blue-600"
                                            : "bg-red-600"
                                      }`}
                                    >
                                      {it.s.operator === "BOTH" ? "KB + MZK" : it.s.operator || "KB"}
                                    </span>
                                    <span className="truncate">
                                      {displayStopName(it.s.name)} {it.s.symbol ? `(${it.s.symbol})` : ""}
                                    </span>
                                  </span>
                                  {it.dist != null && (
                                    <span className="shrink-0 text-[11px] tabular-nums text-text-mute">
                                      {formatDistance(it.dist)}
                                    </span>
                                  )}
                                </>
                              )}

                              {it.kind === "line" && (
                                <>
                                  <LineBadge line={it.l.name} operator={it.l.operator} />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5 truncate text-text font-medium">
                                      <span
                                        className={`rounded px-1 text-[10px] font-bold text-white ${
                                          it.l.operator === "MZK" ? "bg-blue-600" : "bg-red-600"
                                        }`}
                                      >
                                        {it.l.operator || "KB"}
                                      </span>
                                      <span className="truncate">
                                        {it.l.terminus ? `→ ${displayStopName(it.l.terminus)}` : `Linia ${it.l.name}`}
                                      </span>
                                    </span>
                                    <span className="mt-0.5 block text-[11px] text-text-faint">
                                      {it.active
                                        ? "filtr aktywny · kliknij aby wyłączyć"
                                        : it.live > 0
                                          ? `${it.live} ${wozPlural(it.live)} na trasie`
                                          : "brak wozów na trasie"}
                                    </span>
                                  </span>
                                  {it.active && <CheckGlyph />}
                                </>
                              )}

                              {it.kind === "veh" && (
                                <>
                                  <LineBadge line={it.v.line || "?"} operator={it.v.operator} />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5 truncate text-text font-medium">
                                      <span
                                        className={`rounded px-1 text-[10px] font-bold text-white ${
                                          it.v.operator === "MZK" ? "bg-blue-600" : "bg-red-600"
                                        }`}
                                      >
                                        {it.v.operator || "KB"}
                                      </span>
                                      <span className="truncate">
                                        {it.v.headsign ? `→ ${displayStopName(it.v.headsign)}` : `Linia ${it.v.line || "?"}`}
                                      </span>
                                      {it.v.side_number && (
                                        <span className="text-[11px] text-text-faint font-normal">#{it.v.side_number}</span>
                                      )}
                                    </span>
                                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-faint">
                                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-good" aria-hidden />
                                      na żywo{it.v.delay != null ? ` · ${delayTxt(it.v.delay)}` : ""}
                                    </span>
                                  </span>
                                </>
                              )}

                              {it.kind === "action" && (
                                <>
                                  <Glyph>{it.a.icon}</Glyph>
                                  <span className="min-w-0 flex-1 truncate text-text font-medium">
                                    {it.a.label}
                                  </span>
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
