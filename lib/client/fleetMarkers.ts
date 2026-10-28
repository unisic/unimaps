/**
 * Which live vehicles VehicleLayer draws, and how. Every DOM pill is its own composited layer: with
 * GZM's ~720 pills mounted, six drags of the map spent 5.7 s in long tasks at 4x CPU throttle (real
 * GPU, 2026-10-29) and 0 ms with the pills hidden. A dense fleet is therefore drawn as canvas dots
 * while zoomed out, and as pills only around the viewport while zoomed in. A fleet the size of
 * BB's keeps every pill mounted, as before.
 * Pure (no leaflet), so it runs under node:test.
 */

/** ponytail: fleet size, not the count in view; a city with a small fleet packed into one view stays all pills */
export const DENSE_FLEET = 250;
/** below this zoom a dense fleet is dots: pills of ~360+ vehicles in view overlap into a smear anyway */
export const PILL_MIN_ZOOM = 13;

export interface LatLonBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

export function fleetMarkers<T extends { lat: number; lon: number }>(
  shown: T[],
  zoom: number,
  box: LatLonBox,
): { dots: boolean; list: T[] } {
  if (shown.length <= DENSE_FLEET) return { dots: false, list: shown };
  if (zoom < PILL_MIN_ZOOM) return { dots: true, list: shown };
  return { dots: false, list: shown.filter((v) => v.lat >= box.s && v.lat <= box.n && v.lon >= box.w && v.lon <= box.e) };
}
