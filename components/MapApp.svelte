<script lang="ts">
  import "leaflet/dist/leaflet.css";
  import { onMount, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import L from "leaflet";
  import { fetchJSON, fetchRoute, getTrip, tripWarming, type GeoHit } from "@/lib/client/api";
  import { fetchNewerShape, loadShapeLatest } from "@/lib/client/shapes";
  import { projectStopsAlong, slicePolyline } from "@/lib/shared/polyline";
  import { peekVehicleAnimator } from "@/lib/client/vehicleAnimator";
  import { holdWakeLock } from "@/lib/client/wakeLock";
  import { adjustStopRoutePoint, injectDetourPoints } from "@/lib/client/detours";
  import { arrivedSecs, operatorColor, tripTimeMatchesStop } from "@/lib/client/format";
  import { makeJourneyPinIcon, makeStopPingIcon, makeUserLocationIcon } from "@/lib/client/leafletIcons";
  import { panMotion } from "@/lib/client/motion";
  import { focusPoint, glideTo, installSmoothZoom, isCovered, isLockMove, lockOn } from "@/lib/client/mapGlide";
  import { getSmoothMotion } from "@/lib/client/smoothMotion";
  import { haversineMeters } from "@/lib/client/geo";
  import { startAlertWatchers } from "@/lib/client/alerts";
  import { CITY, GZM_LOADING, getPageCity, withCity } from "@/lib/client/city";
  import { prefetchFavoriteTimetables } from "@/lib/client/timetable";
  import { buildSearch, loadSavedLines, parseUrlState, saveLines, type UrlState } from "@/lib/client/urlState";
  import { schedTripKey, vehicleTripKey } from "@/lib/shared/departures";
  import type {
    ConnectionItinerary,
    JourneyLegResolved,
    JourneyView as JourneyViewState,
    LatLng,
    LineInfo,
    LineVariant,
    ShapeStatus,
    Stop,
    Trip,
    TripExecutionResponse,
    TripStopResolved,
    TripView,
    Vehicle,
  } from "@/lib/client/types";
  import { useGeolocation, useStops, useVehicles } from "@/components/hooks.svelte";
  import { SNAP_COVER, openSheetCover } from "@/components/sheet";
  import { BASE_LAYERS, RASTER_FALLBACK, type BaseLayerId, type BasemapStatus, type TopBarSearchHandle } from "@/components/topbar";
  import AnnouncementsSheet from "@/components/AnnouncementsSheet.svelte";
  import CitySheet from "@/components/CitySheet.svelte";
  import ConnectionsModal from "@/components/ConnectionsModal.svelte";
  import Toast from "@/components/Toast.svelte";
  import LineFilterChip from "@/components/LineFilterChip.svelte";
  import LocateButton from "@/components/LocateButton.svelte";
  import NearbyButton from "@/components/NearbyButton.svelte";
  import LineLayer from "@/components/LineLayer.svelte";
  import LineView from "@/components/LineView.svelte";
  import NearbyView from "@/components/NearbyView.svelte";
  import RouteButton from "@/components/RouteButton.svelte";
  import TopBar from "@/components/TopBar.svelte";
  import StopView from "@/components/StopView.svelte";
  import TripPanel from "@/components/TripView.svelte";
  import JourneyView from "@/components/JourneyView.svelte";
  import VehicleLayer from "@/components/VehicleLayer.svelte";
  import BikesLayer from "@/components/BikesLayer.svelte";
  import StopsLayer from "@/components/StopsLayer.svelte";
  import TripLayer from "@/components/TripLayer.svelte";
  import JourneyLayer from "@/components/JourneyLayer.svelte";
  import VectorBaseLayer from "@/components/VectorBaseLayer.svelte";

  const NOT_STARTED = "Pojazd jeszcze nie wyruszył";
  const OFF_TRIP = "Pojazd poza kursem";
  const SCHEDULED = "Pozycja z rozkładu, metro nie podaje GPS";
  const TRIP_REFRESH_MS = 30_000;
  /** a road match takes ~1.1 s per 9 shape points on the public OSRM (line 27: 19 requests, ~21 s) */
  const MATCH_POLL_MS = 1000;
  const MATCH_POLLS = 100;
  const LAYER_KEY = "kb:baseLayer";
  /** the CSS glide of a vehicle marker to its next fix (globals.css .veh-marker) */
  const MARKER_GLIDE_MS = 900;
  /* road geometry is routed server-side with OSRM: its usage policy asks for credit */
  const OSRM_CREDIT = 'Trasy: <a href="https://project-osrm.org/" target="_blank" rel="noopener noreferrer">OSRM</a>';

  type LastRequest =
    | { kind: "live"; execId: string; tripId: string | number | null; stop: Stop | null }
    | { kind: "static"; tripId: string | number; stop: Stop | null };

  /** The OSMF attribution guidelines let the credit line collapse to an "i" in its corner after 5 s or
   *  the first touch of the map; a tap (or Enter) on the "i" opens it again until the next touch. */
  function collapseAttribution(map: L.Map): () => void {
    const el = map.getContainer().querySelector<HTMLElement>(".leaflet-control-attribution");
    if (!el) return () => {};
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
  }

  /* a non-interactive marker created once, then moved and re-iconed in place (no pop replay); null removes it */
  function placeMarker(
    map: L.Map,
    cur: L.Marker | null,
    at: L.LatLngTuple | null,
    icon: L.DivIcon,
    zIndexOffset = 0,
  ): L.Marker | null {
    if (!at) {
      cur?.remove();
      return null;
    }
    if (!cur) return L.marker(at, { icon, interactive: false, keyboard: false, zIndexOffset }).addTo(map);
    cur.setLatLng(at);
    if (cur.options.icon !== icon) cur.setIcon(icon);
    return cur;
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

  /* fixed for the page life: switching city is a full navigation */
  const city = getPageCity();
  const cityCfg = CITY[city];
  const vehQ = useVehicles();
  const stopsQ = useStops();
  const stops = $derived(stopsQ.data?.stops ?? []);
  /* favourite stops' timetables saved for offline use, once a day, when the first load has settled */
  const stopsReady = $derived(stops.length > 0);
  $effect(() => {
    if (!stopsReady) return;
    const run = () => void prefetchFavoriteTimetables();
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(run, { timeout: 10_000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(run, 3000);
    return () => clearTimeout(t);
  });
  /* alerts set before a reload keep watching their stops */
  onMount(() => {
    startAlertWatchers(city);
  });
  const vehicles = $derived(vehQ.data?.vehicles ?? []);
  const desktopQuery = new MediaQuery("(min-width: 768px)", false);
  const desktop = $derived(desktopQuery.current);

  let mapEl: HTMLDivElement | undefined = $state();
  let map = $state.raw<L.Map | null>(null);
  let selectedStop = $state.raw<Stop | null>(null);
  let stopsVisible = $state(true);
  let bikesVisible = $state(
    (() => {
      try {
        return window.localStorage.getItem("kb:bikes") !== "0";
      } catch {
        return true;
      }
    })(),
  );
  let trip = $state.raw<TripView | null>(null);
  let journey = $state.raw<JourneyViewState | null>(null);
  let journeySeq = 0;
  let vehMeta = $state.raw<Vehicle | null>(null);
  let baseLayer = $state<BaseLayerId>(
    (() => {
      try {
        const v = window.localStorage.getItem(LAYER_KEY);
        if (v && v in BASE_LAYERS) return v as BaseLayerId;
      } catch {
        /* private mode: ignore */
      }
      // no choice yet: the app theme (set by the pre-paint script in the page head)
      return document.documentElement.dataset.theme === "light" ? "kb" : "dark";
    })(),
  );
  /* basemap readiness: veil while loading; one silent remount-retry on failure,
     then swap to the raster fallback so the map never stays a blank void */
  let basemap = $state.raw<{ status: BasemapStatus; attempt: number }>({ status: "loading", attempt: 0 });
  const searchRef: { current: TopBarSearchHandle | null } = { current: null };
  let connModalOpen = $state(false);
  let connInitialFrom = $state.raw<Stop | null>(null);
  let annOpen = $state(false);
  let cityOpen = $state(false);
  /* "W pobliżu": the bottom of the sheet stack. A stop, trip or journey opened from it covers it
     and closing that one comes back to it; back closes it last */
  let nearbyOpen = $state(false);
  /* an address picked in search: nearby is built around it instead of the user's position */
  let nearbyPlace = $state.raw<GeoHit | null>(null);
  /* line view (route, stops, today's timetable), opened from search: the bottom of the stack like nearby */
  let openLine = $state.raw<LineInfo | null>(null);
  /* the line view's pattern drawn on the map (LineView reports it, cleared with the sheet) */
  let lineVariant = $state.raw<LineVariant | null>(null);
  /* MZK vehicle card over the map (side number). It has its own history entry: back closes
     the card and leaves the trip under it open. `cardOpen` is what the popstate listener reads. */
  let cardSide = $state<string | null>(null);
  let cardOpen: string | null = null;
  /* deep link parsed exactly once, before any state settles */
  const initialUrl: UrlState = parseUrlState(window.location.search);
  /* line names shown on the map; null = no filter (all vehicles), seeded from
     the ?lines= deep link, else from the filter remembered in this browser */
  let lineFilter = $state.raw<ReadonlySet<string> | null>(
    (() => {
      const lines = initialUrl.lines ?? loadSavedLines(city);
      return lines ? new Set(lines) : null;
    })(),
  );
  let operatorFilter = $state<"all" | "kb" | "mzk">("all");
  /* generation counter: every async trip step re-checks it, so a newer open (or a close) cancels an older one */
  let tripSeq = 0;
  let lastReq: LastRequest | null = null;
  let toast = $state<string | null>(null);
  /* in-flight /api/trip_execution fetch, aborted when a newer trip open (or a
     close) supersedes it, so rapid re-taps don't stack pending requests; the
     gen check still guards state, this just stops the wasted network work */
  let tripExecAbort: AbortController | null = null;
  const userIcon = makeUserLocationIcon();

  /* geolocation: the blue "you are here" dot follows the user once granted */
  const geo = useGeolocation();
  let wantFly = false;
  /* "Śledź moją lokalizację": the map pans to every fix until a drag (or the button) ends it */
  let geoFollow = $state(false);
  const geoFollowing = $derived(geoFollow && geo.status === "active");

  function setBaseLayer(id: BaseLayerId) {
    baseLayer = id;
    // switching styles gets a fresh vector attempt even after a raster fallback
    basemap = { status: "loading", attempt: 0 };
    try {
      window.localStorage.setItem(LAYER_KEY, id);
    } catch {
      /* private mode: ignore */
    }
  }

  /* reported from the layer's own effects: untracked, so the status write never re-runs them */
  function handleBasemapStatus(s: BasemapStatus) {
    const prev = untrack(() => basemap);
    basemap =
      s === "failed" && prev.attempt === 0
        ? { status: "loading", attempt: 1 } // one silent retry: the key change remounts the GL layer
        : { ...prev, status: s };
  }

  /* fast stop lookup: by internal id and by designator */
  const stopsMaps = $derived.by(() => {
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
  });

  /* /api/stops is revalidated while the app stays open (an MZK list that arrived late, a better merge): the
     open stop follows its fresh record (by id, the designator changes when a stop becomes BOTH), so its
     badges and departure sources update; identical to `selectedStop` while the list is unchanged */
  const liveStop = $derived(selectedStop ? (stopsMaps.byId.get(selectedStop.id) ?? selectedStop) : null);
  const pingOperator = $derived(liveStop?.operator);
  const stopPingIcon = $derived(makeStopPingIcon(pingOperator));
  const placePinIcon = makeJourneyPinIcon("end");
  /* walking distance shown in the stop sheet; rounded so a GPS fix moving a few meters keeps the
     stop sheet unchanged, dropped past 3 km where walking stops being the plan */
  const walkM = $derived.by(() => {
    if (!liveStop || !geo.pos) return null;
    const d = haversineMeters(geo.pos.lat, geo.pos.lon, liveStop.lat, liveStop.lon);
    return d <= 3000 ? Math.round(d / 10) * 10 : null;
  });

  const filteredStops = $derived.by(() => {
    if (operatorFilter === "kb") return stops.filter((s) => s.operator === "KB" || s.operator === "BOTH");
    if (operatorFilter === "mzk") return stops.filter((s) => s.operator === "MZK" || s.operator === "BOTH");
    return stops;
  });

  function showToast(t: string) {
    toast = t;
  }
  function closeToast() {
    toast = null;
  }
  $effect(() => {
    if (!toast) return;
    const t = setTimeout(() => (toast = null), 6000);
    return () => clearTimeout(t);
  });

  function closeTrip() {
    tripSeq++;
    tripExecAbort?.abort();
    tripExecAbort = null;
    trip = null;
    vehMeta = null;
  }

  /** Resolve stop coords, publish trip state, then attach its road geometry:
   *  the server-stored shape when there is one, browser OSRM only while the
   *  server is still routing it, straight lines when it has none.
   *  `gen` guards every async step so a newer trip cancels this one. */
  async function buildTrip(
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
    serverRoute?: { id?: string; status?: ShapeStatus; matching?: boolean } | null,
    arrived: (number | null)[] | null = null,
  ) {
    if (gen !== tripSeq) return;
    const { byId, byDesig } = untrack(() => stopsMaps);
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
    const { points: routePts, detour } = injectDetourPoints(pts, tripData?.line?.name, tripData?.direction);
    const tripNote = note ?? (detour ? detour.title : null);
    const initialRouted = precomputedRoute && precomputedRoute.length >= 2 ? precomputedRoute : null;
    trip = {
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
    };
    if (initialRouted || !needRoute) return;
    let road: LatLng[] | null = null;
    let shapeId: string | null = null;
    if (serverRoute?.id && serverRoute.status === "road") {
      const sh = await loadShapeLatest(serverRoute.id);
      if (gen !== tripSeq) return;
      if (sh) {
        road = sh.pts;
        shapeId = sh.id;
      }
    }
    // browser OSRM only while the server hasn't routed this pattern yet
    // (or an older server that sends no status); "none" = no road geometry
    if (!road && serverRoute?.status !== "none") road = await fetchRoute(routePts);
    if (gen !== tripSeq) return;
    // road geometry when available; straight lines through the stops if not
    const routed = road && road.length >= 2 ? road : pts;
    if (trip?.gen === gen) trip = { ...trip, routed, status: "ready", shapeId };
  }

  /* a trip opened before /api/stops resolved published an empty timeline:
     rebuild it against the freshly loaded stop index (same gen, no refetch) */
  let healedGen = -1;
  $effect(() => {
    const t = trip;
    if (stopsMaps.byId.size === 0 || !t) return;
    if (t.gen !== tripSeq || t.gen === healedGen) return;
    if (t.rawTimes.length === 0 || t.stops.length > 0) return;
    healedGen = t.gen;
    untrack(
      () =>
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
        ),
    );
  });

  async function openTripStatic(tripId: string | number, stop: Stop | null, note: string | null = null) {
    if (!tripId) return;
    lastReq = { kind: "static", tripId, stop };
    const gen = ++tripSeq;
    trip = loadingTrip(gen, false, stop, note, null, tripId);
    let tr: Trip | null = null;
    try {
      tr = await getTrip(tripId);
    } catch {
      tr = null; // getTrip resolves null on failure; guard anyway so we never hang on the spinner
    }
    if (gen !== tripSeq) return;
    if (!tr || !tr.times?.length) {
      const errorMsg = !tr && tripWarming(tripId) ? GZM_LOADING : undefined;
      if (trip?.gen === gen) trip = { ...trip, status: "error", errorMsg };
      return;
    }
    await buildTrip(gen, tr, null, null, stop, false, note, null, tripId, tr.shape, {
      id: tr.shape_id,
      status: tr.shape_status,
      matching: tr.shape_matching,
    });
  }

  async function openTripLive(
    execId: string,
    tripId: string | number | null,
    stop: Stop | null,
    opts?: { deepLink?: boolean },
  ) {
    if (!execId) {
      if (tripId) void openTripStatic(tripId, stop);
      return;
    }
    lastReq = { kind: "live", execId, tripId, stop };
    const gen = ++tripSeq;
    trip = loadingTrip(gen, true, stop, null, execId, tripId);
    tripExecAbort?.abort();
    const ac = new AbortController();
    tripExecAbort = ac;
    try {
      const resp = await fetchJSON<TripExecutionResponse>(
        `/api/trip_execution?exec_id=${encodeURIComponent(execId)}`,
        { cache: "no-store", signal: ac.signal },
      );
      if (gen !== tripSeq) return;
      if (!resp || !resp.trip) {
        // upstream 404: our API returns {}, the vehicle has not departed yet
        if (tripId) void openTripStatic(tripId, stop, NOT_STARTED);
        else if (opts?.deepLink) {
          // exec ids are ephemeral: a shared link may outlive the course,
          // don't strand the user on a misleading "not departed" panel
          tripSeq++;
          trip = null;
          showToast("Ten kurs już się zakończył lub jest niedostępny.");
        } else {
          // a vehicle on the map without a trip (GZM: done for the day, or zbiorkom lists no stops) never departs
          const v = vehicles.find((x) => x.id === execId);
          const off = v != null && !v.trip_id;
          if (trip?.gen === gen) {
            trip = {
              ...trip,
              status: "ready",
              note: off ? (v.agency ? `Przewoźnik ${v.agency}: rozkład niedostępny` : OFF_TRIP) : NOT_STARTED,
              line: v?.line || trip.line,
            };
          }
        }
        return;
      }
      // coerce like the server parses the same payload (parsePosition):
      // upstream may send numeric strings; normalize to real numbers
      const vLat = Number(resp.vehicle?.lat);
      const vLon = Number(resp.vehicle?.lon);
      const veh = resp.vehicle && Number.isFinite(vLat) && Number.isFinite(vLon) ? { lat: vLat, lon: vLon } : null;
      const liveInFleet = vehicles.some((v) => v.id === execId && Number.isFinite(v.lat) && Number.isFinite(v.lon));
      const hasLivePosition = veh !== null || liveInFleet;
      await buildTrip(
        gen,
        resp.trip,
        veh,
        resp.vehicle_trip_index ?? null,
        stop,
        hasLivePosition,
        vehicles.find((v) => v.id === execId)?.scheduled ? SCHEDULED : null,
        execId,
        tripId,
        resp.shape,
        { id: resp.shape_id, status: resp.shape_status, matching: resp.shape_matching },
        arrivedSecs(resp),
      );
    } catch {
      if (gen !== tripSeq) return;
      if (trip?.gen === gen) trip = { ...trip, status: "error" };
    }
  }

  /* the live timeline is fetched once on open: re-fetch it so stops passed meanwhile gain their recorded
     arrival. One request per 30 s per open trip, none while the tab is hidden, never two in flight. */
  const liveExecId = $derived(
    trip?.isLive && (trip.status === "ready" || trip.status === "routing") ? trip.execId : null,
  );
  const tripGen = $derived(trip?.gen);
  $effect(() => {
    const exec = liveExecId;
    const g = tripGen;
    if (!exec) return;
    let ac: AbortController | null = null;
    const id = setInterval(async () => {
      if (document.hidden || ac) return;
      ac = new AbortController();
      try {
        const resp = await fetchJSON<TripExecutionResponse>(
          `/api/trip_execution?exec_id=${encodeURIComponent(exec)}`,
          { cache: "no-store", signal: ac.signal },
        );
        if (g !== tripSeq || !resp?.trip) return;
        const arrived = arrivedSecs(resp);
        if (arrived && trip?.gen === g) trip = { ...trip, arrived };
        // the server swapped in a better road shape since the open (a GZM shape snapped to the roads)
        if (resp.shape_id && resp.shape_status === "road" && trip?.gen === g && trip.shapeId !== resp.shape_id) {
          const sh = await loadShapeLatest(resp.shape_id);
          if (sh && g === tripSeq && trip?.gen === g) {
            trip = { ...trip, routed: sh.pts, shapeId: sh.id, routeHint: { ...trip.routeHint, id: sh.id, matching: !!sh.partial } };
          }
        }
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
  });

  /* the server is snapping the open trip's shape to the roads, the part on screen first: send it the view
     (padded by a quarter, so the raw rest stays off screen) and pick up each stage as soon as it lands instead
     of on the next 30 s refresh (static trips have none). One request per second (a bodiless 304 while nothing
     changed), at most 100 per stage, none while the tab is hidden, never two in flight; ends with the full
     match or the trip. */
  const matchingShape = $derived(
    trip?.routeHint?.matching && trip.shapeId && trip.shapeId === trip.routeHint.id ? trip.shapeId : null,
  );
  $effect(() => {
    const id = matchingShape;
    const g = tripGen;
    if (!id) return;
    let ac: AbortController | null = null;
    let polls = 0;
    const timer = setInterval(async () => {
      if (document.hidden || ac) return;
      if (++polls > MATCH_POLLS) {
        clearInterval(timer);
        return;
      }
      ac = new AbortController();
      try {
        const view = map?.getBounds().pad(0.25);
        const near = view && [view.getSouth(), view.getWest(), view.getNorth(), view.getEast()].map((x) => x.toFixed(4)).join(",");
        const sh = await fetchNewerShape(id, ac.signal, near);
        if (sh && g === tripSeq && trip?.gen === g && trip.shapeId === id) {
          trip = { ...trip, routed: sh.pts, shapeId: sh.id, routeHint: { ...trip.routeHint, id: sh.id, matching: !!sh.partial } };
        }
      } catch {
        /* the next tick retries */
      } finally {
        ac = null;
      }
    }, MATCH_POLL_MS);
    return () => {
      clearInterval(timer);
      ac?.abort();
    };
  });

  function retryTrip() {
    const req = lastReq;
    if (!req) return;
    if (req.kind === "live") void openTripLive(req.execId, req.tripId, req.stop);
    else void openTripStatic(req.tripId, req.stop);
  }

  function closeJourney() {
    journeySeq++;
    journey = null;
  }

  function handleSelectJourneyLeg(legIdx: number | null) {
    if (journey) journey = { ...journey, selectedLegIdx: legIdx };
  }

  function handleBackToConnections() {
    closeJourney();
    connModalOpen = true;
  }

  function handleFocusJourneyStop(lat: number, lon: number) {
    const m = map;
    if (m) glideTo(m, [lat, lon], Math.max(m.getZoom(), 16), focusPoint(m, desktop, openSheetCover()));
  }

  function handleSelectStop(s: Stop, opts?: { fly?: boolean }) {
    /* picking a stop while a trip/journey is drawn closes it so the
       stop sheet actually shows */
    closeTrip();
    closeJourney();
    selectedStop = s;
    const m = map;
    if (!m) return;
    // the stop sheet opens at half: land the stop in the map left above it
    const at = focusPoint(m, desktop, SNAP_COVER.half);
    if (opts?.fly) glideTo(m, [s.lat, s.lon], Math.max(m.getZoom(), 16), at);
    // tapped on the map: move only when the sheet would cover it
    else if (isCovered(m, desktop, SNAP_COVER.half, m.latLngToContainerPoint([s.lat, s.lon])))
      glideTo(m, [s.lat, s.lon], m.getZoom(), at);
  }

  function toggleStops() {
    stopsVisible = !stopsVisible;
  }
  function toggleBikes() {
    bikesVisible = !bikesVisible;
  }
  $effect(() => {
    const on = bikesVisible;
    try {
      window.localStorage.setItem("kb:bikes", on ? "1" : "0");
    } catch {
      /* private mode */
    }
  });
  function pickStopFly(s: Stop) {
    handleSelectStop(s, { fly: true });
  }

  /* search bar focus handle */
  function handleFocusSearch() {
    searchRef.current?.focus();
  }

  /* connections modal ("Wyszukaj połączenie") */
  function openConnModal() {
    connModalOpen = true;
  }
  function closeConnModal() {
    connModalOpen = false;
    connInitialFrom = null;
  }

  function handlePlanRoute(s: Stop) {
    connInitialFrom = s;
    connModalOpen = true;
  }

  async function handleSelectConnection(conn: ConnectionItinerary, selectedLegIdx: number | null = null) {
    closeTrip();
    selectedStop = null;

    const gen = ++journeySeq;
    const { byId, byDesig } = untrack(() => stopsMaps);

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
    const fromStop = firstLeg ? (byId.get(firstLeg.fromStopId) ?? byDesig.get(firstLeg.fromStopId) ?? null) : null;
    const toStop = lastLeg ? (byId.get(lastLeg.toStopId) ?? byDesig.get(lastLeg.toStopId) ?? null) : null;

    journey = {
      gen,
      itinerary: conn,
      fromStop,
      toStop,
      legs: legsResolved,
      selectedLegIdx,
      status: "routing",
    };

    // Road geometry for all legs in parallel: the server-stored trip shape
    // sliced between the leg's first and last stop, browser OSRM otherwise
    const routedLegs = await Promise.all(
      legsResolved.map(async (lr) => {
        const legStops = lr.leg.stops ?? [];
        const pts: LatLng[] = legStops.filter((s) => s.lat && s.lon).map((s) => [s.lat!, s.lon!] as LatLng);
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

    if (gen !== journeySeq) return;
    if (journey?.gen === gen) journey = { ...journey, legs: routedLegs, status: "ready" };
  }

  /* announcements sheet ("Utrudnienia") */
  function openAnnouncements() {
    annOpen = true;
  }
  function closeAnnouncements() {
    annOpen = false;
  }

  /* "Inne miasto" sheet: the city chooser opened from the menu */
  function openCitySheet() {
    cityOpen = true;
  }
  function closeCitySheet() {
    cityOpen = false;
  }

  function closeNearby() {
    nearbyOpen = false;
    nearbyPlace = null;
  }
  function closeLine() {
    openLine = null;
    lineVariant = null;
  }
  function setLineVariant(v: LineVariant | null) {
    lineVariant = v;
  }
  function setOperatorFilter(f: "all" | "kb" | "mzk") {
    operatorFilter = f;
  }

  /* line filter: toggling a line on also frames its live vehicles */
  function toggleLineFilter(line: string) {
    const adding = !lineFilter?.has(line);
    const next = new Set(lineFilter ?? []);
    if (next.has(line)) next.delete(line);
    else next.add(line);
    lineFilter = next.size ? next : null;
    if (adding && map) {
      const vs = vehicles.filter((v) => v.line === line);
      if (vs.length) {
        map.fitBounds(L.latLngBounds(vs.map((v): [number, number] => [v.lat, v.lon])), {
          padding: [60, 60],
          maxZoom: 14,
          ...panMotion(0.8),
        });
      }
    }
  }
  function clearLineFilter() {
    lineFilter = null;
  }
  const filterLines = $derived(lineFilter ? [...lineFilter] : null);
  $effect(() => {
    saveLines(filterLines, city);
  });

  /* ---- deep links: URL -> state (hydration) and state -> URL (sync) ----
     Plain History API: all URL work below runs in effects/listeners over plain
     variables, so the 4 s poll cycle never sees any of it. */

  /* stop/trip hydration waits for /api/stops (near-instant, our own API) so the
     opened trip carries stop context; consumed exactly once and never over a
     user interaction that beat it */
  let dlConsumed = false;
  $effect(() => {
    if (dlConsumed) return;
    const dl = initialUrl;
    if (!dl.stop && !dl.exec && !dl.trip) {
      dlConsumed = true;
      return;
    }
    if (tripSeq > 0 || selectedStop != null) {
      dlConsumed = true;
      return;
    }
    if (stopsMaps.byDesig.size === 0) return;
    dlConsumed = true;
    const s = dl.stop ? (stopsMaps.byDesig.get(dl.stop) ?? null) : null;
    // deferred a tick: state written here would land in the same flush as the URL sync below
    const t = setTimeout(() => {
      if (dl.stop && !s) showToast("Nie znaleziono przystanku z linku.");
      if (s) {
        selectedStop = s;
        if (!dl.map) map?.setView([s.lat, s.lon], 16, { animate: false });
      }
      if (dl.exec) void openTripLive(dl.exec, dl.trip, s, { deepLink: true });
      else if (dl.trip) void openTripStatic(dl.trip, s);
    }, 0);
    return () => clearTimeout(t);
  });

  /* state -> URL. One writer; plain variables carry everything the popstate/moveend
     listeners need so they stay mount-once and render-free. */
  let urlState: UrlState = initialUrl;
  const urlSync = {
    pushed: 0,
    expectPop: 0,
    fromPop: false,
    prevDepth: 0,
    prevOverlays: 0,
    // sheets with no URL param of their own: back closes them via onPop
    journey: false,
    ann: false,
    cityPick: false,
    modal: false,
    nearby: false,
    line: false,
  };
  const tripOpen = $derived(trip != null);
  // a live-opened trip keeps exec= even when buildTrip downgrades it to isLive=false
  // (no position yet): the course is still the one the URL must reopen
  const tripExecId = $derived(trip?.execId ?? null);
  const tripIsStatic = $derived(tripOpen && !tripExecId);
  const journeyOpen = $derived(journey != null);
  $effect(() => {
    const st = urlSync;
    // journey replaces stop/trip as the base sheet; the announcements sheet and
    // the connections modal stack on top, each with a same-URL history entry
    const overlays =
      (annOpen ? 1 : 0) + (cityOpen ? 1 : 0) + (connModalOpen ? 1 : 0) + (nearbyOpen ? 1 : 0) + (openLine ? 1 : 0);
    const depth = (tripOpen ? 2 : selectedStop || journeyOpen ? 1 : 0) + overlays;
    const stopDesig = selectedStop?.designator ?? null;
    const execId = tripExecId;
    const isStatic = tripIsStatic;
    const lines = filterLines;
    const prev = st.prevDepth;
    const prevOverlays = st.prevOverlays;
    st.prevDepth = depth;
    st.prevOverlays = overlays;
    st.journey = journeyOpen;
    st.ann = annOpen;
    st.cityPick = cityOpen;
    st.nearby = nearbyOpen;
    st.line = openLine != null;
    st.modal = connModalOpen;
    const fromPop = st.fromPop;
    st.fromPop = false;
    // a deep link not hydrated yet (waits for /api/stops) stays in the URL:
    // urlState keeps initialUrl, so a reload or a copied link still has it
    if (!dlConsumed) return;
    const staticId = isStatic && lastReq?.kind === "static" ? String(lastReq.tripId) : null;
    const m = untrack(() => map);
    const c = m?.getCenter();
    urlState = {
      stop: stopDesig,
      exec: execId,
      trip: staticId,
      lines,
      map: m && c ? { lat: c.lat, lon: c.lng, zoom: m.getZoom() } : urlState.map,
    };
    const search = withCity(buildSearch(urlState), city);
    if (depth > prev && !fromPop) {
      // sheet appeared/deepened: its own history entry, so back closes it
      // (a same-URL overlay pushes too; landing on a deep link does not)
      if (search !== window.location.search || overlays > prevOverlays) {
        window.history.pushState({ kb: true }, "", search || window.location.pathname);
        st.pushed++;
      }
    } else if (depth < prev && !fromPop && st.pushed > 0) {
      // closed from the UI: unwind our entries; the popstate handler consumes
      // this and repairs the restored URL if it drifted
      const steps = Math.min(st.pushed, prev - depth);
      st.pushed -= steps;
      st.expectPop++;
      window.history.go(-steps);
    } else if (search !== window.location.search) {
      // same-level change (stop to stop, filter, trip kind): replace in place
      window.history.replaceState({ kb: true }, "", search || window.location.pathname);
    }
  });

  function openVehicleCard(side: string) {
    if (cardOpen) return;
    cardOpen = side;
    window.history.pushState({ kb: true }, "", window.location.href);
    cardSide = side;
  }

  function closeVehicleCard() {
    if (!cardOpen) return;
    cardOpen = null;
    cardSide = null;
    urlSync.expectPop++;
    window.history.back();
  }

  /* "Pokaż na mapie" in the card: its course is usually the open trip, else open that one */
  function showCardOnMap(execId: string) {
    closeVehicleCard();
    if (tripExecId === execId) return;
    vehMeta = null;
    void openTripLive(execId, null, null);
  }

  /* popstate: deliberately close-only. Android/browser back closes sheets;
     forward into a sheet the state doesn't have just repairs the URL (state is
     authoritative). Full back/forward re-opening is not worth the surface. */
  function onPop(): void {
    const st = urlSync;
    if (st.expectPop > 0 || cardOpen) {
      // our own unwind, or back while the vehicle card is open: that closes just the card
      if (st.expectPop > 0) st.expectPop--;
      else {
        cardOpen = null;
        cardSide = null;
      }
      const want = withCity(buildSearch(urlState), city);
      if (window.location.search !== want) {
        window.history.replaceState({ kb: true }, "", want || window.location.pathname);
      }
      return;
    }
    // topmost first: the modal, then the city sheet, then the announcements sheet, each one level
    if (st.modal || st.ann || st.cityPick) {
      st.fromPop = true;
      st.pushed = Math.max(0, st.pushed - 1);
      if (st.modal) closeConnModal();
      else if (st.cityPick) closeCitySheet();
      else closeAnnouncements();
      return;
    }
    const dl = parseUrlState(window.location.search);
    const cur = urlState;
    const wantsTrip = !!(dl.exec || dl.trip);
    const haveTrip = !!(cur.exec || cur.trip);
    if (!wantsTrip && haveTrip) {
      st.fromPop = true;
      st.pushed = Math.max(0, st.pushed - 1);
      closeTrip(); // a journey under it has its own entry
      if (!dl.stop) selectedStop = null;
      return;
    }
    if (!dl.stop && !wantsTrip && cur.stop) {
      st.fromPop = true;
      st.pushed = Math.max(0, st.pushed - 1);
      selectedStop = null;
      closeJourney();
      return;
    }
    if (st.journey) {
      st.fromPop = true;
      st.pushed = Math.max(0, st.pushed - 1);
      closeJourney();
      return;
    }
    if (st.nearby || st.line) {
      st.fromPop = true;
      st.pushed = Math.max(0, st.pushed - 1);
      closeNearby();
      closeLine();
      return;
    }
    const want = withCity(buildSearch(cur), city);
    if (window.location.search !== want) {
      window.history.replaceState({ kb: true }, "", want || window.location.pathname);
    }
  }

  /* "Wyczyść widok": close every sheet and drop the line filter */
  function handleClearView() {
    closeTrip();
    closeJourney();
    selectedStop = null;
    nearbyOpen = false;
    openLine = null;
    lineFilter = null;
  }

  function handleCloseAll() {
    closeTrip();
    closeJourney();
    selectedStop = null;
  }

  function handleCloseStop() {
    selectedStop = null;
  }

  function handleShowLive(execId: string, tripId: string | number | null) {
    vehMeta = null;
    void openTripLive(execId, tripId, selectedStop);
  }

  function handleShowStatic(tripId: string | number) {
    vehMeta = null;
    void openTripStatic(tripId, selectedStop);
  }

  function handleVehicleClick(v: Vehicle) {
    /* a trip without a stop under it unwinds two history levels on close (trip depth), which
       would take the nearby sheet's entry with it */
    nearbyOpen = false;
    openLine = null;
    vehMeta = v;
    const m = map;
    if (m && Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
      // zoom in on where the marker is drawn (dead-reckoned), not the raw fix behind it, landing
      // it above the trip sheet (opens at half); TripLayer skips its route fit for this trip
      const d = peekVehicleAnimator(m)?.displayed(v.id);
      const at = focusPoint(m, desktop, SNAP_COVER.half);
      glideTo(m, d ? [d.lat, d.lon] : [v.lat, v.lon], Math.max(m.getZoom(), 16), at);
    }
    void openTripLive(v.id, null, null);
  }

  /* trip sheet's locate button: fly to where the bus is drawn (dead-reckoned) when it is on the fleet layer */
  function handleLocateVehicle(v: { id: string | null; lat: number; lon: number }) {
    const m = map;
    if (!m) return;
    const d = v.id ? peekVehicleAnimator(m)?.displayed(v.id) : null;
    const at = focusPoint(m, desktop, openSheetCover());
    glideTo(m, d ? [d.lat, d.lon] : [v.lat, v.lon], Math.max(m.getZoom(), 16), at);
  }

  /* glide to a stop tapped on the trip timeline (does not change selection) */
  function handleFocusStop(s: Stop) {
    const m = map;
    if (m) glideTo(m, [s.lat, s.lon], Math.max(m.getZoom(), 16), focusPoint(m, desktop, openSheetCover()));
  }

  onMount(() => {
    if (!mapEl) return;
    const m = L.map(mapEl, {
      center: initialUrl.map ? [initialUrl.map.lat, initialUrl.map.lon] : cityCfg.center,
      zoom: initialUrl.map?.zoom ?? cityCfg.zoom,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: false,
    });
    // bottom-left, away from the zoom + locate column in the right corner
    L.control
      .attribution({
        position: "bottomleft",
        prefix: cityCfg.attribution ? `${OSRM_CREDIT} | Dane: ${cityCfg.attribution}` : OSRM_CREDIT,
      })
      .addTo(m);
    const expandAttribution = collapseAttribution(m);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    installSmoothZoom(m);
    // guard against a 0x0 container at mount (dvh reflow on mobile): re-measure
    // once layout settles so the GL canvas isn't sized from an empty box
    const raf = requestAnimationFrame(() => m.invalidateSize(false));

    // Freeze CSS transitions on markers while the map is moving, zooming or flying
    // so vehicle markers don't slide or drift relative to stops or geography
    const container = m.getContainer();
    let moveEndTimer: ReturnType<typeof setTimeout> | null = null;
    const onMoveStart = () => {
      // the follow lock pans every frame: the tracked marker's CSS glide must keep running
      if (isLockMove(m)) return;
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

    // keep map= in the URL fresh: debounced replaceState over plain state, no
    // reactive writes (Safari throttles ~100 history calls/30 s, hence debounce + skip)
    let urlTimer: ReturnType<typeof setTimeout> | null = null;
    m.on("moveend", () => {
      if (urlTimer) clearTimeout(urlTimer);
      urlTimer = setTimeout(() => {
        const c = m.getCenter();
        urlState = { ...urlState, map: { lat: c.lat, lon: c.lng, zoom: m.getZoom() } };
        const search = withCity(buildSearch(urlState), city);
        if (search !== window.location.search) {
          window.history.replaceState({ kb: true }, "", search || window.location.pathname);
        }
      }, 500);
    });

    window.addEventListener("popstate", onPop);
    map = m;
    return () => {
      window.removeEventListener("popstate", onPop);
      cancelAnimationFrame(raf);
      if (moveEndTimer) clearTimeout(moveEndTimer);
      if (urlTimer) clearTimeout(urlTimer);
      expandAttribution();
      map = null;
      m.remove();
    };
  });

  /* the vector style failed twice (or the raster style is picked): plain raster tiles under everything */
  const tiles = $derived(BASE_LAYERS[baseLayer]);
  const raster = $derived(basemap.status === "failed" || tiles.kind !== "vector");
  $effect(() => {
    if (!map || !raster) return;
    const fb = RASTER_FALLBACK[baseLayer];
    const layer = L.tileLayer(fb.url, { className: fb.className, maxZoom: 19, attribution: fb.attribution }).addTo(map);
    return () => {
      layer.remove();
    };
  });

  let pingMarker: L.Marker | null = null;
  $effect(() => {
    if (map) pingMarker = placeMarker(map, pingMarker, liveStop && [liveStop.lat, liveStop.lon], stopPingIcon);
  });
  let placeMarkerRef: L.Marker | null = null;
  $effect(() => {
    if (map) {
      const at: L.LatLngTuple | null = nearbyOpen && nearbyPlace ? [nearbyPlace.lat, nearbyPlace.lon] : null;
      placeMarkerRef = placeMarker(map, placeMarkerRef, at, placePinIcon);
    }
  });
  let userMarker: L.Marker | null = null;
  let accuracyCircle: L.Circle | null = null;
  $effect(() => {
    if (!map) return;
    const p = geo.pos;
    const acc = p && p.accuracy > 0 && p.accuracy < 2000 ? p : null;
    if (!acc) {
      accuracyCircle?.remove();
      accuracyCircle = null;
    } else if (!accuracyCircle) {
      accuracyCircle = L.circle([acc.lat, acc.lon], {
        radius: acc.accuracy,
        color: "#2b83ff",
        weight: 1,
        opacity: 0.5,
        fillColor: "#2b83ff",
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(map);
    } else {
      accuracyCircle.setLatLng([acc.lat, acc.lon]);
      accuracyCircle.setRadius(acc.accuracy);
    }
    userMarker = placeMarker(map, userMarker, p && [p.lat, p.lon], userIcon, 300);
    /* the rider's heading turns the cone inside the dot in place: never a new icon per fix */
    const head = userMarker?.getElement()?.querySelector<HTMLElement>(".user-loc-head");
    if (head) {
      head.hidden = p?.heading == null;
      if (p?.heading != null) head.style.transform = `rotate(${p.heading}deg)`;
    }
  });

  /* locate button: start (or reuse) the GPS watch and recenter on the fix */
  function flyToUser(p: { lat: number; lon: number }) {
    const m = map;
    if (m) glideTo(m, [p.lat, p.lon], Math.max(m.getZoom(), 15), focusPoint(m, desktop, openSheetCover()));
  }

  function handleLocate() {
    // following (or still acquiring): the tap turns the GPS off (stops the drain)
    if (geoFollowing || geo.status === "locating") {
      wantFly = false;
      geoFollow = false;
      geo.stop();
      return;
    }
    // off, or on after a drag ended following: follow, recentred by the effect below on the current or first fix
    wantFly = true;
    geoFollow = true;
    geo.locate();
  }

  /* following pauses while a sheet that placed the map is open (stop, trip, connection, address, line) */
  const geoPanning = $derived(geoFollowing && !selectedStop && !trip && !journey && !nearbyPlace && !openLine);
  let geoZooming = false;
  $effect(() => {
    const m = map;
    if (!geoFollow || !m) return;
    const stop = () => (geoFollow = false);
    const zoomStart = () => (geoZooming = true);
    const zoomEnd = () => (geoZooming = false);
    m.on("dragstart", stop).on("zoomstart", zoomStart).on("zoomend", zoomEnd);
    return () => {
      geoZooming = false;
      m.off("dragstart", stop).off("zoomstart", zoomStart).off("zoomend", zoomEnd);
    };
  });

  /* a locate request recentres once (zoom 15+); while following every later fix pans at the current zoom,
     skipped during a pinch/wheel zoom (a glide would abort it). geoFollow is read so a tap that
     re-follows recentres at once instead of on the next fix. */
  $effect(() => {
    const p = geo.pos;
    const m = map;
    const panning = geoPanning;
    void geoFollow;
    if (!p || !m) return;
    if (wantFly) {
      wantFly = false;
      flyToUser(p);
      return;
    }
    if (!panning || geoZooming || document.hidden) return;
    const at = focusPoint(m, desktop, openSheetCover());
    if (m.latLngToContainerPoint([p.lat, p.lon]).distanceTo(at) >= 2) glideTo(m, [p.lat, p.lon], m.getZoom(), at);
  });

  /* "W pobliżu" replaces whatever sheet is open; without a fix yet it locates first and the
     sheet says so until the fix lands */
  function openNearby() {
    closeTrip();
    closeJourney();
    selectedStop = null;
    openLine = null;
    nearbyPlace = null;
    nearbyOpen = true;
    if (!geo.pos && geo.status !== "locating") geo.locate();
  }

  /* an address from search: nearby around that point, the map glides there */
  function openPlace(g: GeoHit) {
    closeTrip();
    closeJourney();
    selectedStop = null;
    openLine = null;
    nearbyPlace = g;
    nearbyOpen = true;
    flyToUser(g);
  }

  /* a line from search replaces whatever sheet is open, like nearby */
  function openLineView(l: LineInfo) {
    closeTrip();
    closeJourney();
    selectedStop = null;
    nearbyOpen = false;
    lineVariant = null;
    openLine = l;
  }

  /* router stop id (KB id, mzk:<symbol>, gzm:<id>) to the map's stop */
  function resolveStop(id: string): Stop | null {
    return stopsMaps.byId.get(id) ?? stopsMaps.byDesig.get(id) ?? null;
  }

  /* palette "Moja lokalizacja": always fly-to-me, never the LocateButton's
     toggle-off, which would surprise from a search action */
  function paletteLocate() {
    if (geo.pos) {
      flyToUser(geo.pos);
      return;
    }
    wantFly = true;
    geo.locate();
  }

  /* trip opened from a stop: back returns to that stop's sheet */
  const tripFromStop = $derived(!!trip && trip.stop != null && selectedStop != null);

  /* live fix for the open trip: the live poll keeps the drawn
     vehicle's position, heading, delay and current stop fresh (matched by
     exec id or trip id), so it moves on the map and advances the timeline without
     re-opening the route. If the course was opened statically before the bus departed,
     it automatically starts tracking live as soon as the vehicle appears online. */
  const liveTripVeh = $derived.by(() => {
    if (!trip) return null;
    const exec = trip.execId;
    if (exec) {
      const byExec = vehicles.find((v) => v.id === exec);
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
  });

  /* "Śledź pojazd": the trip generation being followed (a new trip or close ends it without a reset) */
  let followGen = $state<number | null>(null);
  const following = $derived(trip != null && trip.isLive && followGen === trip.gen);
  function toggleFollow() {
    followGen = followGen === tripSeq ? null : tripSeq;
  }
  const followId = $derived(following ? (liveTripVeh?.id ?? trip?.execId ?? null) : null);
  $effect(() => {
    const m = map;
    const id = followId;
    if (!id || !m) return;
    const stop = () => (followGen = null);
    m.on("dragstart", stop);
    // smooth motion off: the marker CSS-glides to each new fix (globals.css .veh-marker), the camera along
    let glide: { from: L.LatLng; to: L.LatLng; t0: number } | null = null;
    const along = (g: { from: L.LatLng; to: L.LatLng; t0: number }, now: number) => {
      const k = Math.min(1, (now - g.t0) / MARKER_GLIDE_MS);
      return L.latLng(g.from.lat + (g.to.lat - g.from.lat) * k, g.from.lng + (g.to.lng - g.from.lng) * k);
    };
    const target = () => {
      // where the marker is drawn (dead-reckoned), the raw fix when smooth motion is off
      const d = peekVehicleAnimator(m)?.displayed(id);
      if (!d) return null;
      const ll = L.latLng(d.lat, d.lon);
      if (getSmoothMotion()) {
        glide = null;
        return ll;
      }
      const now = performance.now();
      if (!glide || !glide.to.equals(ll)) glide = { from: glide ? along(glide, now) : ll, to: ll, t0: now };
      return along(glide, now);
    };
    const unlock = lockOn(m, target, () => focusPoint(m, desktop, openSheetCover()));
    const release = holdWakeLock();
    return () => {
      unlock();
      release();
      m.off("dragstart", stop);
    };
  });

  const lineFilterCount = $derived.by(() => {
    const f = lineFilter;
    return f
      ? vehicles.filter(
          (v) =>
            !v.agency &&
            f.has(v.line) &&
            (operatorFilter === "all" || (v.operator ?? "KB").toLowerCase() === operatorFilter),
        ).length
      : 0;
  });
</script>

<div class="fixed inset-0 h-full w-full overflow-hidden bg-bg">
  <div bind:this={mapEl} class="absolute inset-0 z-0 h-full w-full"></div>
  {#if map}
    {#if !raster && tiles.kind === "vector"}
      {#key `${baseLayer}-${basemap.attempt}`}
        <VectorBaseLayer {map} style={tiles.style} filter={tiles.filter} onStatus={handleBasemapStatus} />
      {/key}
    {/if}
    <StopsLayer
      {map}
      stops={filteredStops}
      visible={stopsVisible}
      onSelect={handleSelectStop}
      minZoom={cityCfg.stopMinZoom}
    />
    {#if city === "gzm"}
      <BikesLayer {map} visible={bikesVisible} />
    {/if}
    <TripLayer {map} {trip} {desktop} {vehMeta} liveVehicle={liveTripVeh} />
    <JourneyLayer {map} {journey} {desktop} />
    <LineLayer
      {map}
      line={openLine}
      variant={openLine ? lineVariant : null}
      {desktop}
      {resolveStop}
      onSelectStop={pickStopFly}
    />
    <!-- while a route or journey is drawn, hide the live fleet -->
    <VehicleLayer
      {map}
      {vehicles}
      onVehicleClick={handleVehicleClick}
      hidden={trip != null || journey != null}
      {lineFilter}
      {operatorFilter}
    />
  {/if}

  <!-- dark veil until the basemap's first paint: liberty's background layer
       is light, so without this a slow style/tile fetch reads as a white map -->
  {#if basemap.status === "loading"}
    <div class="pointer-events-none absolute inset-0 z-[500] bg-bg animate-fade" aria-hidden="true">
      <div class="skeleton absolute inset-0 rounded-none opacity-20"></div>
    </div>
  {/if}

  <TopBar
    count={vehQ.data?.count ?? null}
    offline={!!vehQ.error}
    {stopsVisible}
    onToggleStops={toggleStops}
    {bikesVisible}
    onToggleBikes={city === "gzm" ? toggleBikes : undefined}
    {baseLayer}
    onBaseLayer={setBaseLayer}
    onOpenAnnouncements={openAnnouncements}
    onOpenCity={openCitySheet}
    {stops}
    geoPos={geo.pos}
    onLocate={paletteLocate}
    onPickStop={pickStopFly}
    onPickVehicle={handleVehicleClick}
    {lineFilter}
    onOpenLine={openLineView}
    onClearLineFilter={clearLineFilter}
    onClearView={handleClearView}
    onOpenNearby={openNearby}
    onPickPlace={openPlace}
    onOpenConnections={openConnModal}
    {searchRef}
    {operatorFilter}
    onOperatorFilter={setOperatorFilter}
    onShowToast={showToast}
  />

  {#if filterLines}
    <LineFilterChip
      lines={filterLines}
      visibleCount={lineFilterCount}
      onClear={clearLineFilter}
      onOpenPalette={handleFocusSearch}
    />
  {/if}

  <LocateButton status={geo.status} following={geoFollowing} onLocate={handleLocate} />
  <RouteButton onClick={openConnModal} />
  {#if geo.status === "active" && !nearbyOpen && !openLine && !trip && !journey && !liveStop && !annOpen && !cityOpen}
    <NearbyButton onClick={openNearby} />
  {/if}

  <ConnectionsModal
    open={connModalOpen}
    onClose={closeConnModal}
    {stops}
    geoPos={geo.pos}
    geoStatus={geo.status}
    onLocate={geo.locate}
    initialFrom={connInitialFrom}
    onSelectStop={pickStopFly}
    onSelectConnection={handleSelectConnection}
    {vehicles}
  />

  {#if toast}
    <Toast text={toast} onClose={closeToast} />
  {/if}

  <!-- the fleet card (charts and all) loads only when a vehicle card is first opened -->
  {#if cardSide}
    {#await import("@/components/brygady/VehicleSheet.svelte") then { default: VehicleSheet }}
      {#key cardSide}
        <VehicleSheet side={cardSide} onClose={closeVehicleCard} onShowOnMap={showCardOnMap} />
      {/key}
    {/await}
  {/if}

  <!-- one sheet at a time: city chooser over announcements over trip over stop over nearby or
       line; closing the top one returns to whichever sheet was underneath -->
  {#if cityOpen}
    <CitySheet {desktop} onClose={closeCitySheet} />
  {:else if annOpen}
    <AnnouncementsSheet {desktop} onClose={closeAnnouncements} />
  {:else if trip}
    {#key trip.gen}
      <TripPanel
        {trip}
        {desktop}
        {vehMeta}
        liveVeh={liveTripVeh}
        onBack={tripFromStop ? closeTrip : null}
        onClose={handleCloseAll}
        onFocusStop={handleFocusStop}
        onLocate={handleLocateVehicle}
        {following}
        onToggleFollow={toggleFollow}
        onRetry={retryTrip}
        onOpenVehicleCard={openVehicleCard}
        onShowToast={showToast}
        initialSnap="half"
      />
    {/key}
  {:else if journey}
    {#key journey.gen}
      <JourneyView
        {journey}
        {desktop}
        onClose={closeJourney}
        onBackToSearch={handleBackToConnections}
        onSelectLeg={handleSelectJourneyLeg}
        onFocusStop={handleFocusJourneyStop}
        {vehicles}
        onShowToast={showToast}
      />
    {/key}
  {:else if liveStop}
    {#key liveStop.designator}
      <StopView
        stop={liveStop}
        {desktop}
        {vehicles}
        onClose={handleCloseStop}
        onShowLive={handleShowLive}
        onShowStatic={handleShowStatic}
        onPlanRoute={handlePlanRoute}
        {walkM}
      />
    {/key}
  {:else if nearbyOpen}
    <NearbyView
      {desktop}
      {stops}
      pos={nearbyPlace ?? geo.pos}
      geoStatus={geo.status}
      place={nearbyPlace}
      {vehicles}
      onSelectStop={pickStopFly}
      onClose={closeNearby}
    />
  {:else if openLine}
    {#key `${openLine.operator}-${openLine.name}`}
      <LineView
        {desktop}
        line={openLine}
        {city}
        filterActive={!!lineFilter?.has(openLine.name)}
        onToggleFilter={toggleLineFilter}
        {resolveStop}
        onSelectStop={pickStopFly}
        onVariant={setLineVariant}
        onClose={closeLine}
      />
    {/key}
  {/if}
</div>
