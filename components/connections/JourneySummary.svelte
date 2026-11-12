<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { CaretRightIcon, PersonSimpleWalkIcon } from "@/components/icon-paths";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import { delayClass, delayTxt, minsToLeave } from "@/lib/client/format";
  import type { ConnectionItinerary } from "@/lib/client/types";

  /** One journey at a glance, as jakdojade lays it out; spans only, so it fits inside a button: the wait to leave, the lines, walk / board / ride /
   *  alight, the whole duration. The result card and JourneyView's header share it. */
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
  const ride = $derived(board && alight ? Math.round((alight.arrivalSecs - board.departureSecs) / 60) : null);
  const PILL = "rounded-md px-1.5 py-px font-semibold tabular-nums text-bg";
</script>

<span class="flex items-start gap-3">
  <span class="block w-[74px] shrink-0 leading-none">
    {#if mins != null}
      <span class="block text-[11px] text-text-mute">{it.accessWalkMins ? "Wyjdź za:" : "Odjazd za:"}</span>
      {#if mins === 0}
        <span class="mt-1 block text-[24px] font-semibold tracking-tight text-text">teraz</span>
      {:else}
        <span class="mt-1 inline-block text-[30px] font-semibold tracking-tight tabular-nums text-text">{mins}</span><span
          class="text-[13px] font-semibold text-text">&nbsp;min</span
        >
      {/if}
    {:else}
      <span class="block text-[11px] text-text-mute">{dayLabel && dayLabel !== "Dziś" ? dayLabel : "Odjazd"}</span>
      <span class="mt-1 block text-[24px] font-semibold tracking-tight tabular-nums text-text">{it.departureTime}</span>
    {/if}
    {#if delays[0] != null}
      <span class="mt-1 block text-[11px] font-medium tabular-nums {delayClass(delays[0])}">{delayTxt(delays[0])}</span>
    {/if}
  </span>

  <span class="block min-w-0 flex-1">
    <span class="flex flex-wrap items-center gap-1">
      {#each legs as leg, i (i)}
        {#if i > 0}<Icon icon={CaretRightIcon} class="text-[11px] text-text-faint" />{/if}
        <LineBadge line={leg.line} operator={leg.operator} />
      {/each}
    </span>
    <span class="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] tabular-nums text-text-mute">
      {#if it.accessWalkMins}
        <span class="inline-flex items-center gap-0.5"
          ><Icon icon={PersonSimpleWalkIcon} class="text-[13px]" />{it.accessWalkMins} min</span
        >
      {/if}
      <span class="{PILL} bg-good" title="Odjazd">{board?.departureTime ?? it.departureTime}</span>
      {#if ride != null}<span>{ride} min</span>{/if}
      <span class="{PILL} bg-primary" title="Przyjazd">{alight?.arrivalTime ?? it.arrivalTime}</span>
      {#if it.arrivesNextDay}<span class="font-medium text-late" title="Przyjazd następnego dnia">+1 d.</span>{/if}
      {#if it.egressWalkMins}
        <span class="inline-flex items-center gap-0.5"
          ><Icon icon={PersonSimpleWalkIcon} class="text-[13px]" />{it.egressWalkMins} min</span
        >
      {/if}
    </span>
  </span>

  <span class="shrink-0 pt-0.5 text-[13px] tabular-nums text-text-mute">{it.totalDurationMins} min</span>
</span>
