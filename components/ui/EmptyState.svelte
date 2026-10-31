<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { BusIcon } from "@/components/icon-paths";

  let { text }: { text: string } = $props();
</script>

<div class="px-6 py-12 text-center animate-fade">
  <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-tint/5 text-[22px] text-text-faint">
    <Icon icon={BusIcon} />
  </span>
  <p class="mt-3 text-[13px] text-text-mute">{text}</p>
</div>
