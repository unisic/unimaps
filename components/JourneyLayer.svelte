<script lang="ts">
  import L from "leaflet";
  import { onDestroy } from "svelte";

  import { el, KeyedLayers } from "@/components/leafletLayers";
  import { displayStopName } from "@/lib/client/format";
  import { makeJourneyPinIcon } from "@/lib/client/leafletIcons";
  import { prefersReducedMotion } from "@/lib/client/motion";
  import type { JourneyView, LatLng } from "@/lib/client/types";

  let { map, journey, desktop }: { map: L.Map; journey: JourneyView | null; desktop: boolean } = $props();

  const TIP: L.TooltipOptions = { direction: "top", sticky: true, className: "kb-tooltip" };

  const selectedIdx = $derived(journey?.selectedLegIdx ?? null);

  // Determine points for bounds fitting
  const allPoints = $derived.by(() => {
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
  });

  // Fit bounds once per journey and selected leg: the routed legs replace the journey object
  // ~1 s later and must not yank back a map the user has started moving
  let fitted: string | null = null;
  $effect(() => {
    if (!allPoints.length) return;
    const fitKey = `${journey?.gen}:${selectedIdx}`;
    if (fitted === fitKey) return;
    fitted = fitKey;
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
  });

  // svelte-ignore state_referenced_locally
  const layers = new KeyedLayers(map);
  onDestroy(() => layers.clear());

  const line = (key: string, pts: LatLng[], style: L.PolylineOptions) =>
    layers.put(
      key,
      () => L.polyline(pts, style),
      (l) => l.setLatLngs(pts).setStyle(style),
    );
  const dot = (key: string, center: LatLng, radius: number, style: L.PathOptions, tip: () => HTMLElement) =>
    layers.put(
      key,
      () => L.circleMarker(center, { ...style, radius }).bindTooltip(tip, TIP),
      (m) => m.setLatLng(center).setRadius(radius).setStyle(style).getTooltip()?.setContent(tip),
    );
  const pin = (key: string, at: LatLng, icon: L.DivIcon, zIndexOffset: number, tip: () => HTMLElement) =>
    layers.put(
      key,
      () => L.marker(at, { icon, zIndexOffset }).bindTooltip(tip, TIP),
      (m) => m.setLatLng(at).setIcon(icon).setZIndexOffset(zIndexOffset).getTooltip()?.setContent(tip),
    );

  function draw(journey: JourneyView, selectedIdx: number | null): void {
    const startLeg = journey.legs[0]?.leg;
    const startStop = startLeg?.stops?.[0];
    const lastLeg = journey.legs[journey.legs.length - 1]?.leg;
    const endStop = lastLeg?.stops?.[lastLeg.stops.length - 1];

    // Route polylines per leg
    journey.legs.forEach((legItem, lIdx) => {
      const isLegSelected = selectedIdx === null || selectedIdx === lIdx;
      const color = legItem.lineColor;
      const pts: LatLng[] =
        legItem.routed && legItem.routed.length >= 2
          ? legItem.routed
          : (legItem.leg.stops?.flatMap((s): LatLng[] => (s.lat && s.lon ? [[s.lat, s.lon]] : [])) ?? []);
      if (pts.length < 2) return;
      // Casing line
      line(`journey-leg-${lIdx}-casing`, pts, {
        color: "#0d1013",
        weight: isLegSelected ? 9 : 6,
        opacity: isLegSelected ? 0.85 : 0.35,
        lineCap: "round",
        lineJoin: "round",
      });
      // Colored route line
      line(`journey-leg-${lIdx}`, pts, {
        color,
        weight: isLegSelected ? 5 : 3.5,
        opacity: isLegSelected ? 0.95 : 0.4,
        lineCap: "round",
        lineJoin: "round",
      });
    });

    // Walks between the alighting pole and the next boarding pole: a straight dotted line (no footpath geometry)
    journey.legs.slice(1).forEach(({ leg }, i) => {
      const from = journey.legs[i].leg.stops?.at(-1);
      const to = leg.stops?.[0];
      if (!leg.walkMins || !from?.lat || !from.lon || !to?.lat || !to.lon) return;
      const on = selectedIdx === null || selectedIdx === i || selectedIdx === i + 1;
      const pts: LatLng[] = [
        [from.lat, from.lon],
        [to.lat, to.lon],
      ];
      // same dash period as the dots, so each dot gets a dark rim
      line(`journey-walk-${i}-casing`, pts, { color: "#0d1013", weight: 8, opacity: on ? 0.85 : 0.35, dashArray: "1 10", lineCap: "round" });
      line(`journey-walk-${i}`, pts, { color: "#e8eaed", weight: 5, opacity: on ? 0.95 : 0.4, dashArray: "1 10", lineCap: "round" });
    });

    // Intermediate stops across legs
    journey.legs.forEach((legItem, lIdx) => {
      const isLegSelected = selectedIdx === null || selectedIdx === lIdx;
      const color = legItem.lineColor;
      const stops = legItem.leg.stops ?? [];
      stops.slice(1, -1).forEach((st, sIdx) => {
        if (!st.lat || !st.lon) return;
        dot(
          `journey-stop-${lIdx}-${sIdx}-${st.stopId}`,
          [st.lat, st.lon],
          isLegSelected ? 4 : 3,
          {
            color,
            weight: 1.5,
            fillOpacity: isLegSelected ? 0.9 : 0.4,
            fillColor: "#ffffff",
            opacity: isLegSelected ? 0.9 : 0.4,
          },
          () =>
            el(
              "div",
              "",
              el("span", "font-medium", displayStopName(st.stopName)),
              " ",
              el("span", "tabular-nums text-text-mute", st.arrivalTime || st.departureTime),
              el("div", "text-[11px] text-text-faint", `Linia ${legItem.leg.line}`),
            ),
        );
      });
    });

    // Transfer point markers
    journey.legs.slice(0, -1).forEach((legItem, lIdx) => {
      const nextLeg = journey.legs[lIdx + 1]?.leg;
      const transStop = legItem.leg.stops?.[legItem.leg.stops.length - 1];
      if (!transStop || !transStop.lat || !transStop.lon) return;

      const waitMins = nextLeg
        ? Math.max(1, Math.round((nextLeg.departureSecs - legItem.leg.arrivalSecs) / 60))
        : (journey.itinerary.transferWaitMins ?? 5);

      const walk = nextLeg?.walkMins ?? 0;
      const icon = walk ? makeJourneyPinIcon("walk", `${walk} min`) : makeJourneyPinIcon("transfer", `${waitMins} min`);

      pin(`journey-trans-${lIdx}-${transStop.stopId}`, [transStop.lat, transStop.lon], icon, 250, () =>
        el(
          "div",
          "",
          el("div", "font-medium", `Przesiadka: ${displayStopName(transStop.stopName)}`),
          ...(walk > 0 && nextLeg
            ? [
                el(
                  "div",
                  "text-text-mute",
                  "Pieszo ",
                  el("span", "font-medium tabular-nums text-text", `${walk} min`),
                  " do ",
                  displayStopName(nextLeg.fromStopName),
                ),
              ]
            : []),
          el("div", "text-text-mute", "Czas na przesiadkę: ", el("span", "font-medium tabular-nums text-text", `${waitMins} min`)),
          el(
            "div",
            "text-[11px] tabular-nums text-text-faint",
            `Linia ${legItem.leg.line} (${transStop.arrivalTime}) → Linia ${nextLeg?.line ?? ""} (${nextLeg?.departureTime ?? ""})`,
          ),
        ),
      );
    });

    // Origin start marker
    if (startStop && startStop.lat && startStop.lon) {
      pin("journey-start", [startStop.lat, startStop.lon], makeJourneyPinIcon("start"), 300, () =>
        el(
          "div",
          "",
          el("div", "text-[11px] text-text-faint", "Początek trasy"),
          el("div", "font-medium", displayStopName(startStop.stopName)),
          el(
            "div",
            "text-[11px] text-text-mute",
            "Odjazd ",
            el("span", "font-medium tabular-nums text-text", startStop.departureTime),
            ` (Linia ${startLeg?.line ?? ""})`,
          ),
        ),
      );
    }

    // Destination end marker
    if (endStop && endStop.lat && endStop.lon) {
      pin("journey-end", [endStop.lat, endStop.lon], makeJourneyPinIcon("end"), 300, () =>
        el(
          "div",
          "",
          el("div", "text-[11px] text-text-faint", "Cel podróży"),
          el("div", "font-medium", displayStopName(endStop.stopName)),
          el(
            "div",
            "text-[11px] text-text-mute",
            "Przyjazd ",
            el("span", "font-medium tabular-nums text-text", endStop.arrivalTime || endStop.departureTime),
            ` (Linia ${lastLeg?.line ?? ""})`,
          ),
        ),
      );
    }
  }

  /* layers keyed like the old JSX children: a re-run (routed legs, another selected leg) updates them in place */
  $effect(() => {
    if (journey) draw(journey, selectedIdx);
    layers.sweep();
  });
</script>
