<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { ArrowsClockwiseIcon, WarningCircleIcon } from "@/components/icon-paths";

  let { onRetry, message }: { onRetry: () => void; message?: string } = $props();
</script>

<div class="px-6 py-10 text-center animate-fade">
  <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-danger/10 text-[22px] text-danger">
    <Icon icon={WarningCircleIcon} />
  </span>
  <p class="mt-3 text-[13px] text-text-mute">{message ?? "Nie udało się pobrać danych."}</p>
  <button
    type="button"
    onclick={onRetry}
    class="tap mt-4 inline-flex items-center gap-1.5 rounded-full bg-tint/8 px-4 py-2 text-[13px] font-medium text-text hover:bg-tint/12"
  >
    <Icon icon={ArrowsClockwiseIcon} />
    Spróbuj ponownie
  </button>
</div>
