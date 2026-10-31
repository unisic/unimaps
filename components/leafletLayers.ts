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
  put<T extends L.Layer>(key: string, create: () => T, update: (layer: T) => void): void {
    this.seen.add(key);
    const cur = this.live.get(key) as T | undefined;
    if (cur) update(cur);
    else this.live.set(key, create().addTo(this.map));
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

/** Tooltip DOM: strings become text nodes (upstream names are never parsed as HTML, as a Leaflet string would be). */
export function el(tag: string, className: string, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...kids);
  return e;
}
