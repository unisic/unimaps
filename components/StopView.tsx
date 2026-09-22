"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { useNow } from "@/components/hooks";
import { CloseIcon, EmptyState, ErrorState, IconButton, LineBadge, ShareButton, SkeletonRows, StarIcon } from "@/components/ui";
import { fetchJSON, getTripsBatch } from "@/lib/client/api";
import { useFavorites } from "@/lib/client/favorites";
import {
  countdown,
  delayClass,
  delayTxt,
  displayStopName,
  formatPlatform,
  hhmmFromSecs,
  isBusStation,
  secsFromHHMM,
  todayISO,
} from "@/lib/client/format";
import type {
  DepartureRow,
  DeparturesResponse,
  Stop,
  TimetableDeparture,
  TimetableResponse,
  Trip,
  Vehicle,
} from "@/lib/client/types";

type Tab = "live" | "tt";

interface Props {
  stop: Stop;
  desktop: boolean;
  vehicles?: Vehicle[];
  onClose: () => void;
  onShowLive: (execId: string, tripId: string | number | null) => void;
  onShowStatic: (tripId: string | number) => void;
  onPlanRoute?: (s: Stop) => void;
}

interface TtRow {
  dp: TimetableDeparture;
  line: string;
  dir: string;
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-faint" aria-hidden>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

const timetableRowCache = new Map<string, TtRow[]>();

function StopView({ stop, desktop, vehicles, onClose, onShowLive, onShowStatic, onPlanRoute }: Props) {
  const [tab, setTab] = useState<Tab>("live");

  const vehByExec = useMemo(() => {
    const m = new Map<string, Vehicle>();
    for (const v of vehicles ?? []) {
      if (v.id) m.set(v.id, v);
    }
    return m;
  }, [vehicles]);

  const vehByTrip = useMemo(() => {
    const m = new Map<string, Vehicle>();
    for (const v of vehicles ?? []) {
      if (v.trip_id) m.set(String(v.trip_id), v);
    }
    return m;
  }, [vehicles]);
  const [liveRows, setLiveRows] = useState<DepartureRow[] | null>(null);
  /* mirrors liveRows so the refresh closure can tell "have data" without going
     stale — a failed 30 s background refresh must not nuke a list we show */
  const liveRowsRef = useRef<DepartureRow[] | null>(null);
  const [liveErr, setLiveErr] = useState(false);
  const [liveTick, setLiveTick] = useState(0);
  const [tt, setTt] = useState<TtRow[] | null>(null);
  const [ttErr, setTtErr] = useState(false);
  const [ttPhase, setTtPhase] = useState<"timetable" | "trips" | null>(null);
  const now = useNow();
  /* module-level store — the palette's favorites section updates live too */
  const { isFav, toggle } = useFavorites();
  const fav = isFav(stop.designator);
  const isStation = isBusStation(stop.name, stop);

  /* live departures — fetch on open / manual retry + 30 s auto refresh
     (the component is keyed by stop.designator in MapApp, so state resets per stop) */
  useEffect(() => {
    if (tab !== "live") return;
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchJSON<DeparturesResponse>(
          `/api/stop/${encodeURIComponent(stop.designator)}/departures`,
          { cache: "no-store", signal: ac.signal },
        );
        if (!cancelled) {
          liveRowsRef.current = d.rows ?? [];
          setLiveRows(liveRowsRef.current);
          setLiveErr(false);
        }
      } catch {
        // only surface the error sheet when there is nothing to show; with a
        // list on screen stay silent and let the next 30 s tick retry
        if (!cancelled && !ac.signal.aborted && liveRowsRef.current === null) setLiveErr(true);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [stop.designator, tab, liveTick]);

  useEffect(() => {
    if (tab !== "live") return;
    /* hidden tab: skip the 30 s refetch (no one is looking); catch up with one
       immediate refresh the moment the tab becomes visible again */
    const id = setInterval(() => {
      if (!document.hidden) setLiveTick((t) => t + 1);
    }, 30000);
    const onVisible = () => {
      if (!document.hidden) setLiveTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tab, stop.designator]);

  /* today's timetable + per-trip line/direction (client-cached, deduped) */
  useEffect(() => {
    if (tab !== "tt" || tt !== null || ttErr) return;
    const ac = new AbortController();
    let cancelled = false;
    const cacheKey = `${stop.designator}:${todayISO()}`;
    (async () => {
      const cachedRows = timetableRowCache.get(cacheKey);
      if (cachedRows) {
        if (!cancelled) setTt(cachedRows);
        return;
      }
      try {
        setTtPhase("timetable");
        const d = await fetchJSON<TimetableResponse>(
          `/api/stop/${encodeURIComponent(stop.designator)}/timetable?date=${todayISO()}`,
          { signal: ac.signal },
        );
        const deps = d.departures ?? [];
        if (cancelled) return;
        setTtPhase("trips");
        const neededTripIds = Array.from(
          new Set(
            deps
              .filter((dp) => !dp.line || !dp.direction)
              .map((dp) => dp.trip_id)
              .filter(Boolean),
          ),
        );
        const tripMap =
          neededTripIds.length > 0
            ? await getTripsBatch(neededTripIds, ac.signal)
            : new Map<string, Trip | null>();
        if (cancelled) return;
        const rows: TtRow[] = deps.map((dp) => {
          const trip = tripMap.get(String(dp.trip_id));
          return {
            dp,
            line: dp.line || trip?.line?.name || "?",
            dir: dp.direction || trip?.direction || d.main_direction?.name || "",
          };
        });
        if (!cancelled) {
          timetableRowCache.set(cacheKey, rows);
          setTt(rows);
        }
      } catch {
        if (!cancelled && !ac.signal.aborted) setTtErr(true);
      } finally {
        if (!cancelled) setTtPhase(null);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [tab, tt, ttErr, stop.designator]);

  const liveLoading = liveRows === null && !liveErr;

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-bold leading-tight text-text">
            {displayStopName(stop.name)} {stop.symbol ? `(${stop.symbol})` : ""}
          </h2>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-text-faint flex-wrap">
            {stop.operator === "BOTH" ? (
              <>
                <span className="inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 font-bold text-white shadow-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/brand.svg" alt="" className="h-3 w-auto filter brightness-0 invert" />
                  KB
                </span>
                <span className="inline-flex items-center gap-1 rounded bg-blue-600 px-1.5 py-0.5 font-bold text-white shadow-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/mzk-logo.svg" alt="" className="h-3 w-auto filter brightness-0 invert" />
                  MZK
                </span>
              </>
            ) : stop.operator === "MZK" ? (
              <span className="inline-flex items-center gap-1 rounded bg-blue-600 px-1.5 py-0.5 font-bold text-white shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/mzk-logo.svg" alt="" className="h-3 w-auto filter brightness-0 invert" />
                MZK Bielsko-Biała
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 font-bold text-white shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand.svg" alt="" className="h-3 w-auto filter brightness-0 invert" />
                Komunikacja Beskidzka
              </span>
            )}
            <span>
              {isBusStation(stop.name, stop) ? "Dworzec autobusowy" : "Przystanek autobusowy"}
            </span>
            {stop.onRequest && (
              <span className="rounded bg-sky-500/20 px-1 font-medium text-sky-400">Na żądanie</span>
            )}
          </div>
        </div>
        {onPlanRoute && (
          <IconButton label="Wyznacz trasę stąd" onClick={() => onPlanRoute(stop)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="6" cy="19" r="3" />
              <path d="M9 19h8.5a4.5 4.5 0 0 0 0-9H7a4 4 0 0 1 0-8h11" />
              <polyline points="15 5 18 2 21 5" />
            </svg>
          </IconButton>
        )}
        <ShareButton title={`Przystanek ${displayStopName(stop.name)}`} />
        <IconButton
          label={fav ? "Usuń z ulubionych" : "Dodaj do ulubionych"}
          onClick={() => toggle(stop.designator)}
          pressed={fav}
        >
          <StarIcon filled={fav} />
        </IconButton>
        <IconButton label="Zamknij panel przystanku" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      {/* segmented tabs with sliding thumb */}
      <div
        className="relative mt-3 grid grid-cols-2 rounded-full bg-white/6 p-1"
        role="tablist"
        aria-label="Widok przystanku"
      >
        <span
          className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-surface-3 transition-transform duration-300 ${
            tab === "tt" ? "translate-x-[calc(100%+8px)]" : "translate-x-0"
          }`}
          style={{ transitionTimingFunction: "var(--ease-spring)" }}
          aria-hidden
        />
        {(
          [
            ["live", "Odjazdy"],
            ["tt", "Rozkład dziś"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`relative z-10 rounded-full py-1.5 text-[13px] font-semibold transition-colors ${
              tab === key ? "text-text" : "text-text-mute hover:text-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </header>
  );

  return (
    <BottomSheet
      desktop={desktop}
      onClose={onClose}
      ariaLabel={`Odjazdy z przystanku ${displayStopName(stop.name)}`}
      initialSnap="half"
      header={header}
    >
      <div key={tab} className="kb-scroll h-full overflow-y-auto pb-4 animate-fade">
        {tab === "live" ? (
          liveErr ? (
            <ErrorState
              onRetry={() => {
                setLiveErr(false);
                liveRowsRef.current = null;
                setLiveRows(null);
                setLiveTick((t) => t + 1);
              }}
            />
          ) : liveLoading ? (
            <SkeletonRows />
          ) : liveRows && liveRows.length === 0 ? (
            <EmptyState text="Brak przyjazdów w najbliższych godzinach." />
          ) : (
            <ul className="stagger px-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
              {(liveRows ?? []).map((row, i) => {
                const liveVeh =
                  (row.trip_execution_id ? vehByExec.get(row.trip_execution_id) : null) ??
                  (row.trip_id != null ? vehByTrip.get(String(row.trip_id)) : null);
                const planned = row.static_time || (row.time?.includes(":") ? row.time : "");
                const td = liveVeh?.delay != null ? liveVeh.delay : (row.is_estimated ? row.time_diff : null);
                const est = (liveVeh != null && liveVeh.delay != null) || (!!row.is_estimated && td != null);
                const plannedSecs = secsFromHHMM(planned);
                const actualSecs = est && plannedSecs != null && td != null ? plannedSecs + td : null;
                const line = row.line_name || row.symbol || "?";
                const plat = formatPlatform(row.platform, isStation);
                const sideNum = row.side_number || liveVeh?.side_number;
                const vehModel = row.model || liveVeh?.model;
                const vehDetails = sideNum ? `#${sideNum}${vehModel ? ` · ${vehModel}` : ""}` : null;
                const sub = [
                  planned ? `plan ${planned}` : "",
                  plat,
                  vehDetails,
                ]
                  .filter(Boolean)
                  .join(" · ");

                const timeText =
                  actualSecs != null
                    ? countdown(actualSecs, now) || planned || row.time || ""
                    : row.time || planned || "";

                return (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => onShowLive(row.trip_execution_id || "", row.trip_id ?? null)}
                      className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-all hover:bg-white/5 active:scale-[0.985] active:bg-white/8"
                    >
                      <LineBadge line={line} operator={row.operator} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-text">
                          {row.direction ? displayStopName(row.direction) : `Linia ${line}`}
                        </p>
                        {sub && (
                          <p className="mt-0.5 text-[11px] tabular-nums text-text-faint">{sub}</p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className={`text-[15px] font-bold tabular-nums ${est ? delayClass(td) : "text-text"}`}>
                          {timeText}
                        </p>
                        {est ? (
                          <p className={`text-[11px] font-medium tabular-nums ${delayClass(td)}`}>
                            {delayTxt(td)}
                          </p>
                        ) : (
                          <p className="text-[11px] text-text-faint">
                            rozkładowo
                          </p>
                        )}
                      </div>
                      <Chevron />
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : ttErr ? (
          <ErrorState
            onRetry={() => {
              setTtErr(false);
              setTt(null);
            }}
          />
        ) : tt === null ? (
          <>
            <p className="px-4 pt-3 text-center text-[11px] text-text-faint" role="status">
              {ttPhase === "trips" ? "Wczytywanie tras linii…" : "Pobieranie rozkładu…"}
            </p>
            <SkeletonRows />
          </>
        ) : tt.length === 0 ? (
          <EmptyState text="Brak odjazdów dziś." />
        ) : (
          <ul className="stagger px-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
            {tt.map(({ dp, line, dir }, i) => (
              <li key={`${dp.trip_id}-${i}`}>
                <button
                  type="button"
                  onClick={() => onShowStatic(dp.trip_id)}
                  className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-all hover:bg-white/5 active:scale-[0.985] active:bg-white/8"
                >
                  <LineBadge line={line} operator={dp.operator} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-text">{dir ? displayStopName(dir) : `Linia ${line}`}</p>
                    {formatPlatform(dp.platform, isStation) && (
                      <p className="mt-0.5 text-[11px] text-text-faint">
                        {formatPlatform(dp.platform, isStation)}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 text-[15px] font-bold tabular-nums text-text">
                    {hhmmFromSecs(dp.departure)}
                  </p>
                  <Chevron />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
}

export default memo(StopView);
