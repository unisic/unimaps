<script module lang="ts">
  import type { GeoPos, GeoStatus } from "@/components/hooks.svelte";
  import type { ConnectionItinerary, Stop, Vehicle } from "@/lib/client/types";

  export interface ConnectionsModalProps {
    open: boolean;
    onClose: () => void;
    stops: Stop[];
    geoPos: GeoPos | null;
    geoStatus?: GeoStatus;
    /** starts the location watch (from the "Moja lokalizacja" tap, a user gesture) */
    onLocate?: () => void;
    initialFrom?: Stop | null;
    initialTo?: Stop | null;
    onSelectStop: (s: Stop) => void;
    onSelectConnection?: (conn: ConnectionItinerary, selectedLegIdx?: number | null) => void;
    /** the live fleet of the city: current delays on today's legs */
    vehicles?: readonly Vehicle[];
  }
</script>

<script lang="ts">
  import ConnectionsDialog from "@/components/connections/ConnectionsDialog.svelte";

  let { open, ...rest }: ConnectionsModalProps = $props();
</script>

<!-- the dialog mounts per opening: its search state starts fresh each time -->
{#if open}
  <ConnectionsDialog {...rest} />
{/if}
