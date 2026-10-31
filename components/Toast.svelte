<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { XIcon } from "@/components/icon-paths";

  /** Small floating notification under the TopBar. Presentational only: the
   *  owner decides persistence (PwaRegister: sticky; MapApp: 6 s auto-clear). */
  let {
    text,
    actionLabel,
    onAction,
    onClose,
  }: {
    text: string;
    /** optional action pill (e.g. "Odśwież") */
    actionLabel?: string;
    onAction?: () => void;
    onClose: () => void;
  } = $props();
</script>

<div
  role="status"
  aria-live="polite"
  class="surface fixed left-1/2 top-[calc(env(safe-area-inset-top,0px)+0.75rem+60px)] z-[1100] flex w-max max-w-[min(400px,calc(100vw-24px))] -translate-x-1/2 items-center gap-2.5 rounded-full py-2 pl-4 pr-2 text-[13px] text-text animate-drop"
>
  <span class="min-w-0 flex-1">{text}</span>
  {#if actionLabel && onAction}
    <button
      type="button"
      onclick={onAction}
      class="tap shrink-0 rounded-full bg-text px-3 py-1.5 text-[12px] font-semibold text-bg hover:opacity-90"
    >
      {actionLabel}
    </button>
  {/if}
  <button
    type="button"
    aria-label="Zamknij powiadomienie"
    onclick={onClose}
    class="tap grid h-7 w-7 shrink-0 place-items-center rounded-full text-[14px] text-text-mute hover:bg-tint/8 hover:text-text"
  >
    <Icon icon={XIcon} />
  </button>
</div>
