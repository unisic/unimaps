<script lang="ts">
  import { onMount, untrack } from "svelte";

  import BottomSheet from "@/components/BottomSheet.svelte";
  import Icon from "@/components/Icon.svelte";
  import { ArrowsDownUpIcon, CaretRightIcon, XIcon } from "@/components/icon-paths";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import IconButton from "@/components/ui/IconButton.svelte";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import ModeIcon from "@/components/ui/ModeIcon.svelte";
  import SkeletonRows from "@/components/ui/SkeletonRows.svelte";
  import { fetchJSON, isWarming } from "@/lib/client/api";
  import { cityUrl, GZM_LOADING, type City } from "@/lib/client/city";
  import {
    delayTxt,
    displayStopName,
    nowSecs,
    operatorColor,
    todayISO,
    transitMode,
    wozPlural,
  } from "@/lib/client/format";
  import { buildDirection, onLine, placeVehicles, splitDirections } from "@/lib/client/lineRoute";
  import type { LineInfo, LineResponse, LineVariant, Stop, Vehicle } from "@/lib/client/types";

  /** A line as zbiorkom.live shows it: one direction at a time (all of its patterns merged into one stop list), the
   *  line's live vehicles on that list, each stop's departures of every course one tap away. Mounted only while open. */
  let {
    desktop,
    line,
    city,
    vehicles,
    resolveStop,
    onSelectStop,
    onPickVehicle,
    onVariant,
    onClose,
  }: {
    desktop: boolean;
    line: LineInfo;
    city: City;
    /** the whole live fleet (the poll's array); the line's own are picked here */
    vehicles: readonly Vehicle[];
    /** a router stop id to the map's stop, null when the list has none */
    resolveStop: (id: string) => Stop | null;
    onSelectStop: (s: Stop) => void;
    onPickVehicle: (v: Vehicle) => void;
    /** the direction on screen as one pattern (trunk shape, merged stops) for the map layer; null on close */
    onVariant: (v: LineVariant | null) => void;
    onClose: () => void;
  } = $props();

  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  /* a stop row's height (px): the rail circle and the vehicles between stops are placed on it */
  const ROW = 48;

  function byHour(mins: number[]): Map<number, number[]> {
    const hours = new Map<number, number[]>();
    for (const m of mins) {
      const h = Math.floor(m / 60);
      const list = hours.get(h);
      if (list) list.push(m);
      else hours.set(h, [m]);
    }
    return hours;
  }

  /* fixed at open: a sheet left open past midnight keeps the day it was showing */
  const date = todayISO();
  let data = $state.raw<LineResponse | null>(null);
  let err = $state<false | "error" | "warming">(false);
  let attempt = $state(0);
  let dirIdx = $state(0);
  /* expanded row of the direction */
  let open = $state<number | null>(null);
  /* Warsaw minute of the day and date, for dimming departures already gone */
  let today = $state(todayISO());
  let clock = $state(Math.floor(nowSecs() / 60));
  onMount(() => {
    const id = setInterval(() => {
      today = todayISO();
      clock = Math.floor(nowSecs() / 60);
    }, 30_000);
    return () => clearInterval(id);
  });

  const name = $derived(line.name);
  const op = $derived(line.operator === "MZK" ? "MZK" : "KB");
  $effect(() => {
    void attempt;
    const ctrl = new AbortController();
    const p = new URLSearchParams({ name, op, date });
    fetchJSON<LineResponse>(cityUrl(`/api/line?${p.toString()}`, city), { signal: ctrl.signal })
      .then((r) => {
        data = r;
        err = false;
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) err = isWarming(e) ? "warming" : "error";
      });
    return () => ctrl.abort();
  });

  const dirs = $derived.by(() => {
    const d = data;
    return d ? splitDirections(d.variants).map((ix) => buildDirection(d.variants, ix)) : [];
  });
  const dir = $derived(dirs[dirIdx] ?? null);
  $effect(() => {
    const set = onVariant;
    const d = dir;
    const trunk = d && data ? data.variants[d.variants[0]] : null;
    const shown: LineVariant | null =
      d && trunk ? { headsign: d.headsign, shape: trunk.shape, stops: d.rows, times: [], trips: [] } : null;
    untrack(() => set(shown));
  });
  onMount(() => () => onVariant(null));

  const mine = $derived(vehicles.filter((v) => onLine(v, line)));
  const beads = $derived(data && dir ? placeVehicles(data.variants, dir, mine) : []);
  /* each bead in the row it is heading for, offset sideways from the ones already there */
  const beadsByRow = $derived.by(() => {
    const rows = new Map<number, { v: Vehicle; y: number; x: number }[]>();
    for (const b of beads) {
      const r = Math.ceil(b.at);
      const list = rows.get(r) ?? [];
      list.push({ v: b.v, y: ROW / 2 + (b.at - r) * ROW, x: list.length });
      rows.set(r, list);
    }
    return rows;
  });
  const color = $derived(operatorColor(line.operator, line.name));
  const nowMin = $derived(data && data.date === today ? clock : null);

  function swap() {
    dirIdx = (dirIdx + 1) % dirs.length;
    open = null;
  }
</script>

<!-- Departures at one stop as an hour grid; the ones already gone today are dimmed. -->
{#snippet hourGrid(mins: number[], nowMin: number | null)}
  <dl class="grid grid-cols-[2.25rem_1fr] gap-x-2 gap-y-1 text-[13px] tabular-nums">
    {#each [...byHour(mins)] as [h, list] (h)}
      <div class="contents">
        <dt class="font-semibold text-text">{pad(h % 24)}</dt>
        <dd class="flex flex-wrap gap-x-2.5">
          {#each list as m, i (i)}
            <span class={nowMin != null && m < nowMin ? "text-text-faint" : "text-text"}>{pad(m % 60)}</span>
          {/each}
        </dd>
      </div>
    {/each}
  </dl>
{/snippet}

<BottomSheet {desktop} {onClose} ariaLabel={`Linia ${line.name}`} initialSnap="half">
  {#snippet header()}
    <header class="px-4 pb-3 pt-2 md:pt-4">
      <div class="flex items-center gap-3">
        <LineBadge line={line.name} operator={line.operator} big />
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">
            {dir ? `→ ${displayStopName(dir.headsign)}` : `Linia ${line.name}`}
          </h2>
          <p class="mt-0.5 truncate text-[12px] text-text-faint">
            {dir ? `z ${displayStopName(dir.rows[0].name)}, ` : ""}{mine.length > 0
              ? `${mine.length} ${wozPlural(mine.length)} na trasie`
              : "brak wozów na trasie"}
          </p>
        </div>
        {#if dirs.length > 1}
          <IconButton label="Zmień kierunek" onClick={swap}>
            <Icon icon={ArrowsDownUpIcon} />
          </IconButton>
        {/if}
        <IconButton label="Zamknij" onClick={onClose}>
          <Icon icon={XIcon} />
        </IconButton>
      </div>
    </header>
  {/snippet}

  <div
    class="kb-scroll h-full overflow-y-auto pb-4 animate-fade"
    style:padding-bottom="calc(env(safe-area-inset-bottom, 0px) + 1.25rem)"
  >
    {#if err && !data}
      <ErrorState
        message={err === "warming" ? GZM_LOADING : undefined}
        onRetry={() => {
          err = false;
          attempt += 1;
        }}
      />
    {:else if !data}
      <SkeletonRows />
    {:else if !dir}
      <p class="px-6 py-10 text-center text-[13.5px] text-text-faint">Linia nie kursuje dziś według rozkładu.</p>
    {:else}
      {@const rows = dir.rows}
      <ol class="px-2" style:--line-c={color}>
        {#each rows as r, i (`${dirIdx}-${r.id}-${i}`)}
          {@const expanded = open === i}
          {@const next = nowMin == null ? r.times[0] : r.times.find((m) => m >= nowMin)}
          {@const stop = expanded ? resolveStop(r.id) : null}
          <li class="relative">
            <!-- the rail: the line through every row, a ring per stop (a hollow one where only some courses stop) -->
            {#if rows.length > 1}
              <span
                class="absolute left-[25px] w-1 bg-(--line-c)"
                style:top={i === 0 ? `${ROW / 2}px` : "0"}
                style:height={i === rows.length - 1 ? `${ROW / 2}px` : undefined}
                style:bottom={i === rows.length - 1 ? undefined : "0"}
                aria-hidden="true"
              ></span>
            {/if}
            <span
              class="absolute left-[19px] size-4 rounded-full border-[3px] {r.trunk
                ? 'border-(--line-c) bg-bg'
                : 'border-(--line-c) bg-(--line-c)/30'}"
              style:top={`${ROW / 2 - 8}px`}
              aria-hidden="true"
            ></span>
            <button
              type="button"
              onclick={() => (open = expanded ? null : i)}
              aria-expanded={expanded}
              class="tap flex w-full items-center gap-3 rounded-xl pl-12 pr-3 text-left hover:bg-tint/5 active:bg-tint/8"
              style:height={`${ROW}px`}
            >
              <span class="min-w-0 flex-1">
                <span
                  class="block truncate text-[14px] {expanded ? 'font-semibold' : ''} {r.trunk
                    ? 'text-text'
                    : 'text-text-mute'}"
                >
                  {displayStopName(r.name)}
                </span>
                {#if !r.trunk}
                  <span class="block text-[11.5px] text-text-faint">tylko część kursów</span>
                {/if}
              </span>
              {#if next != null}
                <span class="shrink-0 text-[12.5px] tabular-nums text-text-mute">{hhmm(next)}</span>
              {/if}
            </button>
            {#each beadsByRow.get(i) ?? [] as b (b.v.id)}
              <button
                type="button"
                onclick={() => onPickVehicle(b.v)}
                aria-label={`${b.v.side_number ? `Wóz #${b.v.side_number}` : "Wóz"} → ${displayStopName(b.v.headsign)}${
                  b.v.delay != null && !b.v.not_started ? `, ${delayTxt(b.v.delay)}` : ""
                }`}
                title={b.v.side_number ? `#${b.v.side_number}` : undefined}
                class="tap absolute z-10 grid size-6 place-items-center rounded-full bg-(--line-c) text-[14px] text-white ring-2 ring-bg transition-transform duration-500"
                style:left={`${15 + b.x * 14}px`}
                style:top="0"
                style:transform={`translateY(${b.y - 12}px)`}
              >
                <ModeIcon mode={transitMode(b.v.operator, b.v.vehicle_type)} />
              </button>
            {/each}
            {#if expanded}
              <div class="pb-3 pl-12 pr-4 pt-1">
                {#if r.times.length > 0}
                  {@render hourGrid(r.times, nowMin)}
                {:else}
                  <p class="text-[12.5px] text-text-faint">
                    {i === rows.length - 1 ? "Przystanek końcowy." : "Tu kursy tylko kończą bieg."}
                  </p>
                {/if}
                {#if stop}
                  <button
                    type="button"
                    onclick={() => onSelectStop(stop)}
                    class="tap mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-primary"
                  >
                    Odjazdy wszystkich linii
                    <Icon icon={CaretRightIcon} />
                  </button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</BottomSheet>
