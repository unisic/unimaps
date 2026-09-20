/**
 * Shared types for the kb-gtfs backend (port of the Python dataclasses and
 * HTTP response shapes).
 */

/** A generic upstream JSON object we only loosely trust. */
export type UpstreamRecord = Record<string, unknown>;

export interface VehicleFeatures {
  airCondition?: boolean;
  lowFloor?: boolean;
  electric?: boolean;
  hydrogen?: boolean;
  hybrid?: boolean;
  longVehicle?: boolean;
  ticketMachine?: boolean;
  ecoVehicle?: boolean;
}

/** Parsed stop from GET /stops?rev=... positional arrays (port of api.Stop). */
export interface Stop {
  /** field[0]: designator string used in URLs, e.g. "19223" or "19132:39688" */
  urlId: string;
  /** field[1]: clean numeric id, e.g. 20111 */
  internalId: number;
  name: string;
  /** field[3] / 1e6 */
  lon: number;
  /** field[4] / 1e6 */
  lat: number;
  onlyDisembarking: boolean;
  isStation: boolean;
  showPlatforms: boolean;
  /** String(internalId) — Python's Stop.stop_id property. */
  stopId: string;
  operator?: "KB" | "MZK" | "BOTH";
  operators?: ("KB" | "MZK")[];
  symbol?: string;
  onRequest?: boolean;
  gettingOut?: boolean;
  kbId?: string;
  mzkId?: string;
  kbDesignator?: string;
  mzkDesignator?: string;
  mzkSymbol?: string;
  dirs?: number[];
}

export interface LineInfo {
  name: string;
  type?: string;
  operator?: "KB" | "MZK";
}

/** One entry of a trip's "times" array (port of api.TripStop). */
export interface TripStop {
  stopName: string;
  /** internal id */
  designator: number | null;
  /** url designator */
  placeId: string | null;
  /** "HH:MM" */
  departureTime: string;
  index: number;
  platform: string | null;
}

/** Parsed trip detail (port of api.Trip). */
export interface Trip {
  tripId: string;
  times: TripStop[];
  direction: string;
  lineName: string;
  lineType: string | null;
  showName: boolean;
  vehicleType: number | null;
  currentStationId: number | null;
  operator?: "KB" | "MZK";
}

/** Internal live vehicle state (port of poller.VehiclePos). */
export interface VehiclePos {
  execId: string;
  tripId: string;
  routeId: string;
  line: string;
  headsign: string;
  lat: number;
  lon: number;
  vehicleType: number;
  /** null when upstream's vehicle_trip_index is absent/invalid ("unknown") */
  currentStopSequence: number | null;
  atStop: boolean;
  /** seconds, negative = early */
  delay: number | null;
  timestamp: number;
  updatedAt: number;
  bearing: number | null;
  nextStopName: string | null;
  nextStopLat: number | null;
  nextStopLon: number | null;
  /** epoch secs when the position last moved beyond the stale epsilon */
  lastMovedAt: number;
  /** anchor the current position is measured against for movement detection */
  anchorLat: number;
  anchorLon: number;
  /** true once the vehicle has reached its final stop — the course is over, so
   *  it's hidden from the map instead of lingering with an ever-growing delay */
  finished: boolean;
  operator?: "KB" | "MZK";
  sideNumber?: string;
  model?: string;
  features?: VehicleFeatures;
}

/** Wire shape of one vehicle in GET /api/vehicles (VehiclePos.to_json()). */
export interface VehicleJson {
  id: string;
  trip_id: string;
  route_id: string;
  line: string;
  headsign: string;
  lat: number;
  lon: number;
  vehicle_type: number;
  current_stop_sequence: number | null;
  at_stop: boolean;
  delay: number | null;
  bearing: number | null;
  next_stop_name: string | null;
  next_stop_lat: number | null;
  next_stop_lon: number | null;
  timestamp: number;
  updated_at: number;
  operator?: "KB" | "MZK";
  side_number?: string;
  model?: string;
  features?: VehicleFeatures;
}

/** GET /api/vehicles response. */
export interface VehiclesResponse {
  timestamp: number;
  scan_count: number;
  last_scan: number;
  count: number;
  vehicles: VehicleJson[];
}

export type WireStop = {
  id: string;
  designator: string;
  name: string;
  lat: number;
  lon: number;
  dirs?: number[];
  isStation?: boolean;
  showPlatforms?: boolean;
  operator?: "KB" | "MZK" | "BOTH";
  operators?: ("KB" | "MZK")[];
  symbol?: string;
  onRequest?: boolean;
  gettingOut?: boolean;
  kbId?: string;
  mzkId?: string;
  kbDesignator?: string;
  mzkDesignator?: string;
  mzkSymbol?: string;
};

export interface StopsResponse {
  count: number;
  stops: WireStop[];
}

/** GET /api/health response. "degraded" (served as HTTP 503) = the scan loop
 *  stalled or upstream contact went stale — never keyed on the vehicle count
 *  (0 vehicles overnight is normal). */
export interface HealthResponse {
  status: "ok" | "degraded";
  stops: number;
  scan_count: number;
  last_scan: number;
  /** live vehicle count (frozen ghosts excluded) */
  vehicles: number;
  /** internally tracked vehicles, including deliberately hidden ghosts */
  tracked: number;
  last_refresh: number;
  /** epoch secs of the last proven upstream contact */
  last_good_refresh: number;
  feed_age_secs: number;
  loop_restarts: number;
  last_loop_error: string | null;
  /** epoch secs of the last successful stop-list load */
  stops_loaded_at: number;
}

/** One row of an upstream departures board (loosely typed). */
export interface DepartureRow extends UpstreamRecord {
  trip_execution_id?: unknown;
  trip_id?: unknown;
  time?: unknown;
  static_time?: unknown;
}

/** One stop's departures block inside GET /api/departures?places=... */
export interface StopDepartures extends UpstreamRecord {
  designator?: unknown;
  rows?: unknown;
}

/** GET /api/departures?places=... upstream response. */
export interface MultiDeparturesResponse extends UpstreamRecord {
  departures?: unknown;
}

/** One entry of trip.times inside a trip_execution response. */
export interface TripTimeEntry extends UpstreamRecord {
  stop_name?: unknown;
  designator?: unknown;
  place_id?: unknown;
  departure_time?: unknown;
  trip_id?: unknown;
  estimate?: unknown;
}

/** GET /api/trip_execution/<b64>/<index> upstream response (loosely typed). */
export interface TripExecutionResponse extends UpstreamRecord {
  trip?: unknown;
  vehicle?: unknown;
  vehicle_trip_index?: unknown;
  next_departure_index?: unknown;
  at_stop?: unknown;
  estimates?: unknown;
  timestamp?: unknown;
  vehicle_type?: unknown;
  trip_id?: unknown;
}
