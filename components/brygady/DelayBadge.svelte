<script lang="ts">
  import { classifyDelay } from "@/lib/shared/fleet";

  import { DELAY_LABEL, DELAY_RANGE, DELAY_TEXT, fmtDelay } from "./common";

  let { sec, size = "sm" }: { sec: number; size?: "sm" | "md" } = $props();
  const cls = $derived(classifyDelay(sec));
</script>

<span
  class="inline-flex shrink-0 items-center rounded-md bg-tint/6 font-semibold tabular-nums {DELAY_TEXT[cls]} {size === 'md'
    ? 'px-2 py-1 text-[13px]'
    : 'px-1.5 py-0.5 text-[12px]'}"
  title="{DELAY_LABEL[cls]} ({DELAY_RANGE[cls]})">{fmtDelay(sec)}</span>
