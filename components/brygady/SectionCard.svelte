<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    subtitle,
    actions,
    children,
    id,
  }: {
    title: string;
    subtitle?: string;
    actions?: Snippet;
    children: Snippet;
    id?: string;
  } = $props();
</script>

<section aria-labelledby={id} class="rounded-2xl border border-hairline bg-surface p-4 sm:p-5">
  <div class="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
    <div class="min-w-0">
      <h2 {id} class="text-[15px] font-semibold text-text">
        {title}
      </h2>
      {#if subtitle}<p class="mt-0.5 text-[12.5px] leading-snug text-text-mute">{subtitle}</p>{/if}
    </div>
    {@render actions?.()}
  </div>
  {@render children()}
</section>
