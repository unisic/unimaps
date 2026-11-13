<script lang="ts">
  /** Shares `path` (resolved against this page), else the page itself (deep-link state keeps it fresh), via
   *  the native share sheet, falling back to clipboard + a 2 s "copied" check. */
  import Icon from "@/components/Icon.svelte";
  import { CheckIcon, ShareNetworkIcon } from "@/components/icon-paths";
  import IconButton from "@/components/ui/IconButton.svelte";

  let { title, path }: { title: string; path?: string } = $props();
  let copied = $state(false);

  async function onShare() {
    const url = path ? new URL(path, window.location.href).href : window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        /* user cancelled the share sheet */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      /* clipboard blocked: nothing sensible to do */
    }
  }
</script>

<IconButton label={copied ? "Skopiowano link" : "Udostępnij"} onClick={() => void onShare()} pressed={copied}>
  {#if copied}
    <Icon icon={CheckIcon} class="animate-pop" />
  {:else}
    <Icon icon={ShareNetworkIcon} />
  {/if}
</IconButton>
