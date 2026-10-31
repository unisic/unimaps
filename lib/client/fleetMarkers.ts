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

/** pill centres closer than this (px, both axes) cover each other's line number: one pill "+N" for the stack */
export const STACK_DX = 32;
export const STACK_DY = 16;

/**
 * Stacks pills that cover each other (screen px): in the given order, a point within STACK_DX x STACK_DY of an
 * earlier leader joins that leader, else it leads. Returns leader id -> member ids; members are absent.
 * Grid hash, O(n). Callers pass a stable order so a stack keeps its leader from poll to poll.
 */
export function stackPills(pts: readonly { id: string; x: number; y: number }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const grid = new Map<string, { id: string; x: number; y: number }[]>();
  for (const p of pts) {
    const cx = Math.floor(p.x / STACK_DX);
    const cy = Math.floor(p.y / STACK_DY);
    let lead: string | null = null;
    for (let i = -1; i <= 1 && !lead; i++)
      for (let j = -1; j <= 1 && !lead; j++)
        for (const l of grid.get(`${cx + i},${cy + j}`) ?? [])
          if (Math.abs(l.x - p.x) < STACK_DX && Math.abs(l.y - p.y) < STACK_DY) {
            lead = l.id;
            break;
          }
    if (lead) {
      out.get(lead)!.push(p.id);
      continue;
    }
    out.set(p.id, []);
    const k = `${cx},${cy}`;
    const cell = grid.get(k);
    if (cell) cell.push(p);
    else grid.set(k, [p]);
  }
  return out;
}
