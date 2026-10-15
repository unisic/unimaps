"use client";

import L from "leaflet";
import { easeSpring, glideSeconds, prefersReducedMotion } from "@/lib/client/motion";

/** Leaflet's own frame plumbing, the one flyTo drives (stable across 1.x). A move parks its
 *  frame id in `_flyToFrame`, so `_stop()`, which every drag, pinch, wheel zoom and
 *  setView/flyTo/fitBounds calls first, cancels it exactly like a flyTo. */
type FrameMap = L.Map & {
  _flyToFrame?: number;
  _stop(): L.Map;
  _move(center: L.LatLng, zoom: number): L.Map;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): L.Map;
  _moveEnd(zoomChanged: boolean): L.Map;
  _animateZoom(center: L.LatLng, zoom: number): void;
  _getCenterOffset(latlng: L.LatLng): L.Point;
};

/** A vector renderer: `_onZoomEnd` re-projects its paths, `_update` redraws them for the view. */
type PathRenderer = L.Renderer & { _update(): void; _onZoomEnd(): void };

/** Farther than this many screens a straight glide smears unloaded tiles: fly out and back in. */
const FLY_SCREENS = 3;
/** Vector renderers pre-draw at most this many screens around the view: every straight glide. */
const MAX_PAD = FLY_SCREENS;
/** During a flyTo vector renderers draw this much around the view, redrawn every REDRAW_MS. */
const FLY_PAD = 0.5;
const REDRAW_MS = 80;
/** px the floating top bar covers (TripLayer pads routes the same) */
const TOP_BAR = 80;
/** right edge of the docked desktop panel: left-3 + w-[400px] (BottomSheet) */
const PANEL_RIGHT = 412;
/** a point this close to the sheet/panel edge counts as covered */
const EDGE = 24;

/** The move in flight per map, closed by `cut` when a drag, pinch, wheel or new move stops it. */
const running = new WeakMap<L.Map, { cut: () => void }>();
const installed = new WeakSet<L.Map>();

/** Container point a focused stop or bus should land on: the middle of the map left visible by
 *  the desktop panel (any `cover` > 0) or the mobile sheet (`cover` = viewport fraction it covers). */
export function focusPoint(map: L.Map, desktop: boolean, cover: number): L.Point {
  const { x: w, y: h } = map.getSize();
  if (cover <= 0) return L.point(w / 2, h / 2);
  return desktop ? L.point((PANEL_RIGHT + w) / 2, h / 2) : L.point(w / 2, (TOP_BAR + h * (1 - cover)) / 2);
}

/** Whether container point `p` sits under the top bar or the panel/sheet `cover` describes. */
export function isCovered(map: L.Map, desktop: boolean, cover: number, p: L.Point): boolean {
  if (p.y < TOP_BAR) return true;
  if (cover <= 0) return false;
  return desktop ? p.x < PANEL_RIGHT + EDGE : p.y > map.getSize().y * (1 - cover) - EDGE;
}

/**
 * Replace Leaflet's CSS zoom animation (wheel, double tap, the +/- buttons, keyboard, pinch
 * release, animated setView/fitBounds) with frame-by-frame zooming around the same point. The
 * CSS one scales a stale basemap canvas, blank at the edges when zooming out until it ends; per
 * frame the GL map renders the real view, as during a pinch. Idempotent.
 */
export function installSmoothZoom(map: L.Map): void {
  if (installed.has(map)) return;
  installed.add(map);
  const m = map as FrameMap;
  const stop = m._stop;
  m._stop = function () {
    const cur = running.get(m);
    running.delete(m);
    cur?.cut();
    return stop.call(m);
  };
  // called after _moveStart (by _tryAnimatedZoom, or the pinch that began the zoom)
  m._animateZoom = (center, zoom) => {
    const dz = zoom - m.getZoom();
    if (Math.abs(dz) < 1e-6 || prefersReducedMotion()) {
      m._move(center, zoom);
      m._moveEnd(true);
      return;
    }
    // Leaflet's zoom origin, the one point the zoom leaves in place
    const o = m
      .getSize()
      .divideBy(2)
      .add(m._getCenterOffset(center).divideBy(1 - 1 / m.getZoomScale(zoom)));
    zoomFrames(m, m.containerPointToLatLng(o), o, o, zoom, center, glideSeconds(0, dz) * 1000);
  };
}

function renderers(m: L.Map): PathRenderer[] {
  const out: PathRenderer[] = [];
  m.eachLayer((l) => {
    if (l instanceof L.Renderer) out.push(l as PathRenderer);
  });
  return out;
}

/**
 * Have every vector renderer (routes, stop dots) draw `pad` screens around the view: Leaflet draws
 * only the view + 10% and redraws on moveend, so a route sliding or zooming into view would show
 * up only after the move. Returns the undo; `redraw` re-fits the renderers to the current view (a
 * cut move, no moveend coming to do it).
 */
function growPaths(m: L.Map, pad: number): (redraw: boolean) => void {
  const grown: [PathRenderer, number | undefined][] = [];
  for (const l of renderers(m)) {
    if (pad <= (l.options.padding ?? 0.1)) continue;
    grown.push([l, l.options.padding]);
    l.options.padding = pad;
    l._update();
  }
  return (redraw) => {
    for (const [l, pad] of grown) {
      l.options.padding = pad;
      if (redraw) l._update();
    }
  };
}

/** Screens around today's view that the view at `center`/`zoom` reaches: what to pre-draw. */
function padFor(m: L.Map, center: L.LatLng, zoom: number): number {
  const size = m.getSize();
  const c = m.latLngToContainerPoint(center);
  // half the end view, in today's pixels
  const r = size.divideBy(2 * m.getZoomScale(zoom));
  return Math.min(
    MAX_PAD,
    Math.max((r.x - c.x) / size.x, (c.x + r.x) / size.x - 1, (r.y - c.y) / size.y, (c.y + r.y) / size.y - 1),
  );
}

/** `ll` slides on a straight screen line from `p0` to `at` while the zoom eases to `zoom`, landing
 *  exactly on `end`; each frame re-projects like flyTo and pinch do. Caller fired _moveStart. */
function zoomFrames(m: FrameMap, ll: L.LatLng, p0: L.Point, at: L.Point, zoom: number, end: L.LatLng, ms: number) {
  const z0 = m.getZoom();
  const dz = zoom - z0;
  const half = m.getSize().divideBy(2);
  const shift = at.subtract(p0);
  // the map centre that puts `ll` at container point `p` at zoom `z`
  const centerFor = (p: L.Point, z: number) => m.unproject(m.project(ll, z).subtract(p).add(half), z);
  const restore = growPaths(m, padFor(m, end, zoom));
  running.set(m, {
    cut: () => {
      // the GL basemap waits for zoomend to follow pans again
      m.fire("zoomend");
      restore(true);
    },
  });
  const t0 = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - t0) / ms);
    if (t < 1) {
      const e = easeSpring(t);
      const z = z0 + dz * e;
      m._flyToFrame = requestAnimationFrame(frame);
      m._move(centerFor(p0.add(shift.multiplyBy(e)), z), z);
      return;
    }
    running.delete(m);
    restore(false);
    m._move(end, zoom);
    m._moveEnd(true);
  };
  m._flyToFrame = requestAnimationFrame(frame);
}

/**
 * Bring `target` to container point `at` at `zoom`: the target slides along a straight screen
 * line while the zoom eases in step, on the sheet's spring curve, 0.3-0.6 s by distance. No
 * zoom-out arc (flyTo's hop) unless the target is over FLY_SCREENS away. Same zoom: the map pane
 * slides (Leaflet's own pan path, the GL basemap just moves).
 */
export function glideTo(map: L.Map, target: L.LatLngExpression, zoom: number, at: L.Point): void {
  installSmoothZoom(map);
  const m = map as FrameMap;
  m._stop();
  const ll = L.latLng(target);
  const size = m.getSize();
  const half = size.divideBy(2);
  const p0 = m.latLngToContainerPoint(ll);
  const end = m.unproject(m.project(ll, zoom).subtract(at).add(half), zoom);
  const screens = p0.distanceTo(at) / Math.min(size.x, size.y);
  if (prefersReducedMotion()) {
    m.setView(end, zoom, { animate: false });
    return;
  }
  if (screens > FLY_SCREENS) {
    m.flyTo(end, zoom, { duration: 0.8 });
    // the flight zooms out and back in: keep the route drawn for the view along the way, Leaflet
    // would redraw it only after landing
    const restore = growPaths(m, FLY_PAD);
    let last = performance.now();
    const onZoom = () => {
      const now = performance.now();
      if (now - last < REDRAW_MS) return;
      last = now;
      for (const l of renderers(m)) {
        l._onZoomEnd();
        l._update();
      }
    };
    const done = () => {
      m.off("zoom", onZoom).off("moveend", done);
      running.delete(m);
      restore(true);
    };
    m.on("zoom", onZoom).on("moveend", done);
    running.set(m, { cut: done });
    return;
  }
  const dz = zoom - m.getZoom();
  if (!dz && p0.distanceTo(at) < 1) return;
  const ms = glideSeconds(screens, dz) * 1000;

  if (dz) {
    m._moveStart(true, false);
    zoomFrames(m, ll, p0, at, zoom, end, ms);
    return;
  }

  const pane = m.getPanes().mapPane;
  const from = L.DomUtil.getPosition(pane);
  const shift = at.subtract(p0);
  const restore = growPaths(m, padFor(m, end, zoom));
  running.set(m, { cut: () => restore(true) });
  m.fire("movestart");
  const t0 = performance.now();
  const pan = (now: number) => {
    const t = Math.min(1, (now - t0) / ms);
    const pos = from.add(shift.multiplyBy(easeSpring(t)));
    L.DomUtil.setPosition(pane, t < 1 ? pos : pos.round());
    m.fire("move");
    if (t < 1) {
      m._flyToFrame = requestAnimationFrame(pan);
      return;
    }
    running.delete(m);
    restore(false);
    m.fire("moveend");
  };
  m._flyToFrame = requestAnimationFrame(pan);
}
