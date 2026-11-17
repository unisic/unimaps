<script lang="ts">
  import { quintOut } from "svelte/easing";
  import { fly } from "svelte/transition";

  import Icon from "@/components/Icon.svelte";
  import { PersonSimpleWalkIcon } from "@/components/icon-paths";
  import { delayClass, delayTxt, minsToLeave, operatorColor } from "@/lib/client/format";
  import { journeySegments } from "@/lib/client/journey";
  import { prefersReducedMotion } from "@/lib/client/motion";
  import type { ConnectionItinerary } from "@/lib/client/types";

  /** One journey at a glance; spans only, so it fits inside a button: the clock times and the wait to leave, the
   *  journey as a strip (rides in their line colours, walks, waits; widths by minutes), the totals. The result card and
   *  JourneyView's header share it. */
  let {
    it,
    delays,
    now,
    live,
    dayLabel,
  }: {
    it: ConnectionItinerary;
    /** each leg's live delay (s, null = none) */
    delays: readonly (number | null)[];
    /** seconds since midnight */
    now: number;
    /** the journey runs today, so a countdown means something */
    live: boolean;
    dayLabel?: string;
  } = $props();

  const legs = $derived(it.legs);
  const board = $derived(legs[0]);
  const alight = $derived(legs[legs.length - 1]);
  const mins = $derived(live ? minsToLeave(it.departureSecs + (delays[0] ?? 0), now) : null);
  const segments = $derived(journeySegments(it));
  const walk = $derived(it.walkMinutes ?? segments.reduce((a, s) => a + (s.kind === "walk" ? s.mins : 0), 0));
  const xfers = $derived(it.transfersCount === 1 ? "1 przesiadka" : it.transfersCount < 5 ? `${it.transfersCount} przesiadki` : `${it.transfersCount} przesiadek`);
  // the new minute drops in from above, like a departure board; local to the {#key}, so a card's own entrance skips it
  const tick = () => ({ y: "-60%", duration: prefersReducedMotion() ? 0 : 240, easing: quintOut });
</script>

<span class="block">
  <span class="flex items-end justify-between gap-3">
    <span class="flex min-w-0 items-baseline gap-1.5 tabular-nums">
      <span class="text-[19px] font-semibold tracking-tight text-text">{board?.departureTime ?? it.departureTime}</span>
      <span class="text-[13px] text-text-faint" aria-hidden="true">→</span>
      <span class="sr-only">przyjazd</span>
      <span class="text-[15px] font-medium text-text-mute">{alight?.arrivalTime ?? it.arrivalTime}</span>
      {#if it.arrivesNextDay}<span class="text-[12px] font-medium text-late" title="Przyjazd następnego dnia">+1 d.</span>{/if}
    </span>
    <span class="shrink-0 text-right leading-none">
      {#if mins != null}
        <span class="text-[11px] text-text-mute">{it.accessWalkMins ? (mins ? "wyjdź za" : "wyjdź") : mins ? "za" : ""}</span>
        {#key mins}
          <span in:fly={tick()} class="inline-block text-[24px] font-semibold tracking-tight tabular-nums text-primary"
            >{mins === 0 ? "teraz" : mins}</span
          >
        {/key}
        {#if mins > 0}<span class="text-[12px] font-semibold text-primary">min</span>{/if}
      {:else if dayLabel && dayLabel !== "Dziś"}
        <span class="text-[12px] font-medium text-text-mute">{dayLabel}</span>
      {/if}
    </span>
  </span>

  <!-- the strip draws in left to right, the way the journey goes (.journey-strip) -->
  <span class="journey-strip mt-2.5 flex h-[22px] gap-[3px]">
    {#each segments as s, i (i)}
      {#if s.kind === "ride"}
        <span
          class="flex min-w-[34px] items-center justify-center overflow-hidden rounded-md px-1 text-[12px] font-semibold tabular-nums text-white"
          style:flex-grow={s.mins}
          style:background={operatorColor(s.leg.operator, s.leg.line)}
          title="Linia {s.leg.line}, {s.mins} min">{s.leg.line}</span
        >
      {:else if s.kind === "walk"}
        <span
          class="flex min-w-[20px] items-center justify-center rounded-md bg-tint/8 text-[12px] text-text-mute"
          style:flex-grow={s.mins}
          title="Pieszo {s.mins} min"><Icon icon={PersonSimpleWalkIcon} /></span
        >
      {:else}
        <span class="min-w-1 rounded-md bg-tint/4" style:flex-grow={s.mins} title="Czekasz {s.mins} min"></span>
      {/if}
    {/each}
  </span>

  <span class="mt-2 flex items-center gap-1.5 text-[12px] tabular-nums text-text-mute">
    <span class="font-medium text-text">{it.totalDurationMins} min</span>
    <span aria-hidden="true">·</span>
    <span>{it.transfersCount ? xfers : "bez przesiadek"}</span>
    {#if walk > 0}
      <span aria-hidden="true">·</span>
      <span>{walk} min pieszo</span>
    {/if}
    {#if delays[0] != null}
      <span class="ml-auto font-medium {delayClass(delays[0])}">{delayTxt(delays[0])}</span>
    {/if}
  </span>
</span>
