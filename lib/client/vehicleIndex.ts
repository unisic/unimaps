import type { DepartureRow, Vehicle } from "@/lib/client/types";
import { schedTripKey, vehicleTripKey } from "@/lib/shared/departures";

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
