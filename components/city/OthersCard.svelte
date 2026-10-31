<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { MapTrifoldIcon } from "@/components/icon-paths";
  import Card from "@/components/city/Card.svelte";
  import OpensMore from "@/components/city/OpensMore.svelte";
  import { OTHERS_HINT } from "@/components/cityChooser";

  /** The "Inne miasto" card: a generic map icon, it opens `OtherCities`. */
  let { big, onClick }: { big?: boolean; onClick: () => void } = $props();
</script>

<Card {big} name="Inne miasto" sub={OTHERS_HINT} {onClick}>
  {#snippet icon()}
    <span
      class="grid shrink-0 place-items-center rounded-full bg-tint/6 text-text-mute {big
        ? 'h-12 w-12 text-[24px]'
        : 'h-9 w-9 text-[18px]'}"
    >
      <Icon icon={MapTrifoldIcon} weight="bold" />
    </span>
  {/snippet}
  {#snippet trailing()}
    <OpensMore />
  {/snippet}
</Card>
