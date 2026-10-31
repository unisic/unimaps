<script lang="ts">
  import { operatorColor } from "@/lib/client/format";

  /** Colored line-number pill, size-adjustable. */
  let { line, big = false, operator }: { line: string; big?: boolean; operator?: "KB" | "MZK" | "GZM" } = $props();
</script>

<span
  class="flex shrink-0 items-center justify-center rounded-lg font-semibold tabular-nums tracking-tight text-white {big
    ? 'h-8 min-w-11 px-2 text-[15px]'
    : 'h-7 min-w-9 px-1.5 text-[12px]'}"
  style:background={operatorColor(operator, line)}>{line}</span>
