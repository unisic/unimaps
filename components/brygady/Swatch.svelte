<script lang="ts">
  let { color, hatched = false }: { color: string; hatched?: boolean } = $props();
</script>

<span
  aria-hidden="true"
  class="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
  style:background={hatched ? undefined : color}
  style:background-image={hatched ? `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 5px)` : undefined}
  style:box-shadow={hatched ? `inset 0 0 0 1px ${color}` : undefined}
></span>
