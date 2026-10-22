"use client";

import { Fragment, memo, useEffect, useMemo, useRef } from "react";
import { CircleMarker, Marker, Polyline, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { displayStopName } from "@/lib/client/format";
import { makeJourneyPinIcon } from "@/lib/client/leafletIcons";
import { prefersReducedMotion } from "@/lib/client/motion";
import type { JourneyView, LatLng } from "@/lib/client/types";

interface Props {
  journey: JourneyView | null;
  desktop: boolean;
}

function JourneyLayer({ journey, desktop }: Props) {
  const map = useMap();

  const selectedIdx = journey?.selectedLegIdx ?? null;

  // Determine points for bounds fitting
  const allPoints = useMemo(() => {
    if (!journey) return [];
    const pts: LatLng[] = [];
    journey.legs.forEach((l, lIdx) => {
      if (selectedIdx !== null && selectedIdx !== lIdx) return;
      if (l.routed && l.routed.length >= 2) {
        pts.push(...l.routed);
      } else if (l.leg.stops) {
        for (const s of l.leg.stops) {
          if (s.lat && s.lon) pts.push([s.lat, s.lon]);
        }
      }
    });
    return pts;
  }, [journey, selectedIdx]);

  // Fit bounds once per journey and selected leg: the routed legs replace the journey object
  // ~1 s later and must not yank back a map the user has started moving
  const fittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!allPoints.length) return;
    const fitKey = `${journey?.gen}:${selectedIdx}`;
    if (fittedRef.current === fitKey) return;
    fittedRef.current = fitKey;
    const opts: L.FitBoundsOptions = desktop
      ? { paddingTopLeft: [440, 60], paddingBottomRight: [60, 40] }
      : { paddingTopLeft: [24, 80], paddingBottomRight: [24, Math.round(window.innerHeight * 0.35)] };

    const reduce = prefersReducedMotion();
    map.getContainer().classList.add("map-moving");
    if (allPoints.length === 1) {
      map.setView(allPoints[0], 15, { animate: !reduce, duration: reduce ? 0 : 0.9 });
      return;
    }
    map.fitBounds(L.latLngBounds(allPoints), { ...opts, maxZoom: 17, animate: !reduce, duration: reduce ? 0 : 0.9 });
  }, [journey?.gen, selectedIdx, allPoints]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!journey) return null;

  const startLeg = journey.legs[0]?.leg;
  const startStop = startLeg?.stops?.[0];
  const lastLeg = journey.legs[journey.legs.length - 1]?.leg;
  const endStop = lastLeg?.stops?.[lastLeg.stops.length - 1];

  return (
    <>
      {/* Route polylines per leg */}
      {journey.legs.map((legItem, lIdx) => {
        const isLegSelected = selectedIdx === null || selectedIdx === lIdx;
        const color = legItem.lineColor;
        const pts: LatLng[] =
          legItem.routed && legItem.routed.length >= 2
            ? legItem.routed
            : (legItem.leg.stops?.filter((s) => s.lat && s.lon).map((s) => [s.lat!, s.lon!] as LatLng) ?? []);

        if (pts.length < 2) return null;

        return (
          <Fragment key={`journey-leg-${lIdx}`}>
            {/* Casing line */}
            <Polyline
              positions={pts}
              pathOptions={{
                color: "#0d1013",
                weight: isLegSelected ? 9 : 6,
                opacity: isLegSelected ? 0.85 : 0.35,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
            {/* Colored route line */}
            <Polyline
              positions={pts}
              pathOptions={{
                color,
                weight: isLegSelected ? 5 : 3.5,
                opacity: isLegSelected ? 0.95 : 0.4,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          </Fragment>
        );
      })}

      {/* Walks between the alighting pole and the next boarding pole: a straight dotted line (no footpath geometry) */}
      {journey.legs.slice(1).map(({ leg }, i) => {
        const from = journey.legs[i].leg.stops?.at(-1);
        const to = leg.stops?.[0];
        if (!leg.walkMins || !from?.lat || !from.lon || !to?.lat || !to.lon) return null;
        const on = selectedIdx === null || selectedIdx === i || selectedIdx === i + 1;
        const pts: LatLng[] = [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ];
        return (
          <Fragment key={`journey-walk-${i}`}>
            {/* same dash period as the dots, so each dot gets a dark rim */}
            <Polyline
              positions={pts}
              pathOptions={{ color: "#0d1013", weight: 8, opacity: on ? 0.85 : 0.35, dashArray: "1 10", lineCap: "round" }}
            />
            <Polyline
              positions={pts}
              pathOptions={{ color: "#e8eaed", weight: 5, opacity: on ? 0.95 : 0.4, dashArray: "1 10", lineCap: "round" }}
            />
          </Fragment>
        );
      })}

      {/* Intermediate stops across legs */}
      {journey.legs.map((legItem, lIdx) => {
        const isLegSelected = selectedIdx === null || selectedIdx === lIdx;
        const color = legItem.lineColor;
        const stops = legItem.leg.stops ?? [];

        return stops.slice(1, -1).map((st, sIdx) => {
          if (!st.lat || !st.lon) return null;
          return (
            <CircleMarker
              key={`journey-stop-${lIdx}-${sIdx}-${st.stopId}`}
              center={[st.lat, st.lon]}
              radius={isLegSelected ? 4 : 3}
              pathOptions={{
                color,
                weight: 1.5,
                fillOpacity: isLegSelected ? 0.9 : 0.4,
                fillColor: "#ffffff",
                opacity: isLegSelected ? 0.9 : 0.4,
              }}
            >
              <Tooltip direction="top" sticky className="kb-tooltip">
                <span className="font-medium">{displayStopName(st.stopName)}</span>{" "}
                <span className="tabular-nums text-text-mute">{st.arrivalTime || st.departureTime}</span>
                <div className="text-[11px] text-text-faint">Linia {legItem.leg.line}</div>
              </Tooltip>
            </CircleMarker>
          );
        });
      })}

      {/* Transfer point markers */}
      {journey.legs.slice(0, -1).map((legItem, lIdx) => {
        const nextLeg = journey.legs[lIdx + 1]?.leg;
        const transStop = legItem.leg.stops?.[legItem.leg.stops.length - 1];
        if (!transStop || !transStop.lat || !transStop.lon) return null;

        const waitMins = nextLeg
          ? Math.max(1, Math.round((nextLeg.departureSecs - legItem.leg.arrivalSecs) / 60))
          : journey.itinerary.transferWaitMins ?? 5;

        const walk = nextLeg?.walkMins ?? 0;
        const icon = walk ? makeJourneyPinIcon("walk", `${walk} min`) : makeJourneyPinIcon("transfer", `${waitMins} min`);

        return (
          <Marker
            key={`journey-trans-${lIdx}-${transStop.stopId}`}
            position={[transStop.lat, transStop.lon]}
            icon={icon}
            zIndexOffset={250}
          >
            <Tooltip direction="top" sticky className="kb-tooltip">
              <div className="font-medium">Przesiadka: {displayStopName(transStop.stopName)}</div>
              {walk > 0 && nextLeg && (
                <div className="text-text-mute">
                  Pieszo <span className="font-medium tabular-nums text-text">{walk} min</span> do{" "}
                  {displayStopName(nextLeg.fromStopName)}
                </div>
              )}
              <div className="text-text-mute">
                Czas na przesiadkę: <span className="font-medium tabular-nums text-text">{waitMins} min</span>
              </div>
              <div className="text-[11px] tabular-nums text-text-faint">
                Linia {legItem.leg.line} ({transStop.arrivalTime}) → Linia {nextLeg?.line} ({nextLeg?.departureTime})
              </div>
            </Tooltip>
          </Marker>
        );
      })}

      {/* Origin start marker */}
      {startStop && startStop.lat && startStop.lon && (
        <Marker
          position={[startStop.lat, startStop.lon]}
          icon={makeJourneyPinIcon("start")}
          zIndexOffset={300}
        >
          <Tooltip direction="top" sticky className="kb-tooltip" permanent={false}>
            <div className="text-[11px] text-text-faint">Początek trasy</div>
            <div className="font-medium">{displayStopName(startStop.stopName)}</div>
            <div className="text-[11px] text-text-mute">
              Odjazd <span className="font-medium tabular-nums text-text">{startStop.departureTime}</span> (Linia {startLeg?.line})
            </div>
          </Tooltip>
        </Marker>
      )}

      {/* Destination end marker */}
      {endStop && endStop.lat && endStop.lon && (
        <Marker
          position={[endStop.lat, endStop.lon]}
          icon={makeJourneyPinIcon("end")}
          zIndexOffset={300}
        >
          <Tooltip direction="top" sticky className="kb-tooltip" permanent={false}>
            <div className="text-[11px] text-text-faint">Cel podróży</div>
            <div className="font-medium">{displayStopName(endStop.stopName)}</div>
            <div className="text-[11px] text-text-mute">
              Przyjazd{" "}
              <span className="font-medium tabular-nums text-text">{endStop.arrivalTime || endStop.departureTime}</span>{" "}
              (Linia {lastLeg?.line})
            </div>
          </Tooltip>
        </Marker>
      )}
    </>
  );
}

export default memo(JourneyLayer);
