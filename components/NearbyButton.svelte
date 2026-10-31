<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { PersonSimpleWalkIcon } from "@/components/icon-paths";

  /** "W pobliżu", third in the LocateButton / RouteButton column; shown only while located. */
  let { onClick }: { onClick: () => void } = $props();
</script>

<button
  type="button"
  onclick={onClick}
  aria-label="Odjazdy w pobliżu"
  title="Odjazdy w pobliżu"
  class="surface tap absolute top-[calc(4.5rem+env(safe-area-inset-top,0px)+104px)] right-3 z-[1000] grid h-11 w-11 place-items-center rounded-full text-[20px] text-text-mute hover:text-text md:top-auto md:bottom-[206px]"
>
  <Icon icon={PersonSimpleWalkIcon} />
</button>
