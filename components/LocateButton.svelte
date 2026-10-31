<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import { GpsFixIcon, GpsSlashIcon } from "@/components/icon-paths";
  import type { GeoStatus } from "@/components/hooks.svelte";

  /**
   * Floating "locate me" control, bottom-right (above the desktop zoom control).
   * Reflects the geolocation status: spinner while acquiring, filled accent glyph
   * while the map follows the blue dot, outlined accent glyph when the dot is live
   * but a drag ended following, crossed-out danger glyph if permission was denied.
   */
  let {
    status,
    following,
    onLocate,
  }: {
    status: GeoStatus;
    /** the map pans to every fix (a drag ends it) */
    following: boolean;
    onLocate: () => void;
  } = $props();

  const active = $derived(status === "active");
  const denied = $derived(status === "denied");
  const error = $derived(status === "error");
</script>

<button
  type="button"
  onclick={onLocate}
  aria-label="Śledź moją lokalizację"
  aria-pressed={following}
  title={denied
    ? "Brak zgody na lokalizację. Włącz ją w ustawieniach przeglądarki"
    : error
      ? "Lokalizacja niedostępna"
      : following
        ? "Wyłącz lokalizację"
        : "Śledź moją lokalizację"}
  class="surface tap absolute top-[calc(4.5rem+env(safe-area-inset-top,0px))] right-3 z-[1000] grid h-11 w-11 place-items-center rounded-full text-[20px] md:top-auto md:bottom-[102px] {active
    ? 'text-primary'
    : denied || error
      ? 'text-danger'
      : 'text-text-mute hover:text-text'}"
>
  {#if status === "locating"}
    <span class="h-4 w-4 animate-spin rounded-full border-2 border-surface-3 border-t-primary" aria-hidden="true"></span>
  {:else if denied || error}
    <Icon icon={GpsSlashIcon} />
  {:else}
    <Icon icon={GpsFixIcon} weight={following ? "fill" : "bold"} />
  {/if}
</button>
