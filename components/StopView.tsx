"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { CloseIcon, EmptyState, ErrorState, IconButton, LineBadge, ShareButton, SkeletonRows, StarIcon } from "@/components/ui";
import { fetchJSON, getTripsBatch } from "@/lib/client/api";
import { useFavorites } from "@/lib/client/favorites";
import { createLivePoll, LIVE_STALE_MS, type LivePoll } from "@/lib/client/live-poll";
import {
  delayClass,
  delayTxt,
  displayStopName,
  formatPlatform,
  hhmmFromSecs,
  isBusStation,
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
import { etaLabel, hhmm, resolveTiming, sortBoard, uniqueKeys, type BoardItem } from "@/lib/shared/departures";

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

/** An upstream source failed: the list is incomplete, not empty (a failed MZK fetch used to look like "no MZK buses"). */
function SourceWarning({ sources }: { sources: ReadonlyArray<"kb" | "mzk"> }) {
  return (
    <p
      role="status"
      className="mx-4 mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300"
    >
      Brak danych z {sources.map((s) => s.toUpperCase()).join(" i ")} — lista może być niepełna.
    </p>
  );
}

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
  const [liveWarn, setLiveWarn] = useState<ReadonlyArray<"kb" | "mzk">>([]);
  const [ttWarn, setTtWarn] = useState<ReadonlyArray<"kb" | "mzk">>([]);
  const [tt, setTt] = useState<TtRow[] | null>(null);
  const [ttErr, setTtErr] = useState(false);
  const [ttPhase, setTtPhase] = useState<"timetable" | "trips" | null>(null);
  /* "now" on the SERVER's clock (epoch s): every row time is an absolute instant, so there is no
     seconds-of-day / midnight arithmetic left, and a wrong device clock cannot shift the countdowns.
     skewRef = server_ts - device clock, refreshed by every successful fetch. */
  const skewRef = useRef(0);
  const [nowTs, setNowTs] = useState(() => Date.now() / 1000);
  /* server clock (epoch s) of the last SUCCESSFUL fetch — a list whose rows have all aged out while
     refetches keep failing must read as "no fresh data", not as "no departures" */
  const [fetchedTs, setFetchedTs] = useState(0);
  /* device clock (ms) of the last successful fetch + a 5 s tick: drives the "data is old" stamp */
  const [lastOkMs, setLastOkMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  /* the .stagger entrance animation must play ONCE: a keyed reorder re-inserts DOM nodes and would
     replay it on every row that React moves (verified in Chromium) */
  const [fresh, setFresh] = useState(true);
  /* module-level store — the palette's favorites section updates live too */
  const { isFav, toggle } = useFavorites();
  const fav = isFav(stop.designator);
  const isStation = isBusStation(stop.name, stop);

  /* live departures: poll controller (lib/client/live-poll) — 10 s cadence while visible, per-request timeout,
     backoff, immediate catch-up on visibility/pageshow/focus/online, never two requests in flight, a failing
     refresh never wipes a list we show. The component is keyed by stop.designator in MapApp. */
  const pollRef = useRef<LivePoll | null>(null);
  useEffect(() => {
    if (tab !== "live") return;
    const url = `/api/stop/${encodeURIComponent(stop.designator)}/departures`;
    const poll = createLivePoll<DeparturesResponse>({
      load: (signal) => fetchJSON<DeparturesResponse>(url, { cache: "no-store", signal }),
      onOk: (d) => {
        liveRowsRef.current = d.rows ?? [];
        if (typeof d.server_ts === "number") skewRef.current = d.server_ts - Date.now() / 1000;
        const t = Date.now() / 1000 + skewRef.current;
        setNowTs(t);
        setFetchedTs(t);
        setLastOkMs(Date.now());
        setLiveRows(liveRowsRef.current);
        setLiveWarn(d.warnings ?? []);
        setLiveErr(false);
      },
      // the error sheet only when there is nothing to show; with a list on screen the next poll retries
      onFail: () => {
        if (liveRowsRef.current === null) setLiveErr(true);
      },
      isVisible: () => !document.hidden,
    });
    pollRef.current = poll;
    poll.start();
    const kick = () => poll.kick();
    document.addEventListener("visibilitychange", kick);
    window.addEventListener("pageshow", kick);
    window.addEventListener("focus", kick);
    window.addEventListener("online", kick);
    /* 5 s UI tick: countdowns on the server clock + freshness stamp + poll watchdog */
    const id = setInterval(() => {
      setNowTs(Date.now() / 1000 + skewRef.current);
      setNowMs(Date.now());
      poll.tick();
    }, 5000);
    return () => {
      poll.stop();
      pollRef.current = null;
      clearInterval(id);
      document.removeEventListener("visibilitychange", kick);
      window.removeEventListener("pageshow", kick);
      window.removeEventListener("focus", kick);
      window.removeEventListener("online", kick);
    };
  }, [stop.designator, tab]);

  const hasRows = liveRows !== null;
  useEffect(() => {
    if (!hasRows) return;
    const t = setTimeout(() => setFresh(false), 900);
    return () => clearTimeout(t);
  }, [hasRows]);

  /* ONE canonical ETA per row (lib/shared/departures): the countdown on screen and the order of the
     list come from the same number — nearest departure first, as displayed */
  const board = useMemo(() => {
    const items = (liveRows ?? []).map((row) => {
      const veh =
        (row.trip_execution_id ? vehByExec.get(row.trip_execution_id) : null) ??
        (row.trip_id != null ? vehByTrip.get(String(row.trip_id)) : null) ??
        null;
      return { row, veh, timing: resolveTiming(row, veh) } satisfies BoardItem<DepartureRow> & { veh: Vehicle | null };
    });
    const sorted = sortBoard(items, nowTs);
    const keys = uniqueKeys(sorted.map((it) => it.row));
    return sorted.map((it, i) => ({ ...it, key: keys[i] }));
  }, [liveRows, vehByExec, vehByTrip, nowTs]);

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
          if (!d.warnings?.length) timetableRowCache.set(cacheKey, rows);
          setTtWarn(d.warnings ?? []);
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
  const staleEmpty = liveRows !== null && liveRows.length > 0 && board.length === 0 && nowTs - fetchedTs > 90;

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
        {(tab === "live" ? liveWarn : ttWarn).length > 0 && !liveErr && (
          <SourceWarning sources={tab === "live" ? liveWarn : ttWarn} />
        )}
        {tab === "live" ? (
          liveErr || staleEmpty ? (
            <ErrorState
              onRetry={() => {
                setLiveErr(false);
                liveRowsRef.current = null;
                setLiveRows(null);
                pollRef.current?.refreshNow();
              }}
            />
          ) : liveLoading ? (
            <SkeletonRows />
          ) : board.length === 0 ? (
            <EmptyState text="Brak przyjazdów w najbliższych godzinach." />
          ) : (
            <>
            {lastOkMs > 0 && nowMs - lastOkMs > LIVE_STALE_MS && (
              <p className="mx-4 mt-2 text-[11px] text-amber-300" role="status">
                Dane sprzed {Math.round((nowMs - lastOkMs) / 1000)} s —{" "}
                <button type="button" className="underline" onClick={() => pollRef.current?.refreshNow()}>
                  odśwież
                </button>
              </p>
            )}
          <ul className={`${fresh ? "stagger " : ""}px-2`} style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
              {board.map(({ row, veh, timing, key }) => {
                const line = row.line_name || row.symbol || "?";
                const plat = formatPlatform(row.platform, isStation);
                const sideNum = row.side_number || veh?.side_number;
                const vehModel = row.model || veh?.model;
                const vehDetails = sideNum ? `#${sideNum}${vehModel ? ` · ${vehModel}` : ""}` : null;
                const sub = [
                  timing.planTs != null ? `plan ${hhmm(timing.planTs)}` : "",
                  plat,
                  vehDetails,
                ]
                  .filter(Boolean)
                  .join(" · ");
                const timeText = etaLabel(timing, nowTs, row.time ?? "");
                const td = timing.delaySec;
                const est = timing.estimated && !timing.canceled;
                /* KB boards carry only direction_id; the server resolves it through the board's
                   `directions` map, the live vehicle's headsign is the fallback */
                const dest = row.direction || veh?.headsign;

                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => onShowLive(row.trip_execution_id || "", row.trip_id ?? null)}
                      className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-all hover:bg-white/5 active:scale-[0.985] active:bg-white/8"
                    >
                      <LineBadge line={line} operator={row.operator} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-text">
                          {dest ? displayStopName(dest) : `Linia ${line}`}
                        </p>
                        {sub && (
                          <p className="mt-0.5 text-[11px] tabular-nums text-text-faint">{sub}</p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={`text-[15px] font-bold tabular-nums ${
                            timing.canceled ? "text-text-faint line-through" : est ? delayClass(td) : "text-text"
                          }`}
                        >
                          {timeText}
                        </p>
                        {timing.canceled ? null : est ? (
                          <p className={`text-[11px] font-medium tabular-nums ${delayClass(td)}`}>
                            {delayTxt(td)}
                          </p>
                        ) : timing.source === "waiting" ? (
                          <p className="text-[11px] font-medium text-late">czeka na odjazd</p>
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
          </>
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
