<script lang="ts">
  /** Favorite star, filled when active. */
  import Icon from "@/components/Icon.svelte";
  import { StarIcon } from "@/components/icon-paths";

  let { filled = false }: { filled?: boolean } = $props();
</script>

<Icon icon={StarIcon} weight={filled ? "fill" : "bold"} class={filled ? "animate-pop" : undefined} />
