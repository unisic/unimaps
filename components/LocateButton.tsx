"use client";

import { memo } from "react";
import type { GeoStatus } from "@/components/hooks";
import { GpsFixIcon, GpsSlashIcon } from "@/components/icons";

interface Props {
  status: GeoStatus;
  onLocate: () => void;
}

/**
 * Floating "locate me" control, bottom-right (above the desktop zoom control).
 * Reflects the geolocation status: spinner while acquiring, filled accent glyph
 * once the blue dot is live, crossed-out danger glyph if permission was denied.
 */
function LocateButton({ status, onLocate }: Props) {
  const active = status === "active";
  const denied = status === "denied";
  const error = status === "error";
  return (
    <button
      type="button"
      onClick={onLocate}
      aria-label="Pokaż moją lokalizację"
      aria-pressed={active}
      title={
        denied
          ? "Brak zgody na lokalizację. Włącz ją w ustawieniach przeglądarki"
          : error
            ? "Lokalizacja niedostępna"
            : active
              ? "Wyłącz lokalizację"
              : "Moja lokalizacja"
      }
      className={`surface tap absolute top-[calc(4.5rem+env(safe-area-inset-top,0px))] right-3 z-[1000] grid h-11 w-11 place-items-center rounded-full text-[20px] md:top-auto md:bottom-[102px] ${
        active ? "text-primary" : denied || error ? "text-danger" : "text-text-mute hover:text-text"
      }`}
    >
      {status === "locating" ? (
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-surface-3 border-t-primary"
          aria-hidden
        />
      ) : denied || error ? (
        <GpsSlashIcon />
      ) : (
        <GpsFixIcon weight={active ? "fill" : "bold"} />
      )}
    </button>
  );
}

export default memo(LocateButton);
