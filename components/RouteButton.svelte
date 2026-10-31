<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { PathIcon } from "@/components/icon-paths";

  /**
   * Floating button for connection search / journey planning.
   * Matches LocateButton positioning and style.
   */
  let { onClick }: { onClick: () => void } = $props();
</script>

<button
  type="button"
  onclick={onClick}
  aria-label="Wyszukaj połączenie"
  title="Wyszukaj połączenie"
  class="surface tap absolute top-[calc(4.5rem+env(safe-area-inset-top,0px)+52px)] right-3 z-[1000] grid h-11 w-11 place-items-center rounded-full text-[20px] text-text-mute hover:text-text md:top-auto md:bottom-[154px]"
>
  <Icon icon={PathIcon} />
</button>
