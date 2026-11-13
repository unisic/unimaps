<script module lang="ts">
  import type { FleetCurrentCourse, FleetVehicleDetail } from "@/lib/shared/fleet";

  /* "Nietypowy przydział" needs this many courses held, and the current line under this share of them */
  const UNUSUAL_MIN = 30;
  const UNUSUAL_SHARE = 0.03;

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,summary,[tabindex]:not([tabindex="-1"])';

  /** Opens a live course on the map in place (the card sits over the map); without it the link navigates. */
  type ShowOnMap = (execId: string) => void;

  /** The map's exec id of the running course: GZM keys a live vehicle by its side alone. */
  function liveExec(v: FleetVehicleDetail, c: FleetCurrentCourse): string | null {
    if (v.operator === "GZM") return `gzm:${v.sideNumber}`;
    return c.courseLoid === undefined ? null : `mzk:${c.courseLoid}:${v.sideNumber}`;
  }

  /** "69/1" when the course has a brigade (GZM). */
  function brigadeOf(c: { lineName: string; brigade?: string }): string | null {
    return c.brigade ? `${c.lineName}/${c.brigade}` : null;
  }
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";

  import { useNow } from "@/components/hooks.svelte";
  import Icon from "@/components/Icon.svelte";
  import { XIcon } from "@/components/icon-paths";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import ShareLink from "@/components/ui/ShareLink.svelte";
  import { cityOfSide, isNotFound, type FleetSummaryItem } from "@/lib/client/fleet";
  import { fleetWatches, forgetFleetWatch, setFleetWatch } from "@/lib/client/alerts";
  import { useVehicleDetail, useVehicleHistory } from "@/lib/client/fleet.svelte";
  import type { PredictedNextCourse, VehicleCourseRecord, VehiclePhoto } from "@/lib/shared/fleet";

  import Block from "./Block.svelte";
  import type { DelayColumn, GanttCourse } from "./charts";
  import { featureList, FLEET_CITY, fmtAgo, fmtDelay, fmtDelayMin, fmtKm, FUEL_LABEL, LENGTH_LABEL, pluralPl, SERIES_FILL } from "./common";
  import CourseDelayColumns from "./CourseDelayColumns.svelte";
  import CourseGantt from "./CourseGantt.svelte";
  import DelayBadge from "./DelayBadge.svelte";
  import GanttLegend from "./GanttLegend.svelte";
  import { useEpochNow } from "./hooks.svelte";
  import { ALERT, BELL, CHEVRON_DOWN, CHEVRON_LEFT, CHEVRON_RIGHT, INFO, MAP } from "./icons";
  import Svg from "./Svg.svelte";
  import VehicleHistory from "./VehicleHistory.svelte";

  /** Modal sheet: bottom sheet on phones, centred dialog from md up. The city follows from the side number. */
  let {
    side,
    seed,
    onClose,
    onShowOnMap,
    prev,
    next,
    onStep,
  }: {
    side: string;
    seed?: FleetSummaryItem;
    onClose: () => void;
    onShowOnMap?: ShowOnMap;
    /** the neighbours in the list the card was opened from; the sheet stays open and swaps the vehicle */
    prev?: string;
    next?: string;
    onStep?: (side: string) => void;
  } = $props();

  const uid = $props.id();
  const titleId = `${uid}-title`;
  let panel: HTMLDivElement | undefined = $state();
  const city = $derived(cityOfSide(side));
  const brand = $derived(FLEET_CITY[city]);
  // svelte-ignore state_referenced_locally
  const detail = useVehicleDetail(() => side, cityOfSide(side));
  // svelte-ignore state_referenced_locally
  const history = useVehicleHistory(() => side, cityOfSide(side));
  let scroller: HTMLDivElement | undefined = $state();

  onMount(() => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!panel) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // the page behind is still inert in this flush (BrigadesApp drops it after the sheet): focus a frame later
      requestAnimationFrame(() => {
        if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
      });
    };
  });

  /* phone: pull the handle or the header down to close; a short slow pull springs back */
  let pull = $state.raw<{ id: number; y: number; t: number } | null>(null);
  let pullY = $state(0);
  function onPullStart(e: PointerEvent) {
    if (pull || !e.isPrimary || e.pointerType === "mouse") return;
    if ((e.target as HTMLElement).closest("button,a")) return;
    pull = { id: e.pointerId, y: e.clientY, t: e.timeStamp };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPullEnd(e: PointerEvent) {
    if (pull?.id !== e.pointerId) return;
    // average speed in px/ms: a flick closes a short pull too
    const flick = pullY / Math.max(1, e.timeStamp - pull.t) > 0.6;
    pull = null;
    if (e.type === "pointerup" && (pullY > 120 || (flick && pullY > 30))) onClose();
    else pullY = 0;
  }

  const vehicle = $derived(detail.data?.vehicle);
  const notFound = $derived(isNotFound(detail.error));
  const model = $derived(vehicle?.model ?? seed?.model);
  const company = $derived(vehicle?.company ?? seed?.company);
  // GZM shows the printed fleet number, not the "<company>_<fleet>" key (MZK: the side number itself)
  const label = $derived(vehicle?.label ?? seed?.label ?? side.slice(side.indexOf("_") + 1));
  // this vehicle's own year from phototrans before the model's range from the fleet table
  const headYear = $derived(vehicle?.tech?.built ?? vehicle?.year);

  /* ── vehicle body ── */

  const nowSecs = useNow(30_000);
  const nowEpoch = useEpochNow(30_000);
  // keyed by the side: a vehicle reached with prev/next starts with every course folded
  let open = $state.raw<{ side: string; ids: ReadonlySet<string> }>({ side: "", ids: new Set() });
  const expanded = $derived(open.side === side ? open.ids : new Set<string>());

  /* "Powiadom, gdy wyjedzie": the sides this browser watches, and why the last try failed */
  let watched = $state.raw(fleetWatches());
  let watchHint = $state.raw<{ side: string; text: string } | null>(null);

  async function toggleWatch() {
    const s = side;
    const on = !watched.has(s);
    watchHint = null;
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    const ok = await setFleetWatch(s, on);
    watched = fleetWatches();
    if (on && !ok)
      watchHint = {
        side: s,
        text:
          typeof Notification !== "undefined" && Notification.permission === "denied"
            ? "Powiadomienia są zablokowane w ustawieniach przeglądarki."
            : "Nie udało się włączyć powiadomienia. Na iPhonie dodaj aplikację do ekranu początkowego.",
      };
  }

  // the server dropped the watch when it pushed: the vehicle runs a begun course
  $effect(() => {
    if (vehicle?.status === "active" && !vehicle.currentCourse?.notStarted && untrack(() => watched).has(side)) {
      forgetFleetWatch(side);
      watched = fleetWatches();
    }
  });

  function step(to: string) {
    onStep?.(to);
    scroller?.scrollTo({ top: 0 });
  }

  /** "Nietypowy przydział": the line it runs now took under UNUSUAL_SHARE of its courses on the days held */
  const unusual = $derived.by(() => {
    const line = vehicle?.status === "active" ? vehicle.currentCourse?.lineName : undefined;
    const days = history.data?.days;
    if (!line || !days) return null;
    let total = 0;
    let onLine = 0;
    for (const d of days)
      for (const c of d.courses) {
        total++;
        if (c.lineName === line) onLine++;
      }
    return total >= UNUSUAL_MIN && onLine / total < UNUSUAL_SHARE ? { line, onLine, total, days: days.length } : null;
  });

  const ganttCourses = $derived.by((): GanttCourse[] => {
    if (!vehicle) return [];
    const cur = vehicle.currentCourse;
    const out: GanttCourse[] = vehicle.todayCourses.map((course) => ({ course, live: false }));
    if (cur) out.push({ course: cur, live: true, notStarted: cur.notStarted });
    return out;
  });

  const delayColumns = $derived.by((): DelayColumn[] => {
    if (!vehicle) return [];
    const cur = vehicle.currentCourse;
    const measured: { c: VehicleCourseRecord; live: boolean }[] = vehicle.todayCourses
      .filter((c) => c.status === "completed")
      .map((c) => ({ c, live: false }));
    if (cur && !cur.notStarted) measured.push({ c: cur, live: true });
    return measured
      .sort((a, b) => a.c.startSecs - b.c.startSecs)
      .map(({ c, live }) => ({
        id: c.id,
        label: c.startTime,
        lineName: c.lineName,
        delaySec: c.delaySec,
        live,
        title: `Linia ${c.lineName}, ${c.startTime}–${c.endTime}: ${fmtDelay(c.delaySec)}${live ? " (w trakcie)" : ""}`,
      }));
  });

  const roadLog = $derived.by((): { c: VehicleCourseRecord | FleetCurrentCourse; live: boolean }[] =>
    vehicle
      ? [...(vehicle.currentCourse ? [{ c: vehicle.currentCourse, live: true }] : []), ...vehicle.todayCourses.map((c) => ({ c, live: false }))]
      : [],
  );

  const SOURCE_LABEL: Record<PredictedNextCourse["source"], string> = {
    schedule: "rozkład brygady",
    history: "z historii",
    timetable: "rozkład linii",
    estimate: "szacunek",
  };
  const CONFIDENCE_LABEL: Record<PredictedNextCourse["confidence"], string> = { high: "pewne", medium: "prawdopodobne", low: "możliwe" };

  function toggle(id: string) {
    const ids = new Set(expanded);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    open = { side, ids };
  }

  /** thumbnails that failed to load: phototrans removed the photo since the index was built */
  let brokenPhotos = $state.raw<ReadonlySet<string>>(new Set());
  const photos = $derived((vehicle?.photos ?? []).filter((p) => !brokenPhotos.has(p.thumb)));

  function reveal(id: string) {
    if (!expanded.has(id)) open = { side, ids: new Set(expanded).add(id) };
    requestAnimationFrame(() => document.getElementById(`course-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }
</script>

{#snippet sheetSkeleton()}
  <div aria-label="Ładowanie karty pojazdu" class="space-y-4">
    <div class="skeleton h-28 w-full rounded-2xl"></div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {#each [0, 1, 2, 3] as i (i)}
        <div class="skeleton h-16 rounded-xl"></div>
      {/each}
    </div>
    <div class="skeleton h-24 w-full rounded-2xl"></div>
    <div class="skeleton h-40 w-full rounded-2xl"></div>
  </div>
{/snippet}

{#snippet kpi(label: string, value: string, note: string, danger = false)}
  <div class="rounded-xl border border-hairline bg-surface px-3 py-2.5">
    <dt class="text-[11.5px] font-medium text-text-mute">{label}</dt>
    <dd class="mt-0.5 text-[18px] font-bold text-text tabular-nums">{value}</dd>
    <dd class="text-[11.5px] text-text-faint">
      {#if danger}<span class="text-danger">{note}</span>{:else}{note}{/if}
    </dd>
  </div>
{/snippet}

{#snippet statusBlock(v: FleetVehicleDetail)}
  {#if v.currentCourse && v.status === "active"}
    {@const c = v.currentCourse}
    {@const exec = liveExec(v, c)}
    {@const brigade = brigadeOf(c)}
    {@const driven = c.drivenMeters !== undefined ? c.drivenMeters / 1000 : null}
    {@const length = c.lengthMeters !== undefined ? c.lengthMeters / 1000 : null}
    <section aria-label="Bieżący kurs" class="flex flex-col rounded-2xl border border-hairline bg-surface p-4">
      <div class="flex items-center gap-2.5">
        <LineBadge line={c.lineName} operator={v.operator} big />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[15px] font-semibold text-text">{c.direction}</p>
          <p class="text-[12.5px] text-text-mute tabular-nums">
            Kurs {c.startTime}–{c.endTime} z {c.firstStopName}{brigade ? `, brygada ${brigade}` : null}
          </p>
        </div>
        {#if !c.notStarted}
          <DelayBadge sec={c.delaySec} size="md" />
        {/if}
      </div>

      {#if c.notStarted}
        <p class="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-text">
          Czeka na odjazd o <span class="font-semibold tabular-nums">{c.startTime}</span> z przystanku {c.firstStopName}.
        </p>
      {:else}
        <p class="mt-3 text-[13px] text-text">
          {#if c.atStop}
            Na przystanku <span class="font-semibold">{c.currentStopName}</span>
          {:else if c.nextStopName}
            Następny przystanek: <span class="font-semibold">{c.nextStopName}</span>
          {:else}
            Ostatni przystanek: <span class="font-semibold">{c.currentStopName}</span>
          {/if}
        </p>
        <div
          class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-label="Postęp kursu"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(c.progressPct)}
        >
          <div class="h-full rounded-full" style:width="{Math.min(100, Math.max(0, c.progressPct))}%" style:background={SERIES_FILL}></div>
        </div>
        <p class="mt-1.5 flex justify-between gap-3 text-[12px] text-text-mute tabular-nums">
          <span>
            {driven !== null && length !== null && length > 0
              ? `${fmtKm(driven)} z ${fmtKm(length)}`
              : `przystanek ${c.currentStopIndex + 1} z ${c.stopsCount}`}
          </span>
          <span>{Math.round(c.progressPct)}%</span>
        </p>
      {/if}

      {#if unusual && unusual.line === c.lineName}
        <p class="mt-3 flex gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[12.5px] text-text">
          <Svg icon={INFO} size={15} class="mt-px shrink-0 text-late" />
          <span>
            <span class="font-semibold">Nietypowy przydział.</span>
            Linia {unusual.line} to {unusual.onLine} z {unusual.total}
            {pluralPl(unusual.total, "kursu", "kursów", "kursów")} tego {brand.vehGen} z ostatnich {unusual.days}
            {pluralPl(unusual.days, "dnia", "dni", "dni")}.
          </span>
        </p>
      {/if}

      <div class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
        <span class="text-[12px] text-text-faint">Pozycja {fmtAgo(c.fixAt ?? v.lastSeenAt, nowEpoch.current)}</span>
        {#if exec}
          <a
            href="/?exec={encodeURIComponent(exec)}"
            onclick={(e) => {
              // a modified click still opens a new tab
              if (!onShowOnMap || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onShowOnMap(exec);
            }}
            class="inline-flex min-h-10 items-center gap-2 rounded-full bg-brand px-4 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hi"
          >
            <Svg icon={MAP} size={15} />
            Pokaż na mapie
          </a>
        {/if}
      </div>
    </section>
  {:else}
    {@const loc = v.lastKnownLocation}
    {@const hasCoords = loc && Math.abs(loc.lat) > 1 && Math.abs(loc.lon) > 1}
    {@const on = watched.has(v.sideNumber)}
    <section aria-label="Stan pojazdu" class="flex flex-col rounded-2xl border border-hairline bg-surface p-4">
      <p class="text-[15px] font-semibold text-text">Nie kursuje</p>
      <p class="mt-1 text-[13px] text-text-mute">
        {#if v.lastSeenAt > 0}
          Ostatnio w trasie {fmtAgo(v.lastSeenAt, nowEpoch.current)}{loc?.name ? `. ${loc.name}` : ""}
        {:else}
          Dziś nie wyjechał na trasę.
        {/if}
      </p>
      <div class="mt-3">
        <button
          type="button"
          onclick={toggleWatch}
          aria-pressed={on}
          class="inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-[13px] font-semibold transition-colors {on
            ? 'bg-primary-dim text-primary'
            : 'bg-surface-3 text-text hover:bg-tint/12'}"
        >
          <Svg icon={BELL} size={15} />
          {on ? "Powiadomię, gdy wyjedzie" : "Powiadom, gdy wyjedzie"}
        </button>
        <p class="mt-1.5 text-[12px] text-text-faint">
          {watchHint?.side === v.sideNumber
            ? watchHint.text
            : on
              ? "Dotknij, aby anulować. Powiadomienie wygasa po 24 godzinach."
              : "Jedno powiadomienie, gdy ruszy w najbliższy kurs, także przy zamkniętej stronie."}
        </p>
      </div>
      {#if v.lastSeenAt > 0 && hasCoords && loc}
        <div class="mt-auto pt-3">
          <a
            href="/?{v.operator === 'GZM' ? 'city=gzm&' : ''}map={loc.lat.toFixed(5)},{loc.lon.toFixed(5)},16"
            class="inline-flex min-h-10 items-center gap-2 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text transition-colors hover:bg-tint/12"
          >
            <Svg icon={MAP} size={15} />
            Ostatnia pozycja na mapie
          </a>
        </div>
      {/if}
    </section>
  {/if}
{/snippet}

{#snippet predictionCard(p: NonNullable<FleetVehicleDetail["predictedNextCourse"]>, operator: FleetVehicleDetail["operator"])}
  <!-- only a same-line layover guess is a guess: the rest names a source (brigade schedule, history, timetable) -->
  {@const guess = p.source === "estimate"}
  <section
    aria-label={guess ? "Następny kurs, szacunek" : "Następny kurs"}
    class="rounded-2xl border p-4 {guess ? 'border-dashed border-tint/15' : 'border-hairline bg-surface'}"
  >
    <div class="mb-2 flex items-center justify-between gap-3">
      <h3 class="text-[14px] font-semibold text-text">{guess ? "Następny kurs (szacunek)" : "Następny kurs"}</h3>
      <span class="rounded-full bg-tint/6 px-2 py-0.5 text-[11.5px] font-medium text-text-mute">
        {SOURCE_LABEL[p.source]}{p.seen ? `, ${p.seen.days} z ${p.seen.of} dni` : ""}
      </span>
    </div>
    <div class="flex items-center gap-2.5">
      <LineBadge line={p.lineName} {operator} />
      <p class="min-w-0 flex-1 text-[13.5px] text-text">
        <span class="font-medium">{p.direction}</span><span class="block text-[12.5px] text-text-mute tabular-nums">
          {guess
            ? `ok. ${p.departureTime} z ${p.fromStopName}, postój ok. ${p.pauseMinutes} min`
            : `${p.departureTime} z ${p.fromStopName}, postój ${p.pauseMinutes} min`}
        </span>
      </p>
      {#if !guess && p.confidence !== "high"}
        <span class="shrink-0 text-[11.5px] text-text-faint">{CONFIDENCE_LABEL[p.confidence]}</span>
      {/if}
    </div>
    <p class="mt-2.5 text-[12px] leading-snug text-text-faint">{p.reason}</p>
    {#if p.later && p.later.length > 0}
      <h4 class="mt-3 mb-1 text-[12px] font-medium text-text-mute">Potem</h4>
      <ol class="-mx-1 divide-y divide-hairline">
        {#each p.later as l, i (i)}
          <li class="flex min-h-10 items-center gap-2.5 px-1 py-1.5">
            <span class="w-11 shrink-0 text-[12.5px] text-text-mute tabular-nums">{l.departureTime}</span>
            <LineBadge line={l.lineName} {operator} />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-text">{l.direction}</span>
              <span class="block truncate text-[11.5px] text-text-faint">z {l.fromStopName}</span>
            </span>
            {#if l.confidence !== "high"}
              <span class="shrink-0 text-[11.5px] text-text-faint">{CONFIDENCE_LABEL[l.confidence]}</span>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/snippet}

{#snippet courseRow(c: VehicleCourseRecord | FleetCurrentCourse, live: boolean, operator: FleetVehicleDetail["operator"])}
  {@const open = expanded.has(c.id)}
  {@const panelId = `${uid}-${c.id}`}
  {@const brigade = brigadeOf(c)}
  {@const notStarted = live && "notStarted" in c && Boolean(c.notStarted)}
  {@const cancelled = c.status === "cancelled"}
  {@const km = c.drivenMeters !== undefined ? c.drivenMeters / 1000 : null}
  {@const extra = [brigade ? `brygada ${brigade}` : null, km !== null && km > 0 ? fmtKm(km) : null].filter(Boolean).join(", ")}
  {@const expandable = (c.stops?.length ?? 0) > 0 || (cancelled && Boolean(c.cancelledReason))}
  <!-- a past GZM course keeps no stop list: such a row has nothing to expand -->
  <li id="course-{c.id}" class="scroll-mt-4">
    {#snippet head()}
      <!-- a phone has no room for a time column: the time leads the second line there -->
      <span class="hidden w-[5.5rem] shrink-0 text-[12.5px] text-text-mute tabular-nums sm:block">
        {c.startTime}–{c.endTime}
      </span>
      <LineBadge line={c.lineName} {operator} />
      <span class="min-w-0 flex-1">
        <span class="line-clamp-2 text-[13px] text-text">
          {c.firstStopName} → {c.lastStopName}
        </span>
        <span class="block text-[11.5px] text-text-faint tabular-nums">
          <span class="text-text-mute sm:hidden">{c.startTime}–{c.endTime}{extra ? ", " : ""}</span>{extra}
        </span>
      </span>
      {#if cancelled}
        <span class="shrink-0 rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-semibold text-danger">Przerwany</span>
      {:else if notStarted}
        <span class="shrink-0 rounded-md bg-tint/6 px-1.5 py-0.5 text-[12px] font-medium text-text-mute">Czeka</span>
      {:else}
        <span class="flex shrink-0 items-center gap-1.5">
          {#if live}
            <span class="text-[11.5px] font-medium text-good">teraz</span>
          {/if}
          <DelayBadge sec={c.delaySec} />
        </span>
      {/if}
      {#if expandable}
        <Svg icon={CHEVRON_DOWN} size={16} class="shrink-0 text-text-faint transition-transform {open ? 'rotate-180' : ''}" />
      {/if}
    {/snippet}
    {#if !expandable}
      <div class="flex min-h-12 w-full items-center gap-3 px-1 py-2">{@render head()}</div>
    {:else}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onclick={() => toggle(c.id)}
        class="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-tint/5"
      >{@render head()}</button>
      <div id={panelId} hidden={!open} class="pb-3 pl-1 pr-1">
        {#if open}
          {#if cancelled && c.cancelledReason}
            <p class="mb-2 flex gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] leading-snug text-text">
              <Svg icon={ALERT} size={14} class="mt-0.5 shrink-0 text-danger" />
              {c.cancelledReason}
            </p>
          {/if}
          {#if c.stops && c.stops.length > 0}
            <div class="kb-scroll max-h-80 overflow-y-auto rounded-lg border border-hairline">
              <table class="w-full text-[12.5px] tabular-nums">
                <thead class="sticky top-0 bg-surface-2 text-left text-text-mute">
                  <tr>
                    <th scope="col" class="px-3 py-1.5 font-medium">Przystanek</th>
                    <th scope="col" class="px-2 py-1.5 text-right font-medium">Rozkład</th>
                    <th scope="col" class="px-3 py-1.5 text-right font-medium">{c.status === "in_progress" ? "Prognoza" : "Ostatnia prognoza"}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each c.stops as st, i (`${st.symbol}-${i}`)}
                    <tr
                      class="border-t border-hairline {st.status === 'current' ? 'bg-primary-dim' : ''}"
                      aria-current={st.status === "current" ? "location" : undefined}
                    >
                      <th scope="row" class="px-3 py-1.5 text-left font-normal {st.status === 'passed' ? 'text-text-mute' : 'text-text'}">
                        <span class="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            class="h-1.5 w-1.5 shrink-0 rounded-full {st.status === 'current'
                              ? 'bg-primary'
                              : st.status === 'passed'
                                ? 'bg-text-faint'
                                : 'border border-text-faint'}"
                          ></span>
                          {st.name}
                        </span>
                      </th>
                      <td class="px-2 py-1.5 text-right text-text-mute">{st.scheduledTime}</td>
                      <td class="px-3 py-1.5 text-right text-text">{st.plannedTime !== st.scheduledTime ? st.plannedTime : ""}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <p class="text-[12.5px] text-text-mute">Brak listy przystanków dla tego kursu.</p>
          {/if}
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

{#snippet techRow(name: string, value: string | number | undefined)}
  {#if value}
    <dt class="text-text-mute">{name}</dt>
    <dd class="text-text">{value}</dd>
  {/if}
{/snippet}

{#snippet photoStrip(v: FleetVehicleDetail, list: VehiclePhoto[])}
  <ul
    class="kb-scroll -mx-1 mb-4 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-1 pb-2"
    aria-label="Zdjęcia pojazdu #{v.label ?? v.sideNumber}"
  >
    {#each list as p, i (p.thumb)}
      <li class="w-[240px] shrink-0 snap-start">
        <a
          href={p.page}
          target="_blank"
          rel="noopener"
          title="Pełna rozdzielczość na phototrans.eu"
          class="block overflow-hidden rounded-xl border border-hairline bg-surface-2"
        >
          <img
            src={p.thumb}
            alt="Pojazd #{v.label ?? v.sideNumber}, zdjęcie {i + 1} z {list.length}, fot. {p.author}"
            width="300"
            height="200"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            class="aspect-[3/2] w-full object-cover"
            onerror={() => (brokenPhotos = new Set(brokenPhotos).add(p.thumb))}
          />
        </a>
        <p class="mt-1 truncate text-[11.5px] text-text-faint">
          fot. {p.author}{p.date ? `, ${p.date.split("-").reverse().join(".")}` : ""}
        </p>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet vehicleBody(v: FleetVehicleDetail)}
  {@const s = v.stats}
  {@const cur = v.currentCourse}
  <div class="space-y-4">
    {@render statusBlock(v)}

    <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {#if s.cancelledCoursesToday > 0}
        {@render kpi(
          "Kursy dziś",
          String(s.totalCoursesToday),
          `${s.cancelledCoursesToday} ${pluralPl(s.cancelledCoursesToday, "przerwany", "przerwane", "przerwanych")}`,
          true,
        )}
      {:else}
        {@render kpi(
          "Kursy dziś",
          String(s.totalCoursesToday),
          `${s.completedCoursesToday} ${pluralPl(s.completedCoursesToday, "zakończony", "zakończone", "zakończonych")}`,
        )}
      {/if}
      {@render kpi("Przejechane dziś", fmtKm(s.kmToday), "według długości kursów")}
      {@render kpi(
        "Średnie opóźnienie",
        s.measuredCourses > 0 ? fmtDelayMin(s.averageDelaySecs) : "–",
        s.measuredCourses > 0 ? `z ${s.measuredCourses} ${pluralPl(s.measuredCourses, "kursu", "kursów", "kursów")}` : "brak pomiarów",
      )}
      {@render kpi("Punktualność", s.punctualityPct !== null ? `${s.punctualityPct}%` : "–", "od −1 do +3 min")}
    </dl>

    <Block title="Linie dziś">
      {#snippet aside()}
        {#if v.mainLine && v.lines.length > 1}
          <span class="text-[12px] text-text-mute">najczęściej linia {v.mainLine}</span>
        {/if}
      {/snippet}
      {#if v.lines.length > 0}
        <ul class="flex flex-wrap gap-2" aria-label="Linie obsłużone dziś">
          {#each v.lines as l (l)}
            <li>
              <LineBadge line={l} operator={v.operator} big={l === v.mainLine} />
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-[13px] text-text-mute">Dziś ten pojazd jeszcze nie kursował.</p>
      {/if}
      <p class="mt-3 flex gap-2 text-[12px] leading-snug text-text-faint">
        <Svg icon={INFO} size={14} class="mt-px shrink-0" />
        {v.operator === "GZM"
          ? "Brygady kursów i następny kurs pochodzą z rozkładu GZM."
          : "MZK nie publikuje numerów brygad, dlatego pokazujemy linie obsłużone dziś przez ten pojazd."}
      </p>
    </Block>

    {#if ganttCourses.length > 0}
      <Block title="Przebieg dnia">
        <CourseGantt courses={ganttCourses} nowSecs={nowSecs.current} onSelect={reveal} />
        <div class="mt-2">
          <GanttLegend showWaiting={Boolean(cur?.notStarted)} />
        </div>
      </Block>
    {/if}

    {#if delayColumns.length >= 2}
      <Block title="Opóźnienie na kolejnych kursach">
        {#snippet aside()}
          <span class="text-[12px] text-text-mute">przyjazd na końcowy</span>
        {/snippet}
        <CourseDelayColumns columns={delayColumns} />
      </Block>
    {/if}

    {#if v.predictedNextCourse}
      {@render predictionCard(v.predictedNextCourse, v.operator)}
    {/if}

    <Block title="Karta drogowa">
      {#snippet aside()}
        {#if roadLog.length > 0}
          <span class="text-[12px] text-text-mute tabular-nums">
            {roadLog.length} {pluralPl(roadLog.length, "kurs", "kursy", "kursów")}
          </span>
        {/if}
      {/snippet}
      {#if roadLog.length > 0}
        <ul class="-mx-1 divide-y divide-hairline">
          {#each roadLog as { c, live } (c.id)}
            {@render courseRow(c, live, v.operator)}
          {/each}
        </ul>
      {:else}
        <p class="text-[13px] text-text-mute">Brak kursów zarejestrowanych dzisiaj.</p>
      {/if}
    </Block>

    {#key v.sideNumber}
      <VehicleHistory side={v.sideNumber} operator={v.operator} />
    {/key}

    <Block title="Dane techniczne">
      {#if photos.length > 0}
        {@render photoStrip(v, photos)}
      {/if}
      {@const t = v.tech}
      {#if v.operator === "GZM"}
        <!-- GZM publishes the model only: the rest comes from phototrans when it lists the vehicle -->
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
          <dt class="text-text-mute">Numer taborowy</dt>
          <dd class="font-semibold text-text tabular-nums">#{v.label ?? v.sideNumber}</dd>
          <dt class="text-text-mute">Przewoźnik</dt>
          <dd class="text-text">{v.company || "–"}</dd>
          {@render techRow("Producent", v.producer)}
          <dt class="text-text-mute">Model</dt>
          <dd class="text-text">{v.model || "–"}</dd>
          {@render techRow("Rok produkcji", t?.built)}
          {@render techRow("W taborze od", t?.since)}
          {@render techRow("Długość", v.lengthCategory ? LENGTH_LABEL[v.lengthCategory] : undefined)}
          {@render techRow("Napęd", v.fuelType ? FUEL_LABEL[v.fuelType] : undefined)}
          {@render techRow("Nadwozie", t?.body)}
          {@render techRow("Silnik", t?.engine)}
          {@render techRow("Skrzynia biegów", t?.gearbox)}
          {@render techRow("Układ drzwi", t?.doors)}
        </dl>
      {:else}
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
          <dt class="text-text-mute">Numer boczny</dt>
          <dd class="font-semibold text-text tabular-nums">#{v.sideNumber}</dd>
          <dt class="text-text-mute">Producent</dt>
          <dd class="text-text">{v.producer || "–"}</dd>
          <dt class="text-text-mute">Model</dt>
          <dd class="text-text">{v.model || "–"}</dd>
          <!-- v.year is the model's year range from the fleet table; phototrans knows this vehicle's own year -->
          <dt class="text-text-mute">{t?.built || !v.year || /^\d{4}$/.test(v.year) ? "Rok produkcji" : "Roczniki modelu"}</dt>
          <dd class="text-text tabular-nums">{t?.built ?? v.year ?? "–"}</dd>
          <dt class="text-text-mute">Długość</dt>
          <dd class="text-text">{v.lengthCategory ? LENGTH_LABEL[v.lengthCategory] : "–"}</dd>
          <dt class="text-text-mute">Napęd</dt>
          <dd class="text-text">{v.fuelType ? FUEL_LABEL[v.fuelType] : "–"}</dd>
          <dt class="text-text-mute">Wyposażenie</dt>
          <dd class="text-text">{featureList(v.features).join(", ") || "–"}</dd>
          {@render techRow("Silnik", t?.engine)}
          {@render techRow("Skrzynia biegów", t?.gearbox)}
          {@render techRow("Układ drzwi", t?.doors)}
        </dl>
      {/if}
      {#if t}
        <p class="mt-3 text-[12px] text-text-faint">
          Źródło danych{photos.length > 0 ? " i zdjęć" : ""}:
          <a href={t.page} target="_blank" rel="noopener" class="font-medium text-primary hover:underline">phototrans.eu</a>
        </p>
      {/if}
    </Block>
  </div>
{/snippet}

<div class="fixed inset-0 z-[2000] flex items-end justify-center md:items-center md:p-6">
  <div class="absolute inset-0 animate-fade bg-black/65" onclick={onClose} aria-hidden="true"></div>
  <div
    bind:this={panel}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    class="relative flex max-h-[92dvh] w-full animate-rise flex-col overflow-hidden rounded-t-3xl border border-hairline bg-bg shadow-[var(--shadow-sheet)] focus:outline-none md:max-h-[88dvh] md:max-w-3xl md:rounded-3xl"
    style:transform={pullY > 0 ? `translate3d(0, ${pullY}px, 0)` : undefined}
    style:transition={pull ? "none" : "transform 0.25s var(--ease-spring)"}
  >
    <div
      role="presentation"
      class="shrink-0 select-none"
      style:touch-action="none"
      onpointerdown={onPullStart}
      onpointermove={(e) => pull?.id === e.pointerId && (pullY = Math.max(0, e.clientY - pull.y))}
      onpointerup={onPullEnd}
      onpointercancel={onPullEnd}
    >
      <div aria-hidden="true" class="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-tint/15 md:hidden"></div>
      <header class="flex shrink-0 items-center gap-2 border-b border-hairline px-4 pb-3 pt-2 md:pt-4">
        <div class="min-w-0 flex-1">
          <h2 id={titleId} class="truncate text-[18px] font-bold text-text tabular-nums">
            Pojazd #{label}
          </h2>
          <p class="truncate text-[13px] text-text-mute">
            {company ? `${company}${model ? ", " : ""}` : null}{model ?? (notFound ? "Nieznany pojazd" : " ")}{#if headYear}<span class="text-text-faint">{` (${headYear})`}</span>{/if}
          </p>
        </div>
        <ShareLink
          title="Pojazd {brand.short} #{label}"
          path="/brygady?{city === 'gzm' ? 'city=gzm&' : ''}tabor={encodeURIComponent(side)}"
        />
        {#if onStep && (prev || next)}
          <button
            type="button"
            onclick={() => prev && step(prev)}
            disabled={!prev}
            aria-label="Poprzedni pojazd na liście"
            class="grid h-11 w-9 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-tint/8 hover:text-text disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Svg icon={CHEVRON_LEFT} size={18} />
          </button>
          <button
            type="button"
            onclick={() => next && step(next)}
            disabled={!next}
            aria-label="Następny pojazd na liście"
            class="grid h-11 w-9 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-tint/8 hover:text-text disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Svg icon={CHEVRON_RIGHT} size={18} />
          </button>
        {/if}
        <button
          type="button"
          onclick={onClose}
          aria-label="Zamknij kartę pojazdu"
          class="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-tint/8 hover:text-text"
        >
          <Icon icon={XIcon} />
        </button>
      </header>
    </div>

    <div bind:this={scroller} class="kb-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
      {#if vehicle}
        {#if detail.error && !notFound}
          <p class="mb-3 flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[12.5px] text-late">
            <Svg icon={ALERT} size={14} />
            Nie udało się odświeżyć, pokazujemy ostatnie dane.
          </p>
        {/if}
        {@render vehicleBody(vehicle)}
      {:else if notFound}
        <div class="py-12 text-center">
          <p class="text-[15px] font-medium text-text">Nie znamy pojazdu #{label}</p>
          <p class="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
            {city === "gzm"
              ? "Ten pojazd nie wyjechał dziś na trasę. Link mógł się zestarzeć albo numer ma literówkę."
              : "Tego numeru nie ma we flocie MZK Bielsko-Biała. Link mógł się zestarzeć albo numer ma literówkę."}
          </p>
          <button
            type="button"
            onclick={onClose}
            class="mt-4 min-h-10 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text hover:bg-tint/12"
          >
            Wróć do listy
          </button>
        </div>
      {:else if detail.error && !detail.isLoading}
        <div class="py-12 text-center">
          <p class="text-[13px] text-danger">Nie udało się pobrać karty pojazdu.</p>
          <button
            type="button"
            onclick={() => void detail.mutate()}
            class="mt-3 min-h-10 rounded-full bg-brand px-4 text-[13px] font-semibold text-on-brand hover:bg-brand-hi"
          >
            Spróbuj ponownie
          </button>
        </div>
      {:else}
        {@render sheetSkeleton()}
      {/if}
    </div>
  </div>
</div>
