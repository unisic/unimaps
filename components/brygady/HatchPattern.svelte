<svelte:options namespace="svg" />

<script lang="ts">
  /** Hatched fill ids are per-SVG; this draws the pattern content. */
  let { id, color, bg = "transparent" }: { id: string; color: string; bg?: string } = $props();
</script>

<pattern {id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
  <rect width="6" height="6" fill={bg} />
  <rect width="2.2" height="6" fill={color} />
</pattern>
