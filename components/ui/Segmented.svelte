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
</script>

<div class="flex rounded-full bg-tint/5 p-1" role="radiogroup" aria-label={label}>
  {#each options as o (o.id)}
    {@const on = value === o.id}
    <button
      type="button"
      role="radio"
      aria-checked={on}
      title={o.title}
      onclick={() => onChange(o.id)}
      class="tap inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-medium {on
        ? 'bg-surface-3 text-text shadow-sm'
        : 'text-text-mute hover:text-text'}"
    >
      {@render lead?.(o.id)}
      {o.label}
    </button>
  {/each}
</div>
