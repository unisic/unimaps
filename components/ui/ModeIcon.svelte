<script lang="ts">
  /** Bus, tram, metro or trolleybus glyph at the font size (Phosphor has no trolleybus: its bus under two poles, as on the map pill). */
  import Icon from "@/components/Icon.svelte";
  import { BusIcon, SubwayIcon, TramIcon } from "@/components/icon-paths";
  import type { TransitMode } from "@/lib/client/format";

  let { mode, weight = "fill" }: { mode: TransitMode; weight?: "fill" | "bold" } = $props();
</script>

{#if mode === "tram"}
  <Icon icon={TramIcon} {weight} />
{:else if mode === "metro"}
  <Icon icon={SubwayIcon} {weight} />
{:else if mode === "bus"}
  <Icon icon={BusIcon} {weight} />
{:else}
  <svg width="1em" height="1em" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
    <g transform="translate(32 56) scale(0.75)">{@html BusIcon[weight]}</g>
    <path d="M108 80 76 16M148 80 116 16" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" />
  </svg>
{/if}
