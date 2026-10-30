import { haversineMeters } from "@/lib/client/geo";
import type { ConnectionLeg, DepartureRow, Vehicle } from "@/lib/client/types";
import { SAME_VISIT_SEC, schedTripKey, vehicleTripKey, warsawDayTs } from "@/lib/shared/departures";

/** The running fleet keyed every way a departure row can name its bus. */
export interface VehicleIndex {
  byExec: Map<string, Vehicle>;
  byTrip: Map<string, Vehicle>;
  /** the timetable trip each running bus serves (MZK: its course; KB: the static id the server
      learned from the departures boards), so a timetable row can show its bus */
  bySched: Map<string, Vehicle>;
}

export function indexVehicles(vehicles: readonly Vehicle[] | undefined): VehicleIndex {
  const idx: VehicleIndex = { byExec: new Map(), byTrip: new Map(), bySched: new Map() };
  for (const v of vehicles ?? []) {
    if (v.id) idx.byExec.set(v.id, v);
    if (v.trip_id) idx.byTrip.set(String(v.trip_id), v);
    const k = vehicleTripKey(v);
    if (k) idx.bySched.set(k, v);
  }
  return idx;
}

/** The bus serving a live departure row, or null. */
export function rowVehicle(row: DepartureRow, idx: VehicleIndex): Vehicle | null {
  return (
    (row.trip_execution_id ? idx.byExec.get(row.trip_execution_id) : null) ??
    (row.trip_id != null ? (idx.byTrip.get(String(row.trip_id)) ?? idx.bySched.get(schedTripKey(row.trip_id))) : null) ??
    null
  );
}

/** The bus running a connection leg on the searched day, or null (the trip id repeats every day). */
export function legVehicle(leg: ConnectionLeg, date: string | undefined, idx: VehicleIndex): Vehicle | null {
  const planTs = date ? warsawDayTs(date, leg.departureSecs) : null;
  if (planTs == null) return null;
  const id = String(leg.tripId);
  // KB legs carry the built feed's "<upstream id>_<service>" trip id, the bus the bare upstream id
  const v = idx.bySched.get(schedTripKey(leg.operator === "KB" ? id.split("_", 1)[0] : id));
  return v && Math.abs(planTs - v.updated_at) < SAME_VISIT_SEC ? v : null;
}

/** A transfer the live delays break: the feeder arrives (plus the walk) after the next bus leaves.
 *  `delays[i]` = leg i's current delay in seconds, null = no live data (the plan holds). */
export function transferAtRisk(legs: readonly ConnectionLeg[], delays: readonly (number | null)[]): boolean {
  return legs.some((l, i) => {
    if (i === 0 || (delays[i - 1] == null && delays[i] == null)) return false;
    const arrive = legs[i - 1].arrivalSecs + (delays[i - 1] ?? 0) + (l.walkMins ?? 0) * 60;
    return l.departureSecs + (delays[i] ?? 0) < arrive;
  });
}

/** same pole: the bus's next stop and the leg's stop come from one operator source; twin poles of a loop are 14 m+ apart */
const POLE_M = 10;
const ALIGHT_NEAR_M = 300;
const ALIGHT_WINDOW_SEC = 180;

/** "Wysiadasz na następnym": the leg's bus heads for the leg's last pole, or (KB's stop index can freeze
 *  for minutes) is within ALIGHT_NEAR_M of it inside the last ALIGHT_WINDOW_SEC before its delayed arrival.
 *  The time gate keeps a loop's way out, past the twin pole, from firing. */
export function alightSoon(leg: ConnectionLeg, date: string | undefined, v: Vehicle): boolean {
  const pole = leg.stops?.at(-1);
  if (pole?.lat == null || pole.lon == null) return false;
  if (v.next_stop_lat != null && v.next_stop_lon != null && haversineMeters(pole.lat, pole.lon, v.next_stop_lat, v.next_stop_lon) <= POLE_M)
    return true;
  const eta = date ? warsawDayTs(date, leg.arrivalSecs) : null;
  return (
    eta != null &&
    eta + (v.delay ?? 0) - v.updated_at <= ALIGHT_WINDOW_SEC &&
    haversineMeters(pole.lat, pole.lon, v.lat, v.lon) <= ALIGHT_NEAR_M
  );
}
