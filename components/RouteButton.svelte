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
  class="surface tap absolute top-[calc(4.5rem+env(safe-area-inset-top,0px)+52px)] right-3 z-[1000] flex h-11 items-center gap-1.5 rounded-full pr-3.5 pl-3 text-[20px] text-text-mute hover:text-text md:top-auto md:bottom-[154px]"
>
  <Icon icon={PathIcon} />
  <span class="text-[13px] font-medium">Połączenie</span>
</button>
