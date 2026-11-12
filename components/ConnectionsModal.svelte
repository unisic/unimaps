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
    /** a point picked on the map ("Trasa stąd" / "Trasa dotąd"): fills that end of the last search */
    initialPoint?: { end: "from" | "to"; at: { lat: number; lon: number; label: string } } | null;
    onSelectStop: (s: Stop) => void;
    onSelectConnection?: (conn: ConnectionItinerary, selectedLegIdx?: number | null) => void;
    /** desktop: the result to draw on the map under the panel (hovered, else the first); null clears it */
    onPreviewConnection?: (conn: ConnectionItinerary | null) => void;
    /** a docked side panel over a usable map instead of a modal sheet */
    desktop?: boolean;
    /** the live fleet of the city: current delays on today's legs */
    vehicles?: readonly Vehicle[];
  }
</script>

<script lang="ts">
  import ConnectionsDialog from "@/components/connections/ConnectionsDialog.svelte";

  let { open, ...rest }: ConnectionsModalProps = $props();
</script>

<!-- the dialog mounts per opening; its module script keeps the last search to reopen on -->
{#if open}
  <ConnectionsDialog {...rest} />
{/if}
