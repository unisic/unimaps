<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    label,
    onClick,
    children,
    pressed,
  }: {
    label: string;
    onClick: () => void;
    children: Snippet;
    /** for toggle buttons (adds aria-pressed and keeps the icon colored) */
    pressed?: boolean;
  } = $props();
</script>

<button
  type="button"
  onclick={onClick}
  aria-label={label}
  aria-pressed={pressed}
  class="tap grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] hover:bg-tint/8 hover:text-text md:h-9 md:w-9 {pressed
    ? 'text-primary'
    : 'text-text-mute'}"
>
  {@render children()}
</button>
