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
  operator?: "KB" | "MZK" | "GZM";
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
  /** timetable pace m/s along `shape` around `dist_m` (dwell included) */
  sched_speed?: number;
  /** present only while upstream's stop index is stale: `delay` is then the schedule deviation at the GPS
   *  position ("gps"/"gps-held") or withheld ("unknown") */
  delay_src?: "gps" | "gps-held" | "unknown";
  /** GPS-derived index of the last passed stop (present only while upstream's index is stale) — prefer it over
   *  `current_stop_sequence` as the progress hint */
  geo_seq?: number;
  /** MZK bus waiting at the first stop of a course that has not begun — `delay` is null then */
  not_started?: boolean;
  /** KB: static timetable trip id this bus serves (MZK: `trip_id` already is the course id) */
  sched_trip_id?: string;
  /** another operator's vehicle in a zbiorkom city (e.g. "OTWOCK" in Warsaw): `line` is that operator's own
   *  name (Otwock's M1 is not the metro), so it never counts as a line of the city */
  agency?: string;
  /** a metro train placed by the timetable, not by GPS (Warsaw: no source sends metro positions) */
  scheduled?: boolean;
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
}

export interface StopsResponse {
  count: number;
  stops: Stop[];
  /** present (true) while one operator's stop list is still missing — re-fetch soon */
  partial?: boolean;
}

/** Static GTFS line catalog entry (from /api/lines). */
export interface LineInfo {
  /** GTFS route_id, e.g. "L_102" */
  id: string;
  /** rider-facing line number, e.g. "102" */
  name: string;
  /** route_long_name — the terminus, e.g. "KANIÓW" */
  terminus: string;
  operator?: "KB" | "MZK" | "GZM";
  /** GTFS route_type of a zbiorkom city's line: "0" tram, "1" metro, "3" bus, "11" trolleybus */
  type?: string;
}

/** One stop pattern of a line (GET /api/line). */
export interface LineVariant {
  headsign: string;
  /** stored road shape of the pattern (wire id); null/absent = draw straight stop-to-stop */
  shape?: string | null;
  stops: Array<{ id: string; name: string; lat?: number; lon?: number }>;
  /** per trip, by first departure: the departure at each stop in minutes from midnight (past 1440 after midnight) */
  times: number[][];
}

export interface LineResponse {
  line: string;
  operator: "KB" | "MZK" | "GZM";
  date: string;
  /** busiest first */
  variants: LineVariant[];
}

export interface LinesResponse {
  count: number;
  lines: LineInfo[];
}

/** Upstream departures passthrough row. */
export interface DepartureRow {
  trip_execution_id?: string;
  trip_id?: number | string;
  /** KB: visit index on the trip · MZK: orderInCourse (server-added) */
  trip_index?: number;
  /** server-built React key, stable across refetches */
  row_key?: string;
  /** legacy upstream strings — KB: relative ("8 min"; `null`/absent while the bus stands at the stop) */
  static_time?: string | null;
  time?: string | null;
  /** legacy: KB = MINUTES, MZK = seconds — the canonical logic reads `delay_sec` instead */
  time_diff?: number;
  is_estimated?: boolean;
  /** MZK: the course has not begun — `time` is the earliest possible time, `time_diff` is 0 */
  not_started?: boolean;
  at_stop?: boolean;
  canceled?: boolean;
  /** epoch seconds (server-normalised, see lib/shared/departures) */
  plan_ts?: number | null;
  eta_ts?: number | null;
  /** operator's own delay for this stop visit, SECONDS */
  delay_sec?: number | null;
  direction?: string;
  platform?: string;
  line_name?: string;
  symbol?: string;
  operator?: "KB" | "MZK" | "GZM";
  side_number?: string;
  model?: string;
  features?: VehicleFeatures;
  /** whole-stop board (?all=1): the pole the row leaves from, the post number ("02") or for BB the compass way ("płn.") */
  pole?: string | null;
}

export interface DeparturesResponse {
  rows?: DepartureRow[];
  /** upstream sources that failed ("kb" / "mzk"): the list is incomplete, not empty */
  warnings?: Array<"kb" | "mzk" | "gzm">;
  /** server clock (epoch s) when the rows were built — lets the client count down on the server's clock */
  server_ts?: number;
  /** the stop's same-name poles nearby, when more than one: offers the whole-stop board */
  poles?: number;
}

export interface TimetableDeparture {
  trip_id: number | string;
  departure: number;
  platform?: string;
  line?: string;
  direction?: string;
  operator?: "KB" | "MZK" | "GZM";
}

export interface TimetableResponse {
  departures?: TimetableDeparture[];
  main_direction?: { name?: string };
  /** upstream sources that failed ("kb" / "mzk"): the day is incomplete, not empty (and must not be cached) */
  warnings?: Array<"kb" | "mzk" | "gzm">;
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
  operator?: "KB" | "MZK" | "GZM";
  shape?: LatLng[];
  /** stored road geometry id (GET /api/shapes) */
  shape_id?: string;
  shape_status?: ShapeStatus;
  /** the server is snapping this shape to the roads: a newer revision of shape_id follows (GZM) */
  shape_matching?: boolean;
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
  shape_matching?: boolean;
  /** KB: recorded arrival epoch secs per trip.times position (null = unknown / not reached) */
  arrived?: (number | null)[];
}

/** One upstream service announcement (utrudnienia/objazdy). Despite the field
 *  name the content is plain text with \n breaks, not markdown. */
export interface Announcement {
  id: number;
  rev: number;
  content_markdown: string;
  operator?: string;
  /** the full article (GZM news) */
  url?: string;
}

export interface AnnouncementsResponse {
  announcements?: Announcement[];
  /** changes whenever the announcement set changes — drives unread tracking */
  hash?: string;
}

/** One Metrorower station (GBFS) with the bikes available right now. */
export interface BikeStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  bikes: number;
  docks: number;
  url: string | null;
}

export interface BikesResponse {
  stations?: BikeStation[];
  updated?: number;
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
  /** status "error": the text shown instead of the generic one (GZM data still loading) */
  errorMsg?: string;
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
  operator?: "KB" | "MZK" | "GZM";
  /** stored road-shape id `routed` came from (null = browser routing / straight) */
  shapeId?: string | null;
  /** the server's shape reference for this trip (kept so a rebuild can reuse it) */
  routeHint?: { id?: string; status?: ShapeStatus; matching?: boolean } | null;
  /** live trips: recorded arrival per rawTimes position, Warsaw secs since midnight (arrivedSecs) */
  arrived?: (number | null)[] | null;
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
  /** walk from the previous leg's last pole to this leg's first, minutes (0 = the same stop) */
  walkMins?: number;
  /** stored road geometry of the leg's trip (GET /api/shapes) */
  shape_id?: string;
  operator?: "KB" | "MZK" | "GZM";
  /** the bus's delay (s) at search time: the search boarded it at its live times, the times above are the timetable's */
  delaySec?: number;
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
  /** every minute on foot: the walks to the first stop and from the last one (points) plus the transfers */
  walkMinutes?: number;
  /** walk from the searched location to the first leg's pole, minutes (searches from a location only) */
  accessWalkMins?: number;
  /** walk from the last leg's pole to the searched destination point, minutes (searches to a point only) */
  egressWalkMins?: number;
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

