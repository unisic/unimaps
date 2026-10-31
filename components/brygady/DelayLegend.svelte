<script lang="ts">
  import { DELAY_FILL, DELAY_LABEL, DELAY_ORDER, DELAY_RANGE } from "./common";
  import Swatch from "./Swatch.svelte";
</script>

<ul class="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-text-mute">
  {#each DELAY_ORDER as k (k)}
    <li class="flex items-center gap-1.5" title={DELAY_RANGE[k]}>
      <Swatch color={DELAY_FILL[k]} />
      <span>{DELAY_LABEL[k]}</span>
      <span class="hidden text-text-faint sm:inline">({DELAY_RANGE[k]})</span>
    </li>
  {/each}
</ul>
