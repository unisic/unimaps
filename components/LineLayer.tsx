"use client";

import { memo, useEffect, useState } from "react";
import { CircleMarker, Polyline, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { displayStopName, operatorColor } from "@/lib/client/format";
import { prefersReducedMotion } from "@/lib/client/motion";
import { loadShapeLatest } from "@/lib/client/shapes";
import type { LatLng, LineInfo, LineVariant, Stop } from "@/lib/client/types";

interface Props {
  line: LineInfo | null;
  /** the pattern the line view shows; null = nothing drawn */
  variant: LineVariant | null;
  desktop: boolean;
  resolveStop: (id: string) => Stop | null;
  onSelectStop: (s: Stop) => void;
}

/** The open line view's pattern on the map: the stored road shape (straight stop-to-stop until it exists), stops tappable. */
function LineLayer({ line, variant, desktop, resolveStop, onSelectStop }: Props) {
  const map = useMap();
  const [road, setRoad] = useState<{ id: string; pts: LatLng[] } | null>(null);
  const shapeId = variant?.shape ?? null;
  useEffect(() => {
    if (!shapeId) return;
    let live = true;
    void loadShapeLatest(shapeId).then((s) => {
      if (live && s) setRoad({ id: shapeId, pts: s.pts });
    });
    return () => {
      live = false;
    };
  }, [shapeId]);

  const stops = (variant?.stops ?? []).flatMap((s) => (s.lat != null && s.lon != null ? [{ ...s, lat: s.lat, lon: s.lon }] : []));
  const pts: LatLng[] = road && road.id === shapeId ? road.pts : stops.map((s) => [s.lat, s.lon]);

  // frame the pattern once per variant, clear of the sheet (mobile) / the panel (desktop)
  useEffect(() => {
    if (stops.length < 2) return;
    const opts: L.FitBoundsOptions = desktop
      ? { paddingTopLeft: [440, 60], paddingBottomRight: [60, 40] }
      : { paddingTopLeft: [24, 80], paddingBottomRight: [24, Math.round(window.innerHeight * 0.3)] };
    const reduce = prefersReducedMotion();
    map.getContainer().classList.add("map-moving");
    map.fitBounds(L.latLngBounds(stops.map((s): LatLng => [s.lat, s.lon])), { ...opts, maxZoom: 16, animate: !reduce, duration: reduce ? 0 : 0.9 });
  }, [variant]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!variant || pts.length < 2) return null;
  const color = operatorColor(line?.operator, line?.name);
  return (
    <>
      <Polyline positions={pts} pathOptions={{ color: "#0d1013", weight: 9, opacity: 0.85, lineCap: "round", lineJoin: "round" }} />
      <Polyline positions={pts} pathOptions={{ color, weight: 4.5, opacity: 0.95, lineCap: "round", lineJoin: "round" }} />
      {stops.map((s, i) => (
        <CircleMarker
          key={`${s.id}-${i}`}
          center={[s.lat, s.lon]}
          radius={4.5}
          pathOptions={{ color, weight: 2, fillOpacity: 1, fillColor: "#ffffff" }}
          eventHandlers={{
            click: () => {
              const st = resolveStop(s.id);
              if (st) onSelectStop(st);
            },
          }}
        >
          <Tooltip direction="top" sticky className="kb-tooltip">
            {displayStopName(s.name)}
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

export default memo(LineLayer);
