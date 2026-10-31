<script module lang="ts">
  import type { DayLoad, TtRow } from "@/lib/client/timetable";
  import type { DepartureRow } from "@/lib/client/types";
  import { boardExtension, warsawDayTs } from "@/lib/shared/departures";

  type Tab = "live" | "tt";

  const TABS = [
    ["live", "Odjazdy"],
    ["tt", "Rozkład"],
  ] as const;

  const OP_DOT = { kb: "bg-kb", mzk: "bg-mzk", gzm: "bg-gzm" } as const;

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
  /** the whole-stop board has no timetable around it: the timetable is this pole's */
  const NO_SCHED: readonly SchedItem[] = [];

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

  /** boardExtension at the server-aligned current instant; event handlers only, never in a derived. */
  function extensionNow(
    days: ReadonlyMap<string, DayLoad>,
    dates: readonly string[],
    live: readonly DepartureRow[] | null,
    skewSec: number,
    sel: string | null,
  ) {
    return filterExt(boardExtension(schedOf(days, dates), live ?? [], Date.now() / 1000 + skewSec), sel);
  }
</script>

<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  import BottomSheet from "@/components/BottomSheet.svelte";
  import Icon from "@/components/Icon.svelte";
  import {
    BellIcon,
    CalendarBlankIcon,
    CaretDownIcon,
    CaretRightIcon,
    CaretUpIcon,
    PathIcon,
    RssSimpleIcon,
    WarningCircleIcon,
    WheelchairIcon,
    XIcon,
  } from "@/components/icon-paths";
  import { chip } from "@/components/ui";
  import EmptyState from "@/components/ui/EmptyState.svelte";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import IconButton from "@/components/ui/IconButton.svelte";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import LiveMark from "@/components/ui/LiveMark.svelte";
  import RequestStopTag from "@/components/ui/RequestStopTag.svelte";
  import ShareButton from "@/components/ui/ShareButton.svelte";
  import SkeletonRows from "@/components/ui/SkeletonRows.svelte";
  import StarIcon from "@/components/ui/StarIcon.svelte";
  import { alerts, removeAlert } from "@/lib/client/alerts";
  import { fetchJSON, isWarming } from "@/lib/client/api";
  import { CITY, cityOfId, GZM_LOADING } from "@/lib/client/city";
  import { favorites } from "@/lib/client/favorites";
  import {
    delayClass,
    delayTxt,
    displayStopName,
    formatDayLabel,
    formatPlatform,
    isBusStation,
    offsetDateISO,
    operatorColor,
    withoutRequestTail,
  } from "@/lib/client/format";
  import { formatDistance, formatWalk } from "@/lib/client/geo";
  import { createLivePoll, LIVE_STALE_MS, type LivePoll } from "@/lib/client/live-poll";
  import { loadDay, NO_WARNINGS, type Warnings } from "@/lib/client/timetable";
  import type { DeparturesResponse, Stop, Vehicle } from "@/lib/client/types";
  import { indexVehicles, rowVehicle } from "@/lib/client/vehicleIndex";
  import {
    AUTO_AHEAD_SEC,
    autoLaterHorizon,
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
    type BoardItem,
    type Timing,
  } from "@/lib/shared/departures";

  let {
    stop,
    desktop,
    vehicles,
    onClose,
    onShowLive,
    onShowStatic,
    onPlanRoute,
    walkM,
  }: {
    stop: Stop;
    desktop: boolean;
    vehicles?: Vehicle[];
    onClose: () => void;
    onShowLive: (execId: string, tripId: string | number | null) => void;
    onShowStatic: (tripId: string | number) => void;
    onPlanRoute?: (s: Stop) => void;
    /** straight-line distance from the user's location, rounded to 10 m; null = unknown or too far */
    walkM?: number | null;
  } = $props();

  let tab = $state<Tab>("live");
  const alertByKey = $derived(new Map(alerts.current.map((a) => [a.key, a])));

  const vix = $derived(indexVehicles(vehicles));

  /* a string: a new stop object for the same stop must not restart the poll or the timetable loads */
  const designator = $derived(stop.designator);

  let liveRows = $state.raw<DepartureRow[] | null>(null);
  /* "warming": the server is still loading the GZM data (503); the poll keeps retrying */
  let liveErr = $state<false | "error" | "warming">(false);
  let liveWarn = $state.raw<Warnings>(NO_WARNINGS);
  /* "Cały przystanek": the board of every same-name pole nearby (the server says how many there are) */
  let wholeStop = $state(false);
  let poles = $state(0);
  /* "now" on the SERVER's clock (epoch s): every row time is an absolute instant, so there is no
     seconds-of-day / midnight arithmetic left, and a wrong device clock cannot shift the countdowns.
     skew = server_ts - device clock, refreshed by every successful fetch. */
  let skew = 0;
  let nowTs = $state(Date.now() / 1000);
  /* server clock (epoch s) of the last SUCCESSFUL fetch: a list whose rows have all aged out while
     refetches keep failing must read as "no fresh data", not as "no departures" */
  let fetchedTs = $state(0);
  /* device clock (ms) of the last successful fetch + a 5 s tick: drives the "data is old" stamp */
  let lastOkMs = $state(0);
  let nowMs = $state(Date.now());
  /* the .stagger entrance animation must play ONCE: a keyed reorder re-inserts DOM nodes and would
     replay it on every row that moves */
  let fresh = $state(true);
  /* module-level store: the palette's favorites section updates live too */
  const fav = $derived(favorites.isFav(stop.designator));
  const isStation = $derived(isBusStation(stop.name, stop));

  /* live departures: poll controller (lib/client/live-poll), 10 s cadence while visible, per-request timeout,
     backoff, immediate catch-up on visibility/pageshow/focus/online, never two requests in flight, a failing
     refresh never wipes a list we show. The component is keyed by stop.designator in MapApp. */
  let poll: LivePoll | null = null;
  $effect(() => {
    if (tab !== "live") return;
    const url = `/api/stop/${encodeURIComponent(designator)}/departures${wholeStop ? "?all=1" : ""}`;
    /* restarts on the stop, the tab and the whole-stop switch only: nothing below may subscribe */
    return untrack(() => {
      const p = createLivePoll<DeparturesResponse>({
        load: (signal) => fetchJSON<DeparturesResponse>(url, { cache: "no-store", signal }),
        onOk: (d) => {
          if (typeof d.server_ts === "number") skew = d.server_ts - Date.now() / 1000;
          const t = Date.now() / 1000 + skew;
          nowTs = t;
          fetchedTs = t;
          lastOkMs = Date.now();
          liveRows = d.rows ?? [];
          liveWarn = d.warnings ?? [];
          poles = d.poles ?? 0;
          liveErr = false;
        },
        // the error sheet only when there is nothing to show; with a list on screen the next poll retries
        onFail: (err) => {
          if (liveRows === null) liveErr = cityOfId(designator) !== "bb" && isWarming(err) ? "warming" : "error";
        },
        isVisible: () => !document.hidden,
      });
      poll = p;
      p.start();
      const kick = () => p.kick();
      document.addEventListener("visibilitychange", kick);
      window.addEventListener("pageshow", kick);
      window.addEventListener("focus", kick);
      window.addEventListener("online", kick);
      /* 5 s UI tick: countdowns on the server clock + freshness stamp + poll watchdog */
      const id = setInterval(() => {
        nowTs = Date.now() / 1000 + skew;
        nowMs = Date.now();
        p.tick();
      }, 5000);
      return () => {
        p.stop();
        poll = null;
        clearInterval(id);
        document.removeEventListener("visibilitychange", kick);
        window.removeEventListener("pageshow", kick);
        window.removeEventListener("focus", kick);
        window.removeEventListener("online", kick);
      };
    });
  });

  /* the other board is not this one: show the skeleton until it loads */
  function toggleWhole() {
    liveRows = null;
    liveErr = false;
    wholeStop = !wholeStop;
  }

  function retryLive() {
    liveErr = false;
    liveRows = null;
    poll?.refreshNow();
  }

  const hasRows = $derived(liveRows !== null);
  $effect(() => {
    if (!hasRows) return;
    const t = setTimeout(() => (fresh = false), 900);
    return () => clearTimeout(t);
  });

  /* the timetable tab has no 5 s tick: keep "now" (and so today's date) moving past midnight there too */
  $effect(() => {
    if (tab === "live") return;
    const id = setInterval(() => (nowTs = Date.now() / 1000 + skew), 60_000);
    return () => clearInterval(id);
  });

  /* the stop's timetable per date: today (Warsaw date on the server clock, so a sheet left open rolls over
     at midnight) feeds the earlier/later rows of the live board, tomorrow only once "later" runs past
     today's last departure; the "Rozkład" tab loads the day it shows (today, tomorrow or a picked date).
     Loads live for the whole sheet (one AbortController), so switching tabs never drops a fetch half way. */
  const day0 = $derived(warsawDateISO(nowTs));
  const day1 = $derived(offsetDateISO(day0, 1));
  let days = $state.raw<ReadonlyMap<string, DayLoad>>(new Map());
  const dayLoads = new Map<string, Promise<DayLoad>>();
  const lifeAc = new AbortController();
  onDestroy(() => {
    lifeAc.abort();
    dayLoads.clear();
  });

  function putDay(date: string, v: DayLoad | null) {
    const next = new Map(days);
    if (v) next.set(date, v);
    else next.delete(date);
    days = next;
  }

  /** Deduped: one request per date while it is in flight or loaded; a failed day is fetched again on the next call. */
  function ensureDay(date: string): Promise<DayLoad> {
    const hit = dayLoads.get(date);
    if (hit) return hit;
    if (lifeAc.signal.aborted) return Promise.resolve({ status: "error" });
    /* a day dropped by pickDate while in flight must not come back */
    const current = () => !lifeAc.signal.aborted && dayLoads.get(date) === p;
    const p: Promise<DayLoad> = loadDay(designator, date, lifeAc.signal, () => {
      if (current()) putDay(date, { status: "trips" });
    }).then((res) => {
      if (!current()) return res;
      if (res.status === "error") dayLoads.delete(date);
      putDay(date, res);
      return res;
    });
    dayLoads.set(date, p);
    return p;
  }

  /* today loads with the sheet on either tab: the live board fills the courses OnTime leaves out
     (it lists only those with a tracked bus) from it; one request, cached 15 min server-side.
     ensureDay reads only the date and the designator synchronously (its state writes come after an await). */
  $effect(() => {
    void ensureDay(day0);
  });

  /* the day shown in the "Rozkład" tab; null = today, following midnight */
  let ttDate = $state<string | null>(null);
  const ttDay = $derived(ttDate ?? day0);
  $effect(() => {
    void ensureDay(ttDay);
  });
  /* keeps at most today, tomorrow and the picked day (a busy hub is ~450 rows per day) */
  function pickDate(date: string | null) {
    ttDate = date;
    const keep = new Set([day0, day1, date ?? day0]);
    for (const k of dayLoads.keys()) if (!keep.has(k)) dayLoads.delete(k);
    if ([...days.keys()].some((k) => !keep.has(k))) days = new Map([...days].filter(([k]) => keep.has(k)));
  }

  const ttLoad = $derived(days.get(ttDay));
  const tt = $derived(ttLoad?.status === "ok" ? ttLoad.rows : null);
  const ttWarn = $derived(ttLoad?.status === "ok" ? ttLoad.warnings : NO_WARNINGS);
  const ttOffline = $derived(ttLoad?.status === "ok" && ttLoad.offline === true);

  /* one line at a time, for both tabs; not remembered (a new sheet starts with every line) */
  let lineSel = $state<string | null>(null);
  const lines = $derived.by(() => {
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
  });

  const sched = $derived(wholeStop ? NO_SCHED : schedOf(days, [day0, day1]));
  const ext = $derived(filterExt(boardExtension(sched, liveRows ?? [], nowTs), lineSel));
  let earlier = $state.raw<Reveal>(REVEAL_IDLE);
  let later = $state.raw<Reveal>(REVEAL_IDLE);

  /* the extension as of NOW, for the tap handlers: re-read after every await */
  const extNow = () => extensionNow(days, [day0, day1], liveRows, skew, lineSel);

  async function showEarlier() {
    const from = earlier.at;
    earlier = { at: from, busy: true, err: false, tried: true };
    const day = await ensureDay(day0);
    if (lifeAc.signal.aborted) return;
    const at = day.status === "ok" ? nextEarlierHorizon(extNow().earlier, from, REVEAL_STEP) : null;
    earlier = { at: at ?? from, busy: false, err: day.status !== "ok", tried: true };
  }

  async function showLater() {
    const prev = later.at;
    /* continue from what the board shows now, auto-filled rows included */
    const until = laterUntil;
    later = { at: prev, busy: true, err: false, tried: true };
    let ok = (await ensureDay(day0)).status === "ok";
    let next = extNow().later;
    if (ok && next.filter((s) => until == null || s.planTs > until).length < REVEAL_STEP) {
      // today's timetable runs out: continue into tomorrow's
      ok = (await ensureDay(day1)).status === "ok";
      next = extNow().later;
    }
    if (lifeAc.signal.aborted) return;
    const at = nextLaterHorizon(next, until, REVEAL_STEP);
    later = { at: at ?? prev, busy: false, err: !ok && at == null, tried: true };
  }

  const earlierShown = $derived.by(() => {
    const from = earlier.at;
    if (from == null) return [];
    return ext.earlier
      .filter((s) => s.planTs >= from)
      .map((s) => {
        const veh = schedVehicle(s, vix.bySched, nowTs);
        return { s, veh, timing: schedTiming(s.planTs, veh) };
      });
  });
  const earlierKeys = $derived(uniqueKeys(earlierShown.map((e) => e.s.row)));
  /* nothing left to reveal: the earliest/latest timetable row is already on screen (or there is none) */
  const earliestTs = $derived(ext.earlier.length ? ext.earlier[0].planTs : null);
  const latestTs = $derived(ext.later.length ? ext.later[ext.later.length - 1].planTs : null);
  const dayLabel = (date: string) => (date === day0 ? null : formatDayLabel(date, day0));

  /* ONE canonical ETA per row (lib/shared/departures): the countdown on screen and the order of the
     list come from the same number, nearest departure first, as displayed. Timetable rows join the
     same order: the courses the live board misses (OnTime lists only tracked ones), then departures
     past its end up to an hour ahead / its last live row and until it holds AUTO_MIN_ROWS, further
     after "Pokaż późniejsze". A timetable row whose bus is on the road carries that bus's delay. */
  const boardState = $derived.by(() => {
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
  });
  const board = $derived(boardState.board);
  const laterUntil = $derived(boardState.laterUntil);
  const earlierDone = $derived(
    days.get(day0)?.status === "ok" && (earliestTs == null || (earlier.at != null && earliestTs >= earlier.at)),
  );
  const laterDone = $derived(
    days.get(day1)?.status === "ok" && (latestTs == null || (laterUntil != null && latestTs <= laterUntil)),
  );
  /* an empty live board is not "no departures" until today's timetable has had its say */
  const ttPending = $derived(days.get(day0) === undefined || days.get(day0)?.status === "trips");

  const liveLoading = $derived(liveRows === null && !liveErr);

  const staleEmpty = $derived(
    liveRows !== null &&
      liveRows.some((r) => onLine(r, lineSel)) &&
      !board.some((it) => it.sched === null) &&
      nowTs - fetchedTs > 90,
  );

  /* "Rozkład" tab: the picked day by hour, the current hour scrolled into view for today */
  const ttItems = $derived(
    tt ? schedOfDay(ttDay, tt).filter((s) => onLine(s.row, lineSel)).sort((a, b) => a.planTs - b.planTs) : null,
  );
  const ttKeys = $derived(uniqueKeys((ttItems ?? []).map((s) => s.row)));
  const ttHours = $derived.by(() => {
    const out: { hour: string; from: number; items: SchedItem[] }[] = [];
    (ttItems ?? []).forEach((s, i) => {
      const hour = hhmm(s.planTs).slice(0, 2);
      const last = out[out.length - 1];
      if (last?.hour === hour) last.items.push(s);
      else out.push({ hour, from: i, items: [s] });
    });
    return out;
  });
  let scrollEl: HTMLDivElement | undefined = $state();
  /* scrolls when the list first shows, the day or the line changes; never when the clock moves */
  const ttScroll = $derived(tab === "tt" && ttItems !== null ? `${ttDay}|${lineSel}` : null);
  $effect(() => {
    const box = scrollEl;
    if (ttScroll == null || !box) return;
    untrack(() => {
      const nowHour = ttDay === day0 ? ttItems?.find((s) => s.planTs >= nowTs)?.planTs : undefined;
      const nowHourLabel = nowHour == null ? null : hhmm(nowHour).slice(0, 2);
      const i = ttHours.findLastIndex((h) => h.hour === nowHourLabel);
      box.scrollTop = box.querySelectorAll<HTMLElement>("section")[i]?.offsetTop ?? 0;
    });
  });
</script>

{#snippet chevron()}
  <Icon icon={CaretRightIcon} class="shrink-0 text-[13px] text-text-faint" />
{/snippet}

{#snippet operatorTag(op: keyof typeof OP_DOT, label: string)}
  <span class="inline-flex items-center gap-1.5">
    <span class="h-2 w-2 rounded-full {OP_DOT[op]}" aria-hidden="true"></span>
    {label}
  </span>
{/snippet}

<!--
  Right column of a board row: the big text (countdown or clock), a live mark when the time comes from the bus,
  under it the clock when the big text is a countdown, and the delay. A timetable-only row is just its time.
  `note` replaces the clock line of a row without a live time ("w trasie").
-->
{#snippet timeCell(timing: Timing, big: string, note: string | null)}
  {@const est = timing.estimated && !timing.canceled}
  {@const td = timing.delaySec}
  {@const clock = etaClock(timing)}
  {@const clockLine = clock && clock !== big ? clock : null}
  {@const small = timing.canceled
    ? null
    : est
      ? [clockLine, delayTxt(td)].filter(Boolean).join(" · ")
      : timing.source === "waiting"
        ? "czeka na odjazd"
        : (note ?? clockLine)}
  <div class="shrink-0 text-right">
    <p
      class="flex items-center justify-end gap-1 text-[15px] font-semibold tabular-nums {timing.canceled
        ? 'text-text-faint line-through'
        : est
          ? delayClass(td)
          : 'text-text'}"
    >
      {#if est}<LiveMark />{/if}
      {big}
    </p>
    {#if small}
      <p
        class="text-[12px] tabular-nums {est
          ? `font-medium ${delayClass(td)}`
          : timing.source === 'waiting'
            ? 'font-medium text-late'
            : 'text-text-faint'}"
      >
        {small}
      </p>
    {/if}
  </div>
{/snippet}

{#snippet moreButton(dir: "earlier" | "later", busy: boolean, err: boolean, onClick: () => void)}
  <div class="flex justify-center px-4 py-1">
    <button
      type="button"
      onclick={onClick}
      disabled={busy}
      aria-busy={busy}
      class="tap inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium hover:bg-tint/5 disabled:opacity-60 {err
        ? 'text-late'
        : 'text-text-mute hover:text-text'}"
    >
      <Icon icon={dir === "earlier" ? CaretUpIcon : CaretDownIcon} class="text-[12px]" />
      {busy
        ? "Wczytywanie rozkładu…"
        : err
          ? "Nie udało się wczytać rozkładu, ponów"
          : dir === "earlier"
            ? "Pokaż wcześniejsze"
            : "Pokaż późniejsze"}
    </button>
  </div>
{/snippet}

<!-- The bus is low-floor (MZK fleet data; KB and GZM boards carry no vehicle features). -->
{#snippet lowFloorMark()}
  <span class="flex shrink-0 text-[13px]" role="img" aria-label="Niska podłoga"><Icon icon={WheelchairIcon} /></span>
{/snippet}

<!-- An upstream source failed: the list is incomplete, not empty (a failed MZK fetch used to look like "no MZK buses"). -->
{#snippet sourceWarning(sources: Warnings)}
  <p role="status" class="mx-4 mt-3 flex items-center gap-2 rounded-xl bg-late/10 px-3 py-2 text-[12px] text-late">
    <Icon icon={WarningCircleIcon} class="shrink-0 text-[14px]" />
    Brak danych z {sources.map((s) => s.toUpperCase()).join(" i ")}, lista może być niepełna.
  </p>
{/snippet}

<!--
  A timetable departure the live board does not list. Its bus on the road (matched by trip): the plan
  + the bus's current delay, opens the live trip; otherwise the planned time, opens the static trip.
-->
{#snippet scheduleRow(item: SchedItem, veh: Vehicle | null, timing: Timing, past: boolean)}
  {@const row = item.row}
  {@const line = row.line_name || veh?.line || "?"}
  {@const vehDetails = veh?.side_number ? `#${veh.side_number}${veh.model ? ` · ${veh.model}` : ""}` : null}
  {@const sub = [dayLabel(item.date), veh && past ? "w trasie" : null, formatPlatform(row.platform, isStation), vehDetails]
    .filter(Boolean)
    .join(" · ")}
  {@const dest = row.direction || veh?.headsign}
  {@const lowFloor = !!veh?.features?.lowFloor}
  <!-- a countdown to a departure already behind us means nothing: past rows print the clock time -->
  {@const timeText = veh && !past ? etaLabel(timing, nowTs) : etaClock(timing)}
  <button
    type="button"
    onclick={() => (veh ? onShowLive(veh.id, item.trip_id) : onShowStatic(item.trip_id))}
    class="tap flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-tint/5 active:bg-tint/8 {past
      ? 'opacity-60'
      : ''}"
  >
    <LineBadge {line} operator={row.operator} />
    <div class="min-w-0 flex-1">
      <p class="truncate text-[13.5px] font-medium text-text">{dest ? displayStopName(dest) : `Linia ${line}`}</p>
      {#if sub || lowFloor}
        <p class="mt-0.5 flex items-center gap-1 truncate text-[12px] tabular-nums text-text-faint">
          {#if lowFloor}{@render lowFloorMark()}{/if}
          {sub}
        </p>
      {/if}
    </div>
    {@render timeCell(timing, timeText, veh && !past ? "w trasie" : null)}
    {@render chevron()}
  </button>
{/snippet}

<BottomSheet {desktop} {onClose} ariaLabel={`Odjazdy z przystanku ${displayStopName(stop.name)}`} initialSnap="half">
  {#snippet header()}
    <header class="px-4 pb-3 pt-2 md:pt-4">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-[17px] font-semibold leading-tight tracking-tight text-balance text-text">
            {displayStopName(stop.onRequest ? withoutRequestTail(stop.name) : stop.name)}{#if stop.symbol}<span
                class="ml-1.5 font-normal text-text-faint">{stop.symbol}</span
              >{/if}
          </h2>
          <div class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-text-mute">
            {#if stop.operator === "BOTH"}
              {@render operatorTag("kb", "KB")}
              {@render operatorTag("mzk", "MZK")}
            {:else if stop.operator === "MZK"}
              {@render operatorTag("mzk", "MZK Bielsko-Biała")}
            {:else if stop.operator === "GZM"}
              {@render operatorTag("gzm", CITY[cityOfId(stop.designator)].name)}
            {:else}
              {@render operatorTag("kb", "Komunikacja Beskidzka")}
            {/if}
            <span class="text-text-faint">{isStation ? "Dworzec autobusowy" : "Przystanek"}</span>
            {#if stop.onRequest}<RequestStopTag />{/if}
            {#if walkM != null}
              <span class="tabular-nums text-text-faint">{formatDistance(walkM)}, {formatWalk(walkM)}</span>
            {/if}
          </div>
        </div>
        {#if onPlanRoute}
          <IconButton label="Wyznacz trasę stąd" onClick={() => onPlanRoute?.(stop)}>
            <Icon icon={PathIcon} />
          </IconButton>
        {/if}
        <ShareButton title={`Przystanek ${displayStopName(stop.name)}`} />
        <IconButton
          label={fav ? "Usuń z ulubionych" : "Dodaj do ulubionych"}
          onClick={() => favorites.toggle(stop.designator)}
          pressed={fav}
        >
          <StarIcon filled={fav} />
        </IconButton>
        <IconButton label="Zamknij panel przystanku" onClick={onClose}>
          <Icon icon={XIcon} />
        </IconButton>
      </div>

      <!-- segmented tabs with sliding thumb -->
      <div class="relative mt-3.5 grid grid-cols-2 rounded-full bg-tint/5 p-1" role="tablist" aria-label="Widok przystanku">
        <span
          class="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-surface-3 transition-transform duration-300 {tab ===
          'tt'
            ? 'translate-x-[calc(100%+8px)]'
            : 'translate-x-0'}"
          style:transition-timing-function="var(--ease-spring)"
          aria-hidden="true"
        ></span>
        {#each TABS as [key, label] (key)}
          <button
            type="button"
            role="tab"
            aria-selected={tab === key}
            onclick={() => (tab = key)}
            class="relative z-10 rounded-full py-1.5 text-[13px] font-medium transition-colors {tab === key
              ? 'text-text'
              : 'text-text-mute hover:text-text'}"
          >
            {label}
          </button>
        {/each}
      </div>
      {#if lines.length > 1 || (tab === "live" && poles > 1)}
        <div class="-mx-4 mt-2.5 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
          {#if tab === "live" && poles > 1}
            <button type="button" aria-pressed={wholeStop} onclick={toggleWhole} class={chip(wholeStop)}>
              Cały przystanek
            </button>
            {#if lines.length > 1}<span class="my-1.5 w-px shrink-0 bg-hairline" aria-hidden="true"></span>{/if}
          {/if}
          {#if lines.length > 1}
            <div role="group" aria-label="Pokaż jedną linię" class="flex gap-1.5">
              <button
                type="button"
                aria-pressed={lineSel == null}
                onclick={() => (lineSel = null)}
                class={chip(lineSel == null)}
              >
                Wszystkie
              </button>
              {#each lines as [k, l] (k)}
                <button
                  type="button"
                  aria-pressed={lineSel === k}
                  onclick={() => (lineSel = lineSel === k ? null : k)}
                  class="{chip(lineSel === k)} tabular-nums"
                >
                  <span class="h-2 w-2 rounded-full" style:background={operatorColor(l.operator, l.line)} aria-hidden="true"
                  ></span>
                  {l.line}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if tab !== "live"}
        <div role="group" aria-label="Dzień rozkładu" class="mt-2 flex gap-1.5">
          <button type="button" aria-pressed={ttDay === day0} onclick={() => pickDate(null)} class={chip(ttDay === day0)}>
            Dziś
          </button>
          <button type="button" aria-pressed={ttDay === day1} onclick={() => pickDate(day1)} class={chip(ttDay === day1)}>
            Jutro
          </button>
          <label class="{chip(ttDay !== day0 && ttDay !== day1)} relative overflow-hidden">
            <Icon icon={CalendarBlankIcon} />
            {ttDay !== day0 && ttDay !== day1 ? formatDayLabel(ttDay, day0) : "Inny dzień"}
            <input
              type="date"
              aria-label="Wybierz dzień rozkładu"
              min={day0}
              value={ttDay}
              onclick={(e) => {
                try {
                  e.currentTarget.showPicker();
                } catch {
                  /* no picker API: the native control still opens on tap */
                }
              }}
              oninput={(e) => {
                const v = e.currentTarget.value;
                if (v) pickDate(v === day0 ? null : v);
              }}
              class="absolute inset-0 h-full w-full min-w-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      {/if}
    </header>
  {/snippet}

  {#key tab}
    <div bind:this={scrollEl} class="kb-scroll relative h-full overflow-y-auto pb-4 animate-fade">
      {#if tab === "live" ? liveWarn.length > 0 && !liveErr : ttWarn.length > 0}
        {@render sourceWarning(tab === "live" ? liveWarn : ttWarn)}
      {/if}
      {#if tab !== "live" && ttOffline}
        <p role="status" class="mx-4 mt-3 rounded-xl bg-tint/6 px-3 py-2 text-[12px] text-text-mute">
          Bez sieci: zapisany rozkład.
        </p>
      {/if}
      {#if tab === "live"}
        {#if liveErr || staleEmpty}
          <ErrorState message={liveErr === "warming" ? GZM_LOADING : undefined} onRetry={retryLive} />
        {:else if liveLoading}
          <SkeletonRows />
        {:else}
          <div style:padding-bottom="calc(env(safe-area-inset-bottom, 0px) + 1.25rem)">
            {#if lastOkMs > 0 && nowMs - lastOkMs > LIVE_STALE_MS}
              <p class="mx-4 mt-2 text-[12px] text-late" role="status">
                Dane sprzed {Math.round((nowMs - lastOkMs) / 1000)} s.
                <button type="button" class="font-medium underline underline-offset-2" onclick={() => poll?.refreshNow()}>
                  Odśwież
                </button>
              </p>
            {/if}
            {#if !wholeStop}
              {#if earlierDone}
                {#if earlier.tried}
                  <p class="px-4 py-2.5 text-center text-[12px] text-text-faint">Brak wcześniejszych odjazdów dziś</p>
                {/if}
              {:else}
                {@render moreButton("earlier", earlier.busy, earlier.err, showEarlier)}
              {/if}
            {/if}
            {#if earlierShown.length > 0}
              <ul class="px-2" aria-label="Wcześniejsze odjazdy z rozkładu">
                {#each earlierShown as { s, veh, timing }, i (earlierKeys[i])}
                  <li>{@render scheduleRow(s, veh, timing, true)}</li>
                {/each}
              </ul>
              <div class="mx-4 my-1 border-t border-hairline" aria-hidden="true"></div>
            {/if}
            {#if board.length === 0}
              {#if ttPending}
                <SkeletonRows />
              {:else}
                <EmptyState text={`Brak odjazdów${lineSel ? " tej linii" : ""} w najbliższych godzinach.`} />
              {/if}
            {:else}
              <ul class="{fresh ? 'stagger ' : ''}px-2">
                {#each board as { row, veh, timing, key, sched: s } (key)}
                  {#if s}
                    <li>{@render scheduleRow(s, veh, timing, false)}</li>
                  {:else}
                    {@const line = row.line_name || row.symbol || "?"}
                    {@const plat = formatPlatform(row.platform, isStation)}
                    {@const sideNum = row.side_number || veh?.side_number}
                    {@const vehModel = row.model || veh?.model}
                    {@const vehDetails = sideNum ? `#${sideNum}${vehModel ? ` · ${vehModel}` : ""}` : null}
                    {@const pole =
                      wholeStop && row.pole
                        ? `${cityOfId(stop.designator) === "bb" ? "kier." : "słupek"} ${row.pole}`
                        : null}
                    {@const sub = [pole, plat, vehDetails].filter(Boolean).join(" · ")}
                    {@const lowFloor = !!(row.features ?? veh?.features)?.lowFloor}
                    <!-- KB boards carry only direction_id; the server resolves it through the board's
                         `directions` map, the live vehicle's headsign is the fallback -->
                    {@const dest = row.direction || veh?.headsign}
                    {@const destText = dest ? displayStopName(dest) : `Linia ${line}`}
                    {@const ak = rowKey(row)}
                    {@const al = alertByKey.get(ak)}
                    <li>
                      <div class="flex items-center">
                        <button
                          type="button"
                          onclick={() => onShowLive(row.trip_execution_id || "", row.trip_id ?? null)}
                          class="tap flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-tint/5 active:bg-tint/8"
                        >
                          <LineBadge {line} operator={row.operator} />
                          <div class="min-w-0 flex-1">
                            <p class="truncate text-[13.5px] font-medium text-text">{destText}</p>
                            {#if sub || lowFloor}
                              <p class="mt-0.5 flex items-center gap-1 truncate text-[12px] tabular-nums text-text-faint">
                                {#if lowFloor}{@render lowFloorMark()}{/if}
                                {sub}
                              </p>
                            {/if}
                          </div>
                          {@render timeCell(timing, etaLabel(timing, nowTs, row.time ?? ""), null)}
                          {@render chevron()}
                        </button>
                        <!-- set from the trip view; here only shown and cancelled -->
                        {#if al}
                          <button
                            type="button"
                            aria-label={`Wyłącz powiadomienie ${al.leadMin} min przed`}
                            onclick={() => removeAlert(ak)}
                            class="tap grid h-11 w-10 shrink-0 place-items-center rounded-xl text-[17px] text-primary hover:bg-tint/5"
                          >
                            <Icon icon={BellIcon} weight="fill" />
                          </button>
                        {/if}
                      </div>
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
            {#if !wholeStop}
              {#if laterDone}
                <p class="px-4 py-2.5 text-center text-[12px] text-text-faint">Brak dalszych odjazdów w rozkładzie</p>
              {:else}
                {@render moreButton("later", later.busy, later.err, showLater)}
              {/if}
            {/if}
            {#if board.length > 0}
              <p class="flex items-center justify-center gap-1 px-4 pt-1 text-[11.5px] text-text-faint">
                <Icon icon={RssSimpleIcon} class="shrink-0 text-[0.75em]" />
                na żywo z GPS autobusu, pozostałe według rozkładu
              </p>
            {/if}
          </div>
        {/if}
      {:else if ttLoad?.status === "error"}
        <ErrorState
          message={ttLoad.warming ? GZM_LOADING : undefined}
          onRetry={() => {
            putDay(ttDay, null);
            void ensureDay(ttDay);
          }}
        />
      {:else if ttItems === null}
        <p class="px-4 pt-3 text-center text-[12px] text-text-faint" role="status">
          {ttLoad?.status === "trips" ? "Wczytywanie tras linii…" : "Pobieranie rozkładu…"}
        </p>
        <SkeletonRows />
      {:else if ttItems.length === 0}
        <EmptyState text={`Brak odjazdów${lineSel ? " tej linii" : ""} ${ttDay === day0 ? "dziś" : "w tym dniu"}.`} />
      {:else}
        <div style:padding-bottom="calc(env(safe-area-inset-bottom, 0px) + 1.25rem)">
          {#each ttHours as { hour, from, items } (`${hour}:${from}`)}
            <section>
              <h3 class="sticky top-0 z-[1] bg-surface px-4 py-1.5 text-[12px] font-semibold tabular-nums text-text-mute">
                {hour}:00
              </h3>
              <ul class="px-2">
                {#each items as s, j (ttKeys[from + j])}
                  {@const line = s.row.line_name || "?"}
                  {@const dir = s.row.direction}
                  {@const plat = formatPlatform(s.row.platform, isStation)}
                  {@const past = ttDay === day0 && s.planTs < nowTs}
                  <li>
                    <button
                      type="button"
                      onclick={() => onShowStatic(s.trip_id)}
                      class="tap flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-tint/5 active:bg-tint/8 {past
                        ? 'opacity-50'
                        : ''}"
                    >
                      <span class="w-11 shrink-0 text-[15px] font-semibold tabular-nums text-text">
                        {hhmm(s.planTs)}
                      </span>
                      <LineBadge {line} operator={s.row.operator} />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-[13.5px] font-medium text-text">
                          {dir ? displayStopName(dir) : `Linia ${line}`}
                        </p>
                        {#if plat}<p class="mt-0.5 truncate text-[12px] text-text-faint">{plat}</p>{/if}
                      </div>
                      {@render chevron()}
                    </button>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  {/key}
</BottomSheet>
