<script lang="ts">
  import { onMount } from "svelte";

  import Icon from "@/components/Icon.svelte";
  import { MagnifyingGlassIcon } from "@/components/icon-paths";
  import CityCard from "@/components/city/CityCard.svelte";
  import { CITY, OTHER_CITIES, type City } from "@/lib/client/city";
  import { normalizeText } from "@/lib/client/format";

  /**
   * Every city but BB and GZM (those two have cards of their own), filtered by name or operator without
   * regard to diacritics. `listClassName` caps and scrolls the list where the host does not scroll itself.
   */
  let {
    current,
    onPick,
    autoFocus = false,
    listClassName = "",
  }: {
    current?: City;
    onPick: (c: City) => void;
    autoFocus?: boolean;
    listClassName?: string;
  } = $props();

  let q = $state("");
  let input = $state<HTMLInputElement>();

  const list = $derived.by(() => {
    const n = normalizeText(q.trim());
    if (!n) return OTHER_CITIES;
    return OTHER_CITIES.filter((c) => normalizeText(`${c.label} ${CITY[c.id].agency}`).includes(n));
  });

  onMount(() => {
    if (autoFocus) input?.focus();
  });
</script>

<label
  class="flex h-10 items-center gap-2.5 rounded-xl bg-tint/6 px-3.5 text-text-mute transition-colors focus-within:bg-tint/10 focus-within:ring-1 focus-within:ring-primary/50"
>
  <Icon icon={MagnifyingGlassIcon} class="shrink-0 text-[16px]" weight="bold" />
  <input
    bind:this={input}
    type="text"
    bind:value={q}
    placeholder="Miasto lub przewoźnik…"
    aria-label="Szukaj miasta"
    autocomplete="off"
    class="min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-text-faint"
  />
</label>
{#if list.length === 0}
  <p class="px-3 py-6 text-center text-[13px] text-text-mute">Brak takiego miasta.</p>
{:else}
  <ul class="mt-2 {listClassName}">
    {#each list as c (c.id)}
      <li>
        <CityCard id={c.id} current={c.id === current} onClick={() => onPick(c.id)} />
      </li>
    {/each}
  </ul>
{/if}
