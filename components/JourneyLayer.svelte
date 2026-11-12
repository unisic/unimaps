<script lang="ts">
  import L from "leaflet";
  import { onDestroy } from "svelte";

  import { el, KeyedLayers } from "@/components/leafletLayers";
  import { walkRoute, walkRouteNow } from "@/lib/client/api";
  import { displayStopName } from "@/lib/client/format";
  import { legPoints } from "@/lib/client/journey";
  import { makeJourneyLineIcon, makeJourneyPinIcon } from "@/lib/client/leafletIcons";
  import { prefersReducedMotion } from "@/lib/client/motion";
  import { pointAt, preparePolyline } from "@/lib/shared/polyline";
  import type { JourneyView, LatLng } from "@/lib/client/types";

  let {
    map,
    journey,
    desktop,
    fit = true,
  }: {
    map: L.Map;
    journey: JourneyView | null;
    desktop: boolean;
    /** frame the journey (or its selected leg) when it changes; off for the search preview, framed with all the routes */
    fit?: boolean;
  } = $props();

  const TIP: L.TooltipOptions = { direction: "top", sticky: true, className: "kb-tooltip" };

  const selectedIdx = $derived(journey?.selectedLegIdx ?? null);
  /* bumped when a footpath lands, so the walk redraws along it */
  let walksLanded = $state(0);

  // Determine points for bounds fitting
  const allPoints = $derived.by(() => {
    if (!journey) return [];
    return journey.legs.flatMap((l, lIdx) => (selectedIdx === null || selectedIdx === lIdx ? legPoints(l) : []));
  });

  // Fit bounds once per journey and selected leg: the routed legs replace the journey object
  // ~1 s later and must not yank back a map the user has started moving
  let fitted: string | null = null;
  $effect(() => {
    if (!fit || !allPoints.length) return;
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
      (m) => {
        // a new icon is a new element: one per redraw would cut a pin's entrance short
        if ((m.options.icon?.options as L.DivIconOptions | undefined)?.html !== icon.options.html) m.setIcon(icon);
        m.setLatLng(at).setZIndexOffset(zIndexOffset).getTooltip()?.setContent(tip);
      },
    );

  /* the entrance of a new generation: each leg draws from its first stop to its last, one after another (time split
     by the ride minutes), its stops and pins arriving as the line reaches them. WAAPI, so a redraw mid-way (the road
     geometry landing) keeps running; reduced motion skips it */
  const DRAW_MS = 450;
  const MIN_LEG_MS = 120;
  // --ease-out-soft and --ease-spring: WAAPI takes no var()
  const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
  const EASE_SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";
  let enteredGen: number | null = null;

  function sweep(p: L.Path, delay: number, duration: number): void {
    const e = p.getElement();
    if (!e) return;
    for (const a of e.getAnimations()) a.cancel();
    // the dash pattern in path-length units: one dash as long as the line, its offset walks it in
    e.setAttribute("pathLength", "1");
    const a = e.animate(
      [
        { strokeDasharray: "1 1", strokeDashoffset: 1 },
        { strokeDasharray: "1 1", strokeDashoffset: 0 },
      ],
      { duration, delay, easing: EASE_OUT, fill: "backwards" },
    );
    a.onfinish = () => e.removeAttribute("pathLength");
  }
  function arrive(e: Element | undefined, delay: number, pop: boolean): void {
    if (!e) return;
    for (const a of e.getAnimations()) a.cancel();
    e.animate(pop ? [{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }], {
      duration: pop ? 300 : 200,
      delay,
      easing: pop ? EASE_SPRING : EASE_OUT,
      fill: "backwards",
    });
  }
  const pinIn = (m: L.Marker, delay: number) => arrive(m.getElement()?.firstElementChild ?? undefined, delay, true);
  // when the eased sweep reaches fraction f of its line: EASE_OUT read as quint-out, 1 - (1 - u)^5 = f
  const reach = (f: number) => 1 - Math.pow(1 - f, 0.2);

  function draw(journey: JourneyView, selectedIdx: number | null): void {
    const enter = journey.gen !== enteredGen && !!journey.enter && !prefersReducedMotion();
    enteredGen = journey.gen;
    const weight = journey.legs.map((l) => Math.max(60, l.leg.arrivalSecs - l.leg.departureSecs));
    const total = weight.reduce((a, b) => a + b, 0);
    const slots: { at: number; ms: number }[] = [];
    for (const w of weight) {
      const at = slots.length ? slots[slots.length - 1].at + slots[slots.length - 1].ms : 0;
      slots.push({ at, ms: Math.max(MIN_LEG_MS, (DRAW_MS * w) / total) });
    }
    const end = slots.length ? slots[slots.length - 1].at + slots[slots.length - 1].ms : 0;

    const startLeg = journey.legs[0]?.leg;
    const startStop = startLeg?.stops?.[0];
    const lastLeg = journey.legs[journey.legs.length - 1]?.leg;
    const endStop = lastLeg?.stops?.[lastLeg.stops.length - 1];

    // Route polylines per leg
    journey.legs.forEach((legItem, lIdx) => {
      const isLegSelected = selectedIdx === null || selectedIdx === lIdx;
      const color = legItem.lineColor;
      const pts = legPoints(legItem);
      if (pts.length < 2) return;
      const slot = slots[lIdx];
      // Casing line
      const casing = line(`journey-leg-${lIdx}-casing`, pts, {
        color: "#0d1013",
        className: "route-casing",
        weight: isLegSelected ? 9 : 6,
        opacity: isLegSelected ? 0.85 : 0.35,
        lineCap: "round",
        lineJoin: "round",
      });
      // Colored route line
      const route = line(`journey-leg-${lIdx}`, pts, {
        color,
        weight: isLegSelected ? 5 : 3.5,
        opacity: isLegSelected ? 0.95 : 0.4,
        lineCap: "round",
        lineJoin: "round",
      });
      if (enter) {
        sweep(casing, slot.at, slot.ms);
        sweep(route, slot.at, slot.ms);
      }
      if (!isLegSelected) return;
      const { line: name, headsign } = legItem.leg;
      // halfway along the line: the middle vertex sits wherever the shape is densest
      const pl = preparePolyline(pts);
      const mid = pl ? pointAt(pl, pl.length / 2) : null;
      const label = pin(`journey-line-${lIdx}`, mid ? [mid.lat, mid.lon] : pts[pts.length >> 1], makeJourneyLineIcon(name, color), 200, () =>
        el("div", "font-medium", `Linia ${name} → ${displayStopName(headsign)}`),
      );
      // the number lands as the line passes the middle, where it sits
      if (enter) pinIn(label, slot.at + slot.ms * reach(0.5));
    });

    // Walks between the alighting pole and the next boarding pole: along the footpaths once they arrive, a straight
    // dotted line until then (or when the foot router fails)
    journey.legs.slice(1).forEach(({ leg }, i) => {
      const from = journey.legs[i].leg.stops?.at(-1);
      const to = leg.stops?.[0];
      if (!leg.walkMins || !from?.lat || !from.lon || !to?.lat || !to.lon) return;
      const on = selectedIdx === null || selectedIdx === i || selectedIdx === i + 1;
      const a: LatLng = [from.lat, from.lon];
      const b: LatLng = [to.lat, to.lon];
      let pts = walkRouteNow(a, b);
      if (!pts) {
        pts = [a, b];
        void walkRoute(a, b).then((path) => {
          if (path) walksLanded++;
        });
      }
      // same dash period as the dots, so each dot gets a rim in the map's contrast colour
      const rim = line(`journey-walk-${i}-casing`, pts, { color: "#0d1013", className: "route-casing", weight: 8, opacity: on ? 0.85 : 0.35, dashArray: "1 10", lineCap: "round" });
      const dots = line(`journey-walk-${i}`, pts, { color: "#e8eaed", className: "route-walk", weight: 5, opacity: on ? 0.95 : 0.4, dashArray: "1 10", lineCap: "round" });
      if (enter) {
        arrive(rim.getElement(), slots[i + 1].at, false);
        arrive(dots.getElement(), slots[i + 1].at, false);
      }
    });

    // Intermediate stops across legs
    journey.legs.forEach((legItem, lIdx) => {
      const isLegSelected = selectedIdx === null || selectedIdx === lIdx;
      const color = legItem.lineColor;
      const stops = legItem.leg.stops ?? [];
      const slot = slots[lIdx];
      stops.slice(1, -1).forEach((st, sIdx) => {
        if (!st.lat || !st.lon) return;
        const stop = dot(
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
        if (enter) arrive(stop.getElement(), slot.at + slot.ms * reach((sIdx + 1) / (stops.length - 1)), false);
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

      const at = pin(`journey-trans-${lIdx}-${transStop.stopId}`, [transStop.lat, transStop.lon], icon, 250, () =>
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
      if (enter) pinIn(at, slots[lIdx].at + slots[lIdx].ms);
    });

    // Origin start marker
    if (startStop && startStop.lat && startStop.lon) {
      const start = pin("journey-start", [startStop.lat, startStop.lon], makeJourneyPinIcon("start"), 300, () =>
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
      if (enter) pinIn(start, 0);
    }

    // Destination end marker
    if (endStop && endStop.lat && endStop.lon) {
      const finish = pin("journey-end", [endStop.lat, endStop.lon], makeJourneyPinIcon("end"), 300, () =>
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
      // the destination lands when the line reaches it
      if (enter) pinIn(finish, end);
    }
  }

  /* layers keyed like the old JSX children: a re-run (routed legs, another selected leg) updates them in place */
  $effect(() => {
    void walksLanded;
    if (journey) draw(journey, selectedIdx);
    layers.sweep();
  });
</script>
