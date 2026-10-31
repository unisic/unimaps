/**
 * Shared types for the kb-gtfs backend (port of the Python dataclasses and
 * HTTP response shapes).
 */

import type { KbArrivals, KbProgState } from "./kb-progress";

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
  operator?: "KB" | "MZK" | "GZM" | "BOTH";
  operators?: ("KB" | "MZK" | "GZM")[];
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
  operator?: "KB" | "MZK" | "GZM";
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
  operator?: "KB" | "MZK" | "GZM";
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
  /** seconds, negative = early; null = unknown (MZK: course not begun — see lib/mzk-state.ts) */
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
  /** MZK only: the vehicle waits at (or idles next to) the first stop of a course
   *  that has not begun. OnTime's delaySec is then a placeholder (now - scheduled
   *  start, floor -60 s), so `delay` is null instead — see lib/mzk-state.ts */
  notStarted?: boolean;
  operator?: "KB" | "MZK" | "GZM";
  sideNumber?: string;
  model?: string;
  features?: VehicleFeatures;
  /** zbiorkom: another operator's vehicle mixed into the city (lib/gzm.ts ZbRecord.agency) */
  agency?: string;
  /** zbiorkom city: a metro train placed by the timetable, not by a GPS fix (lib/gzm.ts scheduledTracks) */
  scheduled?: boolean;
  /* ---- route info for client-side motion (not part of the Python port) ---- */
  /** epoch secs the current position was (estimated to be) first reported */
  fixAt?: number;
  /** road-shape store key ("kb:<hex>" / "mzk:<variant>") */
  shapeKey?: string | null;
  /** metres along that shape, in the shared polyline metric */
  distM?: number | null;
  /** shape revision distM was measured against */
  distRev?: string;
  /** times/stopPoints index of the next stop the vehicle will arrive at */
  nextStopSeq?: number | null;
  /** cruise speed m/s, from consecutive moving fixes only */
  speed?: number | null;
  /** epoch secs of the last speed sample */
  speedAt?: number;
  /** displacement (m) of the latest distinct fix vs its predecessor */
  moveDs?: number;
  /* ---- GPS progress (lib/kb-progress.ts; KB only) ---- */
  /** parsePosition's upstream-derived delay, kept when `delay` was replaced (isStale must test this one) */
  delayUp?: number | null;
  /** set only while upstream's stop index is stale: "gps" = delay is the schedule deviation at the GPS position,
   *  "gps-held" = the last such value (bus momentarily unplaceable), "unknown" = delay withheld (null) */
  delaySrc?: "gps" | "gps-held" | "unknown";
  /** GPS-derived last passed / next stop index; set only while upstream's index is stale */
  geoLastSeq?: number | null;
  geoNextSeq?: number | null;
  /** tracker state carried across polls */
  prog?: KbProgState;
  /** KB, GZM: recorded stop arrivals (neither upstream keeps times for passed stops) */
  arrivals?: KbArrivals;
  /** KB: static timetable trip id this execution serves (learned from departures boards) */
  schedTripId?: string;
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
  operator?: "KB" | "MZK" | "GZM";
  side_number?: string;
  model?: string;
  features?: VehicleFeatures;
  /* ---- motion extras (vehicleExtras in poller-singleton; emitted only when known) ---- */
  /** "<shapeKey>.<rev6>" — road geometry from GET /api/shapes */
  shape?: string;
  /** metres along `shape` */
  dist_m?: number;
  /** epoch secs, 0.1 s — when this position was first reported */
  fix_at?: number;
  next_stop_seq?: number;
  /** cruise speed m/s */
  speed?: number;
  /* ---- GPS progress (only while upstream's stop index is stale; see lib/kb-progress.ts) ---- */
  /** "gps" | "gps-held": `delay` is the schedule deviation at the GPS position, not upstream's estimate;
   *  "unknown": upstream's estimate is known wrong and the bus can't be placed, `delay` is null */
  delay_src?: "gps" | "gps-held" | "unknown";
  /** GPS-derived index of the last stop the bus passed (use instead of `current_stop_sequence` as the progress hint) */
  geo_seq?: number;
  /** MZK course not begun (bus waiting for its departure); `delay` is null then. Emitted only when true. */
  not_started?: boolean;
  /** KB: static timetable trip id (same space as the timetable's / board's `trip_id`); MZK's `trip_id` already is one */
  sched_trip_id?: string;
  /** zbiorkom: another operator's vehicle (e.g. "OTWOCK"); its `line` is not a line of the city's feed */
  agency?: string;
  scheduled?: boolean;
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
  operator?: "KB" | "MZK" | "GZM" | "BOTH";
  operators?: ("KB" | "MZK" | "GZM")[];
  symbol?: string;
  onRequest?: boolean;
  gettingOut?: boolean;
  kbId?: string;
  mzkId?: string;
  kbDesignator?: string;
  mzkDesignator?: string;
  mzkSymbol?: string;
  /** station hub (D.A.) only: every MZK symbol whose departures the station panel lists, primary (`mzkSymbol`) first */
  mzkSymbols?: string[];
};

export interface StopsResponse {
  count: number;
  stops: WireStop[];
  /** present (true) while one operator's stop list is still missing — the client re-fetches soon */
  partial?: boolean;
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
  /** MZK + merged stop list state — informational, never affects `status` (diagnoses "MZK missing at a stop") */
  mzk_stops?: number;
  /** epoch secs of the last successful MZK getStops load (0 = never) */
  mzk_stops_loaded_at?: number;
  merged_stops?: {
    both: number;
    kb: number;
    mzk: number;
    /** one operator's list is still missing */
    partial: boolean;
    /** MZK stops with learned travel directions */
    mzk_dir_stops: number;
    /** epoch secs the current merge was computed */
    built_at: number;
  };
  /** road-shape store counters — informational, never affects `status` */
  shapes?: Record<string, unknown>;
  /** KB vehicles whose upstream stop index is currently detected stale (delay GPS-corrected) — informational */
  stale_index?: number;
  /** polls placed on the route by GPS / polls where an in-sync upstream delay still differed from the GPS schedule
   *  deviation by >= 2 min — informational (measures upstream's estimate error that the stale detector can't see) */
  gps_polls?: number;
  gps_disagree?: number;
  /** Metropolia GZM live layer + feed (lib/gzm.ts) — informational, never affects `status` */
  gzm?: Record<string, unknown>;
  /** the other zbiorkom cities resident right now (lib/gzm.ts getZb), informational */
  zb?: Record<string, unknown>;
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
