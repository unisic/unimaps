/**
 * The API route table: every server/api/<path>/route.ts module (Web Request -> Response handlers, the shape
 * Next's App Router used) under the URL it answers. `[name]` segments arrive decoded as `ctx.params`.
 */
import * as announcements from "./api/announcements/route";
import * as bikes from "./api/bikes/route";
import * as connections from "./api/connections/route";
import * as fleet from "./api/fleet/route";
import * as fleetSide from "./api/fleet/[sideNumber]/route";
import * as fleetTimeline from "./api/fleet/timeline/route";
import * as geocode from "./api/geocode/route";
import * as gtfsRt from "./api/gtfs-rt.pb/route";
import * as health from "./api/health/route";
import * as line from "./api/line/route";
import * as lines from "./api/lines/route";
import * as push from "./api/push/route";
import * as pushNews from "./api/push/news/route";
import * as shapes from "./api/shapes/route";
import * as stopDepartures from "./api/stop/[designator]/departures/route";
import * as stopTimetable from "./api/stop/[designator]/timetable/route";
import * as stops from "./api/stops/route";
import * as trip from "./api/trip/[tripId]/route";
import * as tripExecution from "./api/trip_execution/route";
import * as trips from "./api/trips/route";
import * as vehicles from "./api/vehicles/route";

export type Method = "GET" | "POST" | "DELETE";
export type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

export interface Route {
  re: RegExp;
  keys: string[];
  methods: Partial<Record<Method, Handler>>;
}

/** `P` = the module's own params shape; the keys come from the same pattern, so the record matches it. */
function route<P>(pattern: string, mod: Partial<Record<Method, (req: Request, ctx: { params: Promise<P> }) => Response | Promise<Response>>>): Route {
  const keys: string[] = [];
  const src = pattern
    .split("/")
    .map((seg) => {
      const m = /^\[(\w+)\]$/.exec(seg);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      keys.push(m[1]);
      return "([^/]+)";
    })
    .join("/");
  const methods: Route["methods"] = {};
  for (const m of ["GET", "POST", "DELETE"] as const) {
    const h = mod[m];
    if (h) methods[m] = h as Handler;
  }
  return { re: new RegExp(`^${src}$`), keys, methods };
}

export const ROUTES: Route[] = [
  route("/api/announcements", announcements),
  route("/api/bikes", bikes),
  route("/api/connections", connections),
  route("/api/fleet", fleet),
  route("/api/fleet/timeline", fleetTimeline),
  route("/api/fleet/[sideNumber]", fleetSide),
  route("/api/geocode", geocode),
  route("/api/gtfs-rt.pb", gtfsRt),
  route("/api/health", health),
  route("/api/line", line),
  route("/api/lines", lines),
  route("/api/push", push),
  route("/api/push/news", pushNews),
  route("/api/shapes", shapes),
  route("/api/stop/[designator]/departures", stopDepartures),
  route("/api/stop/[designator]/timetable", stopTimetable),
  route("/api/stops", stops),
  route("/api/trip/[tripId]", trip),
  route("/api/trip_execution", tripExecution),
  route("/api/trips", trips),
  route("/api/vehicles", vehicles),
];
