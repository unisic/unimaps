<script lang="ts">
  /** A request stop ("na żądanie"): the bus stops only when signalled, so the mark has to be seen. */
  import Icon from "@/components/Icon.svelte";
  import { HandWavingIcon } from "@/components/icon-paths";

  let { dim = false }: { dim?: boolean } = $props();
</script>

<span
  title="Przystanek na żądanie: pomachaj kierowcy albo naciśnij STOP"
  class="inline-flex shrink-0 items-center gap-1 rounded-full bg-late/15 px-1.5 py-px text-[11px] font-semibold leading-4 text-late {dim
    ? 'opacity-60'
    : ''}"
>
  <Icon icon={HandWavingIcon} size="1.1em" />
  na żądanie
</span>
