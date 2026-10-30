"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import {
  BellIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  PathIcon,
  RssSimpleIcon,
  WarningCircleIcon,
} from "@/components/icons";
import { removeAlert, useAlerts } from "@/lib/client/alerts";
import {
  chip,
  CloseIcon,
  EmptyState,
  ErrorState,
  IconButton,
  LineBadge,
  LiveMark,
  ShareButton,
  SkeletonRows,
  StarIcon,
} from "@/components/ui";
import { fetchJSON, isWarming } from "@/lib/client/api";
import { GZM_LOADING } from "@/lib/client/city";
import { useFavorites } from "@/lib/client/favorites";
import { formatDistance, formatWalk } from "@/lib/client/geo";
import { createLivePoll, LIVE_STALE_MS, type LivePoll } from "@/lib/client/live-poll";
import { loadDay, NO_WARNINGS, type DayLoad, type TtRow, type Warnings } from "@/lib/client/timetable";
import { indexVehicles, rowVehicle } from "@/lib/client/vehicleIndex";
import {
  delayClass,
  delayTxt,
  displayStopName,
  formatDayLabel,
  formatPlatform,
  isBusStation,
  offsetDateISO,
  operatorColor,
} from "@/lib/client/format";
import type {
  DepartureRow,
  DeparturesResponse,
  Stop,
  Vehicle,
} from "@/lib/client/types";
import {
  AUTO_AHEAD_SEC,
  autoLaterHorizon,
  boardExtension,
  compareLines,
  etaClock,
  etaLabel,
  hhmm,
  isGone,
  nextEarlierHorizon,
  nextLaterHorizon,
  resolveTiming,
  rowKey,
  schedTiming,
  schedVehicle,
  sortBoard,
  uniqueKeys,
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
  /** straight-line distance from the user's location, rounded to 10 m; null = unknown or too far */
  walkM?: number | null;
}

function Chevron() {
  return <CaretRightIcon className="shrink-0 text-[13px] text-text-faint" />;
}

const OP_DOT = { kb: "bg-kb", mzk: "bg-mzk", gzm: "bg-gzm" } as const;

function OperatorTag({ op, label }: { op: keyof typeof OP_DOT; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${OP_DOT[op]}`} aria-hidden />
      {label}
    </span>
  );
}

/** A timetable departure on the absolute time line, shaped as a board row so it sorts with the live ones. */
interface SchedItem {
  trip_id: number | string;
  operator?: "KB" | "MZK" | "GZM";
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

/** The board's timetable rows: today and tomorrow only (a day picked in the "Rozkład" tab never joins the board). */
function schedOf(days: ReadonlyMap<string, DayLoad>, dates: readonly string[]): SchedItem[] {
  const out: SchedItem[] = [];
  for (const date of dates) {
    const d = days.get(date);
    if (d?.status === "ok") out.push(...schedOfDay(date, d.rows));
  }
  return out;
}

/** Line filter key: operator + line (a KB and an MZK line can share a name). */
const lineKey = (row: DepartureRow) => `${row.operator ?? ""}:${row.line_name || row.symbol || "?"}`;
const onLine = (row: DepartureRow, sel: string | null) => sel == null || lineKey(row) === sel;

type Ext = ReturnType<typeof boardExtension<SchedItem>>;

/** Filtered AFTER boardExtension: which timetable rows the live board already lists must not depend on the filter. */
function filterExt(ext: Ext, sel: string | null): Ext {
  if (sel == null) return ext;
  const f = (l: SchedItem[]) => l.filter((s) => onLine(s.row, sel));
  return { ...ext, earlier: f(ext.earlier), gaps: f(ext.gaps), later: f(ext.later) };
}

/** boardExtension at the server-aligned current instant; event handlers only, never during render. */
function extensionNow(
  days: ReadonlyMap<string, DayLoad>,
  dates: readonly string[],
  live: readonly DepartureRow[] | null,
  skewSec: number,
  sel: string | null,
) {
  return filterExt(boardExtension(schedOf(days, dates), live ?? [], Date.now() / 1000 + skewSec), sel);
}

/**
 * Right column of a board row: the big text (countdown or clock), a live mark when the time comes from the bus,
 * under it the clock when the big text is a countdown, and the delay. A timetable-only row is just its time.
 * `note` replaces the clock line of a row without a live time ("w trasie").
 */
function TimeCell({ timing, big, note }: { timing: Timing; big: string; note?: string | null }) {
  const est = timing.estimated && !timing.canceled;
  const td = timing.delaySec;
  const clock = etaClock(timing);
  const clockLine = clock && clock !== big ? clock : null;
  const small = timing.canceled
    ? null
    : est
      ? [clockLine, delayTxt(td)].filter(Boolean).join(" · ")
      : timing.source === "waiting"
        ? "czeka na odjazd"
        : (note ?? clockLine);
  return (
    <div className="shrink-0 text-right">
      <p
        className={`flex items-center justify-end gap-1 text-[15px] font-semibold tabular-nums ${
          timing.canceled ? "text-text-faint line-through" : est ? delayClass(td) : "text-text"
        }`}
      >
        {est && <LiveMark />}
        {big}
      </p>
      {small && (
        <p
          className={`text-[12px] tabular-nums ${
            est ? `font-medium ${delayClass(td)}` : timing.source === "waiting" ? "font-medium text-late" : "text-text-faint"
          }`}
        >
          {small}
        </p>
      )}
    </div>
  );
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
        className={`tap inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium hover:bg-tint/5 disabled:opacity-60 ${
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
 * + the bus's current delay, opens the live trip; otherwise the planned time, opens the static trip.
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
  const vehDetails = veh?.side_number ? `#${veh.side_number}${veh.model ? ` · ${veh.model}` : ""}` : null;
  const sub = [dayLabel, veh && past ? "w trasie" : null, formatPlatform(row.platform, isStation), vehDetails]
    .filter(Boolean)
    .join(" · ");
  const dest = row.direction || veh?.headsign;
  /* a countdown to a departure already behind us means nothing: past rows print the clock time */
  const timeText = veh && !past ? etaLabel(timing, nowTs) : etaClock(timing);
  return (
    <button
      type="button"
      onClick={() => (veh ? onShowLive(veh.id, item.trip_id) : onShowStatic(item.trip_id))}
      className={`tap flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-tint/5 active:bg-tint/8 ${
        past ? "opacity-60" : ""
      }`}
    >
      <LineBadge line={line} operator={row.operator} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-text">{dest ? displayStopName(dest) : `Linia ${line}`}</p>
        {sub && <p className="mt-0.5 truncate text-[12px] tabular-nums text-text-faint">{sub}</p>}
      </div>
      <TimeCell timing={timing} big={timeText} note={veh && !past ? "w trasie" : null} />
      <Chevron />
    </button>
  );
}

/** An upstream source failed: the list is incomplete, not empty (a failed MZK fetch used to look like "no MZK buses"). */
function SourceWarning({ sources }: { sources: Warnings }) {
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

function StopView({ stop, desktop, vehicles, onClose, onShowLive, onShowStatic, onPlanRoute, walkM }: Props) {
  const [tab, setTab] = useState<Tab>("live");
  const alerts = useAlerts();
  const alertByKey = useMemo(() => new Map(alerts.map((a) => [a.key, a])), [alerts]);

  const vix = useMemo(() => indexVehicles(vehicles), [vehicles]);

  const [liveRows, setLiveRows] = useState<DepartureRow[] | null>(null);
  /* mirrors liveRows so the refresh closure can tell "have data" without going
     stale — a failed 30 s background refresh must not nuke a list we show */
  const liveRowsRef = useRef<DepartureRow[] | null>(null);
  /* "warming": the server is still loading the GZM data (503); the poll keeps retrying */
  const [liveErr, setLiveErr] = useState<false | "error" | "warming">(false);
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
      onFail: (err) => {
        if (liveRowsRef.current === null) setLiveErr(stop.designator.startsWith("gzm:") && isWarming(err) ? "warming" : "error");
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

  /* the timetable tab has no 5 s tick: keep "now" (and so today's date) moving past midnight there too */
  useEffect(() => {
    if (tab === "live") return;
    const id = setInterval(() => setNowTs(Date.now() / 1000 + skewRef.current), 60_000);
    return () => clearInterval(id);
  }, [tab]);

  /* the stop's timetable per date: today (Warsaw date on the server clock, so a sheet left open rolls over
     at midnight) feeds the earlier/later rows of the live board, tomorrow only once "later" runs past
     today's last departure; the "Rozkład" tab loads the day it shows (today, tomorrow or a picked date).
     Loads live for the whole sheet (one AbortController), so switching tabs never drops a fetch half way. */
  const todayNow = useMemo(() => warsawDateISO(nowTs), [nowTs]);
  const day0 = todayNow;
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
      /* a day dropped by pickDate while in flight must not come back */
      const current = () => !ac.signal.aborted && dayLoadsRef.current.get(date) === p;
      const p: Promise<DayLoad> = loadDay(stop.designator, date, ac.signal, () => {
        if (current()) putDay(date, { status: "trips" });
      }).then((res) => {
        if (!current()) return res;
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

  /* the day shown in the "Rozkład" tab; null = today, following midnight */
  const [ttDate, setTtDate] = useState<string | null>(null);
  const ttDay = ttDate ?? day0;
  useEffect(() => {
    void ensureDay(ttDay);
  }, [ttDay, ensureDay]);
  /* keeps at most today, tomorrow and the picked day (a busy hub is ~450 rows per day) */
  const pickDate = (date: string | null) => {
    setTtDate(date);
    const keep = new Set([day0, day1, date ?? day0]);
    for (const k of dayLoadsRef.current.keys()) if (!keep.has(k)) dayLoadsRef.current.delete(k);
    if ([...daysRef.current.keys()].some((k) => !keep.has(k))) {
      const next = new Map([...daysRef.current].filter(([k]) => keep.has(k)));
      daysRef.current = next;
      setDays(next);
    }
  };

  const ttLoad = days.get(ttDay);
  const tt = ttLoad?.status === "ok" ? ttLoad.rows : null;
  const ttErr = ttLoad?.status === "error";
  const ttWarn = ttLoad?.status === "ok" ? ttLoad.warnings : NO_WARNINGS;
  const ttOffline = ttLoad?.status === "ok" && ttLoad.offline === true;

  /* one line at a time, for both tabs; not remembered (a new sheet starts with every line) */
  const [lineSel, setLineSel] = useState<string | null>(null);
  const lines = useMemo(() => {
    const m = new Map<string, { line: string; operator?: DepartureRow["operator"] }>();
    const add = (row: DepartureRow) => {
      const line = row.line_name || row.symbol;
      const k = lineKey(row);
      if (line && line !== "?" && !m.has(k)) m.set(k, { line, operator: row.operator });
    };
    for (const r of liveRows ?? []) add(r);
    for (const date of new Set([day0, ttDay])) {
      const d = days.get(date);
      if (d?.status === "ok") for (const s of schedOfDay(date, d.rows)) add(s.row);
    }
    return [...m].sort(([ka, a], [kb, b]) => compareLines(a.line, b.line) || (ka < kb ? -1 : ka > kb ? 1 : 0));
  }, [liveRows, days, day0, ttDay]);

  const sched = useMemo(() => schedOf(days, [day0, day1]), [days, day0, day1]);
  const ext = useMemo(
    () => filterExt(boardExtension(sched, liveRows ?? [], nowTs), lineSel),
    [sched, liveRows, nowTs, lineSel],
  );
  const [earlier, setEarlier] = useState<Reveal>(REVEAL_IDLE);
  const [later, setLater] = useState<Reveal>(REVEAL_IDLE);

  /* the extension as of NOW, for the tap handlers (state read after an await would be stale) */
  const extNow = () => extensionNow(daysRef.current, [day0, day1], liveRowsRef.current, skewRef.current, lineSel);

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
        const veh = schedVehicle(s, vix.bySched, nowTs);
        return { s, veh, timing: schedTiming(s.planTs, veh) };
      });
  }, [ext.earlier, earlier.at, vix, nowTs]);
  const earlierKeys = useMemo(() => uniqueKeys(earlierShown.map((e) => e.s.row)), [earlierShown]);
  /* nothing left to reveal: the earliest/latest timetable row is already on screen (or there is none) */
  const earliestTs = ext.earlier.length ? ext.earlier[0].planTs : null;
  const latestTs = ext.later.length ? ext.later[ext.later.length - 1].planTs : null;
  const dayLabel = (date: string) => (date === todayNow ? null : formatDayLabel(date, todayNow));

  /* ONE canonical ETA per row (lib/shared/departures): the countdown on screen and the order of the
     list come from the same number — nearest departure first, as displayed. Timetable rows join the
     same order: the courses the live board misses (OnTime lists only tracked ones), then departures
     past its end up to an hour ahead / its last live row and until it holds AUTO_MIN_ROWS, further
     after "Pokaż późniejsze". A timetable row whose bus is on the road carries that bus's delay. */
  const { board, laterUntil } = useMemo(() => {
    type Entry = BoardItem<DepartureRow> & { veh: Vehicle | null; sched: SchedItem | null };
    const items: Entry[] = (liveRows ?? [])
      .filter((row) => onLine(row, lineSel))
      .map((row) => {
        const veh = rowVehicle(row, vix);
        return { row, veh, timing: resolveTiming(row, veh), sched: null };
      });
    const addSched = (s: SchedItem) => {
      const veh = schedVehicle(s, vix.bySched, nowTs);
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
  }, [liveRows, vix, nowTs, ext, later.at, lineSel]);
  const earlierDone =
    days.get(day0)?.status === "ok" && (earliestTs == null || (earlier.at != null && earliestTs >= earlier.at));
  const laterDone =
    days.get(day1)?.status === "ok" && (latestTs == null || (laterUntil != null && latestTs <= laterUntil));
  /* an empty live board is not "no departures" until today's timetable has had its say */
  const ttPending = days.get(day0) === undefined || days.get(day0)?.status === "trips";

  const liveLoading = liveRows === null && !liveErr;

  const staleEmpty =
    liveRows !== null &&
    liveRows.some((r) => onLine(r, lineSel)) &&
    !board.some((it) => it.sched === null) &&
    nowTs - fetchedTs > 90;

  /* "Rozkład" tab: the picked day by hour, the current hour scrolled into view for today */
  const ttItems = useMemo(
    () => (tt ? schedOfDay(ttDay, tt).filter((s) => onLine(s.row, lineSel)).sort((a, b) => a.planTs - b.planTs) : null),
    [tt, ttDay, lineSel],
  );
  const ttKeys = useMemo(() => uniqueKeys((ttItems ?? []).map((s) => s.row)), [ttItems]);
  const ttHours = useMemo(() => {
    const out: { hour: string; from: number; items: SchedItem[] }[] = [];
    (ttItems ?? []).forEach((s, i) => {
      const hour = hhmm(s.planTs).slice(0, 2);
      const last = out[out.length - 1];
      if (last?.hour === hour) last.items.push(s);
      else out.push({ hour, from: i, items: [s] });
    });
    return out;
  }, [ttItems]);
  const nowHour = ttDay === day0 ? ttItems?.find((s) => s.planTs >= nowTs)?.planTs : undefined;
  const nowHourLabel = nowHour == null ? null : hhmm(nowHour).slice(0, 2);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nowHourRef = useRef<HTMLElement>(null);
  const ttReady = tab === "tt" && ttItems !== null;
  useEffect(() => {
    const box = scrollRef.current;
    if (ttReady && box) box.scrollTop = nowHourRef.current?.offsetTop ?? 0;
  }, [ttReady, ttDay, lineSel]);

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-tight tracking-tight text-balance text-text">
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
            ) : stop.operator === "GZM" ? (
              <OperatorTag op="gzm" label="Metropolia GZM" />
            ) : (
              <OperatorTag op="kb" label="Komunikacja Beskidzka" />
            )}
            <span className="text-text-faint">
              {isStation ? "Dworzec autobusowy" : "Przystanek"}
              {stop.onRequest && ", na żądanie"}
            </span>
            {walkM != null && (
              <span className="tabular-nums text-text-faint">
                {formatDistance(walkM)}, {formatWalk(walkM)}
              </span>
            )}
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
        className="relative mt-3.5 grid grid-cols-2 rounded-full bg-tint/5 p-1"
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
            ["tt", "Rozkład"],
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
      {lines.length > 1 && (
        <div
          role="group"
          aria-label="Pokaż jedną linię"
          className="-mx-4 mt-2.5 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]"
        >
          <button type="button" aria-pressed={lineSel == null} onClick={() => setLineSel(null)} className={chip(lineSel == null)}>
            Wszystkie
          </button>
          {lines.map(([k, l]) => (
            <button
              key={k}
              type="button"
              aria-pressed={lineSel === k}
              onClick={() => setLineSel(lineSel === k ? null : k)}
              className={`${chip(lineSel === k)} tabular-nums`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: operatorColor(l.operator, l.line) }} aria-hidden />
              {l.line}
            </button>
          ))}
        </div>
      )}
      {tab !== "live" && (
        <div role="group" aria-label="Dzień rozkładu" className="mt-2 flex gap-1.5">
          <button type="button" aria-pressed={ttDay === day0} onClick={() => pickDate(null)} className={chip(ttDay === day0)}>
            Dziś
          </button>
          <button type="button" aria-pressed={ttDay === day1} onClick={() => pickDate(day1)} className={chip(ttDay === day1)}>
            Jutro
          </button>
          <label className={`${chip(ttDay !== day0 && ttDay !== day1)} relative overflow-hidden`}>
            <CalendarBlankIcon aria-hidden />
            {ttDay !== day0 && ttDay !== day1 ? formatDayLabel(ttDay, day0) : "Inny dzień"}
            <input
              type="date"
              aria-label="Wybierz dzień rozkładu"
              min={day0}
              value={ttDay}
              onClick={(e) => {
                try {
                  e.currentTarget.showPicker();
                } catch {
                  /* no picker API: the native control still opens on tap */
                }
              }}
              onChange={(e) => {
                const v = e.target.value;
                if (v) pickDate(v === day0 ? null : v);
              }}
              className="absolute inset-0 h-full w-full min-w-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      )}
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
      <div key={tab} ref={scrollRef} className="kb-scroll relative h-full overflow-y-auto pb-4 animate-fade">
        {(tab === "live" ? liveWarn.length > 0 && !liveErr : ttWarn.length > 0) && (
          <SourceWarning sources={tab === "live" ? liveWarn : ttWarn} />
        )}
        {tab !== "live" && ttOffline && (
          <p role="status" className="mx-4 mt-3 rounded-xl bg-tint/6 px-3 py-2 text-[12px] text-text-mute">
            Bez sieci: zapisany rozkład.
          </p>
        )}
        {tab === "live" ? (
          liveErr || staleEmpty ? (
            <ErrorState
              message={liveErr === "warming" ? GZM_LOADING : undefined}
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
                <EmptyState text={`Brak odjazdów${lineSel ? " tej linii" : ""} w najbliższych godzinach.`} />
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
                const sub = [plat, vehDetails].filter(Boolean).join(" · ");
                /* KB boards carry only direction_id; the server resolves it through the board's
                   `directions` map, the live vehicle's headsign is the fallback */
                const dest = row.direction || veh?.headsign;
                const destText = dest ? displayStopName(dest) : `Linia ${line}`;
                const ak = rowKey(row);
                const al = alertByKey.get(ak);

                return (
                  <li key={key}>
                    <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => onShowLive(row.trip_execution_id || "", row.trip_id ?? null)}
                      className="tap flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-tint/5 active:bg-tint/8"
                    >
                      <LineBadge line={line} operator={row.operator} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium text-text">{destText}</p>
                        {sub && (
                          <p className="mt-0.5 truncate text-[12px] tabular-nums text-text-faint">{sub}</p>
                        )}
                      </div>
                      <TimeCell timing={timing} big={etaLabel(timing, nowTs, row.time ?? "")} />
                      <Chevron />
                    </button>
                    {/* set from the trip view; here only shown and cancelled */}
                    {al && (
                      <button
                        type="button"
                        aria-label={`Wyłącz powiadomienie ${al.leadMin} min przed`}
                        onClick={() => removeAlert(ak)}
                        className="tap grid h-11 w-10 shrink-0 place-items-center rounded-xl text-[17px] text-primary hover:bg-tint/5"
                      >
                        <BellIcon weight="fill" aria-hidden />
                      </button>
                    )}
                    </div>
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
            {board.length > 0 && (
              <p className="flex items-center justify-center gap-1 px-4 pt-1 text-[11.5px] text-text-faint">
                <RssSimpleIcon aria-hidden className="shrink-0 text-[0.75em]" />
                na żywo z GPS autobusu, pozostałe według rozkładu
              </p>
            )}
          </div>
          )
        ) : ttErr ? (
          <ErrorState
            message={ttLoad.warming ? GZM_LOADING : undefined}
            onRetry={() => {
              putDay(ttDay, null);
              void ensureDay(ttDay);
            }}
          />
        ) : ttItems === null ? (
          <>
            <p className="px-4 pt-3 text-center text-[12px] text-text-faint" role="status">
              {ttLoad?.status === "trips" ? "Wczytywanie tras linii…" : "Pobieranie rozkładu…"}
            </p>
            <SkeletonRows />
          </>
        ) : ttItems.length === 0 ? (
          <EmptyState
            text={`Brak odjazdów${lineSel ? " tej linii" : ""} ${ttDay === day0 ? "dziś" : "w tym dniu"}.`}
          />
        ) : (
          <div style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
            {ttHours.map(({ hour, from, items }) => (
              <section key={`${hour}:${from}`} ref={hour === nowHourLabel ? nowHourRef : undefined}>
                <h3 className="sticky top-0 z-[1] bg-surface px-4 py-1.5 text-[12px] font-semibold tabular-nums text-text-mute">
                  {hour}:00
                </h3>
                <ul className="px-2">
                  {items.map((s, j) => {
                    const line = s.row.line_name || "?";
                    const dir = s.row.direction;
                    const plat = formatPlatform(s.row.platform, isStation);
                    const past = ttDay === day0 && s.planTs < nowTs;
                    return (
                      <li key={ttKeys[from + j]}>
                        <button
                          type="button"
                          onClick={() => onShowStatic(s.trip_id)}
                          className={`tap flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-tint/5 active:bg-tint/8 ${
                            past ? "opacity-50" : ""
                          }`}
                        >
                          <span className="w-11 shrink-0 text-[15px] font-semibold tabular-nums text-text">
                            {hhmm(s.planTs)}
                          </span>
                          <LineBadge line={line} operator={s.row.operator} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13.5px] font-medium text-text">
                              {dir ? displayStopName(dir) : `Linia ${line}`}
                            </p>
                            {plat && <p className="mt-0.5 truncate text-[12px] text-text-faint">{plat}</p>}
                          </div>
                          <Chevron />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}

export default memo(StopView);
