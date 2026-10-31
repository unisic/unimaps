<script lang="ts">
  import type { IconDef } from "@/components/icon-paths";

  /* The one icon family of the app: Phosphor, as inline paths (components/icon-paths.ts, one export per
     glyph). Chrome uses the "bold" weight, "fill" marks an active state; sized to the font by default. */
  let {
    icon,
    weight = "bold",
    size = "1em",
    class: cls,
    color,
  }: { icon: IconDef; weight?: "bold" | "fill"; size?: string | number; class?: string; color?: string } = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 256 256"
  fill={color ?? "currentColor"}
  class={cls}
  aria-hidden="true">{@html icon[weight]}</svg>
