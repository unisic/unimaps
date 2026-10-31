<script lang="ts">
  import { classifyDelay } from "@/lib/shared/fleet";

  import { CANCELLED_HATCH, ganttEnd, ganttLabel, GRID, hourStep, TICK_TEXT, WAITING_HATCH, type GanttCourse } from "./charts";
  import { clockFromSecs, DELAY_FILL, SURFACE } from "./common";
  import HatchPattern from "./HatchPattern.svelte";
  import { useElementWidth } from "./hooks.svelte";

  const GT_H = 64;
  const GT_BAR_Y = 20;
  const GT_BAR_H = 20;

  let {
    courses,
    nowSecs,
    onSelect,
  }: {
    courses: GanttCourse[];
    nowSecs: number;
    onSelect?: (courseId: string) => void;
  } = $props();

  const box = useElementWidth();
  let hover = $state<string | null>(null);
  const uid = $props.id();

  const width = $derived(box.width);

  const geo = $derived.by(() => {
    if (width <= 0 || courses.length === 0) return null;
    const starts = courses.map((c) => c.course.startSecs);
    const ends = courses.map(ganttEnd);
    let x0 = Math.floor(Math.min(...starts) / 3600) * 3600;
    const x1 = Math.min(86400 + 3 * 3600, Math.ceil(Math.max(...ends, nowSecs) / 3600) * 3600);
    if (x1 - x0 < 2 * 3600) x0 = Math.max(0, x1 - 2 * 3600);
    const innerW = Math.max(10, width - 8);
    const sx = (t: number) => 4 + ((t - x0) / (x1 - x0)) * innerW;
    const hs = hourStep(innerW / ((x1 - x0) / 3600));
    const ticks: number[] = [];
    for (let t = Math.ceil(x0 / (hs * 3600)) * hs * 3600; t <= x1; t += hs * 3600) ticks.push(t);

    const sorted = [...courses].sort((a, b) => a.course.startSecs - b.course.startSecs);
    let labelEnd = -Infinity;
    const bars = sorted.map((c) => {
      const xa = sx(c.course.startSecs);
      const xb = Math.max(xa + 3, sx(ganttEnd(c)));
      const cx = (xa + xb) / 2;
      const label = c.course.lineName;
      const lw = label.length * 7 + 4;
      const showLabel = cx - lw / 2 > labelEnd + 2;
      if (showLabel) labelEnd = cx + lw / 2;
      return { c, xa, xb, cx, showLabel };
    });
    // after midnight "now" sits on the axis past 86400 when a course runs there
    const nowT = nowSecs < x0 && nowSecs + 86400 <= x1 ? nowSecs + 86400 : nowSecs;
    return { sx, ticks, bars, x0, x1, nowT };
  });

  const hovered = $derived(geo?.bars.find((b) => b.c.course.id === hover) ?? null);
</script>

<div {@attach box.observe} class="relative w-full select-none" style:height="{GT_H}px">
  {#if geo}
    <svg {width} height={GT_H} aria-hidden="true" class="block overflow-visible">
      <defs>
        <HatchPattern id="{uid}-x" color={CANCELLED_HATCH} bg="rgba(245,204,92,0.12)" />
        <HatchPattern id="{uid}-w" color={WAITING_HATCH} bg="rgba(131,141,150,0.12)" />
      </defs>
      <line x1={4} x2={width - 4} y1={GT_BAR_Y + GT_BAR_H / 2} y2={GT_BAR_Y + GT_BAR_H / 2} stroke={GRID} stroke-width={2} />
      {#each geo.ticks as t (t)}
        <g>
          <line x1={geo.sx(t)} x2={geo.sx(t)} y1={GT_BAR_Y - 4} y2={GT_BAR_Y + GT_BAR_H + 4} stroke={GRID} />
          <text x={geo.sx(t)} y={GT_H - 4} text-anchor="middle" font-size="11" fill={TICK_TEXT} class="tabular-nums">
            {clockFromSecs(t)}
          </text>
        </g>
      {/each}
      {#each geo.bars as { c, xa, xb, cx, showLabel } (c.course.id)}
        {@const fill =
          c.course.status === "cancelled" ? `url(#${uid}-x)` : c.notStarted ? `url(#${uid}-w)` : DELAY_FILL[classifyDelay(c.course.delaySec)]}
        <g>
          {#if showLabel}
            <text x={cx} y={GT_BAR_Y - 7} text-anchor="middle" font-size="11" font-weight={600} fill="#9aa0a6">
              {c.course.lineName}
            </text>
          {/if}
          <rect
            x={xa}
            y={GT_BAR_Y}
            width={xb - xa}
            height={GT_BAR_H}
            rx={3}
            {fill}
            stroke={c.live ? "#e8eaed" : SURFACE}
            stroke-width={c.live ? 1.5 : 2}
          />
        </g>
      {/each}
      {#if geo.nowT >= geo.x0 && geo.nowT <= geo.x1}
        <line
          x1={geo.sx(geo.nowT)}
          x2={geo.sx(geo.nowT)}
          y1={GT_BAR_Y - 6}
          y2={GT_BAR_Y + GT_BAR_H + 6}
          stroke="#5ccbe3"
          stroke-width={2}
          stroke-linecap="round"
        />
      {/if}
    </svg>
  {:else}
    <div class="skeleton h-full w-full"></div>
  {/if}
  <!-- hit targets: taller than the bars, real buttons (keyboard + screen readers) -->
  {#each geo?.bars ?? [] as { c, xa, xb } (c.course.id)}
    <button
      type="button"
      class="absolute rounded-md focus-visible:outline-2"
      style:left="{xa - 2}px"
      style:width="{Math.max(14, xb - xa + 4)}px"
      style:top="{GT_BAR_Y - 6}px"
      style:height="{GT_BAR_H + 12}px"
      aria-label={ganttLabel(c)}
      onpointerenter={() => (hover = c.course.id)}
      onpointerleave={() => {
        if (hover === c.course.id) hover = null;
      }}
      onfocus={() => (hover = c.course.id)}
      onblur={() => {
        if (hover === c.course.id) hover = null;
      }}
      onclick={() => onSelect?.(c.course.id)}
    ></button>
  {/each}
  {#if hovered}
    <div
      class="pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-[16rem] rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-text shadow-[var(--shadow-float)]"
      style:left="{Math.min(Math.max(0, hovered.cx - 100), Math.max(0, width - 220))}px"
    >
      {ganttLabel(hovered.c)}
    </div>
  {/if}
</div>
