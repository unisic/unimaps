/**
 * URL <-> view-state codec for deep links. Query params only — no new routes,
 * the App Router is untouched:
 *   ?stop=<Stop.designator>   stop sheet (designator may contain ':')
 *   &exec=<trip_execution_id> live trip (ephemeral id from /api/vehicles)
 *   &trip=<tripId>            static timetable course
 *   &map=49.82196,19.04575,13 lat,lon,zoom view
 * `exec` and `trip` are separate params on purpose: they live in different id
 * spaces (see CLAUDE.md) and heuristics telling them apart would be fragile.
 * The city marker (&city=gzm) is not part of this codec: callers add it with withCity().
 */
export interface UrlState {
  stop: string | null;
  exec: string | null;
  trip: string | null;
  map: { lat: number; lon: number; zoom: number } | null;
}

export const EMPTY_URL_STATE: UrlState = { stop: null, exec: null, trip: null, map: null };

const ID_MAX = 64;

function cleanId(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 && t.length <= ID_MAX ? t : null;
}

/** Parse (and validate) a location.search string; invalid parts become null. */
export function parseUrlState(search: string): UrlState {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search);
  } catch {
    return EMPTY_URL_STATE;
  }
  let map: UrlState["map"] = null;
  const m = p.get("map");
  if (m) {
    const parts = m.split(",").map(Number);
    if (parts.length === 3) {
      const [lat, lon, zoom] = parts;
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        Number.isFinite(zoom) &&
        zoom >= 3 &&
        zoom <= 19
      ) {
        map = { lat, lon, zoom };
      }
    }
  }
  return {
    stop: cleanId(p.get("stop")),
    exec: cleanId(p.get("exec")),
    trip: cleanId(p.get("trip")),
    map,
  };
}

/** Serialize back to a "?..." search string ("" when nothing is set). */
export function buildSearch(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.stop) p.set("stop", s.stop);
  if (s.exec) p.set("exec", s.exec);
  else if (s.trip) p.set("trip", s.trip);
  if (s.map) p.set("map", `${s.map.lat.toFixed(5)},${s.map.lon.toFixed(5)},${Math.round(s.map.zoom * 100) / 100}`);
  const out = p.toString();
  return out ? `?${out}` : "";
}
