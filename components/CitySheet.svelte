<script lang="ts">
  import BottomSheet from "@/components/BottomSheet.svelte";
  import OtherCities from "@/components/city/OtherCities.svelte";
  import { OTHERS_HINT } from "@/components/cityChooser";
  import Icon from "@/components/Icon.svelte";
  import { MapTrifoldIcon, XIcon } from "@/components/icon-paths";
  import IconButton from "@/components/ui/IconButton.svelte";
  import { getPageCity, switchCity } from "@/lib/client/city";

  /** "Inne miasto": the searchable list of every city but BB and GZM, which sit in the menu itself. */
  let { desktop, onClose }: { desktop: boolean; onClose: () => void } = $props();

  const city = getPageCity();
</script>

<BottomSheet {desktop} {onClose} ariaLabel="Inne miasto" initialSnap="full">
  {#snippet header()}
    <header class="px-4 pb-3 pt-2 md:pt-4">
      <div class="flex items-center gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-tint/6 text-[18px] text-text-mute">
          <Icon icon={MapTrifoldIcon} />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">Inne miasto</h2>
          <p class="mt-0.5 text-[12px] text-text-faint">{OTHERS_HINT}</p>
        </div>
        <IconButton label="Zamknij wybór miasta" onClick={onClose}>
          <Icon icon={XIcon} />
        </IconButton>
      </div>
    </header>
  {/snippet}
  <div
    class="kb-scroll h-full overflow-y-auto px-4 animate-fade"
    style:padding-bottom="calc(env(safe-area-inset-bottom, 0px) + 1.25rem)"
  >
    <OtherCities current={city} onPick={switchCity} />
  </div>
</BottomSheet>
