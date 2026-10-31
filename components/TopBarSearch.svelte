<script lang="ts" module>
  import type { GeoPos } from "@/components/hooks.svelte";
  import type { IconDef } from "@/components/icon-paths";
  import type { BaseLayerId, TopBarSearchHandle } from "@/components/topbar";
  import type { GeoHit } from "@/lib/client/api";
  import { normalizeText } from "@/lib/client/format";
  import type { FleetVehicleSummary } from "@/lib/mzk-fleet";
  import type { LineInfo, Stop, Vehicle, VehicleFeatures } from "@/lib/client/types";

  export interface TopBarSearchProps {
    stops: Stop[];
    geoPos: GeoPos | null;
    onLocate: () => void;
    onPickStop: (s: Stop) => void;
    onPickVehicle: (v: Vehicle) => void;
    lineFilter: ReadonlySet<string> | null;
    onOpenLine: (l: LineInfo) => void;
    onClearLineFilter: () => void;
    onToggleStops: () => void;
    stopsVisible: boolean;
    baseLayer: BaseLayerId;
    onBaseLayer: (id: BaseLayerId) => void;
    onClearView: () => void;
    onOpenNearby: () => void;
    onOpenConnections?: () => void;
    /** an address or place from /api/geocode; absent = no address search */
    onPickPlace?: (g: GeoHit) => void;
    /** Pass-through handle to allow parent / sibling buttons to focus search */
    searchRef?: { current: TopBarSearchHandle | null };
    /** Notifies parent when dropdown opens/closes (e.g. to close settings menu) */
    onDropdownChange?: (open: boolean) => void;
    onShowToast?: (msg: string) => void;
  }


  /* ---------- result model ---------- */

  interface ActionDef {
    id: string;
    label: string;
    keywords: string;
    icon: IconDef;
    run: () => void;
  }

  type Item =
    | { kind: "line"; l: LineInfo; live: number; active: boolean }
    | { kind: "veh"; v: Vehicle }
    | { kind: "fleet"; f: FleetVehicleSummary; liveVeh?: Vehicle }
    | { kind: "stop"; s: Stop; fav: boolean; dist: number | null }
    | { kind: "addr"; g: GeoHit; dist: number | null }
    | { kind: "action"; a: ActionDef };

  interface Section {
    title: string;
    items: Item[];
    best: number;
  }

  /* an addr key carries name + detail: Photon can return two places at one point, and the server
     dedupes on name|detail only; a repeated key would throw in a keyed each */
  const itemKey = (it: Item): string =>
    it.kind === "action" ? `a-${it.a.id}`
    : it.kind === "line" ? `l-${it.l.id}`
    : it.kind === "veh" ? `v-${it.v.id}`
    : it.kind === "fleet" ? `f-${it.f.sideNumber}`
    : it.kind === "addr" ? `p-${it.g.lat},${it.g.lon},${it.g.name},${it.g.detail}`
    : `s-${it.s.id}`;

  const CAP = { lines: 4, vehs: 5, fleet: 5, actions: 3, stops: 6, addr: 4 } as const;
  const NO_ADDR: GeoHit[] = [];

  const OPERATOR_LABEL = { KB: "KB", MZK: "MZK", GZM: "Metropolia GZM", BOTH: "KB i MZK" } as const;

  function matchesFleetKeywords(
    q: string,
    f: { model: string; producer: string; fuelType: string; lengthCategory: string; features: VehicleFeatures },
  ): boolean {
    const nm = normalizeText(f.model);
    const np = normalizeText(f.producer);
    if (nm.includes(q) || np.includes(q)) return true;

    if (
      (q === "wodor" || q === "wodorowy" || q === "wodorowe" || q === "wodorowych" || q === "hydrogen" || q === "h2") &&
      (f.fuelType === "hydrogen" || f.features.hydrogen)
    ) {
      return true;
    }
    if (
      (q === "elektryk" || q === "elektryczny" || q === "elektryczne" || q === "elektrycznych" || q === "electric" || q === "ev") &&
      (f.fuelType === "electric" || f.features.electric)
    ) {
      return true;
    }
    if (
      (q === "hybryda" || q === "hybrydowy" || q === "hybrydowe" || q === "hybrid") &&
      (f.fuelType === "hybrid" || f.features.hybrid)
    ) {
      return true;
    }
    if (
      (q === "przegub" || q === "przegubowy" || q === "przegubowe" || q === "przegubowiec" || q === "mega" || q === "dlugi") &&
      (f.lengthCategory === "MEGA" || f.features.longVehicle)
    ) {
      return true;
    }
    if (q === "mini" && f.lengthCategory === "MINI") return true;
    if (q === "midi" && f.lengthCategory === "MIDI") return true;
    if (q === "maxi" && f.lengthCategory === "MAXI") return true;
    if ((q === "klima" || q === "klimatyzacja" || q === "klimatyzowany") && f.features.airCondition) return true;
    if ((q === "niska podloga" || q === "niskopodlogowy") && f.features.lowFloor) return true;

    return false;
  }

  function matchesVehicleKeywords(q: string, v: Vehicle): boolean {
    if (v.model && normalizeText(v.model).includes(q)) return true;
    const feat = v.features;
    if (!feat) return false;
    if (
      (q === "wodor" || q === "wodorowy" || q === "wodorowe" || q === "wodorowych" || q === "hydrogen" || q === "h2") &&
      feat.hydrogen
    ) {
      return true;
    }
    if (
      (q === "elektryk" || q === "elektryczny" || q === "elektryczne" || q === "elektrycznych" || q === "electric" || q === "ev") &&
      feat.electric
    ) {
      return true;
    }
    if ((q === "hybryda" || q === "hybrydowy" || q === "hybrydowe" || q === "hybrid") && feat.hybrid) return true;
    if (
      (q === "przegub" || q === "przegubowy" || q === "przegubowe" || q === "przegubowiec" || q === "mega" || q === "dlugi") &&
      feat.longVehicle
    ) {
      return true;
    }
    if ((q === "klima" || q === "klimatyzacja" || q === "klimatyzowany") && feat.airCondition) return true;
    if ((q === "niska podloga" || q === "niskopodlogowy") && feat.lowFloor) return true;
    return false;
  }
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";

  import { useLines, useVehicles } from "@/components/hooks.svelte";
  import Icon from "@/components/Icon.svelte";
  import {
    BugIcon,
    BusIcon,
    CheckIcon,
    DropIcon,
    EyeIcon,
    EyeSlashIcon,
    FunnelSimpleXIcon,
    GpsFixIcon,
    LeafIcon,
    LightningIcon,
    MagnifyingGlassIcon,
    MapPinIcon,
    MoonIcon,
    PathIcon,
    PersonSimpleWalkIcon,
    StarIcon,
    SunIcon,
    XCircleIcon,
    XIcon,
  } from "@/components/icon-paths";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import { geocode, HttpError } from "@/lib/client/api";
  import { CITY, getPageCity, withCity } from "@/lib/client/city";
  import { favorites } from "@/lib/client/favorites";
  import { delayTxt, displayStopName, wozPlural } from "@/lib/client/format";
  import { formatDistance, haversineMeters } from "@/lib/client/geo";
  import { getAllFleetVehicles } from "@/lib/mzk-fleet";

  let {
    stops,
    geoPos,
    onLocate,
    onPickStop,
    onPickVehicle,
    lineFilter,
    onOpenLine,
    onClearLineFilter,
    onToggleStops,
    stopsVisible,
    baseLayer,
    onBaseLayer,
    onClearView,
    onOpenNearby,
    onOpenConnections,
    onPickPlace,
    searchRef,
    onDropdownChange,
  }: TopBarSearchProps = $props();

  const veh = useVehicles();
  const linesQ = useLines();

  const vehicles = $derived(veh.data?.vehicles ?? []);
  const lines = $derived(linesQ.data?.lines ?? []);
  const city = getPageCity();
  // "GZM" on the wire = any zbiorkom city; its label is the page's city
  const opLabel = (op: keyof typeof OPERATOR_LABEL): string => (op === "GZM" ? CITY[city].name : OPERATOR_LABEL[op]);
  // the depot fleet list is MZK Bielsko-Biała's: nothing to search outside BB
  const allFleet = city !== "bb" ? [] : getAllFleetVehicles();

  let query = $state("");
  let isFocused = $state(false);
  let hi = $state(0);

  // address search (/api/geocode), one request per typing pause like ConnectionsModal; a failure
  // lists no addresses, a 404 (search off) stops asking for the page's life. Pure numbers are lines.
  const addrQuery = $derived(onPickPlace ? query.replace(/\s+/g, " ").trim() : "");
  let addr = $state.raw<{ q: string; hits: GeoHit[] } | null>(null);
  let geocoderOff = false;
  $effect(() => {
    const q = addrQuery;
    if (q.length < 3 || /^#|^\d+$/.test(q) || geocoderOff) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      geocode(q, city, ac.signal).then(
        (hits) => {
          addr = { q, hits };
        },
        (err: unknown) => {
          if (ac.signal.aborted) return;
          if (err instanceof HttpError && err.status === 404) geocoderOff = true;
          addr = { q, hits: [] };
        },
      );
    }, 350);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  });
  const addrHits = $derived(addr && addr.q === addrQuery ? addr.hits : NO_ADDR);

  let input = $state<HTMLInputElement>();
  let dropdown = $state<HTMLDivElement>();
  const listId = $props.id();

  // Expose focus handle via searchRef
  $effect(() => {
    const ref = searchRef;
    if (!ref) return;
    ref.current = {
      focus: () => {
        input?.focus();
        isFocused = true;
      },
      blur: () => {
        input?.blur();
        isFocused = false;
      },
      clear: () => {
        query = "";
        hi = 0;
      },
    };
    return () => {
      ref.current = null;
    };
  });

  // Global Ctrl/Cmd + K shortcut
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        input?.focus();
        input?.select();
        isFocused = true;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  // Dropdown shows when there's text typed and the input is focused / interacting
  const showDropdown = $derived(isFocused && query.trim().length > 0);

  $effect(() => {
    const open = showDropdown;
    const notify = onDropdownChange;
    untrack(() => notify?.(open));
  });

  // Close dropdown on click outside
  $effect(() => {
    if (!showDropdown) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (input && !input.contains(target) && dropdown && !dropdown.contains(target)) {
        isFocused = false;
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  });

  // Pre-normalized stop names for quick matching
  const stopIndex = $derived(stops.map((s) => ({ s, n: normalizeText(s.name) })));

  // Live vehicles count per line
  const liveByLine = $derived.by(() => {
    const m = new Map<string, number>();
    for (const v of vehicles) if (v.line && !v.agency) m.set(v.line, (m.get(v.line) ?? 0) + 1);
    return m;
  });

  // Fast lookup of currently running vehicles by side number
  const liveSideNumbers = $derived.by(() => {
    const s = new Set<string>();
    for (const v of vehicles) {
      if (v.side_number) s.add(normalizeText(v.side_number));
    }
    return s;
  });

  // Available quick actions
  const actions = $derived.by<ActionDef[]>(() => {
    const list: ActionDef[] = [
      {
        id: "route",
        label: "Wyznacz trasę",
        keywords: "trasa polaczenie jak dojechac dojazd planuj wyszukaj polaczenia",
        icon: PathIcon,
        run: () => {
          onOpenConnections?.();
        },
      },
      {
        id: "locate",
        label: "Moja lokalizacja",
        keywords: "gdzie jestem gps znajdz mnie lokalizacja",
        icon: GpsFixIcon,
        run: onLocate,
      },
      {
        id: "nearby",
        label: "Odjazdy w pobliżu",
        keywords: "w poblizu najblizszy przystanek odjazdy obok blisko",
        icon: PersonSimpleWalkIcon,
        run: onOpenNearby,
      },
      {
        id: "stops-toggle",
        label: stopsVisible ? "Ukryj przystanki" : "Pokaż przystanki",
        keywords: "przystanki ukryj pokaz widocznosc mapa",
        icon: stopsVisible ? EyeSlashIcon : EyeIcon,
        run: onToggleStops,
      },
      {
        id: "map-style",
        label: baseLayer === "dark" ? "Jasna mapa" : "Ciemna mapa",
        keywords: "ciemna jasna mapa styl motyw dark light",
        icon: baseLayer === "dark" ? SunIcon : MoonIcon,
        run: () => onBaseLayer(baseLayer === "dark" ? "kb" : "dark"),
      },
      {
        id: "clear",
        label: "Wyczyść widok",
        keywords: "wyczysc zamknij widok reset",
        icon: XCircleIcon,
        run: onClearView,
      },
      {
        id: "brigades",
        label: "Brygady i rozkłady taboru",
        keywords: "brygady brygada tabor woz wozy flota pojazdy kursy gdzie pojedzie historia",
        icon: BusIcon,
        run: () => {
          window.location.href = `/brygady${withCity("", city)}`;
        },
      },
      {
        id: "report",
        label: "Zgłoś błąd lub pomysł",
        keywords: "zglos blad problem pomysl kontakt uwagi sugestia github",
        icon: BugIcon,
        run: () => {
          window.open("https://github.com/unisic/unimaps/issues/new", "_blank", "noopener");
        },
      },
    ];
    if (lineFilter && lineFilter.size > 0) {
      list.push({
        id: "clear-filter",
        label: "Wyczyść filtr linii",
        keywords: "wyczysc filtr linie pokaz wszystkie",
        icon: FunnelSimpleXIcon,
        run: onClearLineFilter,
      });
    }
    return list;
  });

  // Compute matched sections
  const sections = $derived.by<Section[]>(() => {
    const q = normalizeText(query.trim());
    if (!q) return [];
    const cleanQ = q.replace(/^#/, "").replace(/^nr\s*/, "").replace(/^tabor\s*/, "").trim();

    const stopDist = (s: Stop) => (geoPos ? haversineMeters(geoPos.lat, geoPos.lon, s.lat, s.lon) : null);

    type Scored = { item: Item; rank: number; label: string; dist: number };

    // 1. Lines
    const lineHits: Scored[] = [];
    for (const l of lines) {
      const nl = normalizeText(l.name);
      const nt = normalizeText(l.terminus);
      let rank = -1;
      if (nl === q) rank = 0;
      else if (nl.startsWith(q)) rank = 1;
      else if (nl.includes(q)) rank = 4;
      else if (nt && nt.includes(q)) rank = 4.2;
      if (rank < 0) continue;
      lineHits.push({
        item: { kind: "line", l, live: liveByLine.get(l.name) ?? 0, active: !!lineFilter?.has(l.name) },
        rank,
        label: l.name,
        dist: Infinity,
      });
    }

    // 2. Vehicles
    const vehHits: Scored[] = [];
    const seenVehKeys = new Set<string>();
    for (const v of vehicles) {
      const nl = normalizeText(v.line || "");
      const nh = normalizeText(v.headsign || "");
      const ns = v.side_number ? normalizeText(v.side_number) : "";
      const nm = v.model ? normalizeText(v.model) : "";

      const isExactSide = Boolean(ns && (ns === cleanQ || ns === q));
      const isSidePrefix = Boolean(ns && cleanQ.length >= 2 && ns.startsWith(cleanQ));
      const isModelMatch = Boolean(nm && (nm.includes(q) || (cleanQ.length >= 2 && nm.includes(cleanQ))));
      const isFeatureMatch = matchesVehicleKeywords(cleanQ, v) || matchesVehicleKeywords(q, v);

      let rank = -1;
      if (isExactSide) rank = 0;
      else if (nl && nl === q) rank = 0.5;
      else if (isSidePrefix) rank = 1.1;
      else if (nl && nl.startsWith(q)) rank = 1.5;
      else if (isModelMatch) rank = 2.0;
      else if (isFeatureMatch) rank = 2.4;
      else if (nl && nl.includes(q)) rank = 4.5;
      else if (nh && nh.includes(q)) rank = 5;

      if (rank < 0) continue;

      const isTaborHit = isExactSide || isSidePrefix || isModelMatch || isFeatureMatch;
      const key = isTaborHit ? (v.side_number ? `side-${v.side_number}` : `veh-${v.id}`) : `${v.line} ${v.headsign}`;
      if (seenVehKeys.has(key)) continue;
      seenVehKeys.add(key);

      vehHits.push({
        item: { kind: "veh", v },
        rank,
        label: v.side_number ? `#${v.side_number} ${v.line} ${v.headsign}` : `${v.line} ${v.headsign}`,
        dist: Infinity,
      });
    }

    // 3. Fleet vehicles (depot / offline)
    const fleetHits: Scored[] = [];
    for (const f of allFleet) {
      const ns = normalizeText(f.sideNumber);
      // Skip if currently live on road (it's already in vehHits)
      if (liveSideNumbers.has(ns)) continue;

      const isExactSide = ns === cleanQ || ns === q;
      const isSidePrefix = cleanQ.length >= 2 && ns.startsWith(cleanQ);
      const isModelOrFeature = matchesFleetKeywords(cleanQ, f) || matchesFleetKeywords(q, f);

      let rank = -1;
      if (isExactSide) rank = 0.1;
      else if (isSidePrefix) rank = 1.2;
      else if (isModelOrFeature) rank = 2.2;

      if (rank < 0) continue;

      fleetHits.push({
        item: { kind: "fleet", f },
        rank,
        label: `#${f.sideNumber} ${f.model}`,
        dist: Infinity,
      });
    }

    // 4. Actions
    const actionHits: Scored[] = [];
    for (const a of actions) {
      const nl = normalizeText(a.label);
      let rank = -1;
      if (nl.startsWith(q)) rank = 2.2;
      else if (nl.includes(q) || a.keywords.includes(q)) rank = 2.5;
      if (rank < 0) continue;
      actionHits.push({ item: { kind: "action", a }, rank, label: a.label, dist: Infinity });
    }

    // 5. Stops
    const favSet = favorites.favSet;
    const stopHits: Scored[] = [];
    for (const { s, n } of stopIndex) {
      let rank = -1;
      if (n.startsWith(q)) rank = 2;
      else if (n.includes(q)) rank = 3;
      if (rank < 0) continue;
      const fav = favSet.has(s.designator);
      if (fav) rank -= 0.5; // favorites float higher
      const d = stopDist(s);
      stopHits.push({
        item: { kind: "stop", s, fav, dist: d },
        rank,
        label: s.name,
        dist: d ?? Infinity,
      });
    }

    // Photon's order is its relevance: listed after stops that contain the query
    const addrItems: Item[] = addrHits.slice(0, CAP.addr).map((g) => ({
      kind: "addr",
      g,
      dist: geoPos ? haversineMeters(geoPos.lat, geoPos.lon, g.lat, g.lon) : null,
    }));

    const finish = (hits: Scored[], cap: number, dedupeByName = false): { items: Item[]; best: number } => {
      hits.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.label.localeCompare(b.label, "pl"));
      if (!dedupeByName) {
        return { items: hits.slice(0, cap).map((h) => h.item), best: hits[0]?.rank ?? Infinity };
      }
      const seen = new Set<string>();
      const deduped: Item[] = [];
      for (const h of hits) {
        const key = normalizeText(h.label);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(h.item);
        if (deduped.length >= cap) break;
      }
      return { items: deduped, best: hits[0]?.rank ?? Infinity };
    };

    const groups: Section[] = [
      { title: "Linie", ...finish(lineHits, CAP.lines) },
      { title: "Pojazdy na żywo", ...finish(vehHits, CAP.vehs) },
      { title: "Tabor MZK", ...finish(fleetHits, CAP.fleet) },
      { title: "Przystanki", ...finish(stopHits, CAP.stops, true) },
      { title: "Adresy i miejsca", items: addrItems, best: 3.5 },
      { title: "Akcje", ...finish(actionHits, CAP.actions) },
    ]
      .filter((g) => g.items.length > 0)
      .sort((a, b) => a.best - b.best);

    return groups;
  });

  // Flat array of items for keyboard navigation index
  const flatItems = $derived(sections.flatMap((s) => s.items));
  const flatLen = $derived(flatItems.length);
  /* each section's first index in flatItems: the option ids and the highlight count across sections */
  const offsets = $derived.by(() => {
    let n = 0;
    return sections.map((s) => {
      const at = n;
      n += s.items.length;
      return at;
    });
  });
  // the live vehicle hits can shrink under the highlight between polls: clamp at use
  const hiIdx = $derived(Math.min(hi, Math.max(0, flatLen - 1)));

  // Scroll active item into view
  $effect(() => {
    if (!showDropdown || flatLen === 0) return;
    const activeEl = document.getElementById(optionId(hiIdx));
    activeEl?.scrollIntoView({ block: "nearest" });
  });

  // Pick / execute item
  function pick(it: Item): void {
    if (it.kind === "stop") {
      onPickStop(it.s);
      isFocused = false;
    } else if (it.kind === "veh") {
      onPickVehicle(it.v);
      isFocused = false;
    } else if (it.kind === "fleet") {
      window.location.href = `/brygady?tabor=${it.f.sideNumber}`;
      isFocused = false;
    } else if (it.kind === "line") {
      onOpenLine(it.l);
      isFocused = false;
    } else if (it.kind === "addr") {
      onPickPlace?.(it.g);
      isFocused = false;
    } else if (it.kind === "action") {
      it.a.run();
      isFocused = false;
    }
  }

  // Keyboard navigation on input
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        query = "";
        hi = 0;
      } else {
        isFocused = false;
        input?.blur();
      }
      return;
    }

    if (!showDropdown || flatLen === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      hi = (hiIdx + 1) % flatLen;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      hi = (hiIdx - 1 + flatLen) % flatLen;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const current = flatItems[hiIdx];
      if (current) pick(current);
    }
  }

  function optionId(index: number): string {
    return `${listId}-opt-${index}`;
  }
</script>

<!-- Leading tile, as wide as a LineBadge so every row's text starts on one column. -->
{#snippet glyph(icon: IconDef)}
  <span class="grid h-7 w-9 shrink-0 place-items-center rounded-lg bg-tint/6 text-[15px] text-text-mute" aria-hidden="true">
    <Icon {icon} />
  </span>
{/snippet}

<!-- The map's stop marker in miniature: disc for a stop, rounded square for a station, operator colour. -->
{#snippet stopGlyph(operator: "KB" | "MZK" | "GZM" | "BOTH", station: boolean)}
  {@const fill =
    operator === "BOTH"
      ? "bg-[linear-gradient(90deg,var(--color-kb)_50%,var(--color-mzk)_50%)]"
      : operator === "MZK"
        ? "bg-mzk"
        : operator === "GZM"
          ? "bg-gzm"
          : "bg-kb"}
  <span class="grid h-7 w-9 shrink-0 place-items-center" aria-hidden="true">
    <span
      class="grid place-items-center text-white {fill} {station
        ? 'h-[22px] w-[22px] rounded-[7px] text-[14px]'
        : 'h-[20px] w-[20px] rounded-full text-[12px]'}"
    >
      <Icon icon={BusIcon} weight="fill" />
    </span>
  </span>
{/snippet}

{#snippet tag(text: string, icon: IconDef | null)}
  <span
    class="inline-flex shrink-0 items-center gap-1 rounded-full bg-tint/6 px-1.5 py-px text-[10.5px] font-medium text-text-mute"
    >{#if icon}<Icon {icon} />{/if}{text}</span
  >
{/snippet}

{#snippet fuelTag(fuel: FleetVehicleSummary["fuelType"])}
  {#if fuel === "hydrogen"}
    {@render tag("Wodór", DropIcon)}
  {:else if fuel === "electric"}
    {@render tag("Elektryczny", LightningIcon)}
  {:else if fuel === "hybrid"}
    {@render tag("Hybryda", LeafIcon)}
  {:else}
    {@render tag("Diesel", null)}
  {/if}
{/snippet}

<!-- Search Input inline in TopBar pill -->
<div class="flex h-full min-w-0 flex-1 items-center gap-2">
  <Icon icon={MagnifyingGlassIcon} class="ml-0.5 shrink-0 text-[17px] text-text-faint" />

  <input
    bind:this={input}
    type="text"
    role="combobox"
    aria-expanded={showDropdown}
    aria-controls={showDropdown ? listId : undefined}
    aria-activedescendant={showDropdown && flatLen > 0 ? optionId(hiIdx) : undefined}
    aria-autocomplete="list"
    aria-label="Szukaj przystanku, linii lub taboru"
    placeholder="Przystanek, linia, pojazd…"
    autocomplete="off"
    spellcheck={false}
    value={query}
    oninput={(e) => {
      query = e.currentTarget.value;
      hi = 0;
      isFocused = true;
    }}
    onfocus={() => (isFocused = true)}
    onkeydown={onKeyDown}
    class="no-focus-ring h-full min-w-0 flex-1 bg-transparent text-base md:text-[13.5px] text-text placeholder:text-text-faint focus:outline-none"
  />

  {#if query}
    <button
      type="button"
      onclick={() => {
        query = "";
        hi = 0;
        input?.focus();
      }}
      aria-label="Wyczyść wyszukiwanie"
      class="tap grid h-7 w-7 shrink-0 place-items-center rounded-full bg-tint/6 text-[13px] text-text-mute hover:bg-tint/10 hover:text-text"
    >
      <Icon icon={XIcon} />
    </button>
  {/if}
</div>

<!-- Dropdown Results list -->
{#if showDropdown}
  <div
    bind:this={dropdown}
    class="surface absolute left-0 top-full mt-2 flex max-h-[min(65vh,460px)] w-full flex-col overflow-y-auto overscroll-contain rounded-[20px] p-1.5 animate-drop z-[1003]"
  >
    {#if flatLen === 0}
      <div class="px-4 py-8 text-center text-[13px] text-text-faint">
        Brak wyników dla „<span class="font-medium text-text">{query}</span>”
      </div>
    {:else}
      <ul id={listId} role="listbox" class="flex flex-col gap-0.5">
        {#each sections as section, si (section.title)}
          <li class="flex flex-col">
            <div class="px-3 pb-1 pt-2.5 text-[12px] font-medium text-text-faint">
              {section.title}
            </div>
            <ul class="flex flex-col gap-0.5">
              {#each section.items as it, j (itemKey(it))}
                {@const itemIndex = offsets[si] + j}
                {@const isSelected = itemIndex === hiIdx}
                <li id={optionId(itemIndex)} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    tabindex={-1}
                    onmouseenter={() => (hi = itemIndex)}
                    onpointerdown={(e) => {
                      e.preventDefault();
                    }}
                    onclick={() => pick(it)}
                    class="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[13px] transition-[background-color,color,scale] duration-150 active:scale-[0.99] {isSelected
                      ? 'bg-tint/8 text-text'
                      : 'text-text-mute hover:bg-tint/6'}"
                  >
                    {#if it.kind === "stop"}
                      {@render stopGlyph(it.s.operator ?? "KB", !!it.s.isStation)}
                      <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span class="sr-only">{`${opLabel(it.s.operator ?? "KB")}: `}</span>
                        <span class="truncate font-medium text-text">{displayStopName(it.s.name)}</span>
                        {#if it.s.symbol}
                          <span class="shrink-0 text-[11.5px] tabular-nums text-text-faint">{it.s.symbol}</span>
                        {/if}
                      </span>
                      {#if it.fav}
                        <Icon icon={StarIcon} weight="fill" class="shrink-0 text-[13px] text-primary" />
                      {/if}
                      {#if it.dist != null}
                        <span class="shrink-0 text-[11.5px] tabular-nums text-text-faint">
                          {formatDistance(it.dist)}
                        </span>
                      {/if}
                    {:else if it.kind === "line"}
                      <LineBadge line={it.l.name} operator={it.l.operator} />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate font-medium text-text">
                          {it.l.terminus ? `→ ${displayStopName(it.l.terminus)}` : `Linia ${it.l.name}`}
                        </span>
                        <span class="mt-0.5 block truncate text-[11.5px] tabular-nums text-text-faint">
                          {opLabel(it.l.operator || "KB")} · {it.live > 0
                            ? `${it.live} ${wozPlural(it.live)} na trasie`
                            : "brak wozów na trasie"}{it.active ? " · filtr aktywny" : ""}
                        </span>
                      </span>
                      {#if it.active}
                        <Icon icon={CheckIcon} class="shrink-0 text-[15px] text-primary" />
                      {/if}
                    {:else if it.kind === "veh"}
                      <LineBadge line={it.v.line || "?"} operator={it.v.operator} />
                      <span class="min-w-0 flex-1">
                        <span class="flex items-baseline gap-1.5">
                          <span class="truncate font-medium text-text">
                            {it.v.headsign ? `→ ${displayStopName(it.v.headsign)}` : `Linia ${it.v.line || "?"}`}
                          </span>
                          {#if it.v.side_number}
                            <span class="shrink-0 text-[11.5px] font-medium tabular-nums text-text-mute">
                              #{it.v.side_number}
                            </span>
                          {/if}
                        </span>
                        <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] tabular-nums text-text-faint">
                          <span
                            class="h-1.5 w-1.5 shrink-0 rounded-full {it.v.not_started
                              ? 'bg-text-faint'
                              : 'animate-pulse-dot bg-good'}"
                            aria-hidden="true"
                          ></span>
                          <span class="truncate">
                            {opLabel(it.v.operator || "KB")} · {it.v.not_started
                              ? "czeka na odjazd"
                              : `na żywo${it.v.delay != null ? ` · ${delayTxt(it.v.delay)}` : ""}`}{it.v.model
                              ? ` · ${it.v.model}`
                              : ""}
                          </span>
                          {#if it.v.features?.hydrogen}{@render tag("Wodór", DropIcon)}{/if}
                          {#if it.v.features?.electric}{@render tag("Elektryczny", LightningIcon)}{/if}
                        </span>
                      </span>
                    {:else if it.kind === "fleet"}
                      {@render glyph(BusIcon)}
                      <span class="min-w-0 flex-1">
                        <span class="flex items-baseline gap-1.5">
                          <span class="shrink-0 font-semibold tabular-nums text-text">#{it.f.sideNumber}</span>
                          <span class="truncate text-text-mute">{it.f.model}</span>
                        </span>
                        <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] tabular-nums text-text-faint">
                          <span class="truncate">
                            MZK{it.f.year ? ` · ${it.f.year}` : ""} · w zajezdni
                          </span>
                          {@render tag(it.f.lengthCategory, null)}
                          {@render fuelTag(it.f.fuelType)}
                        </span>
                      </span>
                    {:else if it.kind === "addr"}
                      {@render glyph(MapPinIcon)}
                      <span class="min-w-0 flex-1">
                        <span class="block truncate font-medium text-text">{it.g.name}</span>
                        {#if it.g.detail}
                          <span class="mt-0.5 block truncate text-[11.5px] text-text-faint">{it.g.detail}</span>
                        {/if}
                      </span>
                      {#if it.dist != null}
                        <span class="shrink-0 text-[11.5px] tabular-nums text-text-faint">
                          {formatDistance(it.dist)}
                        </span>
                      {/if}
                    {:else if it.kind === "action"}
                      {@render glyph(it.a.icon)}
                      <span class="min-w-0 flex-1 truncate font-medium text-text">{it.a.label}</span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
