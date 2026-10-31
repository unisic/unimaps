<script lang="ts">
  import type { BarRow } from "./charts";
  import { SERIES_FILL, TRACK_FILL } from "./common";

  let {
    rows,
    max,
    restColor = TRACK_FILL,
    labelClassName = "w-28 sm:w-40",
  }: {
    rows: BarRow[];
    max?: number;
    restColor?: string;
    labelClassName?: string;
  } = $props();

  const top = $derived(max ?? Math.max(1, ...rows.map((r) => r.value)));
</script>

{#snippet body(r: BarRow)}
  {@const w = top > 0 ? (r.value / top) * 100 : 0}
  {@const partW = r.part !== undefined && r.value > 0 ? (r.part / r.value) * 100 : 100}
  {@const color = r.color ?? SERIES_FILL}
  <span class="flex min-w-0 shrink-0 flex-col text-left text-[12.5px] text-text-mute {labelClassName}">
    {#if typeof r.label === "string"}
      <span class="truncate">{r.label}</span>
    {:else}
      <span class="truncate {r.label.class}">{r.label.text}</span>
      {#if r.label.sub !== undefined}<span class="truncate text-[11.5px] text-text-faint">{r.label.sub}</span>{/if}
    {/if}
  </span>
  <span class="relative flex h-3.5 flex-1 items-center" aria-hidden="true">
    <span class="flex h-full overflow-hidden rounded-r" style:width="{Math.max(w, r.value > 0 ? 1 : 0)}%">
      {#if r.part === undefined}
        <span class="h-full w-full" style:background={color}></span>
      {:else}
        {#if r.part > 0}<span class="h-full" style:width="{partW}%" style:background={color}></span>{/if}
        {#if r.part < r.value}
          <span class="h-full flex-1" style:background={restColor} style:margin-left={r.part > 0 ? "2px" : "0px"}></span>
        {/if}
      {/if}
    </span>
  </span>
  <span class="min-w-[4.5rem] shrink-0 text-right text-[12.5px] text-text tabular-nums">{r.valueText}</span>
{/snippet}

<ul class="space-y-0.5">
  {#each rows as r (r.key)}
    <li>
      {#if r.onClick}
        <button
          type="button"
          onclick={r.onClick}
          title={r.title}
          aria-label={r.ariaLabel}
          class="flex min-h-8 w-full items-center gap-3 rounded-lg px-1.5 transition-colors hover:bg-tint/5"
        >
          {@render body(r)}
        </button>
      {:else}
        <div class="flex min-h-8 items-center gap-3 px-1.5" title={r.title} aria-label={r.ariaLabel}>
          {@render body(r)}
        </div>
      {/if}
    </li>
  {/each}
</ul>
