<script lang="ts">
  /** One settings toggle row (role="switch"), optionally with a hint line. */
  let {
    checked,
    onToggle,
    label,
    hint,
  }: { checked: boolean; onToggle: () => void; label: string; hint?: string } = $props();
  const hintId = $props.id();
</script>

<button
  type="button"
  onclick={onToggle}
  role="switch"
  aria-checked={checked}
  aria-describedby={hint ? hintId : undefined}
  class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-tint/5"
>
  <span class="flex flex-col gap-0.5">
    <span class="text-text">{label}</span>
    {#if hint}
      <span id={hintId} class="text-[12px] leading-snug text-text-faint">{hint}</span>
    {/if}
  </span>
  <span
    class="relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full px-[3px] transition-colors duration-200 {checked
      ? 'bg-primary'
      : 'bg-tint/12'}"
    aria-hidden="true"
  >
    <span
      class="h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-spring {checked
        ? 'translate-x-4'
        : 'translate-x-0'}"
    ></span>
  </span>
</button>
