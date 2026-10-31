<script lang="ts">
  import { SERIES_FILL, TRACK_FILL } from "./common";
  import Swatch from "./Swatch.svelte";

  let { partLabel, restLabel }: { partLabel: string; restLabel: string } = $props();
</script>

<ul class="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-mute">
  <li class="flex items-center gap-1.5">
    <Swatch color={SERIES_FILL} />
    {partLabel}
  </li>
  <li class="flex items-center gap-1.5">
    <Swatch color={TRACK_FILL} />
    {restLabel}
  </li>
</ul>
