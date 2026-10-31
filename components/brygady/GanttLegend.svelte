<script lang="ts">
  /** Legend for the Gantt strip (classes + cancelled + waiting + now). */
  import { CANCELLED_HATCH, WAITING_HATCH } from "./charts";
  import { DELAY_FILL, DELAY_LABEL, DELAY_ORDER } from "./common";
  import Swatch from "./Swatch.svelte";

  let { showWaiting }: { showWaiting: boolean } = $props();
</script>

<ul class="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-text-mute">
  {#each DELAY_ORDER as k (k)}
    <li class="flex items-center gap-1.5">
      <Swatch color={DELAY_FILL[k]} />
      {DELAY_LABEL[k]}
    </li>
  {/each}
  <li class="flex items-center gap-1.5">
    <Swatch color={CANCELLED_HATCH} hatched />
    Przerwany
  </li>
  {#if showWaiting}
    <li class="flex items-center gap-1.5">
      <Swatch color={WAITING_HATCH} hatched />
      Czeka na odjazd
    </li>
  {/if}
  <li class="flex items-center gap-1.5">
    <span aria-hidden="true" class="inline-block h-3 w-0.5 rounded bg-primary"></span>
    Teraz
  </li>
</ul>
