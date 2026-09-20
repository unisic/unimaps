"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { CircleMarker, Marker, Polyline, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { displayStopName, formatPlatform, isBusStation, isMzk, operatorColor } from "@/lib/client/format";
import { bearingBucket, makeVehicleIcon } from "@/lib/client/leafletIcons";
import { prefersReducedMotion } from "@/lib/client/motion";
import type { LatLng, TripView, Vehicle } from "@/lib/client/types";

interface Props {
  trip: TripView | null;
  /** md+ — the panel docks left, so pad fitBounds on that side */
  desktop: boolean;
  /** vehicle the trip was opened from — drawn as a fallback so a tapped bus is
   *  never invisible while its route loads or when the exec reports no position */
  vehMeta: Vehicle | null;
  /** fresh position/heading from the live poll (matched by exec id); drives the
   *  marker so the tracked bus keeps moving while its route is open */
  liveVehicle: Vehicle | null;
}

function TripLayer({ trip, desktop, vehMeta, liveVehicle }: Props) {
  const map = useMap();

  /* last non-null live fix — if the vehicle drops off the poll mid-view
   * (finished/pruned) the marker holds there instead of teleporting back to
   * the opening snapshot; keyed by trip generation (not execId) so closing and
   * reopening the same exec starts clean instead of resurrecting an old fix
   * (setState-during-render is the sanctioned way to adjust state on prop change) */
  const gen = trip?.gen ?? -1;
  const [lastLiveHeld, setLastLiveHeld] = useState<{ gen: number; veh: Vehicle } | null>(null);
  if (liveVehicle && (lastLiveHeld?.veh !== liveVehicle || lastLiveHeld.gen !== gen)) {
    setLastLiveHeld({ gen, veh: liveVehicle });
  }
  const lastLive = liveVehicle ?? (lastLiveHeld && lastLiveHeld.gen === gen ? lastLiveHeld.veh : null);

  const tripOp = trip?.operator ?? lastLive?.operator ?? vehMeta?.operator;
  const isMzkTrip = isMzk(tripOp, trip?.line);
  const lineColor = trip ? operatorColor(tripOp, trip.line === "…" ? null : trip.line) : "";
  const liveBB = bearingBucket(lastLive?.bearing);
  /* primitive presence flags so the icon memo can key on values, not identities */
  const hasLive = lastLive != null;
  const hasTripVeh = trip?.vehicle != null;

  const vehicleIcon = useMemo(() => {
    if (!trip) return null;
    const op: "KB" | "MZK" = isMzkTrip ? "MZK" : "KB";
    // live fix present → line color + live heading arrow
    if (lastLive) return makeVehicleIcon(trip.line, lineColor, liveBB, op);
    if (trip.vehicle) return makeVehicleIcon(trip.line, lineColor, null, op);
    // fallback to the clicked vehicle (live only), with its own line + heading
    if (trip.isLive && vehMeta) {
      const fLine = vehMeta.line || trip.line;
      return makeVehicleIcon(fLine, lineColor, vehMeta.bearing ?? null, op);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.line, lineColor, hasLive, liveBB, hasTripVeh, trip?.isLive, vehMeta?.line, vehMeta?.bearing, isMzkTrip]);

  // Fit bounds once per drawn trip, after routing settles — padded so the
  // route is not hidden under the sheet (mobile) or the panel (desktop).
  useEffect(() => {
    if (!trip || trip.status !== "ready") return;
    const pts: LatLng[] =
      trip.routed && trip.routed.length >= 2
        ? trip.routed
        : trip.stops.map(({ s }): LatLng => [s.lat, s.lon]);
    if (!pts.length) return;
    const opts: L.FitBoundsOptions = desktop
      ? { paddingTopLeft: [440, 60], paddingBottomRight: [60, 40] }
      : // keep the route clear of the sheet at its opening (peek) snap ≈ 25dvh
        { paddingTopLeft: [24, 80], paddingBottomRight: [24, Math.round(window.innerHeight * 0.3)] };
    // the CSS reduced-motion reset can't reach Leaflet's JS-driven pan — gate it here
    const reduce = prefersReducedMotion();
    // a single point makes zero-size bounds → fitBounds would compute zoom Infinity
    map.getContainer().classList.add("map-moving");
    if (pts.length === 1) {
      map.setView(pts[0], 16, { animate: !reduce, duration: reduce ? 0 : 0.9 });
      return;
    }
    map.fitBounds(L.latLngBounds(pts), { ...opts, maxZoom: 17, animate: !reduce, duration: reduce ? 0 : 0.9 });
  }, [trip?.gen, trip?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!trip) return null;

  return (
    <>
      {trip.routed && trip.routed.length >= 2 && (
        <>
          {/* dark casing under the colored line */}
          <Polyline
            positions={trip.routed}
            pathOptions={{ color: "#0d1013", weight: 9, opacity: 0.85, lineCap: "round", lineJoin: "round" }}
          />
          <Polyline
            positions={trip.routed}
            pathOptions={{ color: lineColor, weight: 4.5, opacity: 0.95, lineCap: "round", lineJoin: "round" }}
          />
        </>
      )}
      {trip.stops.map(({ t, s, selected }) => (
        <CircleMarker
          key={`${trip.gen}-${t.index}-${s.id}`}
          center={[s.lat, s.lon]}
          radius={selected ? 7 : 4.5}
          pathOptions={{
            color: selected ? "#ffd54a" : lineColor,
            weight: selected ? 3 : 2,
            fillOpacity: 1,
            fillColor: "#ffffff",
          }}
        >
          <Tooltip direction="top" sticky className="kb-tooltip">
            {displayStopName(t.stop_name)} · {t.departure_time}
            {formatPlatform(t.platform, isBusStation(t.stop_name, s))
              ? ` (${formatPlatform(t.platform, isBusStation(t.stop_name, s))})`
              : ""}
          </Tooltip>
        </CircleMarker>
      ))}
      {vehicleIcon && (() => {
        // freshest source first: the last live fix from the poll, then the
        // exec's opening fix, then the clicked vehicle's own position
        const pos: LatLng | null = lastLive
          ? [lastLive.lat, lastLive.lon]
          : trip.vehicle
            ? [trip.vehicle.lat, trip.vehicle.lon]
            : trip.isLive && vehMeta
              ? [vehMeta.lat, vehMeta.lon]
              : null;
        return pos ? (
          <Marker position={pos} icon={vehicleIcon} zIndexOffset={200} keyboard={false} />
        ) : null;
      })()}
    </>
  );
}

export default memo(TripLayer);
