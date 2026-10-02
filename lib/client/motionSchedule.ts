/**
 * Pure scheduling helpers for the vehicle animator (no Leaflet, testable).
 */

/** Ground metres per screen pixel (Web Mercator, 256 px tiles). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 8);
}

/**
 * How often fleet markers are re-positioned: often enough that a bus at
 * 20 m/s moves ≤1 px per tick (finer steps are invisible), clamped to
 * [33, 250] ms — ~4 Hz at city zooms, near frame rate only when zoomed in.
 */
export function fleetIntervalMs(mpp: number): number {
  return Math.min(250, Math.max(33, (1000 * mpp) / 20));
}

/**
 * Next unwrapped angle: `next` (any range) moved to within ±180° of `prev`,
 * so a CSS rotate() never spins the long way round (350° → 5° becomes 365°).
 */
export function unwrapDeg(prev: number | null, next: number): number {
  if (prev === null || !Number.isFinite(prev)) return next;
  const d = ((((next - prev) % 360) + 540) % 360) - 180;
  return prev + d;
}

/**
 * Whether marker writes may run this frame. Only a zoom animation (or the
 * ~120 ms after any zoom event — pinch, flyTo frames) pauses them: Leaflet
 * places markers itself then, so our writes would be wasted. Never a sticky
 * flag — an interrupted flyTo must not freeze the buses.
 */
export function zoomGateOpen(nowMs: number, lastZoomEvtMs: number, animatingZoom: boolean): boolean {
  return !animatingZoom && nowMs - lastZoomEvtMs > 120;
}
