"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";

/**
 * Renders an OpenFreeMap vector style (MapLibre GL) as the Leaflet base layer —
 * the same free, keyless, crisp basemap zbiorkom.live uses. The GL canvas draws
 * into Leaflet's `tilePane` (z-index 200), so vehicle/stop markers and trip
 * routes stay on top untouched.
 */
export type BasemapStatus = "loading" | "ready" | "failed";

type GlMap = {
  once(type: "idle" | "styledata" | "load" | "render", fn: () => void): unknown;
  on(type: "error" | "styleimagemissing" | "render", fn: (e?: { id?: string }) => void): unknown;
  off(type: "idle" | "error" | "styledata" | "styleimagemissing" | "load" | "render", fn: (e?: { id?: string }) => void): unknown;
  isStyleLoaded(): boolean;
  areTilesLoaded(): boolean;
  resize(): unknown;
  hasImage?(id: string): boolean;
  addImage?(id: string, image: { width: number; height: number; data: Uint8Array }): unknown;
};

const EMPTY_SPRITE_IMAGE = {
  width: 1,
  height: 1,
  data: new Uint8Array(4), // transparent 1x1 pixel fallback for missing sprite icons
};
type MaplibreGLLayer = L.Layer & {
  getContainer: () => HTMLDivElement;
  getMaplibreMap: () => GlMap;
};
type MaplibreGLFactory = (opts: {
  style: string;
  attribution?: string;
  /** bridge option: render this fraction of the viewport beyond each edge so
   *  panning reveals already-drawn map instead of blank tiles */
  padding?: number;
  /** bridge option: ms between GL re-centres while the map moves (default 32) */
  updateInterval?: number;
  /** maplibre Map options — forwarded verbatim into `new maplibregl.Map()` */
  fadeDuration?: number;
  maxTileCacheSize?: number;
  refreshExpiredTiles?: boolean;
}) => MaplibreGLLayer;

const OFM_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> ' +
  'Data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap</a>';

/** style JSON never arrived after this long → give up and let the caller fall back */
const STYLE_TIMEOUT_MS = 5_000;

export default function VectorBaseLayer({
  style,
  filter,
  onStatus,
}: {
  style: string;
  /** CSS filter applied to the basemap canvas only (e.g. "brightness(.8)") */
  filter?: string;
  /** basemap readiness for the caller's loading veil / raster fallback;
   *  must be useCallback-stable — it is an effect dependency */
  onStatus?: (s: BasemapStatus) => void;
}) {
  const map = useMap();

  useEffect(() => {
    const maplibreGL = (L as unknown as { maplibreGL: MaplibreGLFactory }).maplibreGL;
    const layer = maplibreGL({
      style,
      attribution: OFM_ATTRIBUTION,
      // ---- smoothness tuning ----
      // moderate padding: keep enough margin for fluid panning without overloading initial network download
      padding: 0.08,
      // re-centre every frame: at 32 ms a fast glide or fling outruns the padding by a frame or two
      updateInterval: 16,
      // no cross-fade: freshly loaded tiles snap in instead of ghosting for 300ms
      fadeDuration: 0,
      // keep lots of already-rendered tiles so zoom-out/in & back-pan are instant
      maxTileCacheSize: 1024,
      // don't re-download still-valid tiles mid-session
      refreshExpiredTiles: false,
    }) as MaplibreGLLayer;
    layer.addTo(map);
    // filter the GL container, not the markers/routes in the other panes
    const container = layer.getContainer();
    container.style.filter = filter ?? "";

    /* readiness: style loaded + first paint frame rendered = visible map.
       We do NOT block on areTilesLoaded() across the entire surrounding region,
       allowing the progressive vector basemap to display immediately. */
    onStatus?.("loading");
    const gl = layer.getMaplibreMap(); // _glMap exists synchronously after addTo
    let settled = false;
    const settle = (s: BasemapStatus) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      onStatus?.(s);
    };

    const checkReady = () => {
      if (settled) return;
      if (gl.isStyleLoaded()) settle("ready");
    };

    const onIdle = () => {
      if (settled) return;
      if (gl.isStyleLoaded()) settle("ready");
      else gl.once("idle", onIdle);
    };

    const onRender = () => {
      if (settled) return;
      if (gl.isStyleLoaded()) settle("ready");
    };

    let styleArrived = false;
    const onStyleData = () => {
      styleArrived = true;
      requestAnimationFrame(checkReady);
    };
    gl.once("styledata", onStyleData);
    gl.once("load", checkReady);
    gl.on("render", onRender);
    gl.once("idle", onIdle);

    const onErr = () => {
      if (!styleArrived) settle("failed");
    };
    const timer = window.setTimeout(
      () => settle(gl.isStyleLoaded() ? "ready" : "failed"),
      STYLE_TIMEOUT_MS,
    );
    const onImageMissing = (e?: { id?: string }) => {
      const id = e?.id;
      if (!id) return;
      try {
        if (!gl.hasImage || !gl.hasImage(id)) {
          gl.addImage?.(id, EMPTY_SPRITE_IMAGE);
        }
      } catch {
        // ignore duplicate addImage
      }
    };
    gl.on("styleimagemissing", onImageMissing);
    gl.on("error", onErr);
    /* re-measure once layout settles (dvh on mobile) — a canvas created from a
       stale container size renders a mis-sized patch until something resizes */
    const raf = requestAnimationFrame(() => {
      if (!settled) gl.resize();
    });

    return () => {
      // unhook GL listeners before removeLayer — onRemove nulls the GL map
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      gl.off("styleimagemissing", onImageMissing);
      gl.off("idle", onIdle);
      gl.off("render", onRender);
      gl.off("load", checkReady);
      gl.off("error", onErr);
      gl.off("styledata", onStyleData);
      map.removeLayer(layer);
    };
  }, [map, style, filter, onStatus]);

  return null;
}
