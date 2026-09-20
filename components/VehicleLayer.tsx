"use client";

import { memo, useMemo } from "react";
import { Marker, Tooltip } from "react-leaflet";
import { delayTxt, displayStopName, vehColor } from "@/lib/client/format";
import { bearingBucket, makeVehicleIcon } from "@/lib/client/leafletIcons";
import type { Vehicle } from "@/lib/client/types";

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

const VehicleMarker = memo(function VehicleMarker({
  v,
  onClick,
}: {
  v: Vehicle;
  onClick: (v: Vehicle) => void;
}) {
  const color = vehColor(v);
  const bb = bearingBucket(v.bearing);
  const icon = useMemo(
    () => makeVehicleIcon(v.line, color, bb, v.operator),
    [v.line, color, bb, v.operator],
  );

  return (
    <Marker
      position={[v.lat, v.lon]}
      icon={icon}
      eventHandlers={{ click: () => onClick(v) }}
      zIndexOffset={100}
      keyboard={false}
    >
      <Tooltip direction="top" offset={[0, -16]} className="kb-tooltip">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span
            className={`rounded px-1 text-[10px] font-bold leading-tight text-white ${
              v.operator === "MZK" ? "bg-blue-600" : "bg-red-600"
            }`}
          >
            {v.operator || "KB"}
          </span>
          <b>{v.line || "?"}</b> {v.headsign ? `→ ${displayStopName(v.headsign)}` : ""}
          {v.side_number ? ` · #${v.side_number}` : ""}
          {v.model ? ` (${v.model})` : ""}
          {v.delay != null ? ` · ${delayTxt(v.delay)}` : ""}
        </span>
      </Tooltip>
    </Marker>
  );
});

function VehicleLayer({
  vehicles,
  onVehicleClick,
  hidden = false,
  lineFilter = null,
  operatorFilter = "all",
}: Props) {
  if (hidden) return null;
  let shown = vehicles;
  if (operatorFilter === "kb") {
    shown = shown.filter((v) => v.operator !== "MZK");
  } else if (operatorFilter === "mzk") {
    shown = shown.filter((v) => v.operator === "MZK");
  }
  if (lineFilter) {
    shown = shown.filter((v) => lineFilter.has(v.line));
  }

  return (
    <>
      {shown.map((v) => (
        <VehicleMarker key={v.id} v={v} onClick={onVehicleClick} />
      ))}
    </>
  );
}

export default memo(VehicleLayer);
