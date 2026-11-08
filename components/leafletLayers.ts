import type L from "leaflet";

/**
 * Keyed map layers, the way react-leaflet's keyed children behaved: each pass `put`s the layers it wants by key. A
 * known key is updated in place (setLatLngs / setStyle keep its place in the SVG z-order and rebuild nothing), a new
 * one is created and added on top, and `sweep()` removes every key the pass did not put.
 */
export class KeyedLayers {
  private readonly map: L.Map;
  private readonly live = new Map<string, L.Layer>();
  private readonly seen = new Set<string>();

  constructor(map: L.Map) {
    this.map = map;
  }

  /** A key always maps to the layer type its `create` returns. */
  put<T extends L.Layer>(key: string, create: () => T, update: (layer: T) => void): T {
    this.seen.add(key);
    const cur = this.live.get(key) as T | undefined;
    if (cur) {
      update(cur);
      return cur;
    }
    const made = create().addTo(this.map);
    this.live.set(key, made);
    return made;
  }

  sweep(): void {
    for (const [key, layer] of this.live) {
      if (this.seen.has(key)) continue;
      layer.remove();
      this.live.delete(key);
    }
    this.seen.clear();
  }

  clear(): void {
    for (const layer of this.live.values()) layer.remove();
    this.live.clear();
    this.seen.clear();
  }
}

/** A drawn route: the line over a casing in the map's contrast colour (.route-casing), 2 px of it on each side. */
export const ROUTE_CASING: L.PolylineOptions = { color: "#0d1013", className: "route-casing", weight: 10, opacity: 0.85, lineCap: "round", lineJoin: "round" };
export const routeLine = (color: string): L.PolylineOptions => ({ color, weight: 6, opacity: 1, lineCap: "round", lineJoin: "round" });
/** A stop on a drawn route: a ring in the line colour around a fill in the map's contrast colour (.route-stop), wider than the casing. */
export const routeStop = (color: string): L.CircleMarkerOptions => ({ color, weight: 3, radius: 5.5, opacity: 1, fillColor: "#0d1013", fillOpacity: 1, className: "route-stop" });

/** Tooltip DOM: strings become text nodes (upstream names are never parsed as HTML, as a Leaflet string would be). */
export function el(tag: string, className: string, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...kids);
  return e;
}
