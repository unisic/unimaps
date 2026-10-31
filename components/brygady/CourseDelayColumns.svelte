<script lang="ts">
  /** Delay of each measured course of one vehicle, in driving order. */
  import { classifyDelay } from "@/lib/shared/fleet";

  import { AXIS, columnPath, fmtMinTick, GRID, niceCeil, TICK_TEXT, type DelayColumn } from "./charts";
  import { DELAY_FILL } from "./common";
  import { useElementWidth } from "./hooks.svelte";

  const CD_H = 160;
  const CD_M = { l: 40, r: 8, t: 18, b: 24 };

  let { columns }: { columns: DelayColumn[] } = $props();

  const box = useElementWidth();
  let hover = $state<number | null>(null);
  const titleId = $props.id();

  const width = $derived(box.width);

  const geo = $derived.by(() => {
    if (width <= 0 || columns.length === 0) return null;
    const innerW = Math.max(10, width - CD_M.l - CD_M.r);
    const innerH = CD_H - CD_M.t - CD_M.b;
    const mins = columns.map((c) => c.delaySec / 60);
    const hi = Math.max(0, ...mins);
    const lo = Math.min(0, ...mins);
    const { step } = niceCeil(Math.max(1, hi, -lo));
    let top = Math.ceil(hi / step) * step;
    const bottom = Math.floor(lo / step) * step;
    if (top === bottom) top = step;
    const sy = (v: number) => CD_M.t + ((top - v) / (top - bottom)) * innerH;
    const slot = innerW / columns.length;
    const barW = Math.min(24, Math.max(4, slot * 0.6));
    const ticks: number[] = [];
    for (let v = bottom; v <= top + 1e-9; v += step) ticks.push(v);
    const every = Math.max(1, Math.ceil(40 / slot));
    // direct labels only where they stay readable: all of them for a short day, else the extremes
    const iMax = mins.indexOf(Math.max(...mins));
    const iMin = mins.indexOf(Math.min(...mins));
    const labelled = new Set(columns.length <= 12 && slot >= 28 ? columns.map((_, i) => i) : [iMax, iMin]);
    return { innerW, innerH, sy, slot, barW, ticks, every, mins, labelled };
  });

  function onKeyDown(e: KeyboardEvent) {
    const cur = hover ?? columns.length - 1;
    let next: number | null = cur;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(columns.length - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = columns.length - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    hover = next;
  }

  const hc = $derived(hover !== null ? columns[hover] : null);
  const hx = $derived(geo && hover !== null ? CD_M.l + geo.slot * (hover + 0.5) : 0);
</script>

<div {@attach box.observe} class="relative w-full select-none" style:height="{CD_H}px">
  {#if geo}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <!-- a focusable chart: the arrow keys move the selection through the courses (role img keeps it one stop for readers) -->
    <svg
      {width}
      height={CD_H}
      role="img"
      aria-labelledby={titleId}
      tabindex="0"
      onkeydown={onKeyDown}
      onblur={() => (hover = null)}
      class="block rounded-lg"
      style:touch-action="pan-y"
    >
      <title id={titleId}>Opóźnienie na kolejnych kursach w minutach. Strzałki przesuwają wybór.</title>
      {#each geo.ticks as v (v)}
        <g>
          <line x1={CD_M.l} x2={CD_M.l + geo.innerW} y1={geo.sy(v)} y2={geo.sy(v)} stroke={v === 0 ? AXIS : GRID} />
          <text x={CD_M.l - 6} y={geo.sy(v)} dy="0.32em" text-anchor="end" font-size="11" fill={TICK_TEXT} class="tabular-nums">
            {fmtMinTick(v)}
          </text>
        </g>
      {/each}
      <text x={CD_M.l - 6} y={CD_M.t - 8} text-anchor="end" font-size="10.5" fill={TICK_TEXT}>min</text>
      {#each columns as c, i (c.id)}
        {@const x = CD_M.l + geo.slot * i + (geo.slot - geo.barW) / 2}
        {@const v = geo.mins[i]}
        {@const y0 = geo.sy(0)}
        {@const y1 = geo.sy(v)}
        {@const d = columnPath(x, geo.barW, y0, y1)}
        <g>
          {#if hover === i}
            <rect x={CD_M.l + geo.slot * i} y={CD_M.t} width={geo.slot} height={geo.innerH} fill="rgba(255,255,255,0.05)" />
          {/if}
          {#if d}
            <path d={d} fill={DELAY_FILL[classifyDelay(c.delaySec)]} stroke={c.live ? "#e8eaed" : "none"} stroke-width={c.live ? 1.5 : 0} />
          {:else}
            <line x1={x} x2={x + geo.barW} y1={y0} y2={y0} stroke={DELAY_FILL.onTime} stroke-width={2} />
          {/if}
          {#if geo.labelled.has(i)}
            <text
              x={x + geo.barW / 2}
              y={v >= 0 ? Math.min(y1, y0) - 4 : Math.max(y1, y0) + 12}
              text-anchor="middle"
              font-size="10.5"
              font-weight={600}
              fill="#9aa0a6"
              class="tabular-nums"
            >
              {fmtMinTick(Math.round(v))}
            </text>
          {/if}
          {#if i % geo.every === 0}
            <text x={x + geo.barW / 2} y={CD_H - 6} text-anchor="middle" font-size="10.5" fill={TICK_TEXT} class="tabular-nums">
              {c.label}
            </text>
          {/if}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- pointer-only hover surface; the svg's arrow keys are its keyboard path -->
          <rect
            x={CD_M.l + geo.slot * i}
            y={CD_M.t}
            width={geo.slot}
            height={geo.innerH + CD_M.b}
            fill="transparent"
            onpointerenter={() => (hover = i)}
            onpointerdown={() => (hover = i)}
            onpointerleave={() => {
              if (hover === i) hover = null;
            }}
          />
        </g>
      {/each}
    </svg>
  {:else}
    <div class="skeleton h-full w-full"></div>
  {/if}
  {#if hc && geo}
    <div
      class="pointer-events-none absolute top-0 z-10 w-max max-w-[15rem] rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-text shadow-[var(--shadow-float)]"
      style:right={hx > width / 2 ? `${Math.max(0, width - hx + 12)}px` : undefined}
      style:left={hx > width / 2 ? undefined : `${hx + 12}px`}
    >
      {hc.title}
    </div>
  {/if}
</div>
