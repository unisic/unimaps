import type { ConnectionItinerary, ConnectionLeg, JourneyLegResolved, LatLng } from "./types";

/** A leg on the map: its road geometry once routed, its stops joined until then. */
export const legPoints = (l: JourneyLegResolved): LatLng[] =>
  l.routed && l.routed.length >= 2
    ? l.routed
    : (l.leg.stops?.flatMap((s): LatLng[] => (s.lat && s.lon ? [[s.lat, s.lon]] : [])) ?? []);

/** One piece of a journey's strip: a ride on a leg, a walk, or a wait at a transfer stop. */
export type JourneySegment =
  | { kind: "ride"; mins: number; leg: ConnectionLeg }
  | { kind: "walk"; mins: number }
  | { kind: "wait"; mins: number };

/** The journey in order, each piece with its minutes (rides at least 1): access walk, rides, the walk and the
 *  wait of each transfer, egress walk. */
export function journeySegments(it: ConnectionItinerary): JourneySegment[] {
  const out: JourneySegment[] = [];
  if (it.accessWalkMins) out.push({ kind: "walk", mins: it.accessWalkMins });
  it.legs.forEach((leg, i) => {
    if (i > 0) {
      const walk = leg.walkMins ?? 0;
      const wait = Math.round((leg.departureSecs - it.legs[i - 1].arrivalSecs) / 60) - walk;
      if (walk > 0) out.push({ kind: "walk", mins: walk });
      if (wait > 0) out.push({ kind: "wait", mins: wait });
    }
    out.push({ kind: "ride", mins: Math.max(1, Math.round((leg.arrivalSecs - leg.departureSecs) / 60)), leg });
  });
  if (it.egressWalkMins) out.push({ kind: "walk", mins: it.egressWalkMins });
  return out;
}

/** Same lines between the same poles: one route on the map, whatever the departure time. */
export const routeKey = (it: ConnectionItinerary): string =>
  it.legs.map((l) => `${l.line}|${l.fromStopId}|${l.toStopId}`).join(">");

/** The first itinerary of each distinct route, in list order, at most `max`. */
export function distinctRoutes(list: readonly ConnectionItinerary[], max: number): ConnectionItinerary[] {
  const seen = new Set<string>();
  const out: ConnectionItinerary[] = [];
  for (const it of list) {
    if (out.length >= max) break;
    const k = routeKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
