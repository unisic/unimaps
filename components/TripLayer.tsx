"use client";

import { memo, useEffect, useRef, useState } from "react";
import { CircleMarker, Polyline, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { displayStopName, formatPlatform, isBusStation, isMzk, operatorColor } from "@/lib/client/format";
import { makeVehicleIcon } from "@/lib/client/leafletIcons";
import { prefersReducedMotion } from "@/lib/client/motion";
import type { LatLng, TripView, Vehicle } from "@/lib/client/types";
import { acquireVehicleAnimator, releaseVehicleAnimator, type VehicleAnimator } from "@/lib/client/vehicleAnimator";

/** Animator view id of the tracked bus (fleet views are keyed by vehicle id). */
const TRACKED = "trip:tracked";

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
  const op: "KB" | "MZK" = isMzkTrip ? "MZK" : "KB";

  /* The tracked bus marker. A live fleet vehicle → an animator view bound to
   * the SAME track as its fleet marker (it continues from where it was drawn,
   * no jump on open/close); otherwise a fixed marker at the exec's opening fix
   * or the clicked vehicle. Icons key on primitives only — the heading arrow
   * is rotated by the animator, so no setIcon (and no pop) on turns. */
  const trackId = lastLive?.id ?? null;
  let iconLine: string | null = null;
  let iconHeading = false;
  if (trip) {
    if (lastLive) {
      iconLine = trip.line;
      iconHeading = lastLive.bearing != null || lastLive.shape != null;
    } else if (trip.vehicle) {
      iconLine = trip.line;
    } else if (trip.isLive && vehMeta) {
      // fallback to the clicked vehicle (live only), with its own line + heading
      iconLine = vehMeta.line || trip.line;
      iconHeading = vehMeta.bearing != null;
    }
  }
  const iconKey = iconLine === null ? null : `${iconLine}|${lineColor}|${op}|${iconHeading ? 1 : 0}`;
  const staticLat = trip?.vehicle?.lat ?? (trip?.isLive && vehMeta ? vehMeta.lat : null);
  const staticLon = trip?.vehicle?.lon ?? (trip?.isLive && vehMeta ? vehMeta.lon : null);
  const staticHeading = vehMeta?.bearing ?? null;
  const liveLat = lastLive?.lat ?? null;
  const liveLon = lastLive?.lon ?? null;

  const animRef = useRef<VehicleAnimator | null>(null);
  const markerRef = useRef<{ marker: L.Marker; key: string } | null>(null);

  useEffect(() => {
    const anim = acquireVehicleAnimator(map);
    animRef.current = anim;
    return () => {
      anim.removeView(TRACKED);
      markerRef.current?.marker.remove();
      markerRef.current = null;
      animRef.current = null;
      releaseVehicleAnimator(map);
    };
  }, [map]);

  useEffect(() => {
    const anim = animRef.current;
    if (!anim) return;
    // where the fleet marker of this bus is drawn right now, else its raw fix
    const live = trackId !== null ? anim.displayed(trackId) : null;
    const pos: LatLng | null = live
      ? [live.lat, live.lon]
      : liveLat !== null && liveLon !== null
        ? [liveLat, liveLon]
        : staticLat !== null && staticLon !== null
          ? [staticLat, staticLon]
          : null;
    if (!iconKey || iconLine === null || !pos) {
      anim.removeView(TRACKED);
      markerRef.current?.marker.remove();
      markerRef.current = null;
      return;
    }
    const heading = iconHeading ? (live?.heading ?? staticHeading ?? 0) : null;
    let cur = markerRef.current;
    if (!cur) {
      const marker = L.marker(pos, {
        icon: makeVehicleIcon(iconLine, lineColor, heading, op),
        zIndexOffset: 200,
        keyboard: false,
      }).addTo(map);
      cur = { marker, key: iconKey };
      markerRef.current = cur;
    } else if (cur.key !== iconKey) {
      cur.marker.setIcon(makeVehicleIcon(iconLine, lineColor, heading, op));
      cur.key = iconKey;
      anim.refreshViewDom(TRACKED);
    }
    if (trackId !== null) {
      // the track may not be ingested yet (deep link): the view waits for it
      anim.addView(TRACKED, trackId, cur.marker, "tracked");
    } else {
      anim.removeView(TRACKED);
      cur.marker.setLatLng(pos);
    }
    // liveLat/liveLon only seed a brand-new marker — not deps, or every poll would re-run this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, iconKey, iconLine, iconHeading, lineColor, op, trackId, staticLat, staticLon, staticHeading]);

  /* follow the drawn route — unless it IS the fleet shape the track already uses */
  const tripGen = trip?.gen ?? -1;
  const routed = trip?.routed ?? null;
  const tripShapeId = trip?.shapeId ?? null;
  const liveShape = lastLive?.shape ?? null;
  const tripStops = trip?.stops;
  const rawTimes = trip?.rawTimes;
  useEffect(() => {
    const anim = animRef.current;
    if (!anim || trackId === null || !routed || routed.length < 2 || !tripStops || !rawTimes) return;
    if (tripShapeId && tripShapeId === liveShape) return;
    const key = `trip:${tripGen}`;
    // stop coords aligned with the trip's times (current_stop_sequence indexes them)
    const byTime = new Map(tripStops.map((r) => [r.t, r.s]));
    const refs = rawTimes.map((t): LatLng | null => {
      const st = byTime.get(t);
      return st ? [st.lat, st.lon] : null;
    });
    anim.setTripShape(key, routed, refs);
    anim.overrideShape(trackId, key);
    return () => anim.overrideShape(trackId, null);
  }, [trackId, routed, tripShapeId, liveShape, tripGen, tripStops, rawTimes]);

  // Fit bounds once per drawn trip, after routing settles — padded so the
  // route is not hidden under the sheet (mobile) or the panel (desktop).
  useEffect(() => {
    if (!trip || trip.status !== "ready") return;
    // opened by tapping the bus: MapApp already zoomed in on it, the whole route would zoom back out
    if (vehMeta && vehMeta.id === trip.execId) return;
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
    </>
  );
}

export default memo(TripLayer);
