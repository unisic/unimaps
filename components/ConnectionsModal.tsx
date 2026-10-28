"use client";

import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ArrowsDownUpIcon,
  BusIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckIcon,
  ClockIcon,
  LightningIcon,
  MapTrifoldIcon,
  PathIcon,
  ShieldCheckIcon,
} from "@/components/icons";
import { CloseIcon, ErrorState, IconButton, LineBadge, StarIcon } from "@/components/ui";
import { getConnections, isWarming } from "@/lib/client/api";
import { CityContext, GZM_LOADING } from "@/lib/client/city";
import { useFavorites } from "@/lib/client/favorites";
import {
  addMinutesToHHMM,
  displayStopName,
  formatDayLabel,
  hhmmFromSecs,
  normalizeText,
  nowHHMM,
  offsetDateISO,
  przystanekPlural,
  todayISO,
} from "@/lib/client/format";
import { formatDistance, haversineMeters, nearestStops } from "@/lib/client/geo";
import type { ConnectionItinerary, Stop } from "@/lib/client/types";
import type { GeoPos } from "@/components/hooks";

export interface ConnectionsModalProps {
  open: boolean;
  onClose: () => void;
  stops: Stop[];
  geoPos: GeoPos | null;
  initialFrom?: Stop | null;
  initialTo?: Stop | null;
  onSelectStop: (s: Stop) => void;
  onSelectConnection?: (conn: ConnectionItinerary, selectedLegIdx?: number | null) => void;
}

/* Chips: one height, one radius. "On" uses the same accent as a pressed IconButton. */
const CHIP = "tap inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full text-[12px] font-medium";
const CHIP_ON = "bg-primary-dim text-primary";
const CHIP_OFF = "bg-white/6 text-text-mute hover:bg-white/10 hover:text-text";
const chip = (on: boolean) => `${CHIP} px-3 ${on ? CHIP_ON : CHIP_OFF}`;
/** The one high-emphasis action of a view: neutral, inverted. */
const CTA =
  "tap inline-flex items-center justify-center gap-1.5 rounded-full bg-text px-4 font-medium text-bg hover:bg-white";

/**
 * 24-Hour Time Input Component
 * Strictly enforces 24-hour format (00:00 - 23:59) across all devices and browsers,
 * preventing any browser-level AM/PM interference.
 */
function TimeInput24H({
  hour,
  minute,
  onChange,
  onBlur,
}: {
  hour: string;
  minute: string;
  onChange: (h: string, m: string) => void;
  onBlur?: () => void;
}) {
  const hourRef = useRef<HTMLInputElement>(null);
  const minRef = useRef<HTMLInputElement>(null);

  const handleHourChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
    onChange(raw, minute);
    if (raw.length === 2 || (raw.length === 1 && Number(raw) >= 3)) {
      minRef.current?.focus();
      minRef.current?.select();
    }
  };

  const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
    onChange(hour, raw);
  };

  const handleHourKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = (parseInt(hour || "0", 10) + 1) % 24;
      onChange(String(n).padStart(2, "0"), minute);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = (parseInt(hour || "0", 10) + 23) % 24;
      onChange(String(n).padStart(2, "0"), minute);
    } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      minRef.current?.focus();
    }
  };

  const handleMinKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = (parseInt(minute || "0", 10) + 5) % 60;
      onChange(hour, String(n).padStart(2, "0"));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = (parseInt(minute || "0", 10) + 55) % 60;
      onChange(hour, String(n).padStart(2, "0"));
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      hourRef.current?.focus();
    } else if (e.key === "Backspace" && !minute) {
      hourRef.current?.focus();
    }
  };

  return (
    <div className="flex h-8 items-center rounded-full bg-white/6 px-3 text-text transition-colors focus-within:bg-white/10 focus-within:ring-1 focus-within:ring-primary/50">
      <input
        ref={hourRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={hour}
        onChange={handleHourChange}
        onKeyDown={handleHourKeyDown}
        onBlur={onBlur}
        className="w-6 bg-transparent text-center text-base font-semibold tabular-nums outline-none ring-0 placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:w-5 md:text-[13px]"
        placeholder="00"
        aria-label="Godzina w formacie 24-godzinnym (00-23)"
      />
      <span className="select-none px-0.5 font-semibold text-text-faint">:</span>
      <input
        ref={minRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={minute}
        onChange={handleMinChange}
        onKeyDown={handleMinKeyDown}
        onBlur={onBlur}
        className="w-6 bg-transparent text-center text-base font-semibold tabular-nums outline-none ring-0 placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:w-5 md:text-[13px]"
        placeholder="00"
        aria-label="Minuty w formacie 24-godzinnym (00-59)"
      />
      <span className="ml-1.5 select-none text-[11px] text-text-faint">24h</span>
    </div>
  );
}

function ConnectionsDialog({
  onClose,
  stops,
  geoPos,
  initialFrom,
  initialTo,
  onSelectStop,
  onSelectConnection,
}: Omit<ConnectionsModalProps, "open">) {
  const [fromStop, setFromStop] = useState<Stop | null>(initialFrom ?? null);
  const [toStop, setToStop] = useState<Stop | null>(initialTo ?? null);
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [activeInput, setActiveInput] = useState<"from" | "to" | null>(
    !initialFrom ? "from" : !initialTo ? "to" : null,
  );

  // Day selection state
  const todayStr = useMemo(() => todayISO(), []);
  const tomorrowStr = useMemo(() => offsetDateISO(todayStr, 1), [todayStr]);
  const [dateMode, setDateMode] = useState<"today" | "tomorrow" | "custom">("today");
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const dateInputRef = useRef<HTMLInputElement>(null);

  // 24-hour time selection state
  const [timeMode, setTimeMode] = useState<"now" | "custom">("now");
  const [hour, setHour] = useState(() => nowHHMM().split(":")[0]);
  const [minute, setMinute] = useState(() => nowHHMM().split(":")[1]);

  // Filters state
  const [directOnly, setDirectOnly] = useState(false);
  const [minTransfer5, setMinTransfer5] = useState(false);
  const [sortBy, setSortBy] = useState<"departure" | "duration">("departure");

  const [connections, setConnections] = useState<ConnectionItinerary[] | null>(null);
  /* "warming": the server is still loading the GZM data (503) */
  const [connErr, setConnErr] = useState<false | "error" | "warming">(false);
  const city = useContext(CityContext);
  const [searchTick, setSearchTick] = useState(0);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const fromInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);

  const { favs, favSet } = useFavorites();

  // Pre-normalized stop lookup index
  const stopIndex = useMemo(() => stops.map((s) => ({ s, n: normalizeText(s.name) })), [stops]);
  const byDesig = useMemo(() => {
    const m = new Map<string, Stop>();
    for (const s of stops) m.set(s.designator, s);
    return m;
  }, [stops]);

  // Close on Escape. On document, so it runs before the stop sheet's window
  // listener, which then sees defaultPrevented and stays open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Derived effective time parameter (HH:MM in 24h format); null while the
  // typed time is incomplete or out of range, so no search fires per keystroke
  // (the blur handler pads and clamps it into a valid one).
  const effectiveTimeParam = useMemo(() => {
    if (timeMode === "now" && dateMode === "today") {
      return undefined; // live search from current second
    }
    if (!/^\d\d$/.test(hour) || !/^\d\d$/.test(minute) || +hour > 23 || +minute > 59) return null;
    return `${hour}:${minute}`;
  }, [timeMode, dateMode, hour, minute]);

  const effectiveDayLabel = useMemo(() => {
    if (dateMode === "today") return "Dziś";
    if (dateMode === "tomorrow") return "Jutro";
    return formatDayLabel(selectedDate, todayStr);
  }, [dateMode, selectedDate, todayStr]);

  // Async connection fetcher
  useEffect(() => {
    if (!fromStop || !toStop || effectiveTimeParam === null) return;
    const ac = new AbortController();
    let cancelled = false;
    const fromParam = fromStop.id || fromStop.name;
    const toParam = toStop.id || toStop.name;

    (async () => {
      try {
        const list = await getConnections(fromParam, toParam, {
          time: effectiveTimeParam ?? undefined,
          date: selectedDate,
          dayLabel: effectiveDayLabel,
          directOnly,
          minTransfer: minTransfer5 ? 5 : undefined,
          sortBy,
          signal: ac.signal,
          city,
        });
        if (!cancelled) {
          setConnections(list);
          setConnErr(false);
        }
      } catch (err) {
        if (!cancelled && !ac.signal.aborted) {
          setConnErr(city === "gzm" && isWarming(err) ? "warming" : "error");
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [
    fromStop,
    toStop,
    effectiveTimeParam,
    selectedDate,
    effectiveDayLabel,
    directOnly,
    minTransfer5,
    sortBy,
    searchTick,
    city,
  ]);

  const handleRefresh = useCallback(() => {
    setConnections(null);
    setConnErr(false);
    setSearchTick((t) => t + 1);
  }, []);

  const handleSwap = useCallback(() => {
    setFromStop(toStop);
    setToStop(fromStop);
    setFromQuery("");
    setToQuery("");
    setActiveInput(null);
    setConnections(null);
    setConnErr(false);
    setExpandedIdx(null);
  }, [fromStop, toStop]);

  const handlePickStop = useCallback(
    (s: Stop, target: "from" | "to") => {
      if (target === "from") {
        setFromStop(s);
        setFromQuery("");
        setConnections(null);
        setConnErr(false);
        if (!toStop) {
          setActiveInput("to");
          setTimeout(() => toInputRef.current?.focus(), 50);
        } else {
          setActiveInput(null);
        }
      } else {
        setToStop(s);
        setToQuery("");
        setConnections(null);
        setConnErr(false);
        setActiveInput(null);
      }
    },
    [toStop],
  );

  const handlePickToday = useCallback(() => {
    setDateMode("today");
    setSelectedDate(todayStr);
    setConnections(null);
  }, [todayStr]);

  const handlePickTomorrow = useCallback(() => {
    setDateMode("tomorrow");
    setSelectedDate(tomorrowStr);
    setTimeMode("custom");
    setHour("05");
    setMinute("00");
    setConnections(null);
  }, [tomorrowStr]);

  /** Re-search from `secs` after midnight of `date` (a list may span midnight, so paging moves the date too). */
  const searchFrom = useCallback(
    (date: string, secs: number) => {
      const [h, m] = hhmmFromSecs(secs).split(":");
      setSelectedDate(date);
      setDateMode(date === todayStr ? "today" : date === tomorrowStr ? "tomorrow" : "custom");
      setHour(h);
      setMinute(m);
      setTimeMode("custom");
      setConnections(null);
    },
    [todayStr, tomorrowStr],
  );

  // departureSecs counts from the searched day's midnight, `date` is the day the journey leaves on
  const leaves = useCallback(
    (c: ConnectionItinerary) => ({ date: c.date ?? selectedDate, secs: c.departureSecs % 86400 }),
    [selectedDate],
  );

  const handleEarlierConnections = useCallback(() => {
    if (!connections || connections.length === 0) return;
    const first = leaves(connections.reduce((a, b) => (b.departureSecs < a.departureSecs ? b : a)));
    const secs = first.secs - 3600;
    const prevDay = offsetDateISO(first.date, -1);
    if (secs >= 0) searchFrom(first.date, secs);
    else if (prevDay >= todayStr) searchFrom(prevDay, secs + 86400);
    else searchFrom(first.date, 0);
  }, [connections, leaves, searchFrom, todayStr]);

  const handleLaterConnections = useCallback(() => {
    if (!connections || connections.length === 0) return;
    const last = leaves(connections.reduce((a, b) => (b.departureSecs > a.departureSecs ? b : a)));
    const secs = last.secs + 60;
    if (secs < 86400) searchFrom(last.date, secs);
    else searchFrom(offsetDateISO(last.date, 1), secs - 86400);
  }, [connections, leaves, searchFrom]);

  const handleOpenDatePicker = useCallback(() => {
    try {
      dateInputRef.current?.showPicker?.();
    } catch {
      dateInputRef.current?.focus();
    }
  }, []);

  const handleSetNow = useCallback(() => {
    setTimeMode("now");
    const [h, m] = nowHHMM().split(":");
    setHour(h);
    setMinute(m);
    setDateMode("today");
    setSelectedDate(todayStr);
    setConnections(null);
  }, [todayStr]);

  const handleAddMinutes = useCallback(
    (delta: number) => {
      const baseTime =
        timeMode === "now" ? nowHHMM() : `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
      const next = addMinutesToHHMM(baseTime, delta);
      const [h, m] = next.split(":");
      setHour(h);
      setMinute(m);
      setTimeMode("custom");
      setConnections(null);
    },
    [timeMode, hour, minute],
  );

  const handleTimeBlur = useCallback(() => {
    let h = parseInt(hour, 10);
    let m = parseInt(minute, 10);
    if (isNaN(h) || h < 0) h = 0;
    if (h > 23) h = 23;
    if (isNaN(m) || m < 0) m = 0;
    if (m > 59) m = 59;
    setHour(String(h).padStart(2, "0"));
    setMinute(String(m).padStart(2, "0"));
    setTimeMode("custom");
  }, [hour, minute]);

  const loading = connections === null && !connErr && !!fromStop && !!toStop;

  // Suggestions for currently active input (deduplicated by stop display name)
  const suggestions = useMemo(() => {
    if (!activeInput) return [];
    const q = normalizeText((activeInput === "from" ? fromQuery : toQuery).trim());
    const stopDist = (s: Stop) =>
      geoPos ? haversineMeters(geoPos.lat, geoPos.lon, s.lat, s.lon) : null;

    if (!q) {
      const list: Array<{ s: Stop; label: string; fav: boolean; dist: number | null }> = [];
      const seenNames = new Set<string>();
      // Favorite stops
      for (const desig of favs) {
        const s = byDesig.get(desig);
        if (s) {
          const key = normalizeText(s.name);
          if (!seenNames.has(key)) {
            seenNames.add(key);
            list.push({ s, label: s.name, fav: true, dist: stopDist(s) });
          }
        }
      }
      // Nearest stops if geolocation is available
      if (geoPos) {
        const nearest = nearestStops(stops, geoPos, 12);
        for (const { s, dist } of nearest) {
          const key = normalizeText(s.name);
          if (!seenNames.has(key)) {
            seenNames.add(key);
            list.push({ s, label: s.name, fav: favSet.has(s.designator), dist });
          }
        }
      }
      return list.slice(0, 8);
    }

    // Match query
    const hits: Array<{ s: Stop; rank: number; dist: number | null }> = [];
    for (const { s, n } of stopIndex) {
      let rank = -1;
      if (n === q) rank = 0;
      else if (n.startsWith(q)) rank = 1;
      else if (n.includes(q)) rank = 3;
      if (rank < 0) continue;
      const fav = favSet.has(s.designator);
      if (fav) rank -= 0.5;
      hits.push({ s, rank, dist: stopDist(s) });
    }
    hits.sort((a, b) => a.rank - b.rank || (a.dist ?? Infinity) - (b.dist ?? Infinity));

    const deduped: Array<{ s: Stop; label: string; fav: boolean; dist: number | null }> = [];
    const seenNames = new Set<string>();
    for (const h of hits) {
      const key = normalizeText(h.s.name);
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      deduped.push({
        s: h.s,
        label: h.s.name,
        fav: favSet.has(h.s.designator),
        dist: h.dist,
      });
      if (deduped.length >= 10) break;
    }
    return deduped;
  }, [activeInput, fromQuery, toQuery, geoPos, favs, favSet, byDesig, stops, stopIndex]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Wyszukiwarka połączeń"
      className="fixed inset-0 z-[2000] flex items-end justify-center bg-black/55 animate-fade md:items-center md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl md:max-h-[88vh] md:max-w-xl md:rounded-[20px] animate-drop">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-hairline py-2.5 pl-4 pr-2.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-text">Wyszukaj połączenie</h2>
            <p className="text-[12px] text-text-faint">
              {city === "gzm" ? "Rozkład jazdy ZTM Metropolii GZM" : "Rozkład jazdy KB i MZK Bielsko-Biała"}
            </p>
          </div>
          <IconButton label="Zamknij" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>

        {/* Inputs & Controls panel */}
        <div className="space-y-3 border-b border-hairline px-4 py-3">
          {/* FROM / TO inputs */}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              {/* FROM input */}
              <div className="relative flex h-11 items-center rounded-xl bg-white/6 pl-3.5 pr-1.5 transition-colors focus-within:bg-white/10 focus-within:ring-1 focus-within:ring-primary/50">
                <span className="mr-3 h-2 w-2 shrink-0 rounded-full bg-good" aria-hidden />
                <input
                  ref={fromInputRef}
                  type="text"
                  placeholder="Skąd: przystanek początkowy…"
                  value={fromStop && activeInput !== "from" ? displayStopName(fromStop.name) : fromQuery}
                  onFocus={() => {
                    setActiveInput("from");
                    if (fromStop) setFromQuery(fromStop.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && suggestions.length > 0) {
                      e.preventDefault();
                      handlePickStop(suggestions[0].s, "from");
                    }
                  }}
                  onChange={(e) => {
                    setFromQuery(e.target.value);
                    if (fromStop) {
                      setFromStop(null);
                      setConnections(null);
                    }
                  }}
                  className="w-full min-w-0 bg-transparent text-base font-medium text-text outline-none ring-0 placeholder:font-normal placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:text-[14px]"
                />
                {(fromStop || fromQuery) && (
                  <button
                    type="button"
                    aria-label="Wyczyść przystanek początkowy"
                    onClick={() => {
                      setFromStop(null);
                      setFromQuery("");
                      setConnections(null);
                      setActiveInput("from");
                      fromInputRef.current?.focus();
                    }}
                    className="tap grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px] text-text-faint hover:bg-white/8 hover:text-text"
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>

              {/* TO input */}
              <div className="relative flex h-11 items-center rounded-xl bg-white/6 pl-3.5 pr-1.5 transition-colors focus-within:bg-white/10 focus-within:ring-1 focus-within:ring-primary/50">
                <span className="mr-3 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
                <input
                  ref={toInputRef}
                  type="text"
                  placeholder="Dokąd: przystanek docelowy…"
                  value={toStop && activeInput !== "to" ? displayStopName(toStop.name) : toQuery}
                  onFocus={() => {
                    setActiveInput("to");
                    if (toStop) setToQuery(toStop.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && suggestions.length > 0) {
                      e.preventDefault();
                      handlePickStop(suggestions[0].s, "to");
                    }
                  }}
                  onChange={(e) => {
                    setToQuery(e.target.value);
                    if (toStop) {
                      setToStop(null);
                      setConnections(null);
                    }
                  }}
                  className="w-full min-w-0 bg-transparent text-base font-medium text-text outline-none ring-0 placeholder:font-normal placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:text-[14px]"
                />
                {(toStop || toQuery) && (
                  <button
                    type="button"
                    aria-label="Wyczyść przystanek docelowy"
                    onClick={() => {
                      setToStop(null);
                      setToQuery("");
                      setConnections(null);
                      setActiveInput("to");
                      toInputRef.current?.focus();
                    }}
                    className="tap grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px] text-text-faint hover:bg-white/8 hover:text-text"
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            </div>

            {/* Swap button */}
            <button
              type="button"
              aria-label="Zamień kierunki"
              title="Zamień kierunki"
              onClick={handleSwap}
              className="tap grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/6 text-[18px] text-text-mute hover:bg-white/10 hover:text-text"
            >
              <ArrowsDownUpIcon />
            </button>
          </div>

          {/* Day selection row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-[52px] shrink-0 text-[12px] text-text-faint">Dzień:</span>
            <button type="button" onClick={handlePickToday} className={chip(dateMode === "today")}>
              Dziś
            </button>
            <button type="button" onClick={handlePickTomorrow} className={chip(dateMode === "tomorrow")}>
              Jutro
            </button>

            {/* Custom date button & hidden native picker */}
            <label
              onClick={handleOpenDatePicker}
              className={`${chip(dateMode === "custom")} relative cursor-pointer select-none`}
            >
              <CalendarBlankIcon className="text-[14px]" weight={dateMode === "custom" ? "fill" : "bold"} />
              <span>{dateMode === "custom" ? formatDayLabel(selectedDate, todayStr) : "Inna data"}</span>
              <input
                ref={dateInputRef}
                type="date"
                min={todayStr}
                value={selectedDate}
                onChange={(e) => {
                  const val = e.target.value;
                  if (!val) return;
                  setSelectedDate(val);
                  if (val === todayStr) {
                    setDateMode("today");
                  } else if (val === tomorrowStr) {
                    setDateMode("tomorrow");
                  } else {
                    setDateMode("custom");
                  }
                  if (val !== todayStr && timeMode === "now") {
                    setTimeMode("custom");
                    setHour("05");
                    setMinute("00");
                  }
                  setConnections(null);
                }}
                className="absolute inset-0 opacity-0 pointer-events-none"
                tabIndex={-1}
                aria-label="Wybierz inną datę połączenia"
              />
            </label>
          </div>

          {/* 24-Hour Time selection row */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-[52px] shrink-0 text-[12px] text-text-faint">Odjazd:</span>

              {dateMode === "today" && (
                <button type="button" onClick={handleSetNow} className={chip(timeMode === "now")}>
                  Teraz
                </button>
              )}

              {/* Explicit 24h Time Stepper */}
              <TimeInput24H
                hour={hour}
                minute={minute}
                onChange={(h, m) => {
                  setHour(h);
                  setMinute(m);
                  setTimeMode("custom");
                  setConnections(null);
                }}
                onBlur={handleTimeBlur}
              />

              {/* Quick time adjustment presets */}
              <button
                type="button"
                onClick={() => handleAddMinutes(15)}
                className={`${CHIP} ${CHIP_OFF} px-2.5 tabular-nums`}
                title="Dodaj 15 minut"
              >
                +15m
              </button>
              <button
                type="button"
                onClick={() => handleAddMinutes(30)}
                className={`${CHIP} ${CHIP_OFF} px-2.5 tabular-nums`}
                title="Dodaj 30 minut"
              >
                +30m
              </button>
              <button
                type="button"
                onClick={() => handleAddMinutes(60)}
                className={`${CHIP} ${CHIP_OFF} px-2.5 tabular-nums`}
                title="Dodaj 1 godzinę"
              >
                +1h
              </button>
            </div>

            {fromStop && toStop && (
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading}
                className={`${CHIP} bg-white/8 px-3 text-text hover:bg-white/12 disabled:opacity-50`}
              >
                <ArrowsClockwiseIcon className="text-[14px]" />
                {loading ? "Szukanie…" : "Odśwież"}
              </button>
            )}
          </div>

          {/* Filter chips row */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline pt-3">
            <span className="w-[52px] shrink-0 text-[12px] text-text-faint">Filtry:</span>

            {/* Direct only filter chip */}
            <button
              type="button"
              onClick={() => {
                setDirectOnly((prev) => !prev);
                setConnections(null);
              }}
              className={chip(directOnly)}
              aria-pressed={directOnly}
              title="Pokaż wyłącznie bezpośrednie połączenia bez przesiadek"
            >
              <BusIcon className="text-[14px]" weight={directOnly ? "fill" : "bold"} />
              <span>Tylko bezpośrednie</span>
              {directOnly && <CheckIcon className="animate-pop text-[13px]" />}
            </button>

            {/* Min 5 min transfer buffer (when transfers are allowed) */}
            {!directOnly && (
              <button
                type="button"
                onClick={() => {
                  setMinTransfer5((prev) => !prev);
                  setConnections(null);
                }}
                className={chip(minTransfer5)}
                aria-pressed={minTransfer5}
                title="Filtruj połączenia z bezpiecznym czasem na przesiadkę (min. 5 minut)"
              >
                <ShieldCheckIcon className="text-[14px]" weight={minTransfer5 ? "fill" : "bold"} />
                <span>Bezpieczna przesiadka (5 min)</span>
                {minTransfer5 && <CheckIcon className="animate-pop text-[13px]" />}
              </button>
            )}

            {/* Sort order toggle chip */}
            <button
              type="button"
              onClick={() => {
                setSortBy((s) => (s === "departure" ? "duration" : "departure"));
                setConnections(null);
              }}
              className={chip(sortBy === "duration")}
              title={
                sortBy === "duration"
                  ? "Sortowanie: najkrótszy całkowity czas podróży"
                  : "Sortowanie: najwcześniejszy odjazd"
              }
            >
              {sortBy === "duration" ? (
                <LightningIcon className="text-[14px]" weight="fill" />
              ) : (
                <ClockIcon className="text-[14px]" />
              )}
              <span>{sortBy === "duration" ? "Najszybsza trasa" : "Wg odjazdu"}</span>
            </button>
          </div>
        </div>

        {/* Modal body */}
        <div className="kb-scroll min-h-0 flex-1 overflow-y-auto p-4">
          {/* Autocomplete suggestion list when user is picking stops */}
          {activeInput ? (
            <div>
              <p className="mb-1.5 px-1 text-[12px] font-medium text-text-faint">
                {activeInput === "from" ? "Wybierz przystanek początkowy" : "Wybierz przystanek docelowy"}
              </p>
              {suggestions.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-text-faint">Nie znaleziono pasujących przystanków.</p>
              ) : (
                <ul>
                  {suggestions.map((item) => (
                    <li key={item.s.id}>
                      <button
                        type="button"
                        onClick={() => handlePickStop(item.s, activeInput)}
                        className="flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/6 active:bg-white/10"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="grid w-4 shrink-0 place-items-center text-[14px] text-primary" aria-hidden>
                            {item.fav ? <StarIcon filled /> : <span className="h-1.5 w-1.5 rounded-full bg-white/25" />}
                          </span>
                          <span className="truncate text-[14px] text-text">{displayStopName(item.s.name)}</span>
                        </span>
                        {item.dist != null && (
                          <span className="ml-2 shrink-0 text-[12px] tabular-nums text-text-faint">
                            {formatDistance(item.dist)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : loading ? (
            /* Loading skeletons, shaped like the result cards */
            <div aria-hidden className="space-y-2.5">
              {[1, 2, 3].map((i) => (
                <div key={i} className="space-y-3 rounded-xl bg-white/4 p-3.5">
                  <div className="flex items-center justify-between">
                    <div className="skeleton h-5 w-32" />
                    <div className="skeleton h-5 w-20 rounded-full" />
                  </div>
                  <div className="flex gap-2">
                    <div className="skeleton h-7 w-9 rounded-lg" />
                    <div className="skeleton h-7 w-28" />
                  </div>
                </div>
              ))}
            </div>
          ) : connErr ? (
            <ErrorState
              onRetry={handleRefresh}
              message={connErr === "warming" ? GZM_LOADING : undefined}
            />
          ) : connections ? (
            connections.length === 0 ? (
              <div className="px-4 py-10 text-center animate-fade">
                <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white/5 text-[22px] text-text-faint">
                  <BusIcon />
                </span>
                <div className="mt-3">
                  <p className="text-[14px] font-medium text-text">
                    {directOnly ? "Brak bezpośrednich połączeń" : "Brak dostępnych połączeń"}
                  </p>
                  <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
                    {directOnly
                      ? "W rozkładzie nie ma bezpośredniego autobusu na wybraną godzinę. Spróbuj wyłączyć filtr, aby zobaczyć połączenia z przesiadką."
                      : dateMode === "today"
                        ? timeMode === "now"
                          ? "Brak dalszych kursów na dziś. Sprawdź połączenia na jutro."
                          : `Brak dalszych kursów na dziś od godziny ${hour}:${minute}. Sprawdź połączenia na jutro.`
                        : "Brak kursów w rozkładzie jazdy na wybrany dzień i godzinę."}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2 pt-5">
                  {directOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        setDirectOnly(false);
                        setConnections(null);
                      }}
                      className={`${CTA} h-9 text-[13px]`}
                    >
                      Pokaż z przesiadkami
                    </button>
                  )}
                  {dateMode === "today" && (
                    <button
                      type="button"
                      onClick={handlePickTomorrow}
                      className="tap inline-flex h-9 items-center rounded-full bg-white/8 px-4 text-[13px] font-medium text-text hover:bg-white/12"
                    >
                      Szukaj na jutro
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between px-1">
                  <p className="text-[12px] font-medium text-text-faint">
                    Znalezione połączenia ({connections.length})
                  </p>
                  <span className="text-[12px] text-text-mute">{effectiveDayLabel}</span>
                </div>

                {/* Earlier connections button */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={handleEarlierConnections}
                    className={`${CHIP} ${CHIP_OFF} px-4`}
                  >
                    <CaretUpIcon className="text-[13px]" />
                    <span>Wcześniejsze połączenia</span>
                  </button>
                </div>

                {connections.map((conn, idx) => {
                  const isExpanded = expandedIdx === idx;
                  const isDirect = conn.type === "direct";
                  const dayBadge = conn.dayLabel || effectiveDayLabel;

                  return (
                    <div
                      key={`${conn.departureTime}-${conn.arrivalTime}-${idx}`}
                      className="rounded-xl bg-white/4 p-3.5"
                    >
                      {/* Summary row */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[19px] font-semibold tracking-tight tabular-nums text-text">
                              {conn.departureTime}
                            </span>
                            <ArrowRightIcon className="self-center text-[13px] text-text-faint" />
                            <span className="text-[19px] font-semibold tracking-tight tabular-nums text-text">
                              {conn.arrivalTime}
                            </span>
                            {conn.arrivesNextDay && (
                              <span
                                className="self-center rounded-full bg-late/15 px-1.5 py-0.5 text-[11px] font-medium text-late"
                                title="Przyjazd następnego dnia"
                              >
                                +1 d.
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[12px] text-text-mute">
                            {dayBadge} · <span className="tabular-nums">{conn.totalDurationMins} min</span>
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-white/6 px-2.5 py-1 text-[12px] font-medium text-text-mute">
                          {isDirect
                            ? "Bezpośredni"
                            : `${conn.transfersCount} ${conn.transfersCount === 1 ? "przesiadka" : "przesiadki"}`}
                        </span>
                      </div>

                      {/* Line badges summary */}
                      <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
                        {conn.legs.map((leg, lIdx) => (
                          <div key={lIdx} className="flex min-w-0 items-center gap-1.5">
                            {lIdx > 0 && <CaretRightIcon className="text-[12px] text-text-faint" />}
                            <LineBadge line={leg.line} operator={leg.operator} />
                            <span className="max-w-[140px] truncate text-[13px] text-text-mute">
                              {displayStopName(leg.headsign)}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Transfer info if applicable */}
                      {!isDirect && conn.transferStopName && (
                        <p className="mt-2 text-[12px] text-text-faint">
                          Przesiadka: <span className="font-medium text-text-mute">{displayStopName(conn.transferStopName)}</span>{" "}
                          (oczekiwanie: {conn.transferWaitMins ?? 0} min)
                        </p>
                      )}

                      {/* Collapsible leg details */}
                      <div className="mt-3 border-t border-hairline pt-1">
                        <button
                          type="button"
                          onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                          aria-expanded={isExpanded}
                          className="flex h-9 w-full items-center justify-between text-[12px] font-medium text-text-mute transition-colors hover:text-text"
                        >
                          <span>{isExpanded ? "Ukryj szczegóły trasy" : "Pokaż szczegóły trasy"}</span>
                          <CaretDownIcon
                            className={`text-[13px] text-text-faint transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                          />
                        </button>

                        {isExpanded && (
                          <div className="mt-1 space-y-2 animate-fade">
                            {conn.legs.map((leg, lIdx) => (
                              <div key={lIdx} className="rounded-xl bg-white/4 p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <LineBadge line={leg.line} operator={leg.operator} />
                                    <span className="truncate text-[13px] font-medium text-text">
                                      Kierunek: {displayStopName(leg.headsign)}
                                    </span>
                                  </div>
                                  <span className="shrink-0 text-[12px] tabular-nums text-text-faint">
                                    {leg.stopsCount} {przystanekPlural(leg.stopsCount)} · {leg.durationMins} min
                                  </span>
                                </div>
                                <div className="ml-1 mt-2.5 space-y-1 border-l-2 border-white/12 pl-2.5 text-[12px] text-text-mute">
                                  <p>
                                    <span className="font-medium tabular-nums text-text">{leg.departureTime}</span>{" "}
                                    {displayStopName(leg.fromStopName)}
                                  </p>
                                  <p>
                                    <span className="font-medium tabular-nums text-text">{leg.arrivalTime}</span>{" "}
                                    {displayStopName(leg.toStopName)}
                                  </p>
                                </div>
                                <div className="mt-2 flex justify-end">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (onSelectConnection) onSelectConnection(conn, lIdx);
                                      onClose();
                                    }}
                                    className={`${CHIP} -mr-1.5 px-3 text-text hover:bg-white/8`}
                                  >
                                    <span>Pokaż ten odcinek na mapie</span>
                                    <ArrowRightIcon className="text-[13px]" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-3">
                        <span className="text-[12px] text-text-faint">
                          {conn.legs.length > 1
                            ? `${conn.legs.length} linie · ${conn.transfersCount} ${conn.transfersCount === 1 ? "przesiadka" : "przesiadki"}`
                            : "Bez przesiadek"}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (onSelectConnection) onSelectConnection(conn, null);
                            else if (fromStop) onSelectStop(fromStop);
                            onClose();
                          }}
                          className={`${CTA} h-9 shrink-0 text-[13px]`}
                        >
                          <MapTrifoldIcon className="text-[15px]" />
                          <span>Pokaż całą trasę na mapie</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Later connections button */}
                <div className="flex justify-center py-1">
                  <button
                    type="button"
                    onClick={handleLaterConnections}
                    className={`${CHIP} ${CHIP_OFF} px-4`}
                  >
                    <CaretDownIcon className="text-[13px]" />
                    <span>Późniejsze połączenia</span>
                  </button>
                </div>
              </div>
            )
          ) : (
            /* Initial state before picking stops */
            <div className="px-4 py-10 text-center animate-fade">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white/5 text-[22px] text-text-faint">
                <PathIcon />
              </span>
              <p className="mt-3 text-[14px] font-medium text-text">Wybierz przystanek początkowy i docelowy</p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
                {city === "gzm"
                  ? "Wyszukiwarka znajdzie najszybsze połączenia w sieci ZTM Metropolii GZM."
                  : "Wyszukiwarka znajdzie najszybsze połączenia autobusowe w sieciach KB i MZK Bielsko-Biała."}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectionsModal(props: ConnectionsModalProps) {
  if (!props.open) return null;
  return <ConnectionsDialog {...props} />;
}

export default memo(ConnectionsModal);
