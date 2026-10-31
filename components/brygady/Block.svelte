<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, children, aside }: { title: string; children: Snippet; aside?: Snippet } = $props();
  const id = $props.id();
</script>

<section aria-labelledby={id} class="rounded-2xl border border-hairline bg-surface p-4">
  <div class="mb-3 flex items-baseline justify-between gap-3">
    <h3 {id} class="text-[14px] font-semibold text-text">
      {title}
    </h3>
    {@render aside?.()}
  </div>
  {@render children()}
</section>
