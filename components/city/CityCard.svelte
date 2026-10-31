<script lang="ts">
  import type { Snippet } from "svelte";

  import Card from "@/components/city/Card.svelte";
  import { CITY, type City } from "@/lib/client/city";

  /** A city as a card: its logo, name and operator line; the page's city carries a check mark. */
  let {
    id,
    big,
    current,
    trailing,
    onClick,
  }: {
    id: City;
    big?: boolean;
    current?: boolean;
    trailing?: Snippet;
    onClick: () => void;
  } = $props();

  const c = $derived(CITY[id]);
</script>

<Card {big} {current} name={c.name} sub={c.agency} {trailing} {onClick}>
  {#snippet icon()}
    {#if c.logo}
      <img
        src={c.logo}
        alt=""
        class="{big ? 'h-12 w-12' : 'h-9 w-9'} shrink-0 object-contain {c.logo.startsWith('/logos/')
          ? 'rounded-xl bg-white p-1 ring-1 ring-hairline'
          : ''}"
        draggable={false}
      />
    {:else}
      <span
        aria-hidden="true"
        class="grid shrink-0 place-items-center rounded-full bg-tint/6 font-semibold text-text-mute {big
          ? 'h-12 w-12 text-[20px]'
          : 'h-9 w-9 text-[15px]'}"
      >
        {c.name.charAt(0)}
      </span>
    {/if}
  {/snippet}
</Card>
