<script lang="ts">
  import type { DelayClass, FleetTimelinePoint } from "@/lib/shared/fleet";

  import { AXIS, GRID, hourStep, measured, niceCeil, TICK_TEXT, WAITING_HATCH } from "./charts";
  import { clockFromSecs, DELAY_FILL, DELAY_LABEL, DELAY_ORDER, SURFACE } from "./common";
  import DelayLegend from "./DelayLegend.svelte";
  import { useElementWidth } from "./hooks.svelte";
  import Swatch from "./Swatch.svelte";

  /* ── fleet punctuality through the day (stacked area) ────────────────────── */

  type TimelineMode = "count" | "share";

  const TL_H = 230;
  const TL_M = { l: 36, r: 10, t: 12, b: 24 };

  let {
    points,
    slotSecs,
    fleetName = "MZK",
  }: {
    points: FleetTimelinePoint[];
    slotSecs: number;
    /** the operator in the chart's accessible title */
    fleetName?: string;
  } = $props();

  const box = useElementWidth();
  let mode = $state<TimelineMode>("count");
  let hover = $state<number | null>(null);
  let keyboard = $state(false);
  const titleId = $props.id();

  const width = $derived(box.width);

  const geo = $derived.by(() => {
    if (width <= 0 || points.length === 0) return null;
    const innerW = Math.max(10, width - TL_M.l - TL_M.r);
    const innerH = TL_H - TL_M.t - TL_M.b;
    const first = points[0].t;
    const last = points[points.length - 1].t + slotSecs;
    let x0 = Math.floor(first / 3600) * 3600;
    const x1 = Math.min(86400, Math.ceil(last / 3600) * 3600);
    if (x1 - x0 < 3 * 3600) x0 = Math.max(0, x1 - 3 * 3600);
    const sx = (t: number) => TL_M.l + ((t - x0) / (x1 - x0)) * innerW;
    const yScale = mode === "share" ? { max: 100, step: 25 } : niceCeil(Math.max(1, ...points.map(measured)));
    const sy = (v: number) => TL_M.t + innerH - (v / yScale.max) * innerH;

    const values = (p: FleetTimelinePoint): number[] => {
      const raw = DELAY_ORDER.map((k) => p[k]);
      if (mode === "count") return raw;
      const m = measured(p);
      return raw.map((v) => (m > 0 ? (v / m) * 100 : 0));
    };

    // contiguous runs; a missing slot (night, server down) is a gap, never interpolated
    const runs: FleetTimelinePoint[][] = [];
    let run: FleetTimelinePoint[] = [];
    for (const p of points) {
      const prev = run[run.length - 1];
      const usable = mode === "count" || measured(p) > 0;
      if (!usable || (prev && p.t - prev.t > slotSecs * 1.5)) {
        if (run.length) runs.push(run);
        run = [];
      }
      if (usable) run.push(p);
    }
    if (run.length) runs.push(run);

    const layers: { key: DelayClass; d: string; edge: string }[] = [];
    DELAY_ORDER.forEach((key, k) => {
      let d = "";
      let edge = "";
      for (const r of runs) {
        // samples sit mid-slot; a lone sample is drawn as one slot wide
        const xs = r.length === 1 ? [r[0].t, r[0].t + slotSecs] : r.map((p) => p.t + slotSecs / 2);
        const pts = r.length === 1 ? [r[0], r[0]] : r;
        const top = pts.map((p) => values(p).slice(0, k + 1).reduce((a, b) => a + b, 0));
        const bot = pts.map((p) => values(p).slice(0, k).reduce((a, b) => a + b, 0));
        const fwd = xs.map((t, i) => `${sx(t).toFixed(1)},${sy(top[i]).toFixed(1)}`);
        const back = xs.map((t, i) => `${sx(t).toFixed(1)},${sy(bot[i]).toFixed(1)}`).reverse();
        d += `M${fwd.join("L")}L${back.join("L")}Z`;
        if (k < DELAY_ORDER.length - 1) edge += `M${fwd.join("L")}`;
      }
      layers.push({ key, d, edge });
    });

    const yTicks: number[] = [];
    for (let v = 0; v <= yScale.max + 1e-9; v += yScale.step) yTicks.push(v);
    const pxPerHour = innerW / ((x1 - x0) / 3600);
    const hs = hourStep(pxPerHour);
    const xTicks: number[] = [];
    for (let t = Math.ceil(x0 / (hs * 3600)) * hs * 3600; t <= x1; t += hs * 3600) xTicks.push(t);

    return { innerW, innerH, x0, x1, sx, sy, layers, yTicks, xTicks, unit: mode === "share" ? "%" : "" };
  });

  function pick(clientX: number, target: Element) {
    if (!geo) return;
    const rect = target.getBoundingClientRect();
    const t = geo.x0 + ((clientX - rect.left - TL_M.l) / geo.innerW) * (geo.x1 - geo.x0);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].t + slotSecs / 2 - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    hover = best >= 0 && bestD <= slotSecs ? best : null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (points.length === 0) return;
    const cur = hover ?? points.length - 1;
    let next: number | null = cur;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(points.length - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = points.length - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    keyboard = true;
    hover = next;
  }

  const hp = $derived(hover !== null ? points[hover] : null);
  const hx = $derived(hp && geo ? geo.sx(hp.t + slotSecs / 2) : 0);

  /** The same data, hour by hour, for readers who do not hover (and screen readers). */
  const tableRows = $derived.by(() => {
    const byHour = new Map<number, { n: number; total: number; m: number; early: number; onTime: number; late: number }>();
    for (const p of points) {
      const h = Math.floor(p.t / 3600);
      const r = byHour.get(h) ?? { n: 0, total: 0, m: 0, early: 0, onTime: 0, late: 0 };
      const m = measured(p);
      r.n++;
      r.total += m + p.waiting;
      r.m += m;
      r.early += p.early;
      r.onTime += p.onTime;
      r.late += p.late + p.veryLate;
      byHour.set(h, r);
    }
    return [...byHour.entries()].sort((a, b) => b[0] - a[0]);
  });
  const pct = (v: number, m: number) => (m > 0 ? `${Math.round((v / m) * 100)}%` : "–");
</script>

{#snippet timelineTooltip(p: FleetTimelinePoint)}
  {@const m = measured(p)}
  <div class="mb-1.5 flex items-baseline justify-between gap-2">
    <span class="font-semibold text-text tabular-nums">
      {clockFromSecs(p.t)}–{clockFromSecs(p.t + slotSecs)}
    </span>
    <span class="text-text-mute tabular-nums">{m + p.waiting} w trasie</span>
  </div>
  <ul class="space-y-1">
    {#each [...DELAY_ORDER].reverse() as k (k)}
      <li class="flex items-center gap-2">
        <Swatch color={DELAY_FILL[k]} />
        <span class="flex-1 text-text-mute">{DELAY_LABEL[k]}</span>
        <span class="font-semibold text-text tabular-nums">{p[k]}</span>
        <span class="w-9 text-right text-text-mute tabular-nums">{m > 0 ? `${Math.round((p[k] / m) * 100)}%` : "–"}</span>
      </li>
    {/each}
    {#if p.waiting > 0}
      <li class="flex items-center gap-2 border-t border-hairline pt-1">
        <Swatch color={WAITING_HATCH} hatched />
        <span class="flex-1 text-text-mute">Czeka na odjazd</span>
        <span class="font-semibold text-text tabular-nums">{p.waiting}</span>
        <span class="w-9"></span>
      </li>
    {/if}
  </ul>
{/snippet}

<div>
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <DelayLegend />
    <div role="group" aria-label="Skala wykresu" class="flex rounded-lg bg-surface-2 p-0.5 text-[12px] font-medium">
      {#each [["count", "Liczba pojazdów"], ["share", "Udział %"]] as const as [m, label] (m)}
        <button
          type="button"
          aria-pressed={mode === m}
          onclick={() => (mode = m)}
          class="min-h-8 rounded-md px-2.5 transition-colors {mode === m ? 'bg-surface-3 text-text' : 'text-text-mute hover:text-text'}"
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  <div {@attach box.observe} class="relative w-full select-none" style:height="{TL_H}px">
    {#if geo}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <!-- a focusable chart: the arrow keys move the cursor through the samples (role img keeps it one stop for readers) -->
      <svg
        {width}
        height={TL_H}
        role="img"
        aria-labelledby={titleId}
        tabindex="0"
        onkeydown={onKeyDown}
        onfocus={() => (keyboard = true)}
        onblur={() => {
          keyboard = false;
          hover = null;
        }}
        class="block rounded-lg"
        style:touch-action="pan-y"
      >
        <title id={titleId}>
          {mode === "count"
            ? `Pojazdy ${fleetName} w trasie według punktualności, w ciągu dnia. Strzałki przesuwają kursor.`
            : `Udział pojazdów ${fleetName} według punktualności, w ciągu dnia. Strzałki przesuwają kursor.`}
        </title>
        {#each geo.yTicks as v (v)}
          <g>
            <line x1={TL_M.l} x2={TL_M.l + geo.innerW} y1={geo.sy(v)} y2={geo.sy(v)} stroke={v === 0 ? AXIS : GRID} />
            <text x={TL_M.l - 6} y={geo.sy(v)} dy="0.32em" text-anchor="end" font-size="11" fill={TICK_TEXT} class="tabular-nums">
              {v}{geo.unit}
            </text>
          </g>
        {/each}
        {#each geo.xTicks as t (t)}
          <text x={geo.sx(t)} y={TL_H - 6} text-anchor={t >= geo.x1 ? "end" : "middle"} font-size="11" fill={TICK_TEXT} class="tabular-nums">
            {clockFromSecs(t)}
          </text>
        {/each}
        {#each geo.layers as l (l.key)}
          <path d={l.d} fill={DELAY_FILL[l.key]} />
        {/each}
        {#each geo.layers as l (`e-${l.key}`)}
          {#if l.edge}<path d={l.edge} fill="none" stroke={SURFACE} stroke-width={1.5} stroke-linejoin="round" />{/if}
        {/each}
        {#if hp}
          <line x1={hx} x2={hx} y1={TL_M.t} y2={TL_M.t + geo.innerH} stroke="#e8eaed" stroke-width={1} stroke-dasharray="3 3" />
        {/if}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- pointer-only hover surface; the svg's arrow keys are its keyboard path -->
        <rect
          x={TL_M.l}
          y={TL_M.t}
          width={geo.innerW}
          height={geo.innerH}
          fill="transparent"
          onpointermove={(e) => {
            keyboard = false;
            pick(e.clientX, e.currentTarget.ownerSVGElement ?? e.currentTarget);
          }}
          onpointerdown={(e) => pick(e.clientX, e.currentTarget.ownerSVGElement ?? e.currentTarget)}
          onpointerleave={() => (hover = null)}
        />
      </svg>
    {:else}
      <div class="skeleton h-full w-full"></div>
    {/if}
    {#if hp && geo}
      <div
        class="pointer-events-none absolute top-2 w-[13.5rem] rounded-xl border border-hairline bg-surface-2 p-3 text-[12px] shadow-[var(--shadow-float)]"
        style:left="{hx > width / 2 ? Math.max(0, hx - 12 - 216) : Math.min(width - 216, hx + 12)}px"
        aria-live={keyboard ? "polite" : undefined}
      >
        {@render timelineTooltip(hp)}
      </div>
    {/if}
  </div>
  {#if tableRows.length > 0}
    <details class="group mt-3">
      <summary
        class="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-[12.5px] font-medium text-text-mute hover:text-text [&::-webkit-details-marker]:hidden"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" class="transition-transform group-open:rotate-90">
          <path d="m9 6 6 6-6 6" />
        </svg>
        Tabela godzinowa
      </summary>
      <div class="kb-scroll mt-2 max-h-72 overflow-auto rounded-lg border border-hairline">
        <table class="w-full text-left text-[12.5px] tabular-nums">
          <thead class="sticky top-0 bg-surface-2 text-text-mute">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">Godzina</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">W trasie (śr.)</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">Punktualnie</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">Opóźnione</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">Przed czasem</th>
            </tr>
          </thead>
          <tbody>
            {#each tableRows as [h, r] (h)}
              <tr class="border-t border-hairline">
                <th scope="row" class="px-3 py-1.5 font-medium text-text">
                  {clockFromSecs(h * 3600)}–{clockFromSecs((h + 1) * 3600)}
                </th>
                <td class="px-3 py-1.5 text-right text-text">{Math.round(r.total / r.n)}</td>
                <td class="px-3 py-1.5 text-right text-text">{pct(r.onTime, r.m)}</td>
                <td class="px-3 py-1.5 text-right text-text">{pct(r.late, r.m)}</td>
                <td class="px-3 py-1.5 text-right text-text">{pct(r.early, r.m)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  {/if}
</div>
