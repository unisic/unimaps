/* Inline SVG icons of the /brygady page (24-unit stroke paths, drawn by Svg.svelte in currentColor). */
import type { FleetFuelType } from "@/lib/shared/fleet";

export const SEARCH = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
export const MAP = '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>';
export const CHEVRON_DOWN = '<path d="m6 9 6 6 6-6"/>';
export const ARROW_UP = '<path d="M12 19V5M5 12l7-7 7 7"/>';
export const BOLT = '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>';
export const DROP = '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>';
export const ALERT = '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>';
export const INFO = '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>';

/** Propulsion marker for cards and the sheet (diesel shows none). */
export function fuelIcon(fuel: FleetFuelType): string | null {
  if (fuel === "electric" || fuel === "hybrid") return BOLT;
  if (fuel === "hydrogen") return DROP;
  return null;
}
