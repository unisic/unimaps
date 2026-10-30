"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { vehiclesClock } from "@/lib/client/api";
import { fleetMarkers } from "@/lib/client/fleetMarkers";
import { delayClass, delayTxt, displayStopName, transitMode, vehColor } from "@/lib/client/format";
import { makeVehicleIcon } from "@/lib/client/leafletIcons";
import type { Vehicle } from "@/lib/client/types";
import { acquireVehicleAnimator, releaseVehicleAnimator, type VehicleAnimator } from "@/lib/client/vehicleAnimator";

interface Props {
  vehicles: Vehicle[];
  onVehicleClick: (v: Vehicle) => void;
  /** hide every live marker (e.g. while a trip route is drawn) so the selected
   *  vehicle isn't duplicated by TripLayer and the others don't obscure it */
  hidden?: boolean;
  /** when set, only vehicles of these lines are drawn */
  lineFilter?: ReadonlySet<string> | null;
  /** filter by operator */
  operatorFilter?: "all" | "kb" | "mzk";
}

interface MarkerView {
  marker: L.Marker | L.CircleMarker;
  iconKey: string;
  dot: boolean;
}

/** a dense fleet zoomed in mounts pills only this far around the viewport (StopsLayer's margin) */
const BOUNDS_PAD = 0.25;

/** Tooltip DOM (textContent only — upstream strings are never parsed as HTML), laid out like TripView's header. */
function buildVehicleTooltip(v: Vehicle | undefined): HTMLElement {
  const root = document.createElement("div");
  root.className = "flex items-center gap-2.5";
  if (!v) return root;
  const span = (className: string, text: string) => {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  };
  const badge = span(
    "flex h-7 min-w-9 shrink-0 items-center justify-center rounded-lg px-1.5 text-[12px] font-semibold tabular-nums tracking-tight text-white",
    v.line || "?",
  );
  badge.style.background = vehColor(v);
  const body = document.createElement("div");
  body.className = "w-max min-w-0 max-w-[260px]";
  body.append(
    span(
      "line-clamp-2 whitespace-normal text-[13px] font-semibold leading-tight tracking-tight text-text",
      v.headsign ? displayStopName(v.headsign) : `Linia ${v.line || "?"}`,
    ),
  );
  const meta: HTMLElement[] = [];
  if (v.not_started) meta.push(span("shrink-0 font-medium text-late", "czeka na odjazd"));
  else if (v.delay != null) meta.push(span(`shrink-0 font-semibold tabular-nums ${delayClass(v.delay)}`, delayTxt(v.delay)));
  if (v.scheduled) meta.push(span("shrink-0", "pozycja z rozkładu"));
  if (v.side_number) meta.push(span("shrink-0 tabular-nums", `#${v.side_number}`));
  if (v.model) meta.push(span("truncate", v.model));
  if (meta.length) {
    const row = document.createElement("div");
    row.className = "mt-1 flex items-center gap-1.5 text-[12px] leading-tight text-text-mute";
    meta.forEach((el, i) => {
      if (i) row.append(span("shrink-0 text-text-faint", "·"));
      row.append(el);
    });
    body.append(row);
  }
  root.append(badge, body);
  return root;
}

/**
 * Live vehicle markers — an imperative layer (like StopsLayer): markers are
 * diffed by id, never re-created per poll, and their positions/arrows are
 * written only by the shared VehicleAnimator (smooth dead-reckoned motion, or
 * raw fixes + CSS glide when "Płynny ruch pojazdów" is off). Do not convert
 * back to declarative react-leaflet <Marker>s: their `position` prop would
 * snap every animated marker back to the raw fix on each 4 s poll.
 * A dense fleet (GZM) is canvas dots zoomed out and pills only around the
 * viewport zoomed in (lib/client/fleetMarkers.ts).
 */
function VehicleLayer({
  vehicles,
  onVehicleClick,
  hidden = false,
  lineFilter = null,
  operatorFilter = "all",
}: Props) {
  const map = useMap();
  const onClickRef = useRef(onVehicleClick);
  const animRef = useRef<VehicleAnimator | null>(null);
  const groupRef = useRef<L.LayerGroup | null>(null);
  const viewsRef = useRef(new Map<string, MarkerView>());
  const rendererRef = useRef<L.Canvas | null>(null);
  // bumped on moveend: the dense-fleet cull box and the dot/pill switch follow the view
  const [viewTick, setViewTick] = useState(0);

  useEffect(() => {
    onClickRef.current = onVehicleClick;
  }, [onVehicleClick]);

  // lifecycle: one layer group + the map's shared animator
  useEffect(() => {
    const anim = acquireVehicleAnimator(map);
    const group = L.layerGroup();
    const renderer = L.canvas({ tolerance: 4 });
    const views = viewsRef.current;
    const onMoveEnd = () => setViewTick((n) => n + 1);
    animRef.current = anim;
    groupRef.current = group;
    rendererRef.current = renderer;
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
      for (const id of views.keys()) anim.removeView(id);
      views.clear();
      group.remove();
      renderer.remove();
      groupRef.current = null;
      rendererRef.current = null;
      animRef.current = null;
      releaseVehicleAnimator(map);
    };
  }, [map]);

  // every poll feeds the motion engine — all vehicles, regardless of filters or
  // `hidden`, so tracks stay warm (a tapped bus continues from where it was)
  useEffect(() => {
    animRef.current?.ingest(vehicles, vehiclesClock.get(vehicles) ?? null);
  }, [vehicles]);

  // reconcile markers with the filtered set
  useEffect(() => {
    const anim = animRef.current;
    const group = groupRef.current;
    const renderer = rendererRef.current;
    if (!anim || !group || !renderer) return;
    const views = viewsRef.current;
    if (hidden) {
      for (const id of views.keys()) anim.removeView(id);
      views.clear();
      group.clearLayers();
      group.remove();
      return;
    }
    group.addTo(map);

    let shown = vehicles;
    if (operatorFilter === "kb") shown = shown.filter((v) => v.operator !== "MZK");
    else if (operatorFilter === "mzk") shown = shown.filter((v) => v.operator === "MZK");
    if (lineFilter) shown = shown.filter((v) => !v.agency && lineFilter.has(v.line));
    const b = map.getBounds().pad(BOUNDS_PAD);
    const { dots, list } = fleetMarkers(shown, map.getZoom(), {
      s: b.getSouth(),
      w: b.getWest(),
      n: b.getNorth(),
      e: b.getEast(),
    });

    const want = new Set(list.map((v) => v.id));
    for (const [id, view] of views) {
      if (want.has(id) && view.dot === dots) continue;
      anim.removeView(id);
      group.removeLayer(view.marker);
      views.delete(id);
    }

    for (const v of list) {
      const color = vehColor(v);
      // heading is applied by the animator, never part of the icon key —
      // rebuilding the DivIcon replays its pop animation and kills the glide
      const hasHeading = anim.headingKnown(v.id) || v.bearing != null;
      const mode = transitMode(v.operator, v.vehicle_type);
      const key = dots ? color : `${v.line}|${color}|${v.operator ?? ""}|${mode}|${hasHeading ? 1 : 0}|${v.scheduled ? 1 : 0}`;
      const existing = views.get(v.id);
      if (!existing) {
        const d = anim.displayed(v.id);
        const at: L.LatLngExpression = d ? [d.lat, d.lon] : [v.lat, v.lon];
        const heading = hasHeading ? (d?.heading ?? v.bearing ?? 0) : null;
        const marker = dots
          ? L.circleMarker(at, {
              renderer,
              radius: 5,
              color: "#fff",
              weight: 1.5,
              fillColor: color,
              fillOpacity: 1,
              bubblingMouseEvents: false, // like a marker: a tap on a dot is not a map click
            })
          : L.marker(at, {
              icon: makeVehicleIcon(v.line, color, heading, v.operator, mode, v.scheduled),
              zIndexOffset: 100,
              keyboard: false,
            });
        const id = v.id;
        marker.bindTooltip(() => buildVehicleTooltip(anim.latest(id) ?? undefined), {
          direction: "top",
          offset: [0, dots ? -6 : -16],
          opacity: 1, // Leaflet's default 0.9 lets the markers underneath show through the card
          className: "kb-tooltip veh-tooltip",
        });
        marker.on("click", () => {
          const cur = anim.latest(id);
          if (cur) onClickRef.current(cur);
        });
        marker.addTo(group);
        views.set(id, { marker, iconKey: key, dot: dots });
        anim.addView(id, id, marker, "fleet");
        continue;
      }
      if (existing.iconKey !== key) {
        if (existing.marker instanceof L.Marker) {
          const d = anim.displayed(v.id);
          existing.marker.setIcon(makeVehicleIcon(v.line, color, hasHeading ? (d?.heading ?? v.bearing ?? 0) : null, v.operator, mode, v.scheduled));
          anim.refreshViewDom(v.id);
        } else existing.marker.setStyle({ fillColor: color });
        existing.iconKey = key;
      }
      // keep an open tooltip's text (delay, headsign) current
      const tip = existing.marker.getTooltip();
      if (tip?.isOpen()) tip.update();
    }
  }, [vehicles, hidden, lineFilter, operatorFilter, map, viewTick]);

  return null;
}

export default memo(VehicleLayer);
