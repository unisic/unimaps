import type { LatLng } from "./polyline";

export interface LineDetour {
  id: string;
  lines: string[];
  title: string;
  description: string;
  /** direction substring filter if direction-specific (e.g. "HULANKA", "JAWORZE", "SZCZYRK") */
  directionContains?: string;
  /** Bounding box or trigger area where detour applies [minLat, minLon, maxLat, maxLon] */
  triggerArea?: [number, number, number, number];
  /** Waypoints to route through instead of the standard road, in travel order */
  viaWaypoints: LatLng[];
  /** Only trips crossing the area in waypoint order detour; the other direction keeps its road. */
  oneWay?: boolean;
}

/**
 * Known prolonged detours (objazdy długoterminowe) in Komunikacja Beskidzka network.
 * Derived from active roadworks and carrier announcements.
 */
export const KNOWN_DETOURS: LineDetour[] = [
  {
    id: "bielsko-piastowska",
    // Remont ul. Piastowskiej, etap od 29.09.2026 do odwołania, tylko w kierunku Hulanki (KB announcement 15375)
    lines: ["121", "122", "123", "124", "125", "127", "129", "131", "132", "133", "134"],
    title: "Objazd: remont ul. Piastowskiej",
    description: "W kierunku Ronda Hulanka trasa ulicami Listopadową, Grunwaldzką, 3 Pułku Strzelców Podhalańskich i Konopnickiej.",
    triggerArea: [49.815, 19.030, 49.835, 19.055],
    viaWaypoints: [
      [49.823333, 19.034472], // GRUNWALDZKA SZPITAL MIEJSKI (replacement stop 11072)
      [49.820083, 19.029194], // KONOPNICKIEJ SZPITAL PEDIATRYCZNY (replacement stop 11082)
    ],
    oneWay: true,
  },
  {
    id: "osiek-beskidzka",
    // Remont ul. Karolina w Osieku od 23.03.2026 do odwołania (KB announcement 12172); the announcement
    // names no detour streets, the waypoint is the pre-existing one
    lines: ["141", "143"],
    title: "Objazd w Osieku",
    description: "Remont ul. Karolina: przystanki Włosień i Malec Granica nieobsługiwane, Włosień Bar przeniesiony na ul. Włosieńską.",
    triggerArea: [49.930, 19.240, 49.970, 19.290],
    viaWaypoints: [
      [49.9455, 19.2612], // ul. Zielona
      [49.9498, 19.2685],
    ],
  },
];

/**
 * Checks if a line has an active detour definition.
 */
export function getLineDetour(line: string, direction?: string): LineDetour | null {
  return lineDetours(line, direction)[0] ?? null;
}

function lineDetours(line: string, direction?: string): LineDetour[] {
  if (!line) return [];
  const cleanLine = line.trim();
  return KNOWN_DETOURS.filter((d) => {
    if (!d.lines.includes(cleanLine)) return false;
    if (d.directionContains && direction) {
      if (!direction.toUpperCase().includes(d.directionContains.toUpperCase())) return false;
    }
    return true;
  });
}

function approxDistanceMeters(p1: LatLng, p2: LatLng): number {
  const dLat = (p1[0] - p2[0]) * 111000;
  const dLon = (p1[1] - p2[1]) * 72000;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Injects detour waypoints into the sequence of stop coordinates if the route passes through
 * the affected detour area. A line can sit in several detours, so each one applies where the
 * trip enters its own area; `detour` is the first one that applied.
 */
export function injectDetourPoints(
  points: LatLng[],
  line?: string,
  direction?: string,
): { points: LatLng[]; detour: LineDetour | null } {
  if (!line || points.length < 2) return { points, detour: null };
  let out = points;
  let hit: LineDetour | null = null;
  for (const detour of lineDetours(line, direction)) {
    const res = applyDetour(out, detour);
    if (!res) continue;
    if (!hit || (out === points && res !== out)) hit = detour;
    out = res;
  }
  return { points: out, detour: hit };
}

/** Points with the detour applied (the same array when it only needs a banner), null when it does not apply. */
function applyDetour(points: LatLng[], detour: LineDetour): LatLng[] | null {
  const area = detour.triggerArea;
  if (!area) return points;

  // If the trip already visits all detour waypoints (e.g. the Grunwaldzka and Konopnickiej
  // replacement stops scheduled on lines 121..134), the detour is already in the timetable.
  // Do not alter points, but return the detour info for banners.
  if (
    detour.viaWaypoints.length > 0 &&
    detour.viaWaypoints.every((wp) => points.some((pt) => approxDistanceMeters(pt, wp) < 380))
  ) {
    return points;
  }

  const [minLat, minLon, maxLat, maxLon] = area;
  // Find contiguous segments of points inside triggerArea so that loop lines
  // entering and exiting the area (e.g. line 134) don't have intermediate stops wiped out.
  const segments: Array<{ start: number; end: number }> = [];
  let curStart = -1;
  for (let i = 0; i < points.length; i++) {
    const [lat, lon] = points[i];
    const inside = lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
    if (inside) {
      if (curStart === -1) curStart = i;
    } else if (curStart !== -1) {
      segments.push({ start: curStart, end: i - 1 });
      curStart = -1;
    }
  }
  if (curStart !== -1) {
    segments.push({ start: curStart, end: points.length - 1 });
  }

  // Inject into the first segment that can carry the detour, preserving all stops before and
  // after it. A single stop in the area has no leg between two of its stops to replace (the
  // waypoints would become an out-and-back spur), and the waypoints follow the travel direction:
  // reversed for a trip crossing the area the other way, skipped for a one-way detour.
  const wps = detour.viaWaypoints;
  if (wps.length === 0) return segments.length > 0 ? points : null;
  for (const seg of segments) {
    if (seg.end === seg.start) continue;
    const a = points[seg.start];
    const b = points[seg.end];
    const first = wps[0];
    const last = wps[wps.length - 1];
    const forward =
      approxDistanceMeters(a, first) + approxDistanceMeters(last, b) <=
      approxDistanceMeters(a, last) + approxDistanceMeters(first, b);
    if (!forward && detour.oneWay) continue;
    const via = forward ? wps : [...wps].reverse();
    return [...points.slice(0, seg.start + 1), ...via, ...points.slice(seg.end)];
  }
  return null;
}

/**
 * Known stop coordinate micro-adjustments for routing.
 * Some physical stop poles are placed on sidewalks or street corners closer to
 * side alleys or driveways than the main road, causing routing engines to detour
 * down residential alleys (e.g. Olimpijska in Szczyrk).
 */
export const ROUTE_STOP_ADJUSTMENTS: Record<string, LatLng> = {
  // SZCZYRK WODOSPAD (pole 21181 was snapping onto Olimpijska residential alley)
  "21181": [49.70298, 19.00137], // center of DW942 (ul. Myśliwska / Salmopolska)
  // SZCZYRK WIDOKOWA (pole 21231 was snapping onto a side driveway)
  "21231": [49.70051, 18.99644], // center of DW942
};

export function adjustStopRoutePoint(stopId: string | undefined, pt: LatLng): LatLng {
  if (!stopId) return pt;
  const adj = ROUTE_STOP_ADJUSTMENTS[stopId];
  return adj ?? pt;
}
