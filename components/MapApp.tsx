"use client";

import "leaflet/dist/leaflet.css";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttributionControl, Circle, MapContainer, Marker, TileLayer, ZoomControl, useMap } from "react-leaflet";
import L from "leaflet";
import { fetchJSON, fetchRoute, getTrip } from "@/lib/client/api";
import { loadShapeLatest } from "@/lib/client/shapes";
import { projectStopsAlong, slicePolyline } from "@/lib/shared/polyline";
import { peekVehicleAnimator } from "@/lib/client/vehicleAnimator";
import { adjustStopRoutePoint, injectDetourPoints } from "@/lib/client/detours";
import { arrivedSecs, operatorColor, tripTimeMatchesStop } from "@/lib/client/format";
import { makeStopPingIcon, makeUserLocationIcon } from "@/lib/client/leafletIcons";
import { panMotion } from "@/lib/client/motion";
import { focusPoint, glideTo, installSmoothZoom, isCovered } from "@/lib/client/mapGlide";
import { haversineMeters } from "@/lib/client/geo";
import { startAlertWatchers } from "@/lib/client/alerts";
import { prefetchFavoriteTimetables } from "@/lib/client/timetable";
import { buildSearch, loadSavedLines, parseUrlState, saveLines, type UrlState } from "@/lib/client/urlState";
import { schedTripKey, vehicleTripKey } from "@/lib/shared/departures";
import type {
  ConnectionItinerary,
  JourneyLegResolved,
  JourneyView as JourneyViewState,
  LatLng,
  ShapeStatus,
  Stop,
  Trip,
  TripExecutionResponse,
  TripStopResolved,
  TripView,
  Vehicle,
} from "@/lib/client/types";
import { useGeolocation, useIsDesktop, useStops, useVehicles } from "@/components/hooks";
import AnnouncementsSheet from "@/components/AnnouncementsSheet";
import { SNAP_COVER, openSheetCover } from "@/components/BottomSheet";
import { type TopBarSearchHandle } from "@/components/TopBarSearch";
import ConnectionsModal from "@/components/ConnectionsModal";
import Toast from "@/components/Toast";
import LineFilterChip from "@/components/LineFilterChip";
import LocateButton from "@/components/LocateButton";
import NearbyButton from "@/components/NearbyButton";
import NearbyView from "@/components/NearbyView";
import RouteButton from "@/components/RouteButton";
import TopBar, { BASE_LAYERS, RASTER_FALLBACK, type BaseLayerId } from "@/components/TopBar";
import StopView from "@/components/StopView";
import TripPanel from "@/components/TripView";
import JourneyView from "@/components/JourneyView";
import VehicleLayer from "@/components/VehicleLayer";
import StopsLayer from "@/components/StopsLayer";
import TripLayer from "@/components/TripLayer";
import JourneyLayer from "@/components/JourneyLayer";
import VectorBaseLayer, { type BasemapStatus } from "@/components/VectorBaseLayer";
import { IconContext } from "@/components/icons";

/* the fleet card (charts and all) loads only when a vehicle card is first opened */
const VehicleSheet = lazy(() => import("@/components/brygady/VehicleSheet").then((m) => ({ default: m.VehicleSheet })));

const NOT_STARTED = "Pojazd jeszcze nie wyruszył";
const TRIP_REFRESH_MS = 30_000;
const LAYER_KEY = "kb:baseLayer";
/* module-level: a stable context value never re-renders the memo()-ized icon consumers */
const ICON_DEFAULTS = { size: "1em", weight: "bold", "aria-hidden": true } as const;

type LastRequest =
  | { kind: "live"; execId: string; tripId: string | number | null; stop: Stop | null }
  | { kind: "static"; tripId: string | number; stop: Stop | null };

function MapBridge({ onMap }: { onMap: (m: L.Map) => void }) {
  const map = useMap();
  useEffect(() => onMap(map), [map, onMap]);
  return null;
}

/** The OSMF attribution guidelines let the credit line collapse to an "i" in its corner after 5 s or
 *  the first touch of the map; a tap (or Enter) on the "i" opens it again until the next touch. */
function AttributionCollapse() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer().querySelector<HTMLElement>(".leaflet-control-attribution");
    if (!el) return;
    const mapEl = map.getContainer();
    const set = (collapsed: boolean) => {
      if (el.classList.contains("is-collapsed") === collapsed) return;
      el.classList.toggle("is-collapsed", collapsed);
      if (collapsed) {
        el.tabIndex = 0;
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", "Pokaż źródła mapy");
      } else {
        el.removeAttribute("tabindex");
        el.removeAttribute("role");
        el.removeAttribute("aria-label");
      }
    };
    const onMapInput = (e: Event) => {
      if (!el.contains(e.target as Node)) set(true);
    };
    const onClick = (e: MouseEvent) => {
      if (!el.classList.contains("is-collapsed")) return;
      e.preventDefault();
      set(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!el.classList.contains("is-collapsed") || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      set(false);
      el.querySelector("a")?.focus();
    };
    const timer = setTimeout(() => set(true), 5000);
    mapEl.addEventListener("pointerdown", onMapInput, { passive: true });
    mapEl.addEventListener("wheel", onMapInput, { passive: true });
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      mapEl.removeEventListener("pointerdown", onMapInput);
      mapEl.removeEventListener("wheel", onMapInput);
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onKey);
      set(false);
    };
  }, [map]);
  return null;
}

function loadingTrip(
  gen: number,
  isLive: boolean,
  stop: Stop | null,
  note: string | null,
  execId: string | null,
  tripId: string | number | null = null,
): TripView {
  return {
    gen,
    isLive,
    status: "loading",
    note,
    line: "…",
    direction: "",
    rawTimes: [],
    stops: [],
    vehicle: null,
    vti: null,
    stop,
    routed: null,
    execId,
    tripId,
  };
}

export default function MapApp() {
  const { data: vehData, error: vehError } = useVehicles();
  const { data: stopsData } = useStops();
  const stops = useMemo(() => stopsData?.stops ?? [], [stopsData]);
  /* favourite stops' timetables saved for offline use, once a day, when the first load has settled */
  const stopsReady = stops.length > 0;
  useEffect(() => {
    if (!stopsReady) return;
    const run = () => void prefetchFavoriteTimetables();
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(run, { timeout: 10_000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(run, 3000);
    return () => clearTimeout(t);
  }, [stopsReady]);
  /* alerts set before a reload keep watching their stops */
  useEffect(() => startAlertWatchers(), []);
  const vehicles = useMemo(() => vehData?.vehicles ?? [], [vehData?.vehicles]);
  const desktop = useIsDesktop();

  const mapRef = useRef<L.Map | null>(null);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [stopsVisible, setStopsVisible] = useState(true);
  const [trip, setTrip] = useState<TripView | null>(null);
  const [journey, setJourney] = useState<JourneyViewState | null>(null);
  const journeyGenRef = useRef(0);
  const [vehMeta, setVehMeta] = useState<Vehicle | null>(null);
  const [baseLayer, setBaseLayerState] = useState<BaseLayerId>(() => {
    // safe to touch window here — MapApp mounts behind the ssr:false boundary
    try {
      const v = window.localStorage.getItem(LAYER_KEY);
      if (v && v in BASE_LAYERS) return v as BaseLayerId;
    } catch {
      /* private mode — ignore */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "kb";
  });
  /* basemap readiness: veil while loading; one silent remount-retry on failure,
     then swap to the raster fallback so the map never stays a blank void */
  const [basemap, setBasemap] = useState<{ status: BasemapStatus; attempt: number }>({
    status: "loading",
    attempt: 0,
  });
  const searchRef = useRef<TopBarSearchHandle | null>(null);
  const [connModalOpen, setConnModalOpen] = useState(false);
  const [connInitialFrom, setConnInitialFrom] = useState<Stop | null>(null);
  const [annOpen, setAnnOpen] = useState(false);
  /* "W pobliżu": the bottom of the sheet stack. A stop, trip or journey opened from it covers it
     and closing that one comes back to it; back closes it last */
  const [nearbyOpen, setNearbyOpen] = useState(false);
  /* MZK vehicle card over the map (side number). It has its own history entry: back closes
     the card and leaves the trip under it open. The ref is what the popstate listener reads. */
  const [cardSide, setCardSide] = useState<string | null>(null);
  const cardRef = useRef<string | null>(null);
  /* deep link parsed exactly once, before any state settles (ssr:false — window
     is safe in the lazy initializer) */
  const [initialUrl] = useState<UrlState>(() => parseUrlState(window.location.search));
  /* line names shown on the map; null = no filter (all vehicles) — seeded from
     the ?lines= deep link, else from the filter remembered in this browser */
  const [lineFilter, setLineFilter] = useState<ReadonlySet<string> | null>(() => {
    const lines = initialUrl.lines ?? loadSavedLines();
    return lines ? new Set(lines) : null;
  });
  const [operatorFilter, setOperatorFilter] = useState<"all" | "kb" | "mzk">("all");
  const genRef = useRef(0);
  const lastReqRef = useRef<LastRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /* in-flight /api/trip_execution fetch — aborted when a newer trip open (or a
     close) supersedes it, so rapid re-taps don't stack pending requests; the
     gen check still guards state, this just stops the wasted network work */
  const tripExecAbortRef = useRef<AbortController | null>(null);
  /* mirror of the 5 s poll so callbacks can read vehicles without depending
     on them (dependency would rebuild the callback + re-render children) */
  const vehiclesRef = useRef<Vehicle[]>([]);
  useEffect(() => {
    vehiclesRef.current = vehicles;
  });
  const userIcon = useMemo(() => makeUserLocationIcon(), []);

  /* geolocation — the blue "you are here" dot follows the user once granted */
  const geo = useGeolocation();
  const wantFlyRef = useRef(false);

  const setBaseLayer = useCallback((id: BaseLayerId) => {
    setBaseLayerState(id);
    // switching styles gets a fresh vector attempt even after a raster fallback
    setBasemap({ status: "loading", attempt: 0 });
    try {
      window.localStorage.setItem(LAYER_KEY, id);
    } catch {
      /* private mode — ignore */
    }
  }, []);

  const handleBasemapStatus = useCallback((s: BasemapStatus) => {
    setBasemap((prev) =>
      s === "failed" && prev.attempt === 0
        ? { status: "loading", attempt: 1 } // one silent retry: key change remounts the GL layer
        : { ...prev, status: s },
    );
  }, []);

  /* fast stop lookup: by internal id and by designator */
  const stopsMaps = useMemo(() => {
    const byId = new Map<string, Stop>();
    const byDesig = new Map<string, Stop>();
    for (const s of stops) {
      byId.set(String(s.id), s);
      byDesig.set(String(s.designator), s);
      if (s.kbId) byId.set(String(s.kbId), s);
      if (s.mzkId) byId.set(String(s.mzkId), s);
      if (s.kbDesignator) byDesig.set(String(s.kbDesignator), s);
      if (s.mzkDesignator) byDesig.set(String(s.mzkDesignator), s);
      if (s.symbol) {
        byDesig.set(`mzk:${s.symbol}`, s);
        byDesig.set(String(s.symbol), s);
      }
      // a station hub's extra MZK symbols have no stop of their own: an MZK trip calling there resolves to the hub
      for (const sym of s.mzkSymbol ? [s.mzkSymbol, ...(s.mzkSymbols ?? [])] : []) {
        byDesig.set(`mzk:${sym}`, s);
        byDesig.set(String(sym), s);
      }
    }
    return { byId, byDesig };
  }, [stops]);
  const stopsMapsRef = useRef(stopsMaps);
  useEffect(() => {
    stopsMapsRef.current = stopsMaps;
  }, [stopsMaps]);

  /* /api/stops is revalidated while the app stays open (an MZK list that arrived late, a better merge): the
     open stop follows its fresh record — by id, the designator changes when a stop becomes BOTH — so its
     badges and departure sources update; identical to `selectedStop` while the list is unchanged */
  const liveStop = useMemo(
    () => (selectedStop ? (stopsMaps.byId.get(selectedStop.id) ?? selectedStop) : null),
    [selectedStop, stopsMaps],
  );
  const stopPingIcon = useMemo(() => makeStopPingIcon(liveStop?.operator), [liveStop?.operator]);
  /* walking distance shown in the stop sheet; rounded so a GPS fix moving a few meters keeps the
     memo'd StopView from re-rendering, dropped past 3 km where walking stops being the plan */
  const walkM = useMemo(() => {
    if (!liveStop || !geo.pos) return null;
    const d = haversineMeters(geo.pos.lat, geo.pos.lon, liveStop.lat, liveStop.lon);
    return d <= 3000 ? Math.round(d / 10) * 10 : null;
  }, [liveStop, geo.pos]);

  const filteredStops = useMemo(() => {
    if (operatorFilter === "all") return stops;
    if (operatorFilter === "kb") {
      return stops.filter((s) => s.operator === "KB" || s.operator === "BOTH");
    }
    if (operatorFilter === "mzk") {
      return stops.filter((s) => s.operator === "MZK" || s.operator === "BOTH");
    }
    return stops;
  }, [stops, operatorFilter]);

  const showToast = useCallback((t: string) => setToast(t), []);
  const closeToast = useCallback(() => setToast(null), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const closeTrip = useCallback(() => {
    genRef.current++;
    tripExecAbortRef.current?.abort();
    tripExecAbortRef.current = null;
    setTrip(null);
    setVehMeta(null);
  }, []);

  /** Resolve stop coords, publish trip state, then attach its road geometry:
   *  the server-stored shape when there is one, browser OSRM only while the
   *  server is still routing it, straight lines when it has none.
   *  `gen` guards every async step so a newer trip cancels this one. */
  const buildTrip = useCallback(
    async (
      gen: number,
      tripData: Trip | null,
      vehicle: { lat: number; lon: number } | null,
      vti: number | null,
      stop: Stop | null,
      isLive: boolean,
      note: string | null,
      execId: string | null,
      tripId: string | number | null = null,
      precomputedRoute?: LatLng[] | null,
      serverRoute?: { id?: string; status?: ShapeStatus } | null,
      arrived: (number | null)[] | null = null,
    ) => {
      if (gen !== genRef.current) return;
      const { byId, byDesig } = stopsMapsRef.current;
      const times = tripData?.times ?? [];
      const resolved: TripStopResolved[] = [];
      for (const t of times) {
        let c: Stop | undefined;
        if (t.designator != null) c = byId.get(String(t.designator));
        if (!c && t.place_id) c = byDesig.get(t.place_id);
        if (!c) continue;
        const selected = !!stop && tripTimeMatchesStop(t, stop);
        resolved.push({ t, s: c, selected });
      }
      const pts: LatLng[] = resolved.map(({ s }): LatLng => adjustStopRoutePoint(s.id, [s.lat, s.lon]));
      const needRoute = pts.length >= 2;
      const { points: routePts, detour } = injectDetourPoints(
        pts,
        tripData?.line?.name,
        tripData?.direction,
      );
      const tripNote = note ?? (detour ? detour.title : null);
      const initialRouted = precomputedRoute && precomputedRoute.length >= 2 ? precomputedRoute : null;
      setTrip({
        gen,
        isLive,
        status: needRoute ? (initialRouted ? "ready" : "routing") : "ready",
        note: tripNote,
        line: tripData?.line?.name || "?",
        direction: tripData?.direction || "",
        rawTimes: times,
        stops: resolved,
        vehicle,
        vti,
        stop,
        routed: initialRouted,
        execId,
        tripId,
        operator: tripData?.operator,
        shapeId: initialRouted ? (serverRoute?.id ?? null) : null,
        routeHint: serverRoute ?? null,
        arrived,
      });
      if (initialRouted || !needRoute) return;
      let road: LatLng[] | null = null;
      let shapeId: string | null = null;
      if (serverRoute?.id && serverRoute.status === "road") {
        const sh = await loadShapeLatest(serverRoute.id);
        if (gen !== genRef.current) return;
        if (sh) {
          road = sh.pts;
          shapeId = sh.id;
        }
      }
      // browser OSRM only while the server hasn't routed this pattern yet
      // (or an older server that sends no status); "none" = no road geometry
      if (!road && serverRoute?.status !== "none") road = await fetchRoute(routePts);
      if (gen !== genRef.current) return;
      // road geometry when available; straight lines through the stops if not
      const routed = road && road.length >= 2 ? road : pts;
      setTrip((prev) => (prev && prev.gen === gen ? { ...prev, routed, status: "ready", shapeId } : prev));
    },
    [],
  );

  /* a trip opened before /api/stops resolved published an empty timeline —
     rebuild it against the freshly loaded stop index (same gen, no refetch) */
  const healedGenRef = useRef(-1);
  useEffect(() => {
    const t = trip;
    if (stopsMaps.byId.size === 0 || !t) return;
    if (t.gen !== genRef.current || t.gen === healedGenRef.current) return;
    if (t.rawTimes.length === 0 || t.stops.length > 0) return;
    healedGenRef.current = t.gen;
    void buildTrip(
      t.gen,
      { times: t.rawTimes, line: { name: t.line }, direction: t.direction, operator: t.operator },
      t.vehicle,
      t.vti,
      t.stop,
      t.isLive,
      t.note,
      t.execId,
      t.tripId,
      null,
      t.routeHint,
      t.arrived,
    );
  }, [stopsMaps, trip, buildTrip]);

  const openTripStatic = useCallback(
    async (tripId: string | number, stop: Stop | null, note: string | null = null) => {
      if (!tripId) return;
      lastReqRef.current = { kind: "static", tripId, stop };
      const gen = ++genRef.current;
      setTrip(loadingTrip(gen, false, stop, note, null, tripId));
      let tr: Trip | null = null;
      try {
        tr = await getTrip(tripId);
      } catch {
        tr = null; // getTrip resolves null on failure; guard anyway so we never hang on the spinner
      }
      if (gen !== genRef.current) return;
      if (!tr || !tr.times?.length) {
        setTrip((prev) => (prev && prev.gen === gen ? { ...prev, status: "error" } : prev));
        return;
      }
      await buildTrip(gen, tr, null, null, stop, false, note, null, tripId, tr.shape, {
        id: tr.shape_id,
        status: tr.shape_status,
      });
    },
    [buildTrip],
  );

  const openTripLive = useCallback(
    async (
      execId: string,
      tripId: string | number | null,
      stop: Stop | null,
      opts?: { deepLink?: boolean },
    ) => {
      if (!execId) {
        if (tripId) void openTripStatic(tripId, stop);
        return;
      }
      lastReqRef.current = { kind: "live", execId, tripId, stop };
      const gen = ++genRef.current;
      setTrip(loadingTrip(gen, true, stop, null, execId, tripId));
      tripExecAbortRef.current?.abort();
      const ac = new AbortController();
      tripExecAbortRef.current = ac;
      try {
        const resp = await fetchJSON<TripExecutionResponse>(
          `/api/trip_execution?exec_id=${encodeURIComponent(execId)}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (gen !== genRef.current) return;
        if (!resp || !resp.trip) {
          // upstream 404 → our API returns {} → vehicle has not departed yet
          if (tripId) void openTripStatic(tripId, stop, NOT_STARTED);
          else if (opts?.deepLink) {
            // exec ids are ephemeral: a shared link may outlive the course —
            // don't strand the user on a misleading "not departed" panel
            genRef.current++;
            setTrip(null);
            showToast("Ten kurs już się zakończył lub jest niedostępny.");
          } else
            setTrip((prev) =>
              prev && prev.gen === gen ? { ...prev, status: "ready", note: NOT_STARTED } : prev,
            );
          return;
        }
        // coerce like the server parses the same payload (parsePosition):
        // upstream may send numeric strings; normalize to real numbers
        const vLat = Number(resp.vehicle?.lat);
        const vLon = Number(resp.vehicle?.lon);
        const veh =
          resp.vehicle && Number.isFinite(vLat) && Number.isFinite(vLon)
            ? { lat: vLat, lon: vLon }
            : null;
        const liveInFleet = vehiclesRef.current.some(
          (v) => v.id === execId && Number.isFinite(v.lat) && Number.isFinite(v.lon),
        );
        const hasLivePosition = veh !== null || liveInFleet;
        await buildTrip(
          gen,
          resp.trip,
          veh,
          resp.vehicle_trip_index ?? null,
          stop,
          hasLivePosition,
          null,
          execId,
          tripId,
          resp.shape,
          { id: resp.shape_id, status: resp.shape_status },
          arrivedSecs(resp),
        );
      } catch {
        if (gen !== genRef.current) return;
        setTrip((prev) => (prev && prev.gen === gen ? { ...prev, status: "error" } : prev));
      }
    },
    [buildTrip, openTripStatic, showToast],
  );

  /* the live timeline is fetched once on open: re-fetch it so stops passed meanwhile gain their recorded
     arrival. One request per 30 s per open trip, none while the tab is hidden, never two in flight. */
  const liveExecId = trip?.isLive && (trip.status === "ready" || trip.status === "routing") ? trip.execId : null;
  const tripGen = trip?.gen;
  useEffect(() => {
    if (!liveExecId) return;
    let ac: AbortController | null = null;
    const id = setInterval(async () => {
      if (document.hidden || ac) return;
      ac = new AbortController();
      try {
        const resp = await fetchJSON<TripExecutionResponse>(
          `/api/trip_execution?exec_id=${encodeURIComponent(liveExecId)}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (tripGen !== genRef.current || !resp?.trip) return;
        const arrived = arrivedSecs(resp);
        if (arrived) setTrip((prev) => (prev && prev.gen === tripGen ? { ...prev, arrived } : prev));
      } catch {
        /* keep the last timeline; the next tick retries */
      } finally {
        ac = null;
      }
    }, TRIP_REFRESH_MS);
    return () => {
      clearInterval(id);
      ac?.abort();
    };
  }, [liveExecId, tripGen]);

  const retryTrip = useCallback(() => {
    const req = lastReqRef.current;
    if (!req) return;
    if (req.kind === "live") void openTripLive(req.execId, req.tripId, req.stop);
    else void openTripStatic(req.tripId, req.stop);
  }, [openTripLive, openTripStatic]);

  const closeJourney = useCallback(() => {
    journeyGenRef.current++;
    setJourney(null);
  }, []);

  const handleSelectJourneyLeg = useCallback((legIdx: number | null) => {
    setJourney((prev) => (prev ? { ...prev, selectedLegIdx: legIdx } : null));
  }, []);

  const handleBackToConnections = useCallback(() => {
    closeJourney();
    setConnModalOpen(true);
  }, [closeJourney]);

  const handleFocusJourneyStop = useCallback(
    (lat: number, lon: number) => {
      const m = mapRef.current;
      if (m) glideTo(m, [lat, lon], Math.max(m.getZoom(), 16), focusPoint(m, desktop, openSheetCover()));
    },
    [desktop],
  );

  const handleSelectStop = useCallback(
    (s: Stop, opts?: { fly?: boolean }) => {
      /* picking a stop while a trip/journey is drawn closes it so the
         stop sheet actually shows */
      closeTrip();
      closeJourney();
      setSelectedStop(s);
      const m = mapRef.current;
      if (!m) return;
      // the stop sheet opens at half: land the stop in the map left above it
      const at = focusPoint(m, desktop, SNAP_COVER.half);
      if (opts?.fly) glideTo(m, [s.lat, s.lon], Math.max(m.getZoom(), 16), at);
      // tapped on the map: move only when the sheet would cover it
      else if (isCovered(m, desktop, SNAP_COVER.half, m.latLngToContainerPoint([s.lat, s.lon])))
        glideTo(m, [s.lat, s.lon], m.getZoom(), at);
    },
    [closeTrip, closeJourney, desktop],
  );

  /* stable identities so memo(TopBar) survives the 5 s vehicle poll re-render */
  const toggleStops = useCallback(() => setStopsVisible((v) => !v), []);
  const pickStopFly = useCallback((s: Stop) => handleSelectStop(s, { fly: true }), [handleSelectStop]);

  /* search bar focus handle */
  const handleFocusSearch = useCallback(() => {
    searchRef.current?.focus();
  }, []);

  /* connections modal ("Wyszukaj połączenie") */
  const openConnModal = useCallback(() => setConnModalOpen(true), []);
  const closeConnModal = useCallback(() => {
    setConnModalOpen(false);
    setConnInitialFrom(null);
  }, []);

  const handlePlanRoute = useCallback((s: Stop) => {
    setConnInitialFrom(s);
    setConnModalOpen(true);
  }, []);

  const handleSelectConnection = useCallback(
    async (conn: ConnectionItinerary, selectedLegIdx: number | null = null) => {
      closeTrip();
      setSelectedStop(null);

      const gen = ++journeyGenRef.current;
      const { byId, byDesig } = stopsMapsRef.current;

      const legsResolved: JourneyLegResolved[] = conn.legs.map((leg) => {
        const color = operatorColor(leg.operator, leg.line);
        if (leg.stops) {
          leg.stops.forEach((st) => {
            if (!st.lat || !st.lon) {
              const s = byId.get(st.stopId) ?? byDesig.get(st.stopId);
              if (s) {
                st.lat = s.lat;
                st.lon = s.lon;
              }
            }
          });
        }
        return {
          leg,
          routed: null,
          lineColor: color,
        };
      });

      const firstLeg = conn.legs[0];
      const lastLeg = conn.legs[conn.legs.length - 1];
      const fromStop = firstLeg ? byId.get(firstLeg.fromStopId) ?? byDesig.get(firstLeg.fromStopId) ?? null : null;
      const toStop = lastLeg ? byId.get(lastLeg.toStopId) ?? byDesig.get(lastLeg.toStopId) ?? null : null;

      const initialJourney: JourneyViewState = {
        gen,
        itinerary: conn,
        fromStop,
        toStop,
        legs: legsResolved,
        selectedLegIdx,
        status: "routing",
      };
      setJourney(initialJourney);

      // Road geometry for all legs in parallel: the server-stored trip shape
      // sliced between the leg's first and last stop, browser OSRM otherwise
      const routedLegs = await Promise.all(
        legsResolved.map(async (lr) => {
          const stops = lr.leg.stops ?? [];
          const pts: LatLng[] = stops
            .filter((s) => s.lat && s.lon)
            .map((s) => [s.lat!, s.lon!] as LatLng);
          if (pts.length < 2) return lr;
          if (lr.leg.shape_id) {
            const sh = await loadShapeLatest(lr.leg.shape_id);
            const [s0, s1] = sh ? projectStopsAlong(sh.pl, [pts[0], pts[pts.length - 1]]) : [null, null];
            if (sh && s0 != null && s1 != null && s1 > s0) {
              return { ...lr, routed: slicePolyline(sh.pl, s0, s1) };
            }
          }
          const road = await fetchRoute(pts);
          return {
            ...lr,
            routed: road && road.length >= 2 ? road : pts,
          };
        }),
      );

      if (gen !== journeyGenRef.current) return;
      setJourney((prev) =>
        prev && prev.gen === gen ? { ...prev, legs: routedLegs, status: "ready" } : prev,
      );
    },
    [closeTrip],
  );

  /* announcements sheet ("Utrudnienia") */
  const openAnnouncements = useCallback(() => setAnnOpen(true), []);
  const closeAnnouncements = useCallback(() => setAnnOpen(false), []);

  const closeNearby = useCallback(() => setNearbyOpen(false), []);

  /* line filter — toggling a line on also frames its live vehicles */
  const toggleLineFilter = useCallback(
    (line: string) => {
      const adding = !lineFilter?.has(line);
      setLineFilter((prev) => {
        const next = new Set(prev ?? []);
        if (next.has(line)) next.delete(line);
        else next.add(line);
        return next.size ? next : null;
      });
      if (adding && mapRef.current) {
        const vs = vehiclesRef.current.filter((v) => v.line === line);
        if (vs.length) {
          mapRef.current.fitBounds(
            L.latLngBounds(vs.map((v): [number, number] => [v.lat, v.lon])),
            { padding: [60, 60], maxZoom: 14, ...panMotion(0.8) },
          );
        }
      }
    },
    [lineFilter],
  );
  const clearLineFilter = useCallback(() => setLineFilter(null), []);
  const filterLines = useMemo(() => (lineFilter ? [...lineFilter] : null), [lineFilter]);
  useEffect(() => saveLines(filterLines), [filterLines]);

  /* ---- deep links: URL -> state (hydration) and state -> URL (sync) ----
     Plain History API on purpose, NOT next/navigation: useRouter schedules real
     App Router work and useSearchParams would subscribe the whole map tree to
     every URL change — our own debounced moveend replaceState would then
     re-render everything. Next ≥14.1 supports history.pushState/replaceState
     as shallow routing; all URL work below runs in effects/listeners over refs,
     so the 5 s poll cycle never sees any of it. */

  /* stop/trip hydration waits for /api/stops (near-instant, our own API) so the
     opened trip carries stop context; consumed exactly once and never over a
     user interaction that beat it */
  const dlConsumedRef = useRef(false);
  useEffect(() => {
    if (dlConsumedRef.current) return;
    const dl = initialUrl;
    if (!dl.stop && !dl.exec && !dl.trip) {
      dlConsumedRef.current = true;
      return;
    }
    if (genRef.current > 0 || selectedStop != null) {
      dlConsumedRef.current = true;
      return;
    }
    if (stopsMaps.byDesig.size === 0) return;
    dlConsumedRef.current = true;
    const s = dl.stop ? stopsMaps.byDesig.get(dl.stop) ?? null : null;
    // deferred a tick: hydration runs inside an effect and synchronous setState
    // here would cascade into the same commit
    const t = setTimeout(() => {
      if (dl.stop && !s) showToast("Nie znaleziono przystanku z linku.");
      if (s) {
        setSelectedStop(s);
        if (!dl.map) mapRef.current?.setView([s.lat, s.lon], 16, { animate: false });
      }
      if (dl.exec) void openTripLive(dl.exec, dl.trip, s, { deepLink: true });
      else if (dl.trip) void openTripStatic(dl.trip, s);
    }, 0);
    return () => clearTimeout(t);
  }, [initialUrl, stopsMaps, selectedStop, openTripLive, openTripStatic, showToast]);

  /* state -> URL. One writer; refs carry everything the popstate/moveend
     listeners need so they stay mount-once and render-free. */
  const urlStateRef = useRef<UrlState>(initialUrl);
  const urlSyncRef = useRef({
    pushed: 0,
    expectPop: 0,
    fromPop: false,
    prevDepth: 0,
    prevOverlays: 0,
    // sheets with no URL param of their own: back closes them via onPop
    journey: false,
    ann: false,
    modal: false,
    nearby: false,
  });
  const tripOpen = trip != null;
  // a live-opened trip keeps exec= even when buildTrip downgrades it to isLive=false
  // (no position yet): the course is still the one the URL must reopen
  const tripExecId = trip?.execId ?? null;
  const tripIsStatic = tripOpen && !tripExecId;
  const journeyOpen = journey != null;
  useEffect(() => {
    const st = urlSyncRef.current;
    // journey replaces stop/trip as the base sheet; the announcements sheet and
    // the connections modal stack on top, each with a same-URL history entry
    const overlays = (annOpen ? 1 : 0) + (connModalOpen ? 1 : 0) + (nearbyOpen ? 1 : 0);
    const depth = (tripOpen ? 2 : selectedStop || journeyOpen ? 1 : 0) + overlays;
    const prev = st.prevDepth;
    const prevOverlays = st.prevOverlays;
    st.prevDepth = depth;
    st.prevOverlays = overlays;
    st.journey = journeyOpen;
    st.ann = annOpen;
    st.nearby = nearbyOpen;
    st.modal = connModalOpen;
    const fromPop = st.fromPop;
    st.fromPop = false;
    // a deep link not hydrated yet (waits for /api/stops) stays in the URL:
    // urlStateRef keeps initialUrl, so a reload or a copied link still has it
    if (!dlConsumedRef.current) return;
    const staticId =
      tripIsStatic && lastReqRef.current?.kind === "static" ? String(lastReqRef.current.tripId) : null;
    const m = mapRef.current;
    const c = m?.getCenter();
    urlStateRef.current = {
      stop: selectedStop?.designator ?? null,
      exec: tripExecId,
      trip: staticId,
      lines: filterLines,
      map: m && c ? { lat: c.lat, lon: c.lng, zoom: m.getZoom() } : urlStateRef.current.map,
    };
    const search = buildSearch(urlStateRef.current);
    if (depth > prev && !fromPop) {
      // sheet appeared/deepened → its own history entry, so back closes it
      // (a same-URL overlay pushes too; landing on a deep link does not)
      if (search !== window.location.search || overlays > prevOverlays) {
        window.history.pushState({ kb: true }, "", search || window.location.pathname);
        st.pushed++;
      }
    } else if (depth < prev && !fromPop && st.pushed > 0) {
      // closed from the UI → unwind our entries; the popstate handler consumes
      // this and repairs the restored URL if it drifted
      const steps = Math.min(st.pushed, prev - depth);
      st.pushed -= steps;
      st.expectPop++;
      window.history.go(-steps);
    } else if (search !== window.location.search) {
      // same-level change (stop→stop, filter, trip kind) → replace in place
      window.history.replaceState({ kb: true }, "", search || window.location.pathname);
    }
  }, [selectedStop, tripOpen, tripExecId, tripIsStatic, filterLines, journeyOpen, annOpen, connModalOpen, nearbyOpen]);

  const openVehicleCard = useCallback((side: string) => {
    if (cardRef.current) return;
    cardRef.current = side;
    window.history.pushState({ kb: true }, "", window.location.href);
    setCardSide(side);
  }, []);

  const closeVehicleCard = useCallback(() => {
    if (!cardRef.current) return;
    cardRef.current = null;
    setCardSide(null);
    urlSyncRef.current.expectPop++;
    window.history.back();
  }, []);

  /* "Pokaż na mapie" in the card: its course is usually the open trip, else open that one */
  const showCardOnMap = useCallback(
    (execId: string) => {
      closeVehicleCard();
      if (tripExecId === execId) return;
      setVehMeta(null);
      void openTripLive(execId, null, null);
    },
    [closeVehicleCard, tripExecId, openTripLive],
  );

  /* popstate: deliberately close-only — Android/browser back closes sheets;
     forward into a sheet the state doesn't have just repairs the URL (state is
     authoritative). Full back/forward re-opening is not worth the surface. */
  useEffect(() => {
    const onPop = (): void => {
      const st = urlSyncRef.current;
      if (st.expectPop > 0 || cardRef.current) {
        // our own unwind, or back while the vehicle card is open: that closes just the card
        if (st.expectPop > 0) st.expectPop--;
        else {
          cardRef.current = null;
          setCardSide(null);
        }
        const want = buildSearch(urlStateRef.current);
        if (window.location.search !== want) {
          window.history.replaceState({ kb: true }, "", want || window.location.pathname);
        }
        return;
      }
      // topmost first: the modal, then the announcements sheet, each one level
      if (st.modal || st.ann) {
        st.fromPop = true;
        st.pushed = Math.max(0, st.pushed - 1);
        if (st.modal) closeConnModal();
        else closeAnnouncements();
        return;
      }
      const dl = parseUrlState(window.location.search);
      const cur = urlStateRef.current;
      const wantsTrip = !!(dl.exec || dl.trip);
      const haveTrip = !!(cur.exec || cur.trip);
      if (!wantsTrip && haveTrip) {
        st.fromPop = true;
        st.pushed = Math.max(0, st.pushed - 1);
        closeTrip(); // a journey under it has its own entry
        if (!dl.stop) setSelectedStop(null);
        return;
      }
      if (!dl.stop && !wantsTrip && cur.stop) {
        st.fromPop = true;
        st.pushed = Math.max(0, st.pushed - 1);
        setSelectedStop(null);
        closeJourney();
        return;
      }
      if (st.journey) {
        st.fromPop = true;
        st.pushed = Math.max(0, st.pushed - 1);
        closeJourney();
        return;
      }
      if (st.nearby) {
        st.fromPop = true;
        st.pushed = Math.max(0, st.pushed - 1);
        closeNearby();
        return;
      }
      const want = buildSearch(cur);
      if (window.location.search !== want) {
        window.history.replaceState({ kb: true }, "", want || window.location.pathname);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [closeTrip, closeJourney, closeConnModal, closeAnnouncements, closeNearby]);

  /* "Wyczyść widok": close every sheet and drop the line filter */
  const handleClearView = useCallback(() => {
    closeTrip();
    closeJourney();
    setSelectedStop(null);
    setNearbyOpen(false);
    setLineFilter(null);
  }, [closeTrip, closeJourney]);

  /* stable identities for the memo()-ized sheets (TripPanel / StopView / JourneyView) */
  const handleCloseAll = useCallback(() => {
    closeTrip();
    closeJourney();
    setSelectedStop(null);
  }, [closeTrip, closeJourney]);

  const handleCloseStop = useCallback(() => setSelectedStop(null), []);

  const handleShowLive = useCallback(
    (execId: string, tripId: string | number | null) => {
      setVehMeta(null);
      void openTripLive(execId, tripId, selectedStop);
    },
    [openTripLive, selectedStop],
  );

  const handleShowStatic = useCallback(
    (tripId: string | number) => {
      setVehMeta(null);
      void openTripStatic(tripId, selectedStop);
    },
    [openTripStatic, selectedStop],
  );

  const handleVehicleClick = useCallback(
    (v: Vehicle) => {
      /* a trip without a stop under it unwinds two history levels on close (trip depth), which
         would take the nearby sheet's entry with it */
      setNearbyOpen(false);
      setVehMeta(v);
      const m = mapRef.current;
      if (m && Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
        // zoom in on where the marker is drawn (dead-reckoned), not the raw fix behind it, landing
        // it above the trip sheet (opens at half); TripLayer skips its route fit for this trip
        const d = peekVehicleAnimator(m)?.displayed(v.id);
        const at = focusPoint(m, desktop, SNAP_COVER.half);
        glideTo(m, d ? [d.lat, d.lon] : [v.lat, v.lon], Math.max(m.getZoom(), 16), at);
      }
      void openTripLive(v.id, null, null);
    },
    [openTripLive, desktop],
  );

  /* trip sheet's locate button: fly to where the bus is drawn (dead-reckoned) when it is on the fleet layer */
  const handleLocateVehicle = useCallback(
    (v: { id: string | null; lat: number; lon: number }) => {
      const m = mapRef.current;
      if (!m) return;
      const d = v.id ? peekVehicleAnimator(m)?.displayed(v.id) : null;
      const at = focusPoint(m, desktop, openSheetCover());
      glideTo(m, d ? [d.lat, d.lon] : [v.lat, v.lon], Math.max(m.getZoom(), 16), at);
    },
    [desktop],
  );

  /* glide to a stop tapped on the trip timeline (does not change selection) */
  const handleFocusStop = useCallback(
    (s: Stop) => {
      const m = mapRef.current;
      if (m) glideTo(m, [s.lat, s.lon], Math.max(m.getZoom(), 16), focusPoint(m, desktop, openSheetCover()));
    },
    [desktop],
  );

  const handleMap = useCallback((m: L.Map) => {
    mapRef.current = m;
    installSmoothZoom(m);
    // guard against a 0×0 container at mount (dvh reflow on mobile): re-measure
    // once layout settles so the GL canvas isn't sized from an empty box
    requestAnimationFrame(() => m.invalidateSize(false));

    // Freeze CSS transitions on markers while the map is moving, zooming or flying
    // so vehicle markers don't slide or drift relative to stops or geography
    const container = m.getContainer();
    let moveEndTimer: ReturnType<typeof setTimeout> | null = null;
    const onMoveStart = () => {
      if (moveEndTimer) clearTimeout(moveEndTimer);
      container.classList.add("map-moving");
    };
    const onMoveEnd = () => {
      if (moveEndTimer) clearTimeout(moveEndTimer);
      moveEndTimer = setTimeout(() => {
        container.classList.remove("map-moving");
      }, 75);
    };
    m.on("movestart", onMoveStart);
    m.on("zoomstart", onMoveStart);
    m.on("zoomanim", onMoveStart);
    m.on("move", onMoveStart);
    m.on("moveend", onMoveEnd);
    m.on("zoomend", onMoveEnd);

    // keep map= in the URL fresh — debounced replaceState over refs, zero React
    // renders (Safari throttles ~100 history calls/30 s, hence debounce + skip)
    let t: ReturnType<typeof setTimeout> | null = null;
    m.on("moveend", () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const c = m.getCenter();
        urlStateRef.current = { ...urlStateRef.current, map: { lat: c.lat, lon: c.lng, zoom: m.getZoom() } };
        const search = buildSearch(urlStateRef.current);
        if (search !== window.location.search) {
          window.history.replaceState({ kb: true }, "", search || window.location.pathname);
        }
      }, 500);
    });
  }, []);

  /* locate button: start (or reuse) the GPS watch and recenter on the fix */
  const flyToUser = useCallback(
    (p: { lat: number; lon: number }) => {
      const m = mapRef.current;
      if (m) glideTo(m, [p.lat, p.lon], Math.max(m.getZoom(), 15), focusPoint(m, desktop, openSheetCover()));
    },
    [desktop],
  );

  const handleLocate = useCallback(() => {
    // watch already running → a second tap turns it off (stops the GPS drain)
    if (geo.status === "active" || geo.status === "locating") {
      wantFlyRef.current = false;
      geo.stop();
      return;
    }
    if (geo.pos) flyToUser(geo.pos);
    else wantFlyRef.current = true; // fly once the first fix arrives
    geo.locate();
  }, [geo, flyToUser]);

  /* first fix after a locate request → recenter exactly once */
  useEffect(() => {
    if (wantFlyRef.current && geo.pos) {
      wantFlyRef.current = false;
      flyToUser(geo.pos);
    }
  }, [geo.pos, flyToUser]);

  /* "W pobliżu" replaces whatever sheet is open; without a fix yet it locates first and the
     sheet says so until the fix lands */
  const openNearby = useCallback(() => {
    closeTrip();
    closeJourney();
    setSelectedStop(null);
    setNearbyOpen(true);
    if (!geo.pos && geo.status !== "locating") geo.locate();
  }, [closeTrip, closeJourney, geo]);

  /* palette "Moja lokalizacja": always fly-to-me — never the LocateButton's
     toggle-off, which would surprise from a search action */
  const paletteLocate = useCallback(() => {
    if (geo.pos) {
      flyToUser(geo.pos);
      return;
    }
    wantFlyRef.current = true;
    geo.locate();
  }, [geo, flyToUser]);

  const tiles = BASE_LAYERS[baseLayer];
  /* trip opened from a stop → back returns to that stop's sheet */
  const tripFromStop = !!trip && trip.stop != null && selectedStop != null;

  /* live fix for the open trip: the live poll keeps the drawn
     vehicle's position, heading, delay and current stop fresh (matched by
     exec id or trip id) — so it moves on the map and advances the timeline without
     re-opening the route. If the course was opened statically before the bus departed,
     it automatically starts tracking live as soon as the vehicle appears online. */
  const liveTripVeh = useMemo(() => {
    if (!trip) return null;
    if (trip.execId) {
      const byExec = vehicles.find((v) => v.id === trip.execId);
      if (byExec) return byExec;
    }
    if (trip.tripId) {
      // static trip ids and live trip_ids are different spaces (MZK "mzk:<course>:<variant>"
      // vs the bare course): match on the shared timetable key, raw trip_id as before
      const key = schedTripKey(trip.tripId);
      const tid = String(trip.tripId);
      const byTrip = vehicles.find((v) => vehicleTripKey(v) === key || (v.trip_id && String(v.trip_id) === tid));
      if (byTrip) return byTrip;
    }
    return null;
  }, [trip, vehicles]);

  return (
    <IconContext.Provider value={ICON_DEFAULTS}>
      <div className="fixed inset-0 h-full w-full overflow-hidden bg-bg">
        <MapContainer
          center={initialUrl.map ? [initialUrl.map.lat, initialUrl.map.lon] : [49.822, 19.046]}
          zoom={initialUrl.map?.zoom ?? 11}
          maxZoom={19}
          zoomControl={false}
          attributionControl={false}
          className="absolute inset-0 z-0 h-full w-full"
        >
          {/* bottom-left, away from the zoom + locate column in the right corner */}
          {/* road geometry is routed server-side with OSRM — its usage policy asks for credit */}
          <AttributionControl
            position="bottomleft"
            prefix={'Trasy: <a href="https://project-osrm.org/" target="_blank" rel="noopener noreferrer">OSRM</a>'}
          />
          <AttributionCollapse />
          <MapBridge onMap={handleMap} />
          {basemap.status !== "failed" && tiles.kind === "vector" ? (
            <VectorBaseLayer
              key={`${baseLayer}-${basemap.attempt}`}
              style={tiles.style}
              filter={tiles.filter}
              onStatus={handleBasemapStatus}
            />
          ) : (
            <TileLayer
              key={`fb-${baseLayer}`}
              url={RASTER_FALLBACK[baseLayer].url}
              className={RASTER_FALLBACK[baseLayer].className}
              maxZoom={19}
              attribution={RASTER_FALLBACK[baseLayer].attribution}
            />
          )}
          <ZoomControl position="bottomright" />
          <StopsLayer stops={filteredStops} visible={stopsVisible} onSelect={handleSelectStop} />
          {liveStop && (
            <Marker
              position={[liveStop.lat, liveStop.lon]}
              icon={stopPingIcon}
              interactive={false}
              keyboard={false}
            />
          )}
          <TripLayer trip={trip} desktop={desktop} vehMeta={vehMeta} liveVehicle={liveTripVeh} />
          <JourneyLayer journey={journey} desktop={desktop} />
          {/* while a route or journey is drawn, hide the live fleet */}
          <VehicleLayer
            vehicles={vehicles}
            onVehicleClick={handleVehicleClick}
            hidden={trip != null || journey != null}
            lineFilter={lineFilter}
            operatorFilter={operatorFilter}
          />
          {geo.pos && (
            <>
              {geo.pos.accuracy > 0 && geo.pos.accuracy < 2000 && (
                <Circle
                  center={[geo.pos.lat, geo.pos.lon]}
                  radius={geo.pos.accuracy}
                  pathOptions={{ color: "#2b83ff", weight: 1, opacity: 0.5, fillColor: "#2b83ff", fillOpacity: 0.1 }}
                  interactive={false}
                />
              )}
              <Marker
                position={[geo.pos.lat, geo.pos.lon]}
                icon={userIcon}
                interactive={false}
                keyboard={false}
                zIndexOffset={300}
              />
            </>
          )}
        </MapContainer>

        {/* dark veil until the basemap's first paint — liberty's background layer
            is light, so without this a slow style/tile fetch reads as a white map */}
        {basemap.status === "loading" && (
          <div className="pointer-events-none absolute inset-0 z-[500] bg-bg animate-fade" aria-hidden>
            <div className="skeleton absolute inset-0 rounded-none opacity-20" />
          </div>
        )}

        <TopBar
          count={vehData?.count ?? null}
          offline={!!vehError}
          stopsVisible={stopsVisible}
          onToggleStops={toggleStops}
          baseLayer={baseLayer}
          onBaseLayer={setBaseLayer}
          onOpenAnnouncements={openAnnouncements}
          stops={stops}
          geoPos={geo.pos}
          onLocate={paletteLocate}
          onPickStop={pickStopFly}
          onPickVehicle={handleVehicleClick}
          lineFilter={lineFilter}
          onToggleLine={toggleLineFilter}
          onClearLineFilter={clearLineFilter}
          onClearView={handleClearView}
          onOpenNearby={openNearby}
          onOpenConnections={openConnModal}
          searchRef={searchRef}
          operatorFilter={operatorFilter}
          onOperatorFilter={setOperatorFilter}
          onShowToast={showToast}
        />

        {filterLines && (
          <LineFilterChip
            lines={filterLines}
            visibleCount={
              lineFilter
                ? vehicles.filter(
                    (v) =>
                      lineFilter.has(v.line) &&
                      (operatorFilter === "all" || (v.operator ?? "KB").toLowerCase() === operatorFilter),
                  ).length
                : 0
            }
            onClear={clearLineFilter}
            onOpenPalette={handleFocusSearch}
          />
        )}

        <LocateButton status={geo.status} onLocate={handleLocate} />
        <RouteButton onClick={openConnModal} />
        {geo.status === "active" && !nearbyOpen && !trip && !journey && !liveStop && !annOpen && (
          <NearbyButton onClick={openNearby} />
        )}

        <ConnectionsModal
          open={connModalOpen}
          onClose={closeConnModal}
          stops={stops}
          geoPos={geo.pos}
          initialFrom={connInitialFrom}
          onSelectStop={pickStopFly}
          onSelectConnection={handleSelectConnection}
        />

        {toast && <Toast text={toast} onClose={closeToast} />}

        {cardSide && (
          <Suspense fallback={null}>
            <VehicleSheet key={cardSide} side={cardSide} onClose={closeVehicleCard} onShowOnMap={showCardOnMap} />
          </Suspense>
        )}

        {/* one sheet at a time: announcements over trip over stop over nearby; closing the
            top one returns to whichever sheet was underneath */}
        {annOpen ? (
          <AnnouncementsSheet desktop={desktop} onClose={closeAnnouncements} />
        ) : trip ? (
          <TripPanel
            key={trip.gen}
            trip={trip}
            desktop={desktop}
            vehMeta={vehMeta}
            liveVeh={liveTripVeh}
            onBack={tripFromStop ? closeTrip : null}
            onClose={handleCloseAll}
            onFocusStop={handleFocusStop}
            onLocate={handleLocateVehicle}
            onRetry={retryTrip}
            onOpenVehicleCard={openVehicleCard}
            onShowToast={showToast}
            initialSnap="half"
          />
        ) : journey ? (
          <JourneyView
            key={`journey-${journey.gen}`}
            journey={journey}
            desktop={desktop}
            onClose={closeJourney}
            onBackToSearch={handleBackToConnections}
            onSelectLeg={handleSelectJourneyLeg}
            onFocusStop={handleFocusJourneyStop}
          />
        ) : liveStop ? (
          <StopView
            key={liveStop.designator}
            stop={liveStop}
            desktop={desktop}
            vehicles={vehicles}
            onClose={handleCloseStop}
            onShowLive={handleShowLive}
            onShowStatic={handleShowStatic}
            onPlanRoute={handlePlanRoute}
            walkM={walkM}
          />
        ) : (
          nearbyOpen && (
            <NearbyView
              desktop={desktop}
              stops={stops}
              pos={geo.pos}
              geoStatus={geo.status}
              vehicles={vehicles}
              onSelectStop={pickStopFly}
              onClose={closeNearby}
            />
          )
        )}
      </div>
    </IconContext.Provider>
  );
}
