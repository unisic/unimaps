<script lang="ts">
  import type { Snippet } from "svelte";

  import Icon from "@/components/Icon.svelte";
  import { CheckIcon } from "@/components/icon-paths";

  /* one card layout for every row: an icon, a bold name, a muted second line; `big` is the first-screen size */
  let {
    big = false,
    current = false,
    icon,
    name,
    sub,
    trailing,
    onClick,
  }: {
    big?: boolean;
    current?: boolean;
    icon: Snippet;
    name: string;
    sub: string;
    trailing?: Snippet;
    onClick: () => void;
  } = $props();
</script>

<button
  type="button"
  onclick={onClick}
  aria-current={current ? "true" : undefined}
  class={big
    ? "flex w-full items-center gap-4 rounded-2xl border border-hairline bg-surface p-4 text-left transition-colors hover:bg-surface-2"
    : `tap flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-tint/5 ${current ? "bg-tint/5" : ""}`}
>
  {@render icon()}
  <span class="flex min-w-0 flex-1 flex-col">
    <span class="font-semibold text-text {big ? 'text-base' : 'text-[13.5px]'}">{name}</span>
    <span class="text-text-mute {big ? 'text-sm' : 'text-[12px]'}">{sub}</span>
  </span>
  {#if current}<Icon icon={CheckIcon} class="shrink-0 text-[16px] text-primary" weight="bold" />{/if}
  {@render trailing?.()}
</button>
