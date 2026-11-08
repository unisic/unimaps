<script lang="ts">
  import L from "leaflet";
  import { onDestroy, untrack } from "svelte";

  import { el, KeyedLayers, ROUTE_CASING, routeLine, routeStop } from "@/components/leafletLayers";
  import { displayStopName, formatPlatform, isBusStation, isMzk, operatorColor, transitMode, withoutRequestTail } from "@/lib/client/format";
  import { makeVehicleIcon } from "@/lib/client/leafletIcons";
  import { prefersReducedMotion } from "@/lib/client/motion";
  import { smoothRoute, snapStopsOnto } from "@/lib/shared/polyline";
  import { smoothMotion } from "@/lib/client/smoothMotion";
  import type { LatLng, Stop, TripView, Vehicle } from "@/lib/client/types";
  import { acquireVehicleAnimator, releaseVehicleAnimator, type VehicleAnimator } from "@/lib/client/vehicleAnimator";

  /** Animator view id of the tracked bus (fleet views are keyed by vehicle id). */
  const TRACKED = "trip:tracked";

  let {
    map,
    trip,
    desktop,
    vehMeta,
    liveVehicle,
    onSelectStop,
  }: {
    map: L.Map;
    trip: TripView | null;
    /** md+: the panel docks left, so pad fitBounds on that side */
    desktop: boolean;
    /** vehicle the trip was opened from: drawn as a fallback so a tapped bus is
     *  never invisible while its route loads or when the exec reports no position */
    vehMeta: Vehicle | null;
    /** fresh position/heading from the live poll (matched by exec id); drives the
     *  marker so the tracked bus keeps moving while its route is open */
    liveVehicle: Vehicle | null;
    /** a tapped stop circle: the stop markers are hidden while a trip is open, so these open the stop */
    onSelectStop: (s: Stop) => void;
  } = $props();

  /* last non-null live fix: if the vehicle drops off the poll mid-view
   * (finished/pruned) the marker holds there instead of teleporting back to
   * the opening snapshot; keyed by trip generation (not execId) so closing and
   * reopening the same exec starts clean instead of resurrecting an old fix */
  const gen = $derived(trip?.gen ?? -1);
  let lastLiveHeld: { gen: number; veh: Vehicle } | null = null;
  const lastLive = $derived.by((): Vehicle | null => {
    if (liveVehicle) {
      lastLiveHeld = { gen, veh: liveVehicle };
      return liveVehicle;
    }
    return lastLiveHeld && lastLiveHeld.gen === gen ? lastLiveHeld.veh : null;
  });

  const tripOp = $derived(trip?.operator ?? lastLive?.operator ?? vehMeta?.operator);
  const isMzkTrip = $derived(isMzk(tripOp, trip?.line));
  const lineColor = $derived(trip ? operatorColor(tripOp, trip.line === "…" ? null : trip.line) : "");
  const op = $derived<"KB" | "MZK" | "GZM">(tripOp === "GZM" ? "GZM" : isMzkTrip ? "MZK" : "KB");

  /* The tracked bus marker. A live fleet vehicle: an animator view bound to
   * the SAME track as its fleet marker (it continues from where it was drawn,
   * no jump on open/close); otherwise a fixed marker at the exec's opening fix
   * or the clicked vehicle. Icons key on primitives only: the heading arrow
   * is rotated by the animator, so no setIcon (and no pop) on turns. */
  const trackId = $derived(lastLive?.id ?? null);
  const iconLine = $derived.by((): string | null => {
    if (!trip) return null;
    if (lastLive || trip.vehicle) return trip.line;
    // fallback to the clicked vehicle (live only), with its own line + heading
    return trip.isLive && vehMeta ? vehMeta.line || trip.line : null;
  });
  const iconHeading = $derived.by((): boolean => {
    if (!trip) return false;
    // a shape gives a heading only through the motion engine (smooth motion off = raw bearing)
    if (lastLive) return lastLive.bearing != null || (smoothMotion.current && lastLive.shape != null);
    return !trip.vehicle && trip.isLive && vehMeta != null && vehMeta.bearing != null;
  });
  const sched = $derived(lastLive?.scheduled === true);
  const mode = $derived(transitMode(op, (lastLive ?? vehMeta)?.vehicle_type));
  const iconKey = $derived(
    iconLine === null ? null : `${iconLine}|${lineColor}|${op}|${mode}|${iconHeading ? 1 : 0}|${sched ? 1 : 0}`,
  );
  const staticLat = $derived(trip?.vehicle?.lat ?? (trip?.isLive && vehMeta ? vehMeta.lat : null));
  const staticLon = $derived(trip?.vehicle?.lon ?? (trip?.isLive && vehMeta ? vehMeta.lon : null));
  const staticHeading = $derived(vehMeta?.bearing ?? null);

  /* stop names sit above the route and the markers (600), the tracked bus above the names, both below the
     tooltips (650) */
  const LABEL_PANE = "tripStopLabels";
  const BUS_PANE = "tripVehicle";
  for (const [name, z] of [
    [LABEL_PANE, "620"],
    [BUS_PANE, "630"],
  ] as const) {
    // svelte-ignore state_referenced_locally
    if (!map.getPane(name)) map.createPane(name).style.zIndex = z;
  }

  let animator: VehicleAnimator | null = null;
  let tracked: { marker: L.Marker; key: string } | null = null;

  $effect(() => {
    const anim = acquireVehicleAnimator(map);
    animator = anim;
    return () => {
      anim.removeView(TRACKED);
      tracked?.marker.remove();
      tracked = null;
      animator = null;
      releaseVehicleAnimator(map);
    };
  });

  $effect(() => {
    const anim = animator;
    if (!anim) return;
    // the raw live fix only seeds a brand-new marker: tracking it would re-run this on every poll
    const [liveLat, liveLon] = untrack(() => [lastLive?.lat ?? null, lastLive?.lon ?? null]);
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
      tracked?.marker.remove();
      tracked = null;
      return;
    }
    const heading = iconHeading ? (live?.heading ?? staticHeading ?? 0) : null;
    let cur = tracked;
    if (!cur) {
      const marker = L.marker(pos, {
        icon: makeVehicleIcon(iconLine, lineColor, heading, op, mode, sched),
        pane: BUS_PANE,
        keyboard: false,
      }).addTo(map);
      cur = { marker, key: iconKey };
      tracked = cur;
    } else if (cur.key !== iconKey) {
      cur.marker.setIcon(makeVehicleIcon(iconLine, lineColor, heading, op, mode, sched));
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
  });

  /* follow the drawn route, unless it IS the fleet shape the track already uses or the course has not begun */
  const tripRoute = $derived(trip?.routed ?? null);
  const tripShapeId = $derived(trip?.shapeId ?? null);
  const liveShape = $derived(lastLive?.shape ?? null);
  const liveNotStarted = $derived(lastLive?.not_started === true);
  const tripStops = $derived(trip?.stops);
  const rawTimes = $derived(trip?.rawTimes);
  /* the circles sit ON the drawn line, as zbiorkom.live draws them: a pole stands at the kerb, 5-30 m off the road's
     centre line the route follows */
  const stopPts = $derived((tripStops ?? []).map(({ s }): LatLng => [s.lat, s.lon]));
  /* no sharp edges (smoothRoute); once per route: a live refresh keeps the route's identity and only moves the stops */
  const routed = $derived(tripRoute && tripRoute.length >= 2 ? smoothRoute(tripRoute, untrack(() => stopPts)) : tripRoute);
  const stopAt = $derived(routed && routed.length >= 2 ? snapStopsOnto(routed, stopPts) : stopPts);
  $effect(() => {
    const anim = animator;
    const id = trackId;
    if (!anim || id === null || !routed || routed.length < 2 || !tripStops || !rawTimes) return;
    if (liveNotStarted || (tripShapeId && tripShapeId === liveShape)) return;
    const key = `trip:${gen}`;
    // stop coords aligned with the trip's times (current_stop_sequence indexes them)
    const byTime = new Map(tripStops.map((r) => [r.t, r.s]));
    const refs = rawTimes.map((t): LatLng | null => {
      const st = byTime.get(t);
      return st ? [st.lat, st.lon] : null;
    });
    anim.setTripShape(key, routed, refs);
    anim.overrideShape(id, key);
    return () => anim.overrideShape(id, null);
  });

  // Fit bounds once per drawn trip, after routing settles: padded so the
  // route is not hidden under the sheet (mobile) or the panel (desktop).
  const fitGen = $derived(trip?.status === "ready" ? trip.gen : null);
  $effect(() => {
    if (fitGen === null) return;
    untrack(() => {
      if (!trip) return;
      // opened by tapping the bus, or from a stop while the bus is on the map: MapApp already zoomed in on it,
      // the whole route would zoom back out
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
      // the CSS reduced-motion reset can't reach Leaflet's JS-driven pan: gate it here
      const reduce = prefersReducedMotion();
      // a single point makes zero-size bounds: fitBounds would compute zoom Infinity
      map.getContainer().classList.add("map-moving");
      if (pts.length === 1) {
        map.setView(pts[0], 16, { animate: !reduce, duration: reduce ? 0 : 0.9 });
        return;
      }
      map.fitBounds(L.latLngBounds(pts), { ...opts, maxZoom: 17, animate: !reduce, duration: reduce ? 0 : 0.9 });
    });
  });

  // svelte-ignore state_referenced_locally
  const layers = new KeyedLayers(map);
  onDestroy(() => layers.clear());


  /** below this zoom only the selected stop and the termini are named: a whole route's names would bury the basemap */
  const ALL_NAMES_ZOOM = 13;
  /** names in placement priority: 0 the selected stop, 1 the termini, 2 the rest in route order */
  let labels: { rank: number; label: L.Tooltip }[] = [];
  /** Greedy decluttering: a name that would overlap one already shown is hidden. Pixel distances change only with the
   *  zoom, so it runs per drawn trip and on zoomend; all reads before all writes, one forced layout per pass. */
  const declutter = () => {
    const few = map.getZoom() < ALL_NAMES_ZOOM;
    const rects = labels.map(({ rank, label }) => (few && rank > 1 ? null : (label.getElement()?.getBoundingClientRect() ?? null)));
    const shown: DOMRect[] = [];
    const covered = rects.map((r) => {
      if (!r) return true;
      const hit = shown.some((o) => r.left < o.right + 2 && o.left < r.right + 2 && r.top < o.bottom && o.top < r.bottom);
      if (!hit) shown.push(r);
      return hit;
    });
    labels.forEach(({ label }, i) => label.getElement()?.classList.toggle("is-covered", covered[i]));
  };
  $effect(() => {
    map.on("zoomend", declutter);
    return () => {
      map.off("zoomend", declutter);
    };
  });

  /* the route and its stops; a re-run updates the drawn layers in place (no rebuild, z-order kept) */
  $effect(() => {
    const color = lineColor;
    // the names take the route's colour (.route-stop-label)
    map.getPane(LABEL_PANE)?.style.setProperty("--route-c", color);
    const pts = routed;
    if (pts && pts.length >= 2) {
      const casing = layers.put(
        "casing",
        () => L.polyline(pts, ROUTE_CASING),
        (l) => l.setLatLngs(pts),
      );
      const line = routeLine(color);
      const route = layers.put(
        "route",
        () => L.polyline(pts, line),
        (l) => l.setLatLngs(pts).setStyle(line),
      );
      // the route usually arrives after the stops: a new layer lands on top and would bury their circles
      route.bringToBack();
      casing.bringToBack();
    }
    const stops = tripStops ?? [];
    const ranked: { rank: number; label: L.Tooltip }[] = [];
    stops.forEach(({ t, s, selected }, i) => {
      const center = stopAt[i];
      const style: L.CircleMarkerOptions = selected ? { ...routeStop("#ffd54a"), radius: 8 } : routeStop(color);
      const tip = () => {
        const platform = formatPlatform(t.platform, isBusStation(t.stop_name, s));
        return el("span", "", `${displayStopName(t.stop_name)} · ${t.departure_time}${platform ? ` (${platform})` : ""}`);
      };
      const key = `${gen}-${t.index}-${s.id}`;
      layers.put(
        key,
        () =>
          L.circleMarker(center, style)
            .bindTooltip(tip, { direction: "top", sticky: true, className: "kb-tooltip" })
            .on("click", () => onSelectStop(s)),
        (m) => m.setLatLng(center).setStyle(style).getTooltip()?.setContent(tip),
      );
      const label = layers.put(
        `${key}-name`,
        () =>
          L.tooltip(center, {
            content: el("span", "", withoutRequestTail(displayStopName(t.stop_name))),
            direction: "bottom",
            // + leaflet's 6 px margin: the name starts 12 px below the stop, clear of its circle (9.5 px when selected)
            offset: [0, 6],
            opacity: 1,
            // a non-permanent tooltip closes on any map click (preclick) and KeyedLayers would never re-add it
            permanent: true,
            pane: LABEL_PANE,
            className: "route-stop-label",
          }),
        (l) => l.setLatLng(center),
      );
      ranked.push({ rank: selected ? 0 : i === 0 || i === stops.length - 1 ? 1 : 2, label });
    });
    layers.sweep();
    labels = ranked.sort((a, b) => a.rank - b.rank);
    declutter();
  });
</script>
