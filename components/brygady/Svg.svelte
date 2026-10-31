<script lang="ts">
  /** One inline icon of components/brygady/icons.ts, stroked in currentColor. */
  let { icon, size = 16, class: cls }: { icon: string; size?: number; class?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  class={cls}>{@html icon}</svg>
