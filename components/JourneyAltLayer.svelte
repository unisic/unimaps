<script lang="ts">
  import L from "leaflet";
  import { onDestroy } from "svelte";

  import { el, KeyedLayers } from "@/components/leafletLayers";
  import { legPoints, routeKey } from "@/lib/client/journey";
  import { prefersReducedMotion } from "@/lib/client/motion";
  import type { ConnectionItinerary, JourneyLegResolved } from "@/lib/client/types";

  /** Every route of a search, muted, under the chosen one (JourneyLayer): a click opens that route's journey. The
   *  chosen route is drawn here too, hidden under its own casing, so a hover down the list redraws nothing here. */
  let {
    map,
    routes,
    active,
    fit,
    onPick,
  }: {
    map: L.Map;
    routes: readonly { it: ConnectionItinerary; legs: JourneyLegResolved[] }[];
    /** the drawn journey: a click on its route opens this departure, not the route's first one */
    active: ConnectionItinerary | null;
    /** frame them all, once per result list (the desktop search panel) */
    fit: boolean;
    onPick: (it: ConnectionItinerary) => void;
  } = $props();

  const TIP: L.TooltipOptions = { direction: "top", sticky: true, className: "kb-tooltip" };
  const ROUND = { lineCap: "round", lineJoin: "round" } as const;
  const CASING: L.PolylineOptions = { ...ROUND, color: "#0d1013", className: "route-casing", weight: 7, opacity: 0.6, interactive: false };
  const LINE: L.PolylineOptions = { ...ROUND, className: "journey-alt", weight: 4, opacity: 0.6, interactive: false };
  const LINE_HOT: L.PolylineOptions = { ...LINE, opacity: 1 };
  // transparent and wide: a finger can hit a 4 px line
  const HIT: L.PolylineOptions = { ...ROUND, weight: 22, opacity: 0 };
  // --ease-out-soft
  const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

  let fitted: ConnectionItinerary | null = null;
  $effect(() => {
    const first = routes[0]?.it ?? null;
    if (!fit || !first || first === fitted) return;
    const pts = routes.flatMap((r) => r.legs.flatMap(legPoints));
    if (pts.length < 2) return;
    fitted = first;
    const reduce = prefersReducedMotion();
    map.getContainer().classList.add("map-moving");
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [440, 60],
      paddingBottomRight: [60, 40],
      maxZoom: 16,
      animate: !reduce,
      duration: reduce ? 0 : 0.9,
    });
  });

  // svelte-ignore state_referenced_locally
  const layers = new KeyedLayers(map);
  onDestroy(() => layers.clear());
  /* per route key, rebuilt each pass: the layers outlive a result list, the handlers read the current one */
  const pick = new Map<string, ConnectionItinerary>();
  const lines = new Map<string, L.Polyline[]>();
  const hot = (key: string, on: boolean) => lines.get(key)?.forEach((l) => l.setStyle(on ? LINE_HOT : LINE));

  function tip(key: string): HTMLElement {
    const it = pick.get(key);
    if (!it) return el("div", "");
    return el(
      "div",
      "",
      el("div", "font-medium", it.legs.map((l) => l.line).join(" › ")),
      el("div", "tabular-nums text-text-mute", `${it.departureTime} → ${it.arrivalTime} · ${it.totalDurationMins} min`),
    );
  }

  $effect(() => {
    pick.clear();
    for (const { it } of routes) {
      const key = routeKey(it);
      pick.set(key, active && routeKey(active) === key ? active : it);
    }
  });

  $effect(() => {
    const fade = !prefersReducedMotion();
    lines.clear();
    for (const { it, legs } of routes) {
      const key = routeKey(it);
      const own: L.Polyline[] = [];
      lines.set(key, own);
      legs.forEach((leg, i) => {
        const pts = legPoints(leg);
        if (pts.length < 2) return;
        const made: L.Polyline[] = [];
        const put = (part: string, style: L.PolylineOptions, init?: (p: L.Polyline) => L.Polyline) =>
          layers.put(
            `${key}#${i}-${part}`,
            () => {
              const p = L.polyline(pts, style);
              made.push(p);
              return init ? init(p) : p;
            },
            (p) => p.setLatLngs(pts),
          );
        const hit = put("hit", HIT, (p) =>
          p
            .bindTooltip(() => tip(key), TIP)
            .on("click", () => {
              const cur = pick.get(key);
              if (cur) onPick(cur);
            })
            .on("mouseover", () => hot(key, true))
            .on("mouseout", () => hot(key, false)),
        );
        own.push(put("line", LINE));
        put("casing", CASING);
        // under everything drawn already (the chosen route above all); each goes to the back, so the casing ends lowest
        for (const p of made) {
          p.bringToBack();
          // decoration: fades in place while the chosen route draws in
          if (fade && p !== hit)
            p.getElement()?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 150, easing: EASE_OUT, fill: "backwards" });
        }
      });
    }
    layers.sweep();
  });
</script>
