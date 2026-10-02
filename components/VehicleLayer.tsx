"use client";

import { memo, useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { vehiclesClock } from "@/lib/client/api";
import { delayTxt, displayStopName, vehColor } from "@/lib/client/format";
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
  marker: L.Marker;
  iconKey: string;
}

/** Tooltip DOM (textContent only — upstream strings are never parsed as HTML). */
function buildVehicleTooltip(v: Vehicle | undefined): HTMLElement {
  const root = document.createElement("span");
  root.className = "flex items-center gap-1.5 flex-wrap";
  if (!v) return root;
  const badge = document.createElement("span");
  badge.className = `rounded px-1 text-[10px] font-bold leading-tight text-white ${
    v.operator === "MZK" ? "bg-blue-600" : "bg-red-600"
  }`;
  badge.textContent = v.operator || "KB";
  const line = document.createElement("b");
  line.textContent = v.line || "?";
  root.append(badge, " ", line);
  const rest =
    (v.headsign ? ` → ${displayStopName(v.headsign)}` : "") +
    (v.side_number ? ` · #${v.side_number}` : "") +
    (v.model ? ` (${v.model})` : "") +
    (v.not_started ? " · czeka na odjazd" : v.delay != null ? ` · ${delayTxt(v.delay)}` : "");
  if (rest) root.append(rest);
  return root;
}

/**
 * Live vehicle markers — an imperative layer (like StopsLayer): markers are
 * diffed by id, never re-created per poll, and their positions/arrows are
 * written only by the shared VehicleAnimator (smooth dead-reckoned motion, or
 * raw fixes + CSS glide when "Płynny ruch pojazdów" is off). Do not convert
 * back to declarative react-leaflet <Marker>s: their `position` prop would
 * snap every animated marker back to the raw fix on each 4 s poll.
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

  useEffect(() => {
    onClickRef.current = onVehicleClick;
  }, [onVehicleClick]);

  // lifecycle: one layer group + the map's shared animator
  useEffect(() => {
    const anim = acquireVehicleAnimator(map);
    const group = L.layerGroup();
    const views = viewsRef.current;
    animRef.current = anim;
    groupRef.current = group;
    return () => {
      for (const id of views.keys()) anim.removeView(id);
      views.clear();
      group.remove();
      groupRef.current = null;
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
    if (!anim || !group) return;
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
    if (lineFilter) shown = shown.filter((v) => lineFilter.has(v.line));

    const want = new Set(shown.map((v) => v.id));
    for (const [id, view] of views) {
      if (want.has(id)) continue;
      anim.removeView(id);
      group.removeLayer(view.marker);
      views.delete(id);
    }

    for (const v of shown) {
      const color = vehColor(v);
      // heading is applied by the animator, never part of the icon key —
      // rebuilding the DivIcon replays its pop animation and kills the glide
      const hasHeading = anim.headingKnown(v.id) || v.bearing != null;
      const key = `${v.line}|${color}|${v.operator ?? ""}|${hasHeading ? 1 : 0}`;
      const existing = views.get(v.id);
      if (!existing) {
        const d = anim.displayed(v.id);
        const heading = hasHeading ? (d?.heading ?? v.bearing ?? 0) : null;
        const marker = L.marker(d ? [d.lat, d.lon] : [v.lat, v.lon], {
          icon: makeVehicleIcon(v.line, color, heading, v.operator),
          zIndexOffset: 100,
          keyboard: false,
        });
        const id = v.id;
        marker.bindTooltip(() => buildVehicleTooltip(anim.latest(id) ?? undefined), {
          direction: "top",
          offset: [0, -16],
          className: "kb-tooltip",
        });
        marker.on("click", () => {
          const cur = anim.latest(id);
          if (cur) onClickRef.current(cur);
        });
        marker.addTo(group);
        views.set(id, { marker, iconKey: key });
        anim.addView(id, id, marker, "fleet");
        continue;
      }
      if (existing.iconKey !== key) {
        const d = anim.displayed(v.id);
        existing.marker.setIcon(makeVehicleIcon(v.line, color, hasHeading ? (d?.heading ?? v.bearing ?? 0) : null, v.operator));
        existing.iconKey = key;
        anim.refreshViewDom(v.id);
      }
      // keep an open tooltip's text (delay, headsign) current
      const tip = existing.marker.getTooltip();
      if (tip?.isOpen()) tip.update();
    }
  }, [vehicles, hidden, lineFilter, operatorFilter, map]);

  return null;
}

export default memo(VehicleLayer);
