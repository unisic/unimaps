"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { CaretDownIcon, CaretRightIcon, CaretUpIcon, PathIcon, WarningCircleIcon } from "@/components/icons";
import { CloseIcon, EmptyState, ErrorState, IconButton, LineBadge, ShareButton, SkeletonRows, StarIcon } from "@/components/ui";
import { fetchJSON, getTripsBatch } from "@/lib/client/api";
import { useFavorites } from "@/lib/client/favorites";
import { createLivePoll, LIVE_STALE_MS, type LivePoll } from "@/lib/client/live-poll";
import {
  delayClass,
  delayTxt,
  displayStopName,
  formatDayLabel,
  formatPlatform,
  hhmmFromSecs,
  isBusStation,
  offsetDateISO,
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
import {
  AUTO_AHEAD_SEC,
  autoLaterHorizon,
  boardExtension,
  etaClock,
  etaLabel,
  hhmm,
  isGone,
  nextEarlierHorizon,
  nextLaterHorizon,
  resolveTiming,
  schedTiming,
  schedVehicle,
  sortBoard,
  uniqueKeys,
  vehicleTripKey,
  warsawDateISO,
  warsawDayTs,
  type Timing,
  type BoardItem,
} from "@/lib/shared/departures";

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
  return <CaretRightIcon className="shrink-0 text-[13px] text-text-faint" />;
}

function OperatorTag({ op, label }: { op: "kb" | "mzk"; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${op === "kb" ? "bg-kb" : "bg-mzk"}`} aria-hidden />
      {label}
    </span>
  );
}

type Warnings = ReadonlyArray<"kb" | "mzk">;
const NO_WARNINGS: Warnings = [];

/** One day of the stop's timetable. Absent from the map = not requested yet or still fetching. */
type DayLoad = { status: "trips" } | { status: "ok"; rows: TtRow[]; warnings: Warnings } | { status: "error" };

/** A timetable departure on the absolute time line, shaped as a board row so it sorts with the live ones. */
interface SchedItem {
  trip_id: number | string;
  operator?: "KB" | "MZK";
  planTs: number;
  date: string;
  row: DepartureRow;
}

/** How far the live board is extended with timetable rows (`at` = horizon, epoch s). */
interface Reveal {
  at: number | null;
  busy: boolean;
  err: boolean;
  /** tapped at least once: an empty answer then reads "none", not a silently vanished button */
  tried: boolean;
}
const REVEAL_IDLE: Reveal = { at: null, busy: false, err: false, tried: false };
/** departures added per "Pokaż wcześniejsze / późniejsze" tap */
const REVEAL_STEP = 10;

/* complete days only (a day with a failed upstream leg is never cached), FIFO-capped:
   one busy hub is ~450 rows */
const timetableRowCache = new Map<string, TtRow[]>();
const TT_CACHE_MAX = 8;

/** One day of the timetable with every row's line and direction (KB rows carry neither: resolved via /api/trips). */
async function loadDay(designator: string, date: string, signal: AbortSignal, onTrips: () => void): Promise<DayLoad> {
  const cacheKey = `${designator}:${date}`;
  const cached = timetableRowCache.get(cacheKey);
  if (cached) return { status: "ok", rows: cached, warnings: NO_WARNINGS };
  try {
    const d = await fetchJSON<TimetableResponse>(
      `/api/stop/${encodeURIComponent(designator)}/timetable?date=${date}`,
      { signal },
    );
    const deps = d.departures ?? [];
    onTrips();
    const neededTripIds = Array.from(
      new Set(
        deps
          .filter((dp) => !dp.line || !dp.direction)
          .map((dp) => dp.trip_id)
          .filter(Boolean),
      ),
    );
    const tripMap =
      neededTripIds.length > 0 ? await getTripsBatch(neededTripIds, signal) : new Map<string, Trip | null>();
    // getTripsBatch stops early on abort: a half-resolved day must not be cached
    if (signal.aborted) return { status: "error" };
    const rows: TtRow[] = deps.map((dp) => {
      const trip = tripMap.get(String(dp.trip_id));
      return {
        dp,
        line: dp.line || trip?.line?.name || "?",
        dir: dp.direction || trip?.direction || d.main_direction?.name || "",
      };
    });
    const warnings = d.warnings ?? NO_WARNINGS;
    if (!warnings.length) {
      timetableRowCache.set(cacheKey, rows);
      for (const k of timetableRowCache.keys()) {
        if (timetableRowCache.size <= TT_CACHE_MAX) break;
        timetableRowCache.delete(k);
      }
    }
    return { status: "ok", rows, warnings };
  } catch {
    return { status: "error" };
  }
}

/* per rows array (one array = one stop-day), so the Intl work runs once per loaded day */
const schedCache = new WeakMap<readonly TtRow[], SchedItem[]>();

function schedOfDay(date: string, rows: readonly TtRow[]): SchedItem[] {
  const hit = schedCache.get(rows);
  if (hit) return hit;
  const out: SchedItem[] = [];
  for (const { dp, line, dir } of rows) {
    const planTs = warsawDayTs(date, dp.departure);
    if (planTs == null) continue;
    out.push({
      trip_id: dp.trip_id,
      operator: dp.operator,
      planTs,
      date,
      row: {
        operator: dp.operator,
        line_name: line,
        trip_id: dp.trip_id,
        plan_ts: planTs,
        eta_ts: null,
        delay_sec: null,
        row_key: `tt:${date}:${dp.trip_id}:${dp.departure}`,
        platform: dp.platform,
        direction: dir || undefined,
      },
    });
  }
  schedCache.set(rows, out);
  return out;
}

function schedOf(days: ReadonlyMap<string, DayLoad>): SchedItem[] {
  const out: SchedItem[] = [];
  for (const [date, d] of days) if (d.status === "ok") out.push(...schedOfDay(date, d.rows));
  return out;
}

/** boardExtension at the server-aligned current instant; event handlers only, never during render. */
function extensionNow(days: ReadonlyMap<string, DayLoad>, live: readonly DepartureRow[] | null, skewSec: number) {
  return boardExtension(schedOf(days), live ?? [], Date.now() / 1000 + skewSec);
}

function MoreButton({ dir, busy, err, onClick }: { dir: "earlier" | "later"; busy: boolean; err: boolean; onClick: () => void }) {
  const Icon = dir === "earlier" ? CaretUpIcon : CaretDownIcon;
  return (
    <div className="flex justify-center px-4 py-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-busy={busy}
        className={`tap inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium hover:bg-white/5 disabled:opacity-60 ${
          err ? "text-late" : "text-text-mute hover:text-text"
        }`}
      >
        <Icon className="text-[12px]" />
        {busy
          ? "Wczytywanie rozkładu…"
          : err
            ? "Nie udało się wczytać rozkładu, ponów"
            : dir === "earlier"
              ? "Pokaż wcześniejsze"
              : "Pokaż późniejsze"}
      </button>
    </div>
  );
}

/**
 * A timetable departure the live board does not list. Its bus on the road (matched by trip): the plan
 * + the bus's current delay, opens the live trip; otherwise "rozkładowo", opens the static trip.
 */
function ScheduleRow({
  item,
  veh,
  timing,
  nowTs,
  dayLabel,
  isStation,
  past,
  onShowStatic,
  onShowLive,
}: {
  item: SchedItem;
  veh: Vehicle | null;
  timing: Timing;
  nowTs: number;
  dayLabel: string | null;
  isStation: boolean;
  past?: boolean;
  onShowStatic: (tripId: string | number) => void;
  onShowLive: (execId: string, tripId: string | number | null) => void;
}) {
  const { row } = item;
  const line = row.line_name || veh?.line || "?";
  const est = timing.estimated;
  const td = timing.delaySec;
  const vehDetails = veh?.side_number ? `#${veh.side_number}${veh.model ? ` · ${veh.model}` : ""}` : null;
  const sub = [
    dayLabel,
    veh && past ? "w trasie" : null,
    veh ? `plan ${hhmm(item.planTs)}` : null,
    formatPlatform(row.platform, isStation),
    vehDetails,
  ]
    .filter(Boolean)
    .join(" · ");
  const dest = row.direction || veh?.headsign;
  /* a countdown to a departure already behind us means nothing: past rows print the clock time */
  const timeText = veh && !past ? etaLabel(timing, nowTs) : etaClock(timing);
  return (
    <button
      type="button"
      onClick={() => (veh ? onShowLive(veh.id, item.trip_id) : onShowStatic(item.trip_id))}
      className={`tap flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-white/5 active:bg-white/8 ${
        past ? "opacity-60" : ""
      }`}
    >
      <LineBadge line={line} operator={row.operator} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-text">{dest ? displayStopName(dest) : `Linia ${line}`}</p>
        {sub && <p className="mt-0.5 truncate text-[12px] tabular-nums text-text-faint">{sub}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-[15px] font-semibold tabular-nums ${est ? delayClass(td) : "text-text"}`}>{timeText}</p>
        {est ? (
          <p className={`text-[12px] font-medium tabular-nums ${delayClass(td)}`}>{delayTxt(td)}</p>
        ) : timing.source === "waiting" ? (
          <p className="text-[12px] font-medium text-late">czeka na odjazd</p>
        ) : (
          <p className="text-[12px] text-text-faint">{veh ? "w trasie" : "rozkładowo"}</p>
        )}
      </div>
      <Chevron />
    </button>
  );
}

/** An upstream source failed: the list is incomplete, not empty (a failed MZK fetch used to look like "no MZK buses"). */
function SourceWarning({ sources }: { sources: ReadonlyArray<"kb" | "mzk"> }) {
  return (
    <p
      role="status"
      className="mx-4 mt-3 flex items-center gap-2 rounded-xl bg-late/10 px-3 py-2 text-[12px] text-late"
    >
      <WarningCircleIcon className="shrink-0 text-[14px]" />
      Brak danych z {sources.map((s) => s.toUpperCase()).join(" i ")}, lista może być niepełna.
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
  /* the timetable trip each running bus serves (MZK: its course; KB: the static id the server
     learned from the departures boards), so a timetable row can show its bus */
  const vehBySched = useMemo(() => {
    const m = new Map<string, Vehicle>();
    for (const v of vehicles ?? []) {
      const k = vehicleTripKey(v);
      if (k) m.set(k, v);
    }
    return m;
  }, [vehicles]);

  const [liveRows, setLiveRows] = useState<DepartureRow[] | null>(null);
  /* mirrors liveRows so the refresh closure can tell "have data" without going
     stale — a failed 30 s background refresh must not nuke a list we show */
  const liveRowsRef = useRef<DepartureRow[] | null>(null);
  const [liveErr, setLiveErr] = useState(false);
  const [liveWarn, setLiveWarn] = useState<Warnings>(NO_WARNINGS);
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

  /* the stop's timetable per date: today (the date the sheet opened) feeds the "Rozkład dziś" tab and the
     earlier/later rows of the live board, tomorrow only once "later" runs past today's last departure.
     Loads live for the whole sheet (one AbortController), so switching tabs never drops a fetch half way. */
  const [day0] = useState(todayISO);
  const day1 = offsetDateISO(day0, 1);
  const [days, setDays] = useState<ReadonlyMap<string, DayLoad>>(() => new Map());
  const daysRef = useRef(days);
  const dayLoadsRef = useRef(new Map<string, Promise<DayLoad>>());
  const lifeAcRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    const loads = dayLoadsRef.current;
    lifeAcRef.current = ac;
    return () => {
      ac.abort();
      loads.clear();
    };
  }, []);

  const putDay = useCallback((date: string, v: DayLoad | null) => {
    const next = new Map(daysRef.current);
    if (v) next.set(date, v);
    else next.delete(date);
    daysRef.current = next;
    setDays(next);
  }, []);

  /** Deduped: one request per date while it is in flight or loaded; a failed day is fetched again on the next call. */
  const ensureDay = useCallback(
    (date: string): Promise<DayLoad> => {
      const hit = dayLoadsRef.current.get(date);
      if (hit) return hit;
      const ac = lifeAcRef.current;
      if (!ac || ac.signal.aborted) return Promise.resolve({ status: "error" });
      const p = loadDay(stop.designator, date, ac.signal, () => {
        if (!ac.signal.aborted) putDay(date, { status: "trips" });
      }).then((res) => {
        if (ac.signal.aborted) return res;
        if (res.status === "error") dayLoadsRef.current.delete(date);
        putDay(date, res);
        return res;
      });
      dayLoadsRef.current.set(date, p);
      return p;
    },
    [stop.designator, putDay],
  );

  /* today loads with the sheet on either tab: the live board fills the courses OnTime leaves out
     (it lists only those with a tracked bus) from it; one request, cached 15 min server-side */
  useEffect(() => {
    void ensureDay(day0);
  }, [day0, ensureDay]);

  const ttLoad = days.get(day0);
  const tt = ttLoad?.status === "ok" ? ttLoad.rows : null;
  const ttErr = ttLoad?.status === "error";
  const ttWarn = ttLoad?.status === "ok" ? ttLoad.warnings : NO_WARNINGS;

  const sched = useMemo(() => schedOf(days), [days]);
  const ext = useMemo(() => boardExtension(sched, liveRows ?? [], nowTs), [sched, liveRows, nowTs]);
  const [earlier, setEarlier] = useState<Reveal>(REVEAL_IDLE);
  const [later, setLater] = useState<Reveal>(REVEAL_IDLE);

  /* the extension as of NOW, for the tap handlers (state read after an await would be stale) */
  const extNow = () => extensionNow(daysRef.current, liveRowsRef.current, skewRef.current);

  const showEarlier = async () => {
    const from = earlier.at;
    setEarlier({ at: from, busy: true, err: false, tried: true });
    const day = await ensureDay(day0);
    if (lifeAcRef.current?.signal.aborted) return;
    const at = day.status === "ok" ? nextEarlierHorizon(extNow().earlier, from, REVEAL_STEP) : null;
    setEarlier({ at: at ?? from, busy: false, err: day.status !== "ok", tried: true });
  };

  const showLater = async () => {
    const prev = later.at;
    /* continue from what the board shows now, auto-filled rows included */
    const until = laterUntil;
    setLater({ at: prev, busy: true, err: false, tried: true });
    let ok = (await ensureDay(day0)).status === "ok";
    let next = extNow().later;
    if (ok && next.filter((s) => until == null || s.planTs > until).length < REVEAL_STEP) {
      // today's timetable runs out: continue into tomorrow's
      ok = (await ensureDay(day1)).status === "ok";
      next = extNow().later;
    }
    if (lifeAcRef.current?.signal.aborted) return;
    const at = nextLaterHorizon(next, until, REVEAL_STEP);
    setLater({ at: at ?? prev, busy: false, err: !ok && at == null, tried: true });
  };

  const earlierShown = useMemo(() => {
    const from = earlier.at;
    if (from == null) return [];
    return ext.earlier
      .filter((s) => s.planTs >= from)
      .map((s) => {
        const veh = schedVehicle(s, vehBySched, nowTs);
        return { s, veh, timing: schedTiming(s.planTs, veh) };
      });
  }, [ext.earlier, earlier.at, vehBySched, nowTs]);
  const earlierKeys = useMemo(() => uniqueKeys(earlierShown.map((e) => e.s.row)), [earlierShown]);
  /* nothing left to reveal: the earliest/latest timetable row is already on screen (or there is none) */
  const earliestTs = ext.earlier.length ? ext.earlier[0].planTs : null;
  const latestTs = ext.later.length ? ext.later[ext.later.length - 1].planTs : null;
  const todayNow = useMemo(() => warsawDateISO(nowTs), [nowTs]);
  const dayLabel = (date: string) => (date === todayNow ? null : formatDayLabel(date, todayNow));

  /* ONE canonical ETA per row (lib/shared/departures): the countdown on screen and the order of the
     list come from the same number — nearest departure first, as displayed. Timetable rows join the
     same order: the courses the live board misses (OnTime lists only tracked ones), then departures
     past its end up to an hour ahead / its last live row and until it holds AUTO_MIN_ROWS, further
     after "Pokaż późniejsze". A timetable row whose bus is on the road carries that bus's delay. */
  const { board, laterUntil } = useMemo(() => {
    type Entry = BoardItem<DepartureRow> & { veh: Vehicle | null; sched: SchedItem | null };
    const items: Entry[] = (liveRows ?? []).map((row) => {
      const veh =
        (row.trip_execution_id ? vehByExec.get(row.trip_execution_id) : null) ??
        (row.trip_id != null ? vehByTrip.get(String(row.trip_id)) : null) ??
        null;
      return { row, veh, timing: resolveTiming(row, veh), sched: null };
    });
    const addSched = (s: SchedItem) => {
      const veh = schedVehicle(s, vehBySched, nowTs);
      items.push({ row: s.row, veh, timing: schedTiming(s.planTs, veh), sched: s });
    };
    for (const s of ext.gaps) addSched(s);
    const shown = items.filter((it) => !isGone(it.timing, nowTs)).length;
    const auto = autoLaterHorizon(ext.later, shown, Math.max(nowTs + AUTO_AHEAD_SEC, ext.liveEnd ?? 0));
    const until = auto == null ? later.at : later.at == null ? auto : Math.max(auto, later.at);
    if (until != null) {
      for (const s of ext.later) {
        if (s.planTs > until) break;
        addSched(s);
      }
    }
    const sorted = sortBoard(items, nowTs);
    const keys = uniqueKeys(sorted.map((it) => it.row));
    return { board: sorted.map((it, i) => ({ ...it, key: keys[i] })), laterUntil: until };
  }, [liveRows, vehByExec, vehByTrip, vehBySched, nowTs, ext, later.at]);
  const earlierDone =
    days.get(day0)?.status === "ok" && (earliestTs == null || (earlier.at != null && earliestTs >= earlier.at));
  const laterDone =
    days.get(day1)?.status === "ok" && (latestTs == null || (laterUntil != null && latestTs <= laterUntil));
  /* an empty live board is not "no departures" until today's timetable has had its say */
  const ttPending = days.get(day0) === undefined || days.get(day0)?.status === "trips";

  const liveLoading = liveRows === null && !liveErr;
  const staleEmpty =
    liveRows !== null && liveRows.length > 0 && !board.some((it) => it.sched === null) && nowTs - fetchedTs > 90;

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-[17px] font-semibold leading-tight tracking-tight text-text">
            {displayStopName(stop.name)}
            {stop.symbol && <span className="ml-1.5 font-normal text-text-faint">{stop.symbol}</span>}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-text-mute">
            {stop.operator === "BOTH" ? (
              <>
                <OperatorTag op="kb" label="KB" />
                <OperatorTag op="mzk" label="MZK" />
              </>
            ) : stop.operator === "MZK" ? (
              <OperatorTag op="mzk" label="MZK Bielsko-Biała" />
            ) : (
              <OperatorTag op="kb" label="Komunikacja Beskidzka" />
            )}
            <span className="text-text-faint">
              {isStation ? "Dworzec autobusowy" : "Przystanek"}
              {stop.onRequest && ", na żądanie"}
            </span>
          </div>
        </div>
        {onPlanRoute && (
          <IconButton label="Wyznacz trasę stąd" onClick={() => onPlanRoute(stop)}>
            <PathIcon />
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
        className="relative mt-3.5 grid grid-cols-2 rounded-full bg-white/5 p-1"
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
            className={`relative z-10 rounded-full py-1.5 text-[13px] font-medium transition-colors ${
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
          ) : (
            <div style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
            {lastOkMs > 0 && nowMs - lastOkMs > LIVE_STALE_MS && (
              <p className="mx-4 mt-2 text-[12px] text-late" role="status">
                Dane sprzed {Math.round((nowMs - lastOkMs) / 1000)} s.{" "}
                <button type="button" className="font-medium underline underline-offset-2" onClick={() => pollRef.current?.refreshNow()}>
                  Odśwież
                </button>
              </p>
            )}
            {earlierDone ? (
              earlier.tried && (
                <p className="px-4 py-2.5 text-center text-[12px] text-text-faint">Brak wcześniejszych odjazdów dziś</p>
              )
            ) : (
              <MoreButton dir="earlier" busy={earlier.busy} err={earlier.err} onClick={showEarlier} />
            )}
            {earlierShown.length > 0 && (
              <>
                <ul className="px-2" aria-label="Wcześniejsze odjazdy z rozkładu">
                  {earlierShown.map(({ s, veh, timing }, i) => (
                    <li key={earlierKeys[i]}>
                      <ScheduleRow
                        item={s}
                        veh={veh}
                        timing={timing}
                        nowTs={nowTs}
                        dayLabel={dayLabel(s.date)}
                        isStation={isStation}
                        past
                        onShowStatic={onShowStatic}
                        onShowLive={onShowLive}
                      />
                    </li>
                  ))}
                </ul>
                <div className="mx-4 my-1 border-t border-hairline" aria-hidden />
              </>
            )}
            {board.length === 0 ? (
              ttPending ? (
                <SkeletonRows />
              ) : (
                <EmptyState text="Brak przyjazdów w najbliższych godzinach." />
              )
            ) : (
            <ul className={`${fresh ? "stagger " : ""}px-2`}>
              {board.map(({ row, veh, timing, key, sched: s }) => {
                if (s) {
                  return (
                    <li key={key}>
                      <ScheduleRow
                        item={s}
                        veh={veh}
                        timing={timing}
                        nowTs={nowTs}
                        dayLabel={dayLabel(s.date)}
                        isStation={isStation}
                        onShowStatic={onShowStatic}
                        onShowLive={onShowLive}
                      />
                    </li>
                  );
                }
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
                      className="tap flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-white/5 active:bg-white/8"
                    >
                      <LineBadge line={line} operator={row.operator} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium text-text">
                          {dest ? displayStopName(dest) : `Linia ${line}`}
                        </p>
                        {sub && (
                          <p className="mt-0.5 truncate text-[12px] tabular-nums text-text-faint">{sub}</p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={`text-[15px] font-semibold tabular-nums ${
                            timing.canceled ? "text-text-faint line-through" : est ? delayClass(td) : "text-text"
                          }`}
                        >
                          {timeText}
                        </p>
                        {timing.canceled ? null : est ? (
                          <p className={`text-[12px] font-medium tabular-nums ${delayClass(td)}`}>
                            {delayTxt(td)}
                          </p>
                        ) : timing.source === "waiting" ? (
                          <p className="text-[12px] font-medium text-late">czeka na odjazd</p>
                        ) : (
                          <p className="text-[12px] text-text-faint">rozkładowo</p>
                        )}
                      </div>
                      <Chevron />
                    </button>
                  </li>
                );
              })}
            </ul>
            )}
            {laterDone ? (
              <p className="px-4 py-2.5 text-center text-[12px] text-text-faint">Brak dalszych odjazdów w rozkładzie</p>
            ) : (
              <MoreButton dir="later" busy={later.busy} err={later.err} onClick={showLater} />
            )}
          </div>
          )
        ) : ttErr ? (
          <ErrorState
            onRetry={() => {
              putDay(day0, null);
              void ensureDay(day0);
            }}
          />
        ) : tt === null ? (
          <>
            <p className="px-4 pt-3 text-center text-[12px] text-text-faint" role="status">
              {ttLoad?.status === "trips" ? "Wczytywanie tras linii…" : "Pobieranie rozkładu…"}
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
                  className="tap flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-white/5 active:bg-white/8"
                >
                  <LineBadge line={line} operator={dp.operator} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-text">{dir ? displayStopName(dir) : `Linia ${line}`}</p>
                    {formatPlatform(dp.platform, isStation) && (
                      <p className="mt-0.5 text-[12px] text-text-faint">
                        {formatPlatform(dp.platform, isStation)}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 text-[15px] font-semibold tabular-nums text-text">
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
