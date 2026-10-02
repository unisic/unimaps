/** Shared client-side types mirroring the /api/* contract. */

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

export interface Vehicle {
  id: string;
  trip_id: string;
  route_id: string;
  line: string;
  headsign: string;
  lat: number;
  lon: number;
  vehicle_type: number;
  /** positional index of the vehicle's current stop; null when unknown upstream */
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
  /* motion extras — present only when the server knows them */
  /** "<shapeKey>.<rev6>" — road geometry from GET /api/shapes */
  shape?: string;
  /** metres along `shape` */
  dist_m?: number;
  /** epoch secs when this position was first reported */
  fix_at?: number;
  next_stop_seq?: number;
  /** cruise speed, m/s */
  speed?: number;
}

export interface VehiclesResponse {
  timestamp: number;
  scan_count: number;
  last_scan: number;
  count: number;
  vehicles: Vehicle[];
}

export interface Stop {
  id: string;
  designator: string;
  name: string;
  lat: number;
  lon: number;
  /** up to two GTFS-derived travel bearings (deg) buses leave this stop on */
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
}

export interface StopsResponse {
  count: number;
  stops: Stop[];
}

/** Static GTFS line catalog entry (from /api/lines). */
export interface LineInfo {
  /** GTFS route_id, e.g. "L_102" */
  id: string;
  /** rider-facing line number, e.g. "102" */
  name: string;
  /** route_long_name — the terminus, e.g. "KANIÓW" */
  terminus: string;
  operator?: "KB" | "MZK";
}

export interface LinesResponse {
  count: number;
  lines: LineInfo[];
}

/** Upstream departures passthrough row. */
export interface DepartureRow {
  trip_execution_id?: string;
  trip_id?: number | string;
  static_time?: string;
  time?: string;
  time_diff?: number;
  is_estimated?: boolean;
  direction?: string;
  platform?: string;
  line_name?: string;
  symbol?: string;
  operator?: "KB" | "MZK";
  side_number?: string;
  model?: string;
  features?: VehicleFeatures;
}

export interface DeparturesResponse {
  rows?: DepartureRow[];
}

export interface TimetableDeparture {
  trip_id: number | string;
  departure: number;
  platform?: string;
  line?: string;
  direction?: string;
  operator?: "KB" | "MZK";
}

export interface TimetableResponse {
  departures?: TimetableDeparture[];
  main_direction?: { name?: string };
}

export interface TripTime {
  stop_name: string;
  designator?: number;
  place_id?: string;
  departure_time: string;
  index: number;
  platform?: string;
  estimate?: { time_diff?: number };
}

export interface Trip {
  times?: TripTime[];
  direction?: string;
  line?: { name?: string };
  operator?: "KB" | "MZK";
  shape?: LatLng[];
  /** stored road geometry id (GET /api/shapes) */
  shape_id?: string;
  shape_status?: ShapeStatus;
}

/** road: stored shape available · pending: being routed · none: no road geometry */
export type ShapeStatus = "road" | "pending" | "none";

export interface TripExecutionResponse {
  trip?: Trip;
  vehicle?: { lat: number; lon: number };
  vehicle_trip_index?: number;
  shape?: LatLng[];
  shape_id?: string;
  shape_status?: ShapeStatus;
}

/** One upstream service announcement (utrudnienia/objazdy). Despite the field
 *  name the content is plain text with \n breaks, not markdown. */
export interface Announcement {
  id: number;
  rev: number;
  content_markdown: string;
}

export interface AnnouncementsResponse {
  announcements?: Announcement[];
  /** changes whenever the announcement set changes — drives unread tracking */
  hash?: string;
}

export type LatLng = [number, number];

/** Resolved trip stop: schedule entry + matched physical stop. */
export interface TripStopResolved {
  t: TripTime;
  s: Stop;
  selected: boolean;
}

export type TripStatus = "loading" | "routing" | "ready" | "error";

/** All state describing the currently drawn trip route. */
export interface TripView {
  gen: number;
  isLive: boolean;
  status: TripStatus;
  /** Extra notice, e.g. vehicle has not departed yet. */
  note: string | null;
  line: string;
  direction: string;
  rawTimes: TripTime[];
  stops: TripStopResolved[];
  vehicle: { lat: number; lon: number } | null;
  vti: number | null;
  stop: Stop | null;
  routed: LatLng[] | null;
  /** upstream trip-execution id — lets the live /api/vehicles poll keep the
   *  drawn vehicle's position, heading and current stop fresh while the route
   *  is open (matched by Vehicle.id). null for static (rozkładowy) trips. */
  execId: string | null;
  /** GTFS trip id for static routes — matches live vehicles sharing this trip */
  tripId?: string | number | null;
  operator?: "KB" | "MZK";
  /** stored road-shape id `routed` came from (null = browser routing / straight) */
  shapeId?: string | null;
  /** the server's shape reference for this trip (kept so a rebuild can reuse it) */
  routeHint?: { id?: string; status?: ShapeStatus } | null;
}

export interface ConnectionLegStop {
  stopId: string;
  stopName: string;
  arrivalTime: string;
  departureTime: string;
  lat?: number;
  lon?: number;
}

export interface ConnectionLeg {
  line: string;
  tripId: string;
  headsign: string;
  fromStopId: string;
  fromStopName: string;
  toStopId: string;
  toStopName: string;
  departureTime: string;
  arrivalTime: string;
  departureSecs: number;
  arrivalSecs: number;
  durationMins: number;
  stopsCount: number;
  stops?: ConnectionLegStop[];
  /** stored road geometry of the leg's trip (GET /api/shapes) */
  shape_id?: string;
}

export interface ConnectionItinerary {
  type: "direct" | "transfer";
  departureTime: string;
  arrivalTime: string;
  departureSecs: number;
  arrivalSecs: number;
  totalDurationMins: number;
  transfersCount: number;
  transferWaitMins?: number;
  transferStopName?: string;
  date?: string;
  dayLabel?: string;
  arrivesNextDay?: boolean;
  legs: ConnectionLeg[];
}

export interface ConnectionsResponse {
  count: number;
  connections: ConnectionItinerary[];
}

export interface JourneyLegResolved {
  leg: ConnectionLeg;
  routed: LatLng[] | null;
  lineColor: string;
}

export interface JourneyView {
  gen: number;
  itinerary: ConnectionItinerary;
  fromStop: Stop | null;
  toStop: Stop | null;
  legs: JourneyLegResolved[];
  selectedLegIdx: number | null;
  status: "routing" | "ready";
}

