<script lang="ts" generics="T extends string">
  import type { Snippet } from "svelte";

  /** Radio group drawn as one pill track; the checked segment lifts onto surface-3. */
  let {
    label,
    value,
    options,
    onChange,
    lead,
  }: {
    label: string;
    value: T;
    options: readonly { id: T; label: string; title?: string }[];
    onChange: (id: T) => void;
    /** drawn before an option's label */
    lead?: Snippet<[T]>;
  } = $props();
  const at = $derived(options.findIndex((o) => o.id === value));
</script>

<!-- the thumb slides to the checked segment (StopView's tab thumb); segments are flex-1, so one segment = the thumb's width -->
<div class="relative flex rounded-full bg-tint/5 p-1" role="radiogroup" aria-label={label}>
  {#if at >= 0}
    <span
      class="absolute inset-y-1 left-1 rounded-full bg-surface-3 shadow-sm transition-transform duration-300"
      style:width="calc((100% - 8px) / {options.length})"
      style:transform="translateX({at * 100}%)"
      style:transition-timing-function="var(--ease-spring)"
      aria-hidden="true"
    ></span>
  {/if}
  {#each options as o (o.id)}
    {@const on = value === o.id}
    <button
      type="button"
      role="radio"
      aria-checked={on}
      title={o.title}
      onclick={() => onChange(o.id)}
      class="tap relative inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-medium {on
        ? 'text-text'
        : 'text-text-mute hover:text-text'}"
    >
      {@render lead?.(o.id)}
      {o.label}
    </button>
  {/each}
</div>
