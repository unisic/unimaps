<script lang="ts">
  import { onMount, untrack } from "svelte";

  import BottomSheet from "@/components/BottomSheet.svelte";
  import Icon from "@/components/Icon.svelte";
  import { CaretDownIcon, CaretRightIcon, XIcon } from "@/components/icon-paths";
  import { chip } from "@/components/ui";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import IconButton from "@/components/ui/IconButton.svelte";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import SkeletonRows from "@/components/ui/SkeletonRows.svelte";
  import { fetchJSON, isWarming } from "@/lib/client/api";
  import { cityUrl, GZM_LOADING, type City } from "@/lib/client/city";
  import { displayStopName, nowSecs, todayISO } from "@/lib/client/format";
  import type { LineInfo, LineResponse, LineVariant, Stop } from "@/lib/client/types";

  /** A line's stop patterns for today, each stop's departures one tap away. Mounted only while open. */
  let {
    desktop,
    line,
    city,
    filterActive,
    onToggleFilter,
    resolveStop,
    onSelectStop,
    onVariant,
    onClose,
  }: {
    desktop: boolean;
    line: LineInfo;
    city: City;
    /** the map shows only this line's vehicles */
    filterActive: boolean;
    onToggleFilter: (line: string) => void;
    /** a router stop id to the map's stop, null when the list has none */
    resolveStop: (id: string) => Stop | null;
    onSelectStop: (s: Stop) => void;
    /** the pattern on screen, for the map layer (null while loading / on close) */
    onVariant: (v: LineVariant | null) => void;
    onClose: () => void;
  } = $props();

  const pad = (n: number) => String(n).padStart(2, "0");

  /** A variant's chip label; patterns sharing a headsign are told apart by their first stop. */
  function variantLabel(v: LineVariant, all: readonly LineVariant[]): string {
    const to = `→ ${displayStopName(v.headsign || v.stops[v.stops.length - 1].name)}`;
    return all.filter((o) => o.headsign === v.headsign).length > 1 ? `${to} (z ${displayStopName(v.stops[0].name)})` : to;
  }

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
  let variant = $state(0);
  /* expanded stop position in the variant; the first stop's departures show at once */
  let open = $state<number | null>(0);
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

  const v = $derived(data?.variants[variant] ?? null);
  $effect(() => {
    const set = onVariant;
    const cur = v;
    untrack(() => set(cur));
  });
  onMount(() => () => onVariant(null));
  const nowMin = $derived(data && data.date === today ? clock : null);
  const column = $derived.by(() => {
    const at = open;
    return v && at != null ? v.times.map((t) => t[at]).sort((a, b) => a - b) : [];
  });

  function pickVariant(i: number) {
    variant = i;
    open = 0;
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
          <h2 class="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">Linia {line.name}</h2>
          <p class="mt-0.5 truncate text-[12px] text-text-faint">
            {line.terminus ? `${displayStopName(line.terminus)}, ` : ""}rozkład na dziś
          </p>
        </div>
        <IconButton label="Zamknij" onClick={onClose}>
          <Icon icon={XIcon} />
        </IconButton>
      </div>
      <div class="kb-scroll mt-3 flex gap-2 overflow-x-auto">
        <button
          type="button"
          onclick={() => onToggleFilter(line.name)}
          aria-pressed={filterActive}
          class={chip(filterActive)}
        >
          Tylko ta linia na mapie
        </button>
        {#if data && data.variants.length > 1}
          {@const all = data.variants}
          {#each all as x, i (i)}
            <button type="button" onclick={() => pickVariant(i)} aria-pressed={variant === i} class={chip(variant === i)}>
              {variantLabel(x, all)}
            </button>
          {/each}
        {/if}
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
    {:else if !v}
      <p class="px-6 py-10 text-center text-[13.5px] text-text-faint">Linia nie kursuje dziś według rozkładu.</p>
    {:else}
      {@const cur = v}
      {#if data.variants.length === 1}
        <p class="px-6 pb-1 text-[12.5px] text-text-faint">{variantLabel(cur, data.variants)}</p>
      {/if}
      <ol class="px-2">
        {#each cur.stops as s, p (`${variant}-${p}`)}
          {@const first = cur.times[0]}
          {@const expanded = open === p}
          {@const stop = expanded ? resolveStop(s.id) : null}
          <li>
            <button
              type="button"
              onclick={() => (open = expanded ? null : p)}
              aria-expanded={expanded}
              class="tap flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-tint/5 active:bg-tint/8"
            >
              <span class="w-12 shrink-0 text-right text-[12px] tabular-nums text-text-faint">
                {p === 0 ? "start" : `+${first[p] - first[0]} min`}
              </span>
              <span class="min-w-0 flex-1 truncate text-[14px] {expanded ? 'font-semibold' : ''} text-text">
                {displayStopName(s.name)}
              </span>
              <Icon
                icon={CaretDownIcon}
                class="shrink-0 text-text-faint transition-transform {expanded ? 'rotate-180' : ''}"
              />
            </button>
            {#if expanded}
              <div class="px-4 pb-3 pt-1">
                {#if p === cur.stops.length - 1}
                  <p class="text-[12.5px] text-text-faint">Przystanek końcowy, przyjazdy:</p>
                {/if}
                {@render hourGrid(column, nowMin)}
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
