<script module lang="ts">
  import {
    BriefcaseIcon,
    ClockIcon,
    HouseIcon,
    LightningIcon,
    ArrowsLeftRightIcon,
    PersonSimpleWalkIcon,
  } from "@/components/icon-paths";
  import type { Place, PlaceSlot } from "@/lib/client/places";
  import type { TransitMode } from "@/lib/client/format";
  import type { Stop } from "@/lib/client/types";

  /** walk radius of a search from a point, metres; the choice is kept per browser */
  const WALK_OPTIONS: readonly number[] = [400, 800, 1200];
  const WALK_DEFAULT = 800;
  const WALK_KEY = "kb:walkMax";
  const fmtWalk = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toLocaleString("pl-PL")} km`);
  function storedWalk(): number {
    try {
      const v = Number(window.localStorage.getItem(WALK_KEY));
      return WALK_OPTIONS.includes(v) ? v : WALK_DEFAULT;
    } catch {
      return WALK_DEFAULT;
    }
  }
  /** result order; the chip steps through them */
  const SORTS = [
    { id: "departure", label: "Wg odjazdu", title: "Kolejność: najwcześniejszy odjazd", icon: ClockIcon },
    { id: "duration", label: "Najszybsza trasa", title: "Kolejność: najkrótszy czas podróży", icon: LightningIcon },
    { id: "transfers", label: "Najmniej przesiadek", title: "Kolejność: najmniej przesiadek", icon: ArrowsLeftRightIcon },
    { id: "walk", label: "Najmniej pieszo", title: "Kolejność: najmniej chodzenia, przejście między przystankami liczy się potrójnie", icon: PersonSimpleWalkIcon },
  ] as const;
  type SortBy = (typeof SORTS)[number]["id"];
  /** GTFS route types a rider can leave out (zbiorkom cities; BB runs buses only) */
  const MODES: readonly { type: string; mode: TransitMode; label: string }[] = [
    { type: "3", mode: "bus", label: "autobus" },
    { type: "0", mode: "tram", label: "tramwaj" },
    { type: "11", mode: "trolleybus", label: "trolejbus" },
    { type: "1", mode: "metro", label: "metro" },
  ];
  /** "Pomiń" chips: avoided lines first, then the last answer's in line order (a new answer keeps the row still) */
  const AVOID_CHIPS = 10;
  const toggled = (list: readonly string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  /** The one high-emphasis action of a view: neutral, inverted. */
  const CTA =
    "tap inline-flex items-center justify-center gap-1.5 rounded-full bg-text px-4 font-medium text-bg hover:bg-tint";

  /** A search from or to a point: the rider's location (a snapshot of the first fix, "pending" until it
   *  lands, origin only) or a searched address, which carries its label. */
  type GeoPoint = { lat: number; lon: number; label?: string };
  type GeoOrigin = GeoPoint | "pending" | null;
  // RFC 5870 geo URI; 4 decimals (~11 m) keep the server's memo warm and the trace coarse
  const geoParam = (p: GeoPoint) => `geo:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
  /* a GPS point moves with the rider: only a stop or a named point is worth saving */
  const asPlace = (stop: Stop | null, geo: GeoOrigin): Place | null =>
    geo ? (geo !== "pending" && geo.label ? { lat: geo.lat, lon: geo.lon, label: geo.label } : null) : stop ? { designator: stop.designator } : null;

  const PLACE_SLOTS = [
    { slot: "home", label: "Dom", icon: HouseIcon },
    { slot: "work", label: "Praca", icon: BriefcaseIcon },
  ] as const;
  const SLOT_LABEL: Record<PlaceSlot, string> = { home: "Dom", work: "Praca" };

  /** Leave now, leave at a time, or arrive by a time: one choice, so the row never shows two picks at once. */
  type When = "now" | "depart" | "arrive";
  const WHEN_LATER: { id: When; label: string; title?: string }[] = [
    { id: "depart", label: "Odjazd o" },
    { id: "arrive", label: "Przyjazd do", title: "Połączenia z przyjazdem najpóźniej o wybranej godzinie" },
  ];
  const WHEN_TODAY: { id: When; label: string; title?: string }[] = [{ id: "now", label: "Teraz" }, ...WHEN_LATER];
</script>

<script lang="ts">
  import { onMount } from "svelte";

  import type { ConnectionsModalProps } from "@/components/ConnectionsModal.svelte";
  import TimeInput24H from "@/components/connections/TimeInput24H.svelte";
  import { useLines } from "@/components/hooks.svelte";
  import Icon from "@/components/Icon.svelte";
  import {
    ArrowRightIcon,
    ArrowsClockwiseIcon,
    ArrowsDownUpIcon,
    BusIcon,
    CalendarBlankIcon,
    CaretDownIcon,
    CaretRightIcon,
    CaretUpIcon,
    CheckIcon,
    CrosshairIcon,
    MapPinIcon,
    MapTrifoldIcon,
    PathIcon,
    ShieldCheckIcon,
    XIcon,
  } from "@/components/icon-paths";
  import { CHIP, chip, CHIP_OFF } from "@/components/ui";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import IconButton from "@/components/ui/IconButton.svelte";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import ModeIcon from "@/components/ui/ModeIcon.svelte";
  import Segmented from "@/components/ui/Segmented.svelte";
  import StarIcon from "@/components/ui/StarIcon.svelte";
  import { geocode, getConnections, isWarming, type GeoHit } from "@/lib/client/api";
  import { CITY, getPageCity, GZM_LOADING } from "@/lib/client/city";
  import { favorites } from "@/lib/client/favorites";
  import {
    addMinutesToHHMM,
    delayClass,
    delayTxt,
    displayStopName,
    formatDayLabel,
    hhmmFromSecs,
    normalizeText,
    nowHHMM,
    offsetDateISO,
    przystanekPlural,
    todayISO,
  } from "@/lib/client/format";
  import { formatDistance, haversineMeters, nearestStops } from "@/lib/client/geo";
  import { hasRoute, placesOf, setPlace, toggleRoute, type SavedRoute } from "@/lib/client/places";
  import type { ConnectionItinerary } from "@/lib/client/types";
  import { indexVehicles, legVehicle, transferAtRisk } from "@/lib/client/vehicleIndex";
  import { gzmStopKey } from "@/lib/shared/gzm-stop-key";

  let {
    onClose,
    stops,
    geoPos,
    geoStatus,
    onLocate,
    initialFrom,
    initialTo,
    onSelectStop,
    onSelectConnection,
    vehicles,
  }: Omit<ConnectionsModalProps, "open"> = $props();

  const vix = $derived(indexVehicles(vehicles));
  // svelte-ignore state_referenced_locally
  let fromStop = $state.raw<Stop | null>(initialFrom ?? null);
  let fromGeo = $state.raw<GeoOrigin>(null);
  // the first fix after "Moja lokalizacja" becomes the origin; later fixes don't re-search
  $effect.pre(() => {
    if (fromGeo === "pending" && geoPos) fromGeo = { lat: geoPos.lat, lon: geoPos.lon };
  });
  // svelte-ignore state_referenced_locally
  let toStop = $state.raw<Stop | null>(initialTo ?? null);
  let toGeo = $state.raw<GeoPoint | null>(null);
  const hasTo = $derived(!!(toStop || toGeo));
  let fromQuery = $state("");
  let toQuery = $state("");
  // svelte-ignore state_referenced_locally
  let activeInput = $state<"from" | "to" | null>(!initialFrom ? "from" : !initialTo ? "to" : null);

  // Day selection state
  const todayStr = todayISO();
  const tomorrowStr = offsetDateISO(todayStr, 1);
  let dateMode = $state<"today" | "tomorrow" | "custom">("today");
  let selectedDate = $state(todayStr);
  let dateInput: HTMLInputElement | undefined = $state();

  // 24-hour time selection state
  let timeMode = $state<"now" | "custom">("now");
  /* the time is the latest arrival */
  let arriveBy = $state(false);
  const [hour0, minute0] = nowHHMM().split(":");
  let hour = $state(hour0);
  let minute = $state(minute0);

  // Filters state
  let directOnly = $state(false);
  let minTransfer5 = $state(false);
  let sortBy = $state<SortBy>("departure");
  let avoidTypes = $state.raw<readonly string[]>([]);
  let avoidLines = $state.raw<readonly string[]>([]);
  /* lines of the last answer: the "Pomiń" chips stay put while the next search runs */
  let answerLines = $state.raw<readonly string[]>([]);
  let walkM = $state(storedWalk());

  let connections = $state.raw<ConnectionItinerary[] | null>(null);
  /* "warming": the server is still loading the GZM data (503) */
  let connErr = $state<false | "error" | "warming">(false);
  const city = getPageCity();
  const lineData = useLines();
  const modes = $derived.by(() => {
    const types = new Set(city === "bb" ? [] : (lineData.data?.lines ?? []).map((l) => l.type ?? "3"));
    return MODES.filter((m) => types.has(m.type));
  });
  let searchTick = $state(0);
  let expandedIdx = $state<number | null>(null);

  let fromInput: HTMLInputElement | undefined = $state();
  let toInput: HTMLInputElement | undefined = $state();

  const placesStore = placesOf(city);
  const places = $derived(placesStore.current);
  // "Dom"/"Praca" waiting for the stop or address the next pick names
  let assign = $state<PlaceSlot | null>(null);
  $effect.pre(() => {
    if (assign && !activeInput) assign = null;
  });

  /* GTFS cities name every pole ("Katowice Dworzec 01" .. "10", "Centrum 02"): the search lists the stop once
     and the router (poles grouped by the same key in its index) departs from any of them; each result names
     the pole it leaves from. Names without a pole suffix (Łódź "… 0298") stay as they are. */
  const stopLabel = (name: string) => (city !== "bb" ? gzmStopKey(name) : name);

  // Pre-normalized stop lookup index
  const stopIndex = $derived(stops.map((s) => ({ s, n: normalizeText(s.name), k: normalizeText(stopLabel(s.name)) })));
  const byDesig = $derived.by(() => {
    const m = new Map<string, Stop>();
    for (const s of stops) m.set(s.designator, s);
    return m;
  });

  // Close on Escape. On document, so it runs before the stop sheet's window
  // listener, which then sees defaultPrevented and stays open.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Derived effective time parameter (HH:MM in 24h format); null while the
  // typed time is incomplete or out of range, so no search fires per keystroke
  // (the blur handler pads and clamps it into a valid one).
  const effectiveTimeParam = $derived.by(() => {
    if (timeMode === "now" && dateMode === "today") {
      return undefined; // live search from current second
    }
    if (!/^\d\d$/.test(hour) || !/^\d\d$/.test(minute) || +hour > 23 || +minute > 59) return null;
    return `${hour}:${minute}`;
  });

  const effectiveDayLabel = $derived(
    dateMode === "today" ? "Dziś" : dateMode === "tomorrow" ? "Jutro" : formatDayLabel(selectedDate, todayStr),
  );

  const fromParam = $derived(
    fromGeo && fromGeo !== "pending" ? geoParam(fromGeo) : fromStop ? fromStop.id || fromStop.name : null,
  );
  const toParam = $derived(toGeo ? geoParam(toGeo) : toStop ? toStop.id || toStop.name : null);

  const walkParam = $derived(fromParam?.startsWith("geo:") || toGeo ? walkM : undefined);

  // Async connection fetcher
  $effect(() => {
    const from = fromParam;
    const to = toParam;
    const time = effectiveTimeParam;
    if (!from || !to || time === null) return;
    // a refresh re-runs the same search
    searchTick;
    const opts = {
      time: time ?? undefined,
      date: selectedDate,
      dayLabel: effectiveDayLabel,
      directOnly,
      minTransfer: minTransfer5 ? 5 : undefined,
      sortBy,
      avoid: avoidLines,
      avoidTypes,
      walk: walkParam,
      arriveBy: arriveBy && !!time,
      city,
    };
    const ac = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const list = await getConnections(from, to, { ...opts, signal: ac.signal });
        if (!cancelled) {
          connections = list;
          answerLines = [...new Set(list.flatMap((c) => c.legs.map((l) => l.line)))].sort((a, b) =>
            a.localeCompare(b, "pl", { numeric: true }),
          );
          connErr = false;
        }
      } catch (err) {
        if (!cancelled && !ac.signal.aborted) {
          connErr = city !== "bb" && isWarming(err) ? "warming" : "error";
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  });

  function handleRefresh() {
    connections = null;
    connErr = false;
    searchTick += 1;
  }

  function handleSwap() {
    const fs = fromStop;
    const fg = fromGeo;
    const ts = toStop;
    const tg = toGeo;
    if (fg === "pending") return;
    fromStop = ts;
    fromGeo = tg;
    toStop = fs;
    toGeo = fg;
    fromQuery = "";
    toQuery = "";
    activeInput = null;
    connections = null;
    connErr = false;
    expandedIdx = null;
  }

  function handlePickStop(s: Stop, target: "from" | "to") {
    if (assign) {
      setPlace(city, assign, { designator: s.designator });
      assign = null;
    }
    if (target === "from") {
      fromStop = s;
      fromGeo = null;
      fromQuery = "";
      connections = null;
      connErr = false;
      if (!hasTo) {
        activeInput = "to";
        setTimeout(() => toInput?.focus(), 50);
      } else {
        activeInput = null;
      }
    } else {
      toStop = s;
      toGeo = null;
      toQuery = "";
      connections = null;
      connErr = false;
      activeInput = null;
    }
  }

  function pickOrigin(origin: GeoOrigin) {
    if (assign && origin && origin !== "pending") {
      setPlace(city, assign, { lat: origin.lat, lon: origin.lon, label: origin.label ?? "Zapisana lokalizacja" });
      assign = null;
    }
    fromGeo = origin;
    fromStop = null;
    fromQuery = "";
    connections = null;
    connErr = false;
    if (!hasTo) {
      activeInput = "to";
      setTimeout(() => toInput?.focus(), 50);
    } else {
      activeInput = null;
    }
  }

  function pickDest(dest: Required<GeoPoint>) {
    if (assign) {
      setPlace(city, assign, dest);
      assign = null;
    }
    toGeo = dest;
    toStop = null;
    toQuery = "";
    connections = null;
    connErr = false;
    activeInput = null;
  }

  const placeStop = (p: Place): Stop | null => ("designator" in p ? (byDesig.get(p.designator) ?? null) : null);
  const placeName = (p: Place) =>
    "designator" in p ? displayStopName(stopLabel(byDesig.get(p.designator)?.name ?? "")) : p.label;
  function applyPlace(p: Place, target: "from" | "to", name: string) {
    if (!("designator" in p)) {
      const pt = { lat: p.lat, lon: p.lon, label: name };
      return target === "from" ? pickOrigin(pt) : pickDest(pt);
    }
    const s = placeStop(p);
    if (s) handlePickStop(s, target);
  }
  function applyRoute(from: Place, to: Place, fromName: string, toName: string) {
    const f = placeStop(from);
    const t = placeStop(to);
    if (("designator" in from && !f) || ("designator" in to && !t)) return;
    fromStop = f;
    fromGeo = "designator" in from ? null : { lat: from.lat, lon: from.lon, label: fromName };
    toStop = t;
    toGeo = "designator" in to ? null : { lat: to.lat, lon: to.lon, label: toName };
    fromQuery = "";
    toQuery = "";
    activeInput = null;
    connections = null;
    connErr = false;
    expandedIdx = null;
  }
  const curFrom = $derived(asPlace(fromStop, fromGeo));
  const curTo = $derived(asPlace(toStop, toGeo));
  const curRoute: SavedRoute | null = $derived(curFrom && curTo ? { from: curFrom, to: curTo } : null);
  const quickRoutes = $derived.by(() => {
    const list: { key: string; from: Place; to: Place; label: string; fromName: string; toName: string }[] = [];
    if (places.home && places.work) {
      list.push({ key: "hw", from: places.home, to: places.work, label: "Dom → Praca", fromName: "Dom", toName: "Praca" });
      list.push({ key: "wh", from: places.work, to: places.home, label: "Praca → Dom", fromName: "Praca", toName: "Dom" });
    }
    for (const r of places.routes) {
      const fromName = placeName(r.from);
      const toName = placeName(r.to);
      list.push({ key: JSON.stringify(r), from: r.from, to: r.to, label: `${fromName} → ${toName}`, fromName, toName });
    }
    return list;
  });

  function handlePickGeo() {
    if (!geoPos) onLocate?.();
    pickOrigin(geoPos ? { lat: geoPos.lat, lon: geoPos.lon } : "pending");
  }

  // address search, one request per typing pause; a failure just lists no addresses
  const addrQuery = $derived(
    (activeInput === "from" ? fromQuery : activeInput === "to" ? toQuery : "").replace(/\s+/g, " ").trim(),
  );
  let addr = $state.raw<{ q: string; hits: GeoHit[] } | null>(null);
  $effect(() => {
    const q = addrQuery;
    if (q.length < 3) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      geocode(q, city, ac.signal).then(
        (hits) => (addr = { q, hits }),
        () => {
          if (!ac.signal.aborted) addr = { q, hits: [] };
        },
      );
    }, 350);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  });
  const addrHits = $derived(addr && addr.q === addrQuery ? addr.hits : []);

  function handlePickToday() {
    dateMode = "today";
    selectedDate = todayStr;
    connections = null;
  }

  function handlePickTomorrow() {
    dateMode = "tomorrow";
    selectedDate = tomorrowStr;
    timeMode = "custom";
    hour = "05";
    minute = "00";
    connections = null;
  }

  /** Re-search from `secs` after midnight of `date` (a list may span midnight, so paging moves the date too). */
  function searchFrom(date: string, secs: number) {
    const [h, m] = hhmmFromSecs(secs).split(":");
    selectedDate = date;
    dateMode = date === todayStr ? "today" : date === tomorrowStr ? "tomorrow" : "custom";
    hour = h;
    minute = m;
    timeMode = "custom";
    connections = null;
  }

  // departureSecs counts from the searched day's midnight, `date` is the day the journey leaves on
  const leaves = (c: ConnectionItinerary) => ({ date: c.date ?? selectedDate, secs: c.departureSecs % 86400 });

  function handleEarlierConnections() {
    if (!connections || connections.length === 0) return;
    // arrive-by: arriving by a minute before the earliest arrival shown, the same day
    if (arriveBy) return searchFrom(selectedDate, Math.max(0, Math.min(...connections.map((c) => c.arrivalSecs)) - 60));
    const first = leaves(connections.reduce((a, b) => (b.departureSecs < a.departureSecs ? b : a)));
    const secs = first.secs - 3600;
    const prevDay = offsetDateISO(first.date, -1);
    if (secs >= 0) searchFrom(first.date, secs);
    else if (prevDay >= todayStr) searchFrom(prevDay, secs + 86400);
    else searchFrom(first.date, 0);
  }

  // later ones are departures after the last one shown, also after an arrive-by search
  function handleLaterConnections() {
    if (!connections || connections.length === 0) return;
    arriveBy = false;
    const last = leaves(connections.reduce((a, b) => (b.departureSecs > a.departureSecs ? b : a)));
    const secs = last.secs + 60;
    if (secs < 86400) searchFrom(last.date, secs);
    else searchFrom(offsetDateISO(last.date, 1), secs - 86400);
  }

  function handleOpenDatePicker() {
    try {
      dateInput?.showPicker?.();
    } catch {
      dateInput?.focus();
    }
  }

  function handleSetNow() {
    timeMode = "now";
    const [h, m] = nowHHMM().split(":");
    hour = h;
    minute = m;
    dateMode = "today";
    selectedDate = todayStr;
    connections = null;
  }

  function handleAddMinutes(delta: number) {
    const baseTime = timeMode === "now" ? nowHHMM() : `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    const [h, m] = addMinutesToHHMM(baseTime, delta).split(":");
    hour = h;
    minute = m;
    timeMode = "custom";
    connections = null;
  }

  const when: When = $derived(arriveBy ? "arrive" : timeMode === "now" && dateMode === "today" ? "now" : "depart");
  function pickWhen(next: When) {
    // an unchanged search would never refetch, the list must not drop to a skeleton
    if (next === when) return;
    arriveBy = next === "arrive";
    if (next === "now") return handleSetNow();
    // leaving starts from the current minute; arriving "now" means nothing, so an hour ahead
    if (timeMode === "now") {
      const [h, m] = addMinutesToHHMM(nowHHMM(), next === "arrive" ? 60 : 0).split(":");
      hour = h;
      minute = m;
      timeMode = "custom";
    }
    connections = null;
  }

  function handleTimeBlur() {
    let h = parseInt(hour, 10);
    let m = parseInt(minute, 10);
    if (isNaN(h) || h < 0) h = 0;
    if (h > 23) h = 23;
    if (isNaN(m) || m < 0) m = 0;
    if (m > 59) m = 59;
    hour = String(h).padStart(2, "0");
    minute = String(m).padStart(2, "0");
    timeMode = "custom";
  }

  function onDateChange(e: Event & { currentTarget: HTMLInputElement }) {
    const val = e.currentTarget.value;
    // a cleared picker keeps the day shown
    if (!val) {
      e.currentTarget.value = selectedDate;
      return;
    }
    selectedDate = val;
    if (val === todayStr) {
      dateMode = "today";
    } else if (val === tomorrowStr) {
      dateMode = "tomorrow";
    } else {
      dateMode = "custom";
    }
    if (val !== todayStr && timeMode === "now") {
      timeMode = "custom";
      hour = "05";
      minute = "00";
    }
    connections = null;
  }

  const loading = $derived(connections === null && !connErr && !!fromParam && !!toParam);
  const geoFailed = $derived(geoStatus === "denied" || geoStatus === "error");

  // Suggestions for currently active input (deduplicated by stop display name)
  const suggestions = $derived.by(() => {
    if (!activeInput) return [];
    const q = normalizeText((activeInput === "from" ? fromQuery : toQuery).trim());
    const pos = geoPos;
    const stopDist = (s: Stop) => (pos ? haversineMeters(pos.lat, pos.lon, s.lat, s.lon) : null);
    const favSet = favorites.favSet;

    if (!q) {
      const list: Array<{ s: Stop; label: string; fav: boolean; dist: number | null }> = [];
      const seenNames = new Set<string>();
      // Favorite stops
      for (const desig of favorites.favs) {
        const s = byDesig.get(desig);
        if (s) {
          const key = normalizeText(stopLabel(s.name));
          if (!seenNames.has(key)) {
            seenNames.add(key);
            list.push({ s, label: stopLabel(s.name), fav: true, dist: stopDist(s) });
          }
        }
      }
      // Nearest stops if geolocation is available
      if (pos) {
        const nearest = nearestStops(stops, pos, 12);
        for (const { s, dist } of nearest) {
          const key = normalizeText(stopLabel(s.name));
          if (!seenNames.has(key)) {
            seenNames.add(key);
            list.push({ s, label: stopLabel(s.name), fav: favSet.has(s.designator), dist });
          }
        }
      }
      return list.slice(0, 8);
    }

    // Match query
    const hits: Array<{ s: Stop; rank: number; dist: number | null }> = [];
    for (const { s, n, k } of stopIndex) {
      let rank = -1;
      if (n === q || k === q) rank = 0;
      else if (n.startsWith(q)) rank = 1;
      else if (n.includes(q)) rank = 3;
      if (rank < 0) continue;
      const fav = favSet.has(s.designator);
      if (fav) rank -= 0.5;
      hits.push({ s, rank, dist: stopDist(s) });
    }
    hits.sort((a, b) => a.rank - b.rank || (a.dist ?? Infinity) - (b.dist ?? Infinity));

    const deduped: Array<{ s: Stop; label: string; fav: boolean; dist: number | null }> = [];
    const seenNames = new Set<string>();
    for (const h of hits) {
      const key = normalizeText(stopLabel(h.s.name));
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      deduped.push({
        s: h.s,
        label: stopLabel(h.s.name),
        fav: favSet.has(h.s.designator),
        dist: h.dist,
      });
      if (deduped.length >= 10) break;
    }
    return deduped;
  });

  /* Sort order chip: each tap steps to the next order */
  const sortIdx = $derived(SORTS.findIndex((o) => o.id === sortBy));
  const sort = $derived(SORTS[sortIdx]);
  const nextSort = $derived(SORTS[(sortIdx + 1) % SORTS.length]);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_interactive_supports_focus (Escape closes it, on document; same DOM as the React dialog, which took no focus) -->
<div
  role="dialog"
  aria-modal="true"
  aria-label="Wyszukiwarka połączeń"
  class="fixed inset-0 z-[2000] flex items-end justify-center bg-black/55 animate-fade md:items-center md:p-4"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="surface relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl md:max-h-[88vh] md:max-w-xl md:rounded-[20px] animate-drop"
  >
    <!-- Header -->
    <header class="flex items-center justify-between gap-3 border-b border-hairline py-2.5 pl-4 pr-2.5">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold tracking-tight text-text">Wyszukaj połączenie</h2>
        <p class="text-[12px] text-text-faint">
          {city === "gzm"
            ? "Rozkład jazdy ZTM Metropolii GZM"
            : city === "bb"
              ? "Rozkład jazdy KB i MZK Bielsko-Biała"
              : `Rozkład jazdy: ${CITY[city].name}`}
        </p>
      </div>
      <IconButton label="Zamknij" onClick={onClose}>
        <Icon icon={XIcon} />
      </IconButton>
    </header>

    <!-- Inputs & Controls panel -->
    <div class="space-y-3 border-b border-hairline px-4 py-3">
      <!-- FROM / TO inputs -->
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1 space-y-2">
          <!-- FROM input -->
          <div
            class="relative flex h-11 items-center rounded-xl bg-tint/6 pl-3.5 pr-1.5 transition-colors focus-within:bg-tint/10 focus-within:ring-1 focus-within:ring-primary/50"
          >
            <span class="mr-3 h-2 w-2 shrink-0 rounded-full bg-good" aria-hidden="true"></span>
            <input
              bind:this={fromInput}
              type="text"
              placeholder="Skąd: przystanek lub adres…"
              value={activeInput === "from"
                ? fromQuery
                : fromGeo
                  ? (fromGeo !== "pending" && fromGeo.label) || "Moja lokalizacja"
                  : fromStop
                    ? displayStopName(stopLabel(fromStop.name))
                    : fromQuery}
              onfocus={() => {
                activeInput = "from";
                if (fromStop) fromQuery = stopLabel(fromStop.name);
              }}
              onkeydown={(e) => {
                if (e.key === "Enter" && suggestions.length > 0) {
                  e.preventDefault();
                  handlePickStop(suggestions[0].s, "from");
                }
              }}
              oninput={(e) => {
                fromQuery = e.currentTarget.value;
                if (fromStop || fromGeo) {
                  fromStop = null;
                  fromGeo = null;
                  connections = null;
                }
              }}
              class="w-full min-w-0 bg-transparent text-base font-medium text-text outline-none ring-0 placeholder:font-normal placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:text-[14px]"
            />
            {#if fromStop || fromGeo || fromQuery}
              <button
                type="button"
                aria-label="Wyczyść przystanek początkowy"
                onclick={() => {
                  fromStop = null;
                  fromGeo = null;
                  fromQuery = "";
                  connections = null;
                  activeInput = "from";
                  fromInput?.focus();
                }}
                class="tap grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px] text-text-faint hover:bg-tint/8 hover:text-text"
              >
                <Icon icon={XIcon} />
              </button>
            {/if}
          </div>

          <!-- TO input -->
          <div
            class="relative flex h-11 items-center rounded-xl bg-tint/6 pl-3.5 pr-1.5 transition-colors focus-within:bg-tint/10 focus-within:ring-1 focus-within:ring-primary/50"
          >
            <span class="mr-3 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
            <input
              bind:this={toInput}
              type="text"
              placeholder="Dokąd: przystanek lub adres…"
              value={activeInput === "to"
                ? toQuery
                : toGeo
                  ? toGeo.label || "Moja lokalizacja"
                  : toStop
                    ? displayStopName(stopLabel(toStop.name))
                    : toQuery}
              onfocus={() => {
                activeInput = "to";
                if (toStop) toQuery = stopLabel(toStop.name);
              }}
              onkeydown={(e) => {
                if (e.key === "Enter" && suggestions.length > 0) {
                  e.preventDefault();
                  handlePickStop(suggestions[0].s, "to");
                }
              }}
              oninput={(e) => {
                toQuery = e.currentTarget.value;
                if (toStop || toGeo) {
                  toStop = null;
                  toGeo = null;
                  connections = null;
                }
              }}
              class="w-full min-w-0 bg-transparent text-base font-medium text-text outline-none ring-0 placeholder:font-normal placeholder:text-text-faint focus:outline-none focus:ring-0 focus-visible:outline-none md:text-[14px]"
            />
            {#if toStop || toGeo || toQuery}
              <button
                type="button"
                aria-label="Wyczyść przystanek docelowy"
                onclick={() => {
                  toStop = null;
                  toGeo = null;
                  toQuery = "";
                  connections = null;
                  activeInput = "to";
                  toInput?.focus();
                }}
                class="tap grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px] text-text-faint hover:bg-tint/8 hover:text-text"
              >
                <Icon icon={XIcon} />
              </button>
            {/if}
          </div>
        </div>

        <!-- Swap button -->
        <button
          type="button"
          aria-label="Zamień kierunki"
          title="Zamień kierunki"
          onclick={handleSwap}
          disabled={fromGeo === "pending"}
          class="tap grid h-11 w-11 shrink-0 place-items-center rounded-full bg-tint/6 text-[18px] text-text-mute hover:bg-tint/10 hover:text-text disabled:opacity-40"
        >
          <Icon icon={ArrowsDownUpIcon} />
        </button>
      </div>

      <!-- Day selection row -->
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="w-[52px] shrink-0 text-[12px] text-text-faint">Dzień:</span>
        <button type="button" onclick={handlePickToday} class={chip(dateMode === "today")}>Dziś</button>
        <button type="button" onclick={handlePickTomorrow} class={chip(dateMode === "tomorrow")}>Jutro</button>

        <!-- Custom date button & hidden native picker -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <label onclick={handleOpenDatePicker} class="{chip(dateMode === 'custom')} relative cursor-pointer select-none">
          <Icon icon={CalendarBlankIcon} class="text-[14px]" weight={dateMode === "custom" ? "fill" : "bold"} />
          <span>{dateMode === "custom" ? formatDayLabel(selectedDate, todayStr) : "Inna data"}</span>
          <input
            bind:this={dateInput}
            type="date"
            min={todayStr}
            value={selectedDate}
            oninput={onDateChange}
            class="absolute inset-0 opacity-0 pointer-events-none"
            tabindex={-1}
            aria-label="Wybierz inną datę połączenia"
          />
        </label>
      </div>

      <!-- When: now, leave at or arrive by; the time and its nudges only for a set time -->
      <div class="space-y-2">
        <div class="flex items-center gap-1.5">
          <span class="w-[52px] shrink-0 text-[12px] text-text-faint">Czas:</span>
          <div class="min-w-0 flex-1 md:max-w-sm">
            <Segmented
              label="Czas podróży"
              value={when}
              options={dateMode === "today" ? WHEN_TODAY : WHEN_LATER}
              onChange={pickWhen}
            />
          </div>
        </div>
        {#if when !== "now" || (fromParam && toParam)}
          <div class="flex flex-wrap items-center gap-1.5 pl-[58px]">
            {#if when !== "now"}
              <TimeInput24H
                {hour}
                {minute}
                onChange={(h, m) => {
                  hour = h;
                  minute = m;
                  timeMode = "custom";
                  connections = null;
                }}
                onBlur={handleTimeBlur}
              />
              <button
                type="button"
                onclick={() => handleAddMinutes(-15)}
                class="{CHIP} {CHIP_OFF} px-2.5 tabular-nums"
                aria-label="15 minut wcześniej"
              >
                −15 min
              </button>
              <button
                type="button"
                onclick={() => handleAddMinutes(15)}
                class="{CHIP} {CHIP_OFF} px-2.5 tabular-nums"
                aria-label="15 minut później"
              >
                +15 min
              </button>
            {/if}
            {#if fromParam && toParam}
              <button
                type="button"
                onclick={handleRefresh}
                disabled={loading}
                class="{CHIP} ml-auto bg-tint/8 px-3 text-text hover:bg-tint/12 disabled:opacity-50"
              >
                <Icon icon={ArrowsClockwiseIcon} class="text-[14px]" />
                {loading ? "Szukanie…" : "Odśwież"}
              </button>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Filter chips row -->
      <div class="flex flex-wrap items-center gap-1.5 border-t border-hairline pt-3">
        <span class="w-[52px] shrink-0 text-[12px] text-text-faint">Filtry:</span>

        <!-- Direct only filter chip -->
        <button
          type="button"
          onclick={() => {
            directOnly = !directOnly;
            connections = null;
          }}
          class={chip(directOnly)}
          aria-pressed={directOnly}
          title="Pokaż wyłącznie bezpośrednie połączenia bez przesiadek"
        >
          <Icon icon={BusIcon} class="text-[14px]" weight={directOnly ? "fill" : "bold"} />
          <span>Tylko bezpośrednie</span>
          {#if directOnly}<Icon icon={CheckIcon} class="animate-pop text-[13px]" />{/if}
        </button>

        <!-- Min 5 min transfer buffer (when transfers are allowed) -->
        {#if !directOnly}
          <button
            type="button"
            onclick={() => {
              minTransfer5 = !minTransfer5;
              connections = null;
            }}
            class={chip(minTransfer5)}
            aria-pressed={minTransfer5}
            title="Filtruj połączenia z bezpiecznym czasem na przesiadkę (min. 5 minut)"
          >
            <Icon icon={ShieldCheckIcon} class="text-[14px]" weight={minTransfer5 ? "fill" : "bold"} />
            <span>Bezpieczna przesiadka (5 min)</span>
            {#if minTransfer5}<Icon icon={CheckIcon} class="animate-pop text-[13px]" />{/if}
          </button>
        {/if}

        <!-- Sort order chip: each tap steps to the next order -->
        <button
          type="button"
          onclick={() => {
            sortBy = nextSort.id;
            connections = null;
          }}
          class={chip(sortBy !== "departure")}
          title={`${sort.title}. Dotknij: ${nextSort.label.toLowerCase()}`}
        >
          <Icon icon={sort.icon} class="text-[14px]" weight={sortBy !== "departure" ? "fill" : "bold"} />
          <span>{sort.label}</span>
        </button>
      </div>

      {#if modes.length > 1}
        <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Pomiń środki transportu">
          <span class="w-[52px] shrink-0 text-[12px] text-text-faint">Bez:</span>
          {#each modes as m (m.type)}
            {@const on = avoidTypes.includes(m.type)}
            <button
              type="button"
              onclick={() => {
                avoidTypes = toggled(avoidTypes, m.type);
                connections = null;
              }}
              class={chip(on)}
              aria-pressed={on}
              title={on ? `Wyszukaj też z: ${m.label}` : `Wyszukaj bez: ${m.label}`}
            >
              <span class="text-[14px]">
                <ModeIcon mode={m.mode} weight={on ? "fill" : "bold"} />
              </span>
              <span class={on ? "line-through" : undefined}>{m.label}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if avoidLines.length > 0 || answerLines.length > 1}
        <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Pomiń linie">
          <span class="w-[52px] shrink-0 text-[12px] text-text-faint">Pomiń:</span>
          {#each [...avoidLines, ...answerLines.filter((l) => !avoidLines.includes(l))].slice(0, AVOID_CHIPS) as line (line)}
            {@const on = avoidLines.includes(line)}
            <button
              type="button"
              onclick={() => {
                avoidLines = toggled(avoidLines, line);
                connections = null;
              }}
              class="{chip(on)} tabular-nums"
              aria-pressed={on}
              title={on ? `Wyszukaj też z linią ${line}` : `Wyszukaj bez linii ${line}`}
            >
              <span class={on ? "line-through" : undefined}>{line}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if fromGeo || toGeo}
        <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Jak daleko do przystanku">
          <span class="w-[52px] shrink-0 text-[12px] text-text-faint">Dojście:</span>
          {#each WALK_OPTIONS as m (m)}
            <button
              type="button"
              onclick={() => {
                walkM = m;
                connections = null;
                try {
                  window.localStorage.setItem(WALK_KEY, String(m));
                } catch {
                  /* private mode: the choice lasts for this modal only */
                }
              }}
              class={chip(walkM === m)}
              aria-pressed={walkM === m}
              title={`Przystanki do ${fmtWalk(m)} w linii prostej`}
            >
              <Icon icon={PersonSimpleWalkIcon} class="text-[14px]" weight={walkM === m ? "fill" : "bold"} />
              <span>do {fmtWalk(m)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Modal body -->
    <div class="kb-scroll min-h-0 flex-1 overflow-y-auto p-4">
      <!-- Autocomplete suggestion list when user is picking stops -->
      {#if activeInput}
        {@const target = activeInput}
        {@const typed = (target === "from" ? fromQuery : toQuery).trim()}
        <div>
          <p class="mb-1.5 px-1 text-[12px] font-medium text-text-faint">
            {assign
              ? `Ustaw: ${SLOT_LABEL[assign]}. Wybierz ${target === "from" ? "przystanek, adres lub lokalizację" : "przystanek lub adres"}`
              : target === "from"
                ? "Wybierz przystanek początkowy"
                : "Wybierz przystanek docelowy"}
          </p>
          {#if !typed}
            {#each PLACE_SLOTS as { slot, label, icon } (slot)}
              {@const p = places[slot]}
              {@const setting = assign === slot}
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  onclick={() => (p && !setting ? applyPlace(p, target, label) : (assign = setting ? null : slot))}
                  class="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-tint/6 active:bg-tint/10"
                >
                  <Icon {icon} class="w-4 shrink-0 text-[15px] text-primary" weight={p ? "fill" : "bold"} />
                  <span class="min-w-0">
                    <span class="block truncate text-[14px] text-text">{label}</span>
                    <span class="block truncate text-[12px] text-text-faint">
                      {setting ? "Wybierz poniżej" : p ? placeName(p) : "Dotknij, aby ustawić"}
                    </span>
                  </span>
                </button>
                {#if p}
                  <button
                    type="button"
                    onclick={() => (assign = setting ? null : slot)}
                    aria-pressed={setting}
                    class={chip(setting)}
                  >
                    {setting ? "Anuluj" : "Zmień"}
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
          {#if target === "from" && onLocate && !fromQuery.trim() && (!assign || geoPos)}
            <button
              type="button"
              onclick={handlePickGeo}
              class="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-tint/6 active:bg-tint/10"
            >
              <Icon icon={CrosshairIcon} class="w-4 shrink-0 text-[15px] text-primary" weight="bold" />
              <span class="min-w-0">
                <span class="block truncate text-[14px] text-text">Moja lokalizacja</span>
                <span class="block text-[12px] text-text-faint">
                  {geoStatus === "denied"
                    ? "Brak zgody na lokalizację w przeglądarce"
                    : `Ze wszystkich przystanków do ${fmtWalk(walkM)} od Ciebie`}
                </span>
              </span>
            </button>
          {/if}
          {#if suggestions.length === 0}
            {#if typed && addrHits.length === 0}
              <p class="py-8 text-center text-[13px] text-text-faint">Nie znaleziono pasujących przystanków.</p>
            {/if}
          {:else}
            <ul>
              {#each suggestions as item (item.s.id)}
                <li>
                  <button
                    type="button"
                    onclick={() => handlePickStop(item.s, target)}
                    class="flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left transition-colors hover:bg-tint/6 active:bg-tint/10"
                  >
                    <span class="flex min-w-0 items-center gap-3">
                      <span class="grid w-4 shrink-0 place-items-center text-[14px] text-primary" aria-hidden="true">
                        {#if item.fav}
                          <StarIcon filled />
                        {:else}
                          <span class="h-1.5 w-1.5 rounded-full bg-tint/25"></span>
                        {/if}
                      </span>
                      <span class="truncate text-[14px] text-text">{displayStopName(item.label)}</span>
                    </span>
                    {#if item.dist != null}
                      <span class="ml-2 shrink-0 text-[12px] tabular-nums text-text-faint">
                        {formatDistance(item.dist)}
                      </span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if addrHits.length > 0}
            <p class="mb-1.5 mt-3 px-1 text-[12px] font-medium text-text-faint">Adresy i miejsca (OpenStreetMap)</p>
            <ul>
              <!-- keyed like the server dedupes them: two hits can share a point, and a duplicate key throws here -->
              {#each addrHits as h (`${h.name}|${h.detail}`)}
                <li>
                  <button
                    type="button"
                    onclick={() => {
                      const pt = { lat: h.lat, lon: h.lon, label: h.detail ? `${h.name}, ${h.detail}` : h.name };
                      if (target === "from") pickOrigin(pt);
                      else pickDest(pt);
                    }}
                    class="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-tint/6 active:bg-tint/10"
                  >
                    <Icon icon={MapPinIcon} class="w-4 shrink-0 text-[15px] text-text-faint" />
                    <span class="min-w-0">
                      <span class="block truncate text-[14px] text-text">{h.name}</span>
                      {#if h.detail}<span class="block truncate text-[12px] text-text-faint">{h.detail}</span>{/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {:else if fromGeo === "pending" && hasTo}
        <div class="px-4 py-10 text-center animate-fade">
          <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-tint/5 text-[22px] text-text-faint">
            <Icon icon={CrosshairIcon} />
          </span>
          <p class="mt-3 text-[14px] font-medium text-text">
            {geoFailed ? "Brak lokalizacji" : "Ustalanie Twojej lokalizacji…"}
          </p>
          {#if geoFailed}
            <p class="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
              Zezwól na lokalizację w przeglądarce albo wybierz przystanek początkowy.
            </p>
          {/if}
        </div>
      {:else if loading}
        <!-- Loading skeletons, shaped like the result cards -->
        <div aria-hidden="true" class="space-y-2.5">
          {#each [1, 2, 3] as i (i)}
            <div class="space-y-3 rounded-xl bg-tint/4 p-3.5">
              <div class="flex items-center justify-between">
                <div class="skeleton h-5 w-32"></div>
                <div class="skeleton h-5 w-20 rounded-full"></div>
              </div>
              <div class="flex gap-2">
                <div class="skeleton h-7 w-9 rounded-lg"></div>
                <div class="skeleton h-7 w-28"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if connErr}
        <ErrorState onRetry={handleRefresh} message={connErr === "warming" ? GZM_LOADING : undefined} />
      {:else if connections}
        {#if connections.length === 0}
          <div class="px-4 py-10 text-center animate-fade">
            <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-tint/5 text-[22px] text-text-faint">
              <Icon icon={BusIcon} />
            </span>
            <div class="mt-3">
              <p class="text-[14px] font-medium text-text">
                {directOnly ? "Brak bezpośrednich połączeń" : "Brak dostępnych połączeń"}
              </p>
              <p class="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
                {directOnly
                  ? "W rozkładzie nie ma bezpośredniego autobusu na wybraną godzinę. Spróbuj wyłączyć filtr, aby zobaczyć połączenia z przesiadką."
                  : fromGeo
                    ? `Z przystanków do ${fmtWalk(walkM)} od ${fromGeo !== "pending" && fromGeo.label ? "tego miejsca" : "Ciebie"} nie ma połączenia na wybraną godzinę.`
                    : toGeo
                      ? `Do przystanków do ${fmtWalk(walkM)} od celu nie ma połączenia na wybraną godzinę.`
                      : arriveBy
                        ? `Brak połączeń z przyjazdem do ${hour}:${minute} tego dnia.`
                        : dateMode === "today"
                          ? timeMode === "now"
                            ? "Brak dalszych kursów na dziś. Sprawdź połączenia na jutro."
                            : `Brak dalszych kursów na dziś od godziny ${hour}:${minute}. Sprawdź połączenia na jutro.`
                          : "Brak kursów w rozkładzie jazdy na wybrany dzień i godzinę."}
              </p>
            </div>
            <div class="flex flex-wrap justify-center gap-2 pt-5">
              {#if directOnly}
                <button
                  type="button"
                  onclick={() => {
                    directOnly = false;
                    connections = null;
                  }}
                  class="{CTA} h-9 text-[13px]"
                >
                  Pokaż z przesiadkami
                </button>
              {/if}
              {#if dateMode === "today"}
                <button
                  type="button"
                  onclick={handlePickTomorrow}
                  class="tap inline-flex h-9 items-center rounded-full bg-tint/8 px-4 text-[13px] font-medium text-text hover:bg-tint/12"
                >
                  Szukaj na jutro
                </button>
              {/if}
            </div>
          </div>
        {:else}
          <div class="space-y-2.5">
            <div class="flex items-center justify-between px-1">
              <p class="text-[12px] font-medium text-text-faint">Znalezione połączenia ({connections.length})</p>
              <div class="flex items-center gap-2">
                {#if curRoute}
                  {@const saved = hasRoute(places, curRoute)}
                  {@const route = curRoute}
                  <button
                    type="button"
                    onclick={() => toggleRoute(city, route)}
                    aria-pressed={saved}
                    class="{chip(saved)} text-[12px]"
                  >
                    <span class="text-[13px]">
                      <StarIcon filled={saved} />
                    </span>
                    <span>{saved ? "Zapisana trasa" : "Zapisz trasę"}</span>
                  </button>
                {/if}
                <span class="text-[12px] text-text-mute">{effectiveDayLabel}</span>
              </div>
            </div>

            <!-- Earlier connections button -->
            <div class="flex justify-center">
              <button type="button" onclick={handleEarlierConnections} class="{CHIP} {CHIP_OFF} px-4">
                <Icon icon={CaretUpIcon} class="text-[13px]" />
                <span>Wcześniejsze połączenia</span>
              </button>
            </div>

            {#each connections as conn, idx (`${conn.departureTime}-${conn.arrivalTime}-${idx}`)}
              {@const isExpanded = expandedIdx === idx}
              {@const isDirect = conn.type === "direct"}
              {@const dayBadge = conn.dayLabel || effectiveDayLabel}
              {@const startPole = conn.legs[0]?.fromStopName ?? ""}
              <!-- the exact pole when the search named a whole stop (GZM) or a location -->
              {@const showPole =
                !!fromGeo || (!!fromStop && normalizeText(startPole) !== normalizeText(stopLabel(fromStop.name)))}
              <!-- the bus on the map, else the delay the search boarded it with -->
              {@const delays = conn.legs.map((l) => legVehicle(l, conn.date, vix)?.delay ?? l.delaySec ?? null)}
              <div class="rounded-xl bg-tint/4 p-3.5">
                <!-- Summary row -->
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex items-baseline gap-1.5">
                      <span class="text-[19px] font-semibold tracking-tight tabular-nums text-text">
                        {conn.departureTime}
                      </span>
                      <Icon icon={ArrowRightIcon} class="self-center text-[13px] text-text-faint" />
                      <span class="text-[19px] font-semibold tracking-tight tabular-nums text-text">
                        {conn.arrivalTime}
                      </span>
                      {#if conn.arrivesNextDay}
                        <span
                          class="self-center rounded-full bg-late/15 px-1.5 py-0.5 text-[11px] font-medium text-late"
                          title="Przyjazd następnego dnia"
                        >
                          +1 d.
                        </span>
                      {/if}
                    </div>
                    <p class="mt-0.5 text-[12px] text-text-mute">
                      {dayBadge} · <span class="tabular-nums">{conn.totalDurationMins} min</span>
                    </p>
                  </div>
                  <span class="shrink-0 rounded-full bg-tint/6 px-2.5 py-1 text-[12px] font-medium text-text-mute">
                    {isDirect
                      ? "Bezpośredni"
                      : `${conn.transfersCount} ${conn.transfersCount === 1 ? "przesiadka" : "przesiadki"}`}
                  </span>
                </div>

                <!-- Line badges summary -->
                <div class="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
                  {#each conn.legs as leg, lIdx (lIdx)}
                    {@const d = delays[lIdx]}
                    <div class="flex min-w-0 items-center gap-1.5">
                      {#if lIdx > 0}<Icon icon={CaretRightIcon} class="text-[12px] text-text-faint" />{/if}
                      <LineBadge line={leg.line} operator={leg.operator} />
                      <span class="max-w-[140px] truncate text-[13px] text-text-mute">
                        {displayStopName(leg.headsign)}
                      </span>
                      {#if d != null}
                        <span class="shrink-0 text-[12px] font-medium tabular-nums {delayClass(d)}">
                          {delayTxt(d)}
                        </span>
                      {/if}
                    </div>
                  {/each}
                </div>

                {#if showPole}
                  <p class="mt-2 flex items-center gap-1.5 text-[12px] text-text-faint">
                    {#if conn.accessWalkMins}
                      <Icon icon={PersonSimpleWalkIcon} class="shrink-0 text-[13px]" />
                      <span>
                        {conn.accessWalkMins} min pieszo do <span class="font-medium text-text-mute">{displayStopName(startPole)}</span>
                      </span>
                    {:else}
                      <span>
                        Odjazd z: <span class="font-medium text-text-mute">{displayStopName(startPole)}</span>
                      </span>
                    {/if}
                  </p>
                {/if}

                {#if conn.egressWalkMins}
                  <p class="mt-1 flex items-center gap-1.5 text-[12px] text-text-faint">
                    <Icon icon={PersonSimpleWalkIcon} class="shrink-0 text-[13px]" />
                    <span>
                      Wysiadka: <span class="font-medium text-text-mute"
                        >{displayStopName(conn.legs[conn.legs.length - 1]?.toStopName ?? "")}</span
                      >, dalej {conn.egressWalkMins} min pieszo
                    </span>
                  </p>
                {/if}

                <!-- Transfer info if applicable -->
                {#if !isDirect && conn.transferStopName}
                  <p class="mt-2 text-[12px] text-text-faint">
                    Przesiadka: <span class="font-medium text-text-mute">{displayStopName(conn.transferStopName)}</span>
                    (oczekiwanie: {conn.transferWaitMins ?? 0} min)
                  </p>
                {/if}
                {#if transferAtRisk(conn.legs, delays)}
                  <p class="mt-1 text-[12px] font-medium text-late">Opóźnienie: możesz nie zdążyć na przesiadkę</p>
                {/if}

                <!-- Collapsible leg details -->
                <div class="mt-3 border-t border-hairline pt-1">
                  <button
                    type="button"
                    onclick={() => (expandedIdx = isExpanded ? null : idx)}
                    aria-expanded={isExpanded}
                    class="flex h-9 w-full items-center justify-between text-[12px] font-medium text-text-mute transition-colors hover:text-text"
                  >
                    <span>{isExpanded ? "Ukryj szczegóły trasy" : "Pokaż szczegóły trasy"}</span>
                    <Icon
                      icon={CaretDownIcon}
                      class={`text-[13px] text-text-faint transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                    />
                  </button>

                  {#if isExpanded}
                    <div class="mt-1 space-y-2 animate-fade">
                      {#each conn.legs as leg, lIdx (lIdx)}
                        <div class="rounded-xl bg-tint/4 p-3">
                          <div class="flex items-center justify-between gap-2">
                            <div class="flex min-w-0 items-center gap-2">
                              <LineBadge line={leg.line} operator={leg.operator} />
                              <span class="truncate text-[13px] font-medium text-text">
                                Kierunek: {displayStopName(leg.headsign)}
                              </span>
                            </div>
                            <span class="shrink-0 text-[12px] tabular-nums text-text-faint">
                              {leg.stopsCount}
                              {przystanekPlural(leg.stopsCount)} · {leg.durationMins} min
                            </span>
                          </div>
                          <div class="ml-1 mt-2.5 space-y-1 border-l-2 border-tint/12 pl-2.5 text-[12px] text-text-mute">
                            <p>
                              <span class="font-medium tabular-nums text-text">{leg.departureTime}</span>
                              {displayStopName(leg.fromStopName)}
                            </p>
                            <p>
                              <span class="font-medium tabular-nums text-text">{leg.arrivalTime}</span>
                              {displayStopName(leg.toStopName)}
                            </p>
                          </div>
                          <div class="mt-2 flex justify-end">
                            <button
                              type="button"
                              onclick={(e) => {
                                e.stopPropagation();
                                if (onSelectConnection) onSelectConnection(conn, lIdx);
                                onClose();
                              }}
                              class="{CHIP} -mr-1.5 px-3 text-text hover:bg-tint/8"
                            >
                              <span>Pokaż ten odcinek na mapie</span>
                              <Icon icon={ArrowRightIcon} class="text-[13px]" />
                            </button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>

                <!-- Action buttons -->
                <div class="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-3">
                  <span class="text-[12px] text-text-faint">
                    {conn.legs.length > 1
                      ? `${conn.legs.length} linie · ${conn.transfersCount} ${conn.transfersCount === 1 ? "przesiadka" : "przesiadki"}`
                      : "Bez przesiadek"}
                  </span>
                  <button
                    type="button"
                    onclick={() => {
                      if (onSelectConnection) onSelectConnection(conn, null);
                      else if (fromStop) onSelectStop(fromStop);
                      onClose();
                    }}
                    class="{CTA} h-9 shrink-0 text-[13px]"
                  >
                    <Icon icon={MapTrifoldIcon} class="text-[15px]" />
                    <span>Pokaż całą trasę na mapie</span>
                  </button>
                </div>
              </div>
            {/each}

            <!-- Later connections button -->
            <div class="flex justify-center py-1">
              <button type="button" onclick={handleLaterConnections} class="{CHIP} {CHIP_OFF} px-4">
                <Icon icon={CaretDownIcon} class="text-[13px]" />
                <span>Późniejsze połączenia</span>
              </button>
            </div>
          </div>
        {/if}
      {:else}
        <!-- Initial state before picking stops -->
        <div class="animate-fade">
          {#if quickRoutes.length > 0}
            <div class="mb-2">
              <p class="mb-1.5 px-1 text-[12px] font-medium text-text-faint">Zapisane trasy</p>
              <ul>
                {#each quickRoutes as r (r.key)}
                  <li>
                    <button
                      type="button"
                      onclick={() => applyRoute(r.from, r.to, r.fromName, r.toName)}
                      class="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-tint/6 active:bg-tint/10"
                    >
                      <Icon icon={PathIcon} class="w-4 shrink-0 text-[15px] text-primary" />
                      <span class="truncate text-[14px] text-text">{r.label}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          <div class="px-4 py-10 text-center">
            <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-tint/5 text-[22px] text-text-faint">
              <Icon icon={PathIcon} />
            </span>
            <p class="mt-3 text-[14px] font-medium text-text">Wybierz przystanek początkowy i docelowy</p>
            <p class="mx-auto mt-1 max-w-sm text-[13px] text-text-mute">
              {city === "gzm"
                ? "Wyszukiwarka znajdzie najszybsze połączenia w sieci ZTM Metropolii GZM."
                : city === "bb"
                  ? "Wyszukiwarka znajdzie najszybsze połączenia autobusowe w sieciach KB i MZK Bielsko-Biała."
                  : `Wyszukiwarka znajdzie najszybsze połączenia komunikacją miejską: ${CITY[city].name}.`}
            </p>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
