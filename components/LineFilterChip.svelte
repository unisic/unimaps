<script lang="ts">
  /** Pill under the TopBar showing the active line filter: which lines are on
   *  and how many vehicles survive the filter. Tapping the body reopens the
   *  palette (to tweak lines), the X clears the filter. */
  import Icon from "@/components/Icon.svelte";
  import { XIcon } from "@/components/icon-paths";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import { wozPlural } from "@/lib/client/format";

  let {
    lines,
    visibleCount,
    onClear,
    onOpenPalette,
  }: {
    lines: string[];
    visibleCount: number;
    onClear: () => void;
    onOpenPalette: () => void;
  } = $props();
</script>

<div
  class="absolute left-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem+56px)] z-[1001] max-w-[calc(100vw-24px)] md:left-1/2 md:-translate-x-1/2 animate-drop"
>
  <div class="surface flex items-center gap-1 rounded-full py-1 pl-1.5 pr-1">
    <button
      type="button"
      onclick={onOpenPalette}
      aria-label="Zmień filtr linii"
      class="tap flex min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 hover:bg-tint/5"
    >
      <span class="flex min-w-0 items-center gap-1 overflow-hidden">
        {#each lines as l (l)}
          <LineBadge line={l} />
        {/each}
      </span>
      <span class="shrink-0 pr-1 text-[12px] tabular-nums text-text-mute">
        {visibleCount} {wozPlural(visibleCount)}
      </span>
    </button>
    <button
      type="button"
      onclick={onClear}
      aria-label="Wyczyść filtr linii"
      class="tap grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px] text-text-mute hover:bg-tint/8 hover:text-text"
    >
      <Icon icon={XIcon} />
    </button>
  </div>
</div>
