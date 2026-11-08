<script lang="ts">
  import L from "leaflet";
  import { onDestroy, untrack } from "svelte";

  import { el, KeyedLayers, ROUTE_CASING, routeLine, routeStop } from "@/components/leafletLayers";
  import { displayStopName, operatorColor } from "@/lib/client/format";
  import { prefersReducedMotion } from "@/lib/client/motion";
  import { loadShapeLatest } from "@/lib/client/shapes";
  import { smoothRoute, snapStopsOnto } from "@/lib/shared/polyline";
  import type { LatLng, LineInfo, LineVariant, Stop } from "@/lib/client/types";

  /** The open line view's pattern on the map: the stored road shape (straight stop-to-stop until it exists), stops tappable. */
  let {
    map,
    line,
    variant,
    desktop,
    resolveStop,
    onSelectStop,
  }: {
    map: L.Map;
    line: LineInfo | null;
    /** the pattern the line view shows; null = nothing drawn */
    variant: LineVariant | null;
    desktop: boolean;
    resolveStop: (id: string) => Stop | null;
    onSelectStop: (s: Stop) => void;
  } = $props();

  let road = $state.raw<{ id: string; pts: LatLng[] } | null>(null);
  const shapeId = $derived(variant?.shape ?? null);
  $effect(() => {
    if (!shapeId) return;
    const id = shapeId;
    let live = true;
    void loadShapeLatest(id).then((s) => {
      if (live && s) road = { id, pts: s.pts };
    });
    return () => {
      live = false;
    };
  });

  const stops = $derived(
    (variant?.stops ?? []).flatMap((s) => (s.lat != null && s.lon != null ? [{ ...s, lat: s.lat, lon: s.lon }] : [])),
  );
  const stopPts = $derived(stops.map((s): LatLng => [s.lat, s.lon]));
  const pts = $derived<LatLng[]>(road && road.id === shapeId ? smoothRoute(road.pts, untrack(() => stopPts)) : stopPts);
  // the circles sit ON the road shape (TripLayer's stopAt)
  const stopAt = $derived(pts === stopPts ? stopPts : snapStopsOnto(pts, stopPts));

  // frame the pattern once per variant, clear of the sheet (mobile) / the panel (desktop)
  $effect(() => {
    const list = stops;
    if (list.length < 2) return;
    untrack(() => {
      const opts: L.FitBoundsOptions = desktop
        ? { paddingTopLeft: [440, 60], paddingBottomRight: [60, 40] }
        : { paddingTopLeft: [24, 80], paddingBottomRight: [24, Math.round(window.innerHeight * 0.3)] };
      const reduce = prefersReducedMotion();
      map.getContainer().classList.add("map-moving");
      map.fitBounds(L.latLngBounds(list.map((s): LatLng => [s.lat, s.lon])), {
        ...opts,
        maxZoom: 16,
        animate: !reduce,
        duration: reduce ? 0 : 0.9,
      });
    });
  });

  // svelte-ignore state_referenced_locally
  const layers = new KeyedLayers(map);
  onDestroy(() => layers.clear());

  $effect(() => {
    if (variant && pts.length >= 2) {
      const path = pts;
      const color = operatorColor(line?.operator, line?.name);
      layers.put(
        "casing",
        () => L.polyline(path, ROUTE_CASING),
        (l) => l.setLatLngs(path),
      );
      const route = routeLine(color);
      layers.put(
        "route",
        () => L.polyline(path, route),
        (l) => l.setLatLngs(path).setStyle(route),
      );
      const style = routeStop(color);
      stops.forEach((s, i) => {
        const center = stopAt[i];
        const tip = () => el("span", "", displayStopName(s.name));
        layers.put(
          `${s.id}-${i}`,
          () =>
            L.circleMarker(center, style)
              .bindTooltip(tip, { direction: "top", sticky: true, className: "kb-tooltip" })
              .on("click", () => {
                const st = resolveStop(s.id);
                if (st) onSelectStop(st);
              }),
          (m) => m.setLatLng(center).setStyle(style).getTooltip()?.setContent(tip),
        );
      });
    }
    layers.sweep();
  });
</script>
