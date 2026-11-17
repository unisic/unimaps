<script module lang="ts">
  import type { FleetFuelType, FleetLengthCategory, FleetSummaryItem } from "@/lib/shared/fleet";

  import { FUEL_LABEL, LENGTH_LABEL } from "./common";
  import { YEAR_BINS, type FleetFilters, type StatusFilter } from "./fleetFilters";
  import type { Facet } from "./gallery";

  /*
   * The "Pojazdy" tab as a catalogue: the fleet grouped by model, every vehicle a photo tile.
   * From 900 px a facet rail beside one shelf per model; below it status views, facet sheets and a page
   * per model. The view (`filters`) is the parent's and lives in the URL; the search box is a jump to one
   * vehicle, never a filter.
   */

  const STATUSES: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "Wszystkie" },
    { key: "active", label: "W trasie" },
    { key: "late", label: "Spóźnione" },
    { key: "waiting", label: "Czeka na odjazd" },
    { key: "depot", label: "W zajezdni" },
    { key: "rare", label: "Rzadkie w trasie" },
  ];

  const NO_DATA = "brak danych";

  interface FacetDef {
    id: Facet;
    title: string;
    /** fixed option order; without one the options go by fleet size */
    order?: string[];
    label: (key: string) => string;
    /** the chosen option's key, null = every vehicle */
    get: (f: FleetFilters) => string | null;
    set: (key: string | null) => Partial<FleetFilters>;
  }

  const FACETS: FacetDef[] = [
    { id: "company", title: "Przewoźnik", label: (k) => k || NO_DATA, get: (f) => f.company || null, set: (k) => ({ company: k ?? "" }) },
    {
      id: "fuel",
      title: "Napęd",
      order: ["diesel", "electric", "hybrid", "hydrogen", "cng", "none"],
      label: (k) => FUEL_LABEL[k as FleetFuelType] ?? NO_DATA,
      get: (f) => (f.fuel === "all" ? null : f.fuel),
      set: (k) => ({ fuel: (k ?? "all") as FleetFilters["fuel"] }),
    },
    {
      id: "length",
      title: "Długość",
      order: ["MINI", "MIDI", "MAXI", "MEGA", "none"],
      label: (k) => LENGTH_LABEL[k as FleetLengthCategory] ?? NO_DATA,
      get: (f) => (f.length === "all" ? null : f.length),
      set: (k) => ({ length: (k ?? "all") as FleetFilters["length"] }),
    },
    {
      id: "year",
      title: "Rocznik",
      order: YEAR_BINS.map((_, i) => String(i)),
      label: (k) => YEAR_BINS[Number(k)]?.label ?? NO_DATA,
      get: (f) => (f.year < 0 ? null : String(f.year)),
      set: (k) => ({ year: k === null ? -1 : Number(k) }),
    },
  ];

  /** tiles of a collapsed shelf, shelves before "Pokaż wszystkie modele", companies before "Pokaż wszystkich" */
  const SHELF_TILES = 5;
  const SHELVES = 4;
  const COMPANIES = 6;
  /** search hits: the desktop dropdown, the phone list, the phone's model matches */
  const HITS = 8;
  const HITS_PHONE = 12;
  /** tiles of a phone strip */
  const STRIP = 12;
  /** ponytail: GZM lists ~1 400 vehicles; 200 tiles per step keep the DOM small. Upgrade: a virtual list. */
  const PAGE_ROWS = 200;
  const RARE_SHELF = "\0rare";

  const isTram = (v: FleetSummaryItem | undefined) => v?.company === TRAM_COMPANY;

  const LIST = "flex flex-col overflow-hidden rounded-2xl border border-hairline bg-surface";
  const GRID = "grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4";
  const STRIP_ROW = "-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]";
  const PILL = "min-h-10 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text hover:bg-tint/12";
  const LINK = "min-h-9 rounded-lg px-2 text-[13px] font-medium text-primary hover:bg-primary-dim";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { MediaQuery } from "svelte/reactivity";

  import Icon from "@/components/Icon.svelte";
  import { BusIcon, TramIcon } from "@/components/icon-paths";
  import LineBadge from "@/components/ui/LineBadge.svelte";
  import ShareLink from "@/components/ui/ShareLink.svelte";
  import type { FleetCity } from "@/lib/client/fleet";
  import { foldText, ptThumbUrl } from "@/lib/shared/fleet";

  import { clockFromEpoch, FLEET_CITY, fmtInt, pluralPl, SERIES_FILL } from "./common";
  import DelayBadge from "./DelayBadge.svelte";
  import { DEFAULT_FILTERS, filtersToParams, hasActiveFilters } from "./fleetFilters";
  import {
    byLine,
    byShelf,
    bySide,
    droveToday,
    FACET_KEY,
    groupModels,
    knownModels,
    isLate,
    labelOf,
    passFacets,
    passStatus,
    RARE_MAX,
    rankHits,
    rareModels,
    TRAM_COMPANY,
    vehicleState,
    type ModelGroup,
  } from "./gallery";
  import { CHEVRON_DOWN, CHEVRON_LEFT, CHEVRON_RIGHT, CLOSE, SEARCH } from "./icons";
  import Svg from "./Svg.svelte";

  let {
    vehicles: listed,
    filters,
    onFiltersChange,
    onOpen,
    city = "bb",
  }: {
    vehicles: FleetSummaryItem[];
    filters: FleetFilters;
    onFiltersChange: (patch: Partial<FleetFilters>) => void;
    /** `order` = the list the vehicle was opened from, for the card's previous / next */
    onOpen: (side: string, order: string[]) => void;
    city?: FleetCity;
  } = $props();

  const vehicles = $derived(knownModels(listed));

  const uid = $props.id();
  const searchId = `${uid}-q`;
  const brand = $derived(FLEET_CITY[city]);

  /* the rail (260) + gap + two tile columns need about 900 px */
  const desktopQuery = new MediaQuery("(min-width: 900px)", false);
  const desktop = $derived(desktopQuery.current);

  let root: HTMLDivElement | undefined = $state();
  let q = $state("");
  let allCompanies = $state(false);
  let allShelves = $state(false);
  let openShelves = $state.raw<ReadonlySet<string>>(new Set());
  let indexOpen = $state(false);
  let depotOpen = $state(false);
  let neverOpen = $state(false);
  /** the facet whose sheet is open (phone) */
  let sheet = $state<Facet | null>(null);
  let dialog = $state<HTMLDialogElement>();
  /** extra PAGE_ROWS steps of the long list on screen; a new view starts over */
  let extra = $state(0);
  $effect(() => {
    void filters;
    extra = 0;
  });
  const limit = $derived(PAGE_ROWS * (1 + extra));

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  /* a model is rare in the whole fleet, never in a filtered view */
  const rare = $derived(rareModels(vehicles));
  const isRareRun = (v: FleetSummaryItem) => vehicleState(v) === "active" && rare.has(v.model);
  const allGroups = $derived(groupModels(vehicles));
  const sizeOf = $derived(new Map(allGroups.map((g) => [g.model, g.vehicles.length])));

  /** every filter but the status: what the status chips count */
  const base = $derived(vehicles.filter((v) => passFacets(v, filters)));
  const groups = $derived(base.length === vehicles.length ? allGroups : groupModels(base));
  const shown = $derived(base.filter((v) => passStatus(v, filters.status, rare)));
  const list = $derived([...shown].sort(filters.status === "active" || filters.status === "rare" ? byLine : byShelf));
  const facetsOn = $derived(hasActiveFilters({ ...filters, status: "all" }));

  const counts = $derived.by(() => {
    const c: Record<StatusFilter, number> = { all: base.length, active: 0, late: 0, waiting: 0, depot: 0, rare: 0 };
    for (const v of base) {
      c[vehicleState(v)]++;
      if (isLate(v)) c.late++;
      if (isRareRun(v)) c.rare++;
    }
    return c;
  });

  /* An option's count is taken over the vehicles passing the other facets, so picking one never empties
     its own list; only options the whole fleet has are listed, a facet with one option is no choice. */
  const facets = $derived(
    FACETS.map((def) => {
      const key = FACET_KEY[def.id];
      const fleet = new Map<string, number>();
      const n = new Map<string, number>();
      const run = new Map<string, number>();
      for (const v of vehicles) {
        const k = key(v);
        fleet.set(k, (fleet.get(k) ?? 0) + 1);
        if (!passFacets(v, filters, def.id)) continue;
        n.set(k, (n.get(k) ?? 0) + 1);
        if (vehicleState(v) === "active") run.set(k, (run.get(k) ?? 0) + 1);
      }
      const keys =
        def.order?.filter((k) => fleet.has(k)) ??
        [...fleet.keys()].sort((a, b) => (fleet.get(b) ?? 0) - (fleet.get(a) ?? 0) || a.localeCompare(b, "pl"));
      return {
        ...def,
        value: def.get(filters),
        options: keys.map((k) => ({ key: k, label: def.label(k), n: n.get(k) ?? 0, run: run.get(k) ?? 0 })),
      };
    }).filter((f) => f.options.length > 1),
  );
  type FacetView = (typeof facets)[number];
  const sheetFacet = $derived(facets.find((f) => f.id === sheet));

  const activeChips = $derived.by(() => {
    const out: { text: string; clear: Partial<FleetFilters> }[] = [];
    if (filters.status !== "all") {
      out.push({ text: `Status: ${STATUSES.find((s) => s.key === filters.status)?.label ?? ""}`, clear: { status: "all" } });
    }
    for (const f of FACETS) {
      const k = f.get(filters);
      if (k !== null) out.push({ text: `${f.title}: ${f.label(k)}`, clear: f.set(null) });
    }
    if (filters.line) out.push({ text: `Linia: ${filters.line}`, clear: { line: "" } });
    if (filters.model !== null) out.push({ text: `Model: ${filters.model || "nieustalony"}`, clear: { model: null } });
    return out;
  });

  /* always names the city: a shared BB view must not open in the receiver's stored city */
  const viewPath = $derived.by(() => {
    const p = new URLSearchParams({ city });
    filtersToParams(filters, p);
    return `/brygady?${p}`;
  });

  /* the pinned shelf: rare models on the street now. While it shows, its tiles leave the model shelves. */
  const pinned = $derived(
    filters.status === "rare" || (filters.model === null && (filters.status === "all" || filters.status === "active"))
      ? shown.filter(isRareRun).sort(byShelf)
      : [],
  );
  const shelves = $derived(
    filters.status === "rare"
      ? []
      : groups.flatMap((g) => {
          const tiles = g.vehicles
            .filter((v) => passStatus(v, filters.status, rare) && !(pinned.length > 0 && isRareRun(v)))
            .sort(byShelf);
          return tiles.length > 0 ? [{ g, tiles }] : [];
        }),
  );

  const running = $derived(base.filter((v) => vehicleState(v) === "active").sort(byLine));
  const worst = $derived(
    running.reduce<FleetSummaryItem | undefined>(
      (w, v) => (v.delaySec !== undefined && (w?.delaySec === undefined || v.delaySec > w.delaySec) ? v : w),
      undefined,
    ),
  );
  /** the least numerous model with a vehicle on the street, for the "no rare model today" card */
  const rarest = $derived(
    groups
      .filter((g) => g.model && g.active > 0)
      .reduce<ModelGroup | undefined>((r, g) => (!r || (sizeOf.get(g.model) ?? 0) < (sizeOf.get(r.model) ?? 0) ? g : r), undefined),
  );
  const quiet = $derived(vehicles.length > 0 && counts.active + counts.waiting === 0 && !hasActiveFilters(filters));
  const rareRule = $derived(
    `${city === "gzm" ? "widać dziś" : `${brand.short} ma`} najwyżej ${RARE_MAX} ${pluralPl(RARE_MAX, "sztukę", "sztuki", "sztuk")}`,
  );

  const found = $derived(rankHits(vehicles, q, desktop ? HITS : HITS_PHONE));
  const modelHits = $derived.by(() => {
    const fq = foldText(q.trim());
    return fq ? allGroups.filter((g) => g.model && foldText(g.model).includes(fq)).slice(0, HITS) : [];
  });
  const view = $derived(q.trim() ? "search" : filters.model !== null ? "model" : filters.status);

  const open = (v: FleetSummaryItem, from: FleetSummaryItem[]) =>
    onOpen(
      v.sideNumber,
      from.map((x) => x.sideNumber),
    );

  function pickHit(v: FleetSummaryItem) {
    const hits = found.hits;
    q = "";
    open(v, hits);
  }

  function pickModel(model: string | null) {
    q = "";
    onFiltersChange({ model });
    requestAnimationFrame(() => root?.scrollIntoView({ block: "start" }));
  }

  const toggle = (f: FacetView, key: string) => onFiltersChange(f.set(f.value === key ? null : key));

  function pickOption(f: FacetView, key: string | null) {
    onFiltersChange(f.set(key));
    dialog?.close();
  }

  function toggleShelf(key: string) {
    const next = new Set(openShelves);
    if (!next.delete(key)) next.add(key);
    openShelves = next;
  }

  const waitText = (v: FleetSummaryItem) =>
    [v.lineName ? `linia ${v.lineName}` : "", v.startTime ? `o ${v.startTime}` : "", v.firstStopName ? `z ${v.firstStopName}` : ""]
      .filter(Boolean)
      .join(" ");
  const depotText = (v: FleetSummaryItem) =>
    droveToday(v) && v.lastSeenAt > 0
      ? `ostatnio ${clockFromEpoch(v.lastSeenAt)}${v.lastLineName ? `, linia ${v.lastLineName}` : ""}`
      : "dziś nie wyjechał";
  function statusText(v: FleetSummaryItem): string {
    const s = vehicleState(v);
    if (s === "active") return `W trasie, linia ${v.lineName ?? "?"}`;
    return s === "waiting" ? `Czeka na odjazd, ${waitText(v)}` : `W zajezdni, ${depotText(v)}`;
  }
  const units = (g: ModelGroup) => {
    const fleet = sizeOf.get(g.model) ?? g.vehicles.length;
    return fleet === g.vehicles.length ? `${fmtInt(fleet)} szt.` : `${fmtInt(g.vehicles.length)} z ${fmtInt(fleet)} szt.`;
  };
  const tagOf = <K extends string>(value: K | "mixed" | null, labels: Record<K, string>) =>
    value === "mixed" ? "różny" : value ? labels[value] : NO_DATA;
</script>

<!-- A phototrans thumbnail, hotlinked like the card's photos; lazy, so only tiles near the viewport fetch
     one. A photo phototrans has since removed hides itself and leaves the glyph. -->
{#snippet photo(thumb: string | undefined, tram: boolean, cls: string, glyph: number)}
  <span
    class="relative grid shrink-0 place-items-center overflow-hidden text-text-faint {cls} {thumb
      ? 'bg-surface-3'
      : 'border-b border-dashed border-tint/10 bg-surface-2'}"
  >
    <Icon icon={tram ? TramIcon : BusIcon} size={glyph} />
    {#if thumb}
      <img
        src={ptThumbUrl(thumb)}
        alt=""
        width="300"
        height="200"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        onerror={(e) => ((e.currentTarget as HTMLImageElement).hidden = true)}
        class="peer absolute inset-0 h-full w-full object-cover"
      />
      <span class="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] leading-4 text-white peer-[[hidden]]:hidden">phototrans.eu</span>
    {:else}
      <span class="absolute bottom-1 left-1.5 text-[10px] leading-4">brak zdjęcia</span>
    {/if}
  </span>
{/snippet}

{#snippet dot(v: FleetSummaryItem)}
  {@const s = vehicleState(v)}
  <span
    aria-hidden="true"
    class="h-2 w-2 shrink-0 rounded-full {s === 'active' ? 'bg-good' : s === 'waiting' ? 'bg-primary' : 'bg-tint/25'}"
  ></span>
{/snippet}

{#snippet tile(v: FleetSummaryItem, from: FleetSummaryItem[], note: string, cls = "")}
  {@const s = vehicleState(v)}
  <button
    type="button"
    onclick={() => open(v, from)}
    aria-label={`#${labelOf(v)}, ${[v.model, v.company, statusText(v), s === "active" && v.direction ? `kierunek ${v.direction}` : ""]
      .filter(Boolean)
      .join(", ")}`}
    class="flex min-w-0 flex-col overflow-hidden border border-hairline bg-surface text-left transition-[background-color,border-color] hover:border-tint/15 hover:bg-surface-2 {desktop
      ? 'rounded-2xl'
      : 'rounded-[14px]'} {cls}"
  >
    {@render photo(v.thumb, isTram(v), desktop ? "aspect-[3/2]" : "aspect-[16/10]", desktop ? 44 : 32)}
    <span class="flex min-w-0 flex-col gap-1.5 px-3 pb-3 pt-2.5">
      <span class="flex min-w-0 items-center gap-1.5">
        <span class="text-[15px] font-semibold tabular-nums text-text">#{labelOf(v)}</span>
        {#if !desktop}{@render dot(v)}{/if}
        <span class="min-w-0 truncate text-[12px] text-text-faint">{note}</span>
      </span>
      {#if s === "active"}
        <span class="flex items-center gap-1.5">
          {#if v.lineName}<LineBadge line={v.lineName} operator={brand.operator} />{/if}
          {#if v.delaySec !== undefined}<DelayBadge sec={v.delaySec} />{/if}
        </span>
        <span class="truncate text-[12px] text-text-mute">{v.direction ? `→ ${v.direction}` : "kierunek nieznany"}</span>
      {:else}
        <span class="text-[12.5px] font-medium {s === 'waiting' ? 'text-primary' : 'text-text-mute'}">
          {s === "waiting" ? "Czeka na odjazd" : "W zajezdni"}
        </span>
        <span class="truncate text-[12px] text-text-mute">{s === "waiting" ? waitText(v) : depotText(v)}</span>
      {/if}
    </span>
  </button>
{/snippet}

{#snippet row(v: FleetSummaryItem, from: FleetSummaryItem[])}
  {@const s = vehicleState(v)}
  <button
    type="button"
    onclick={() => open(v, from)}
    class="flex min-h-14 w-full items-center gap-2.5 border-b border-hairline px-3 py-1.5 text-left transition-colors last:border-b-0 hover:bg-surface-2"
  >
    <span class="min-w-[52px] shrink-0 text-[15px] font-semibold tabular-nums text-text">#{labelOf(v)}</span>
    {#if s !== "depot" && v.lineName}<LineBadge line={v.lineName} operator={brand.operator} />{/if}
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[13px] text-text">{v.model || "Model nieustalony"}</span>
      <span class="block truncate text-[12px] text-text-mute">
        {s === "active" ? (v.direction ? `→ ${v.direction}` : "W trasie") : statusText(v)}
      </span>
    </span>
    {#if s === "active" && v.delaySec !== undefined}<DelayBadge sec={v.delaySec} />{:else}{@render dot(v)}{/if}
  </button>
{/snippet}

{#snippet modelRow(g: ModelGroup)}
  <button
    type="button"
    onclick={() => pickModel(g.model)}
    class="flex min-h-[72px] w-full items-center gap-3 border-b border-hairline py-1 pl-1 pr-3 text-left transition-colors last:border-b-0 hover:bg-surface-2"
  >
    {@render photo(g.thumb, isTram(g.vehicles[0]), "h-16 w-24 rounded-[10px]", 26)}
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[14px] font-semibold text-text">{g.model || "Model nieustalony"}</span>
      <span class="block truncate text-[12.5px] text-text-mute">
        {g.years ? `rocznik ${g.years} · ` : ""}{units(g)}{#if g.active > 0}<span class="font-medium text-good">
            {` · ${fmtInt(g.active)} w trasie`}</span
          >{/if}
      </span>
    </span>
    <Svg icon={CHEVRON_RIGHT} size={18} class="shrink-0 text-text-faint" />
  </button>
{/snippet}

{#snippet heading(title: string, n: number, aside = "")}
  <div class="flex items-baseline justify-between gap-3">
    <h2 class="text-[15px] font-semibold text-text">
      {title} <span class="font-normal tabular-nums text-text-faint">{fmtInt(n)}</span>
    </h2>
    {#if aside}<span class="shrink-0 text-[12px] text-text-faint">{aside}</span>{/if}
  </div>
{/snippet}

{#snippet more(total: number)}
  {#if total > limit}
    <button type="button" onclick={() => extra++} class="self-center {PILL}">
      Pokaż więcej ({fmtInt(limit)} z {fmtInt(total)})
    </button>
  {/if}
{/snippet}

{#snippet empty(title: string, text = "", action?: Snippet)}
  <div class="rounded-2xl border border-dashed border-tint/15 px-4 py-10 text-center">
    <p class="text-[15px] font-medium text-text">{title}</p>
    {#if text}<p class="mx-auto mt-1 max-w-md text-[13px] text-text-mute">{text}</p>{/if}
    {@render action?.()}
  </div>
{/snippet}

{#snippet clearAction()}
  {#if hasActiveFilters(filters)}
    <button type="button" onclick={() => onFiltersChange(DEFAULT_FILTERS)} class="mt-4 {PILL}">Wyczyść filtry</button>
  {/if}
{/snippet}

{#snippet noMatch()}
  {@render empty(hasActiveFilters(filters) ? "Żaden pojazd nie pasuje do tych filtrów." : "Brak pojazdów na liście.", "", clearAction)}
{/snippet}

{#snippet nightNote()}
  <p class="rounded-xl border border-hairline bg-surface px-3.5 py-2.5 text-[13px] text-text-mute">
    Żaden {brand.veh}
    {brand.short} nie jest teraz w trasie, nocą to normalne. Karta pojazdu pokazuje jego dzisiejsze kursy.
  </p>
{/snippet}

{#snippet option(label: string, n: number | null, on: boolean, pick: () => void, tall = false)}
  <button
    type="button"
    aria-pressed={on}
    onclick={pick}
    class="flex w-full shrink-0 items-center justify-between gap-2 border text-left transition-colors {tall
      ? 'min-h-12 rounded-xl px-3.5 text-[15px]'
      : 'min-h-8 rounded-lg px-2 text-[13px]'} {on
      ? 'border-primary/50 bg-primary-dim text-text'
      : tall
        ? 'border-hairline bg-surface text-text'
        : 'border-transparent text-text-mute hover:bg-tint/6 hover:text-text'}"
  >
    <span class="min-w-0 truncate">{label}</span>
    {#if n !== null}<span class="shrink-0 tabular-nums text-text-faint">{fmtInt(n)}</span>{/if}
  </button>
{/snippet}

{#snippet histogram(f: FacetView)}
  {@const max = Math.max(1, ...f.options.map((o) => o.n))}
  <p class="text-[12px] text-text-faint">Wiek floty. Kliknij słupek, aby filtrować.</p>
  <div class="flex items-end gap-1">
    {#each f.options as o (o.key)}
      {@const on = f.value === o.key}
      <button
        type="button"
        aria-pressed={on}
        aria-label={`Rocznik ${o.label}: ${fmtInt(o.n)} ${pluralPl(o.n, "pojazd", "pojazdy", "pojazdów")}, ${fmtInt(o.run)} w trasie`}
        title={`${o.label}: ${fmtInt(o.n)}, w trasie ${fmtInt(o.run)}`}
        onclick={() => toggle(f, o.key)}
        class="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-0.5 pb-1 pt-1.5 transition-colors {on
          ? 'bg-primary-dim'
          : 'hover:bg-tint/6'}"
      >
        <span class="flex h-24 w-full items-end">
          <span
            class="relative block w-full overflow-hidden rounded-t bg-tint/20"
            style:height="{Math.max(2, Math.round((o.n / max) * 96))}px"
          >
            <span
              class="absolute inset-x-0 bottom-0 block"
              style:height="{o.n > 0 ? (o.run / o.n) * 100 : 0}%"
              style:background={SERIES_FILL}
            ></span>
          </span>
        </span>
        <span class="w-full truncate text-center text-[10.5px] tabular-nums {on ? 'font-semibold text-primary' : 'text-text-faint'}">
          {YEAR_BINS[Number(o.key)]?.short}
        </span>
      </button>
    {/each}
  </div>
  <p class="flex items-center gap-3 text-[11.5px] text-text-faint">
    <span class="inline-flex items-center gap-1.5"><span aria-hidden="true" class="h-2 w-2 rounded-sm bg-tint/20"></span>wszystkie</span>
    <span class="inline-flex items-center gap-1.5">
      <span aria-hidden="true" class="h-2 w-2 rounded-sm" style:background={SERIES_FILL}></span>w trasie
    </span>
  </p>
{/snippet}

{#snippet shelf(key: string, title: string, meta: string, tiles: FleetSummaryItem[], note: (v: FleetSummaryItem) => string, late = 0)}
  {@const expanded = filters.model !== null || openShelves.has(key)}
  <section class="flex flex-col gap-3">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="text-[16px] font-semibold text-text">{title}</h2>
      {#if key === RARE_SHELF}
        <span class="rounded-full bg-primary-dim px-2 py-0.5 text-[11px] font-medium text-primary">przypięte</span>
      {/if}
      <p class="text-[12.5px] text-text-mute">{meta}</p>
      {#if late > 0}
        <span class="rounded-md bg-tint/6 px-1.5 py-0.5 text-[12px] font-semibold text-late">
          {fmtInt(late)}
          {pluralPl(late, "spóźniony", "spóźnione", "spóźnionych")}
        </span>
      {/if}
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-3">
      {#each tiles.slice(0, expanded ? limit : SHELF_TILES) as v (v.sideNumber)}
        {@render tile(v, tiles, note(v))}
      {/each}
    </div>
    {#if expanded}{@render more(tiles.length)}{/if}
    {#if tiles.length > SHELF_TILES && filters.model === null}
      <button type="button" aria-expanded={expanded} onclick={() => toggleShelf(key)} class="self-start {LINK}">
        {expanded ? "Zwiń półkę" : `Pokaż całą półkę (${fmtInt(tiles.length)})`}
      </button>
    {/if}
  </section>
{/snippet}

<div
  bind:this={root}
  class="scroll-mt-[calc(env(safe-area-inset-top)+4.5rem)] {desktop
    ? 'grid grid-cols-[260px_minmax(0,1fr)] items-start gap-6'
    : 'flex flex-col'}"
>
  {#if desktop}
    <aside aria-label="Filtry taboru" class="flex flex-col gap-3">
      {#each facets as f (f.id)}
        <section class="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-3.5">
          <h2 class="text-[13px] font-semibold text-text">{f.title}</h2>
          {#if f.id === "year"}
            {@render histogram(f)}
          {:else}
            {@const few = f.id === "company" && !allCompanies}
            {#each f.options as o, i (o.key)}
              {#if !few || i < COMPANIES || f.value === o.key}
                {@render option(o.label, o.n, f.value === o.key, () => toggle(f, o.key))}
              {/if}
            {/each}
            {#if f.id === "company" && f.options.length > COMPANIES}
              <button type="button" aria-expanded={allCompanies} onclick={() => (allCompanies = !allCompanies)} class="self-start {LINK}">
                {allCompanies ? "Pokaż mniej" : `Pokaż wszystkich (${f.options.length})`}
              </button>
            {/if}
          {/if}
        </section>
      {/each}
      <section class="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-3.5">
        <label for="{uid}-line" class="text-[13px] font-semibold text-text">Linia dziś</label>
        <input
          id="{uid}-line"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="12"
          value={filters.line}
          oninput={(e) => onFiltersChange({ line: e.currentTarget.value.trim().toUpperCase() })}
          placeholder="np. 12, T24, M2"
          class="h-10 w-full rounded-xl border border-hairline bg-surface-2 px-3 text-[14px] text-text placeholder:text-text-faint focus:border-primary/60 focus:outline-none"
        />
        <p class="text-[12px] text-text-faint">Pojazdy na tej linii teraz albo ostatnio dziś.</p>
      </section>
    </aside>
  {/if}

  <div class="flex min-w-0 flex-col gap-3.5 {desktop ? 'gap-4' : ''}">
    <div class="group relative {desktop ? 'max-w-[560px]' : ''}">
      <label for={searchId} class="sr-only">{desktop ? "Szukaj numeru bocznego" : "Szukaj numeru bocznego lub modelu"}</label>
      <span class="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-text-faint">
        <Svg icon={SEARCH} size={16} />
      </span>
      <input
        id={searchId}
        type="search"
        inputmode="search"
        enterkeyhint="search"
        autocomplete="off"
        spellcheck="false"
        maxlength="40"
        bind:value={q}
        onkeydown={(e) => {
          if (e.key === "Enter" && found.hits[0]) pickHit(found.hits[0]);
        }}
        placeholder={desktop ? "Numer boczny, np. 4293 albo 95" : "Numer boczny lub model"}
        class="h-11 w-full rounded-xl border border-hairline bg-surface pl-10 pr-11 text-[14px] text-text placeholder:text-text-faint focus:border-primary/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {#if q}
        <button
          type="button"
          onclick={() => (q = "")}
          aria-label="Wyczyść wyszukiwanie"
          class="absolute inset-y-0 right-1 my-auto grid h-9 w-9 place-items-center rounded-lg text-text-mute hover:bg-tint/8 hover:text-text"
        >
          <Svg icon={CLOSE} size={14} />
        </button>
      {/if}
      {#if desktop && q.trim()}
        <div
          class="absolute inset-x-0 top-full z-20 mt-1.5 hidden rounded-xl border border-tint/10 bg-surface-2 p-1.5 shadow-[var(--shadow-float)] group-focus-within:block"
        >
          {#if found.total > 0}
            <p class="px-2.5 pb-1.5 pt-1 text-[12px] text-text-faint">
              {fmtInt(found.total)}
              {pluralPl(found.total, "pojazd", "pojazdy", "pojazdów")} z numerem zawierającym {q.trim()}, najpierw dokładne
            </p>
            {#each found.hits as v (v.sideNumber)}
              {@const s = vehicleState(v)}
              <!-- mousedown would move the focus off the input and fold the list before the click lands (Safari) -->
              <button
                type="button"
                onmousedown={(e) => e.preventDefault()}
                onclick={() => pickHit(v)}
                class="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left hover:bg-tint/8"
              >
                <span class="w-14 shrink-0 text-[14px] font-semibold tabular-nums text-text">#{labelOf(v)}</span>
                <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-mute">{[v.company, v.model].filter(Boolean).join(" · ")}</span>
                <span class="shrink-0 text-[12.5px] {s === 'active' ? 'text-good' : 'text-text-faint'}">
                  {s === "active" ? `W trasie, linia ${v.lineName ?? "?"}` : s === "waiting" ? "Czeka na odjazd" : "W zajezdni"}
                </span>
              </button>
            {/each}
          {:else}
            <p class="px-2.5 py-2 text-[13px] text-text-mute">Brak pojazdu z numerem {q.trim()}</p>
          {/if}
        </div>
      {/if}
    </div>

    <div role="group" aria-label="Stan pojazdu" class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
      {#each STATUSES as s (s.key)}
        {@const on = filters.status === s.key}
        <button
          type="button"
          aria-pressed={on}
          onclick={() => onFiltersChange({ status: on ? "all" : s.key })}
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors {desktop
            ? 'min-h-9'
            : 'min-h-11'} {on ? 'border-primary/50 bg-primary-dim text-text' : 'border-hairline bg-surface text-text-mute hover:text-text'}"
        >
          {s.label}
          <span class="tabular-nums {s.key === 'late' && counts.late > 0 ? 'text-late' : on ? 'text-text' : 'text-text-faint'}">
            {fmtInt(counts[s.key])}
          </span>
        </button>
      {/each}
    </div>

    {#if desktop}
      {#if activeChips.length > 0}
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[12.5px] text-text-mute">Filtry:</span>
            {#each activeChips as c (c.text)}
              <button
                type="button"
                onclick={() => onFiltersChange(c.clear)}
                aria-label="Usuń filtr {c.text}"
                class="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-surface-3 pl-3 pr-2 text-[12.5px] text-text hover:bg-tint/12"
              >
                {c.text}<Svg icon={CLOSE} size={12} class="text-text-mute" />
              </button>
            {/each}
            <button type="button" onclick={() => onFiltersChange(DEFAULT_FILTERS)} class={LINK}>Wyczyść</button>
          </div>
          <div class="flex items-center gap-2 text-[12.5px] text-text-mute">
            <span class="shrink-0">Link do widoku</span>
            <code class="min-w-0 truncate rounded-md bg-surface-2 px-2 py-1 text-[12px] text-text">{location.host}{viewPath}</code>
            <!-- ShareLink reads its path once -->
            {#key viewPath}<ShareLink title="Tabor {brand.name}" path={viewPath} />{/key}
          </div>
        </div>
      {/if}
      {#if quiet}{@render nightNote()}{/if}
      {#if pinned.length > 0}
        {@render shelf(
          RARE_SHELF,
          "Rzadkie dziś w trasie",
          `modele, których ${rareRule} · ${fmtInt(pinned.length)} w trasie`,
          pinned,
          (v) => v.model,
        )}
      {/if}
      {#each allShelves || filters.model !== null ? shelves : shelves.slice(0, SHELVES) as { g, tiles } (g.model)}
        {@render shelf(
          g.model,
          g.model || `Bez modelu w danych ${brand.short}`,
          [
            g.years,
            units(g),
            `${fmtInt(g.active)} w trasie`,
            g.waiting > 0 ? `${fmtInt(g.waiting)} czeka` : "",
            `${fmtInt(g.depot)} w zajezdni`,
          ]
            .filter(Boolean)
            .join(" · "),
          tiles,
          (v) => v.company ?? "",
          g.late,
        )}
      {/each}
      {#if shelves.length > SHELVES && filters.model === null}
        <button type="button" aria-expanded={allShelves} onclick={() => (allShelves = !allShelves)} class="self-center {PILL}">
          {allShelves ? "Pokaż mniej modeli" : `Pokaż wszystkie modele (${shelves.length})`}
        </button>
      {/if}
      {#if pinned.length === 0 && shelves.length === 0}{@render noMatch()}{/if}

      <section class="rounded-2xl border border-hairline bg-surface">
        <div class="flex items-center justify-between gap-3 px-4 py-2.5">
          <h2 class="text-[15px] font-semibold text-text">
            Wszystkie modele
            <span class="font-normal tabular-nums text-text-faint">
              ({groups.length === allGroups.length ? groups.length : `${groups.length} z ${allGroups.length}`})
            </span>
          </h2>
          <button
            type="button"
            aria-expanded={indexOpen}
            aria-controls={indexOpen ? `${uid}-index` : undefined}
            onclick={() => (indexOpen = !indexOpen)}
            class={LINK}
          >
            {indexOpen ? "Zwiń" : "Rozwiń tabelę"}
          </button>
        </div>
        {#if indexOpen}
          <div id="{uid}-index" class="kb-scroll overflow-x-auto border-t border-hairline">
            <table class="w-full min-w-[900px] text-left text-[13px] tabular-nums">
              <thead>
                <tr class="text-[12px] text-text-mute">
                  {#each ["Model", "Napęd", "Długość", "Rocznik", "Szt.", "W trasie", "Czeka", "W zajezdni", "Spóźnione"] as h, i (h)}
                    <th scope="col" class="px-4 py-2 font-medium {i > 3 ? 'text-right' : ''}">{h}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each groups as g (g.model)}
                  <tr class="border-t border-hairline text-text-mute">
                    <th scope="row" class="px-4 py-1 font-medium">
                      <button type="button" onclick={() => pickModel(g.model)} class="min-h-9 text-left text-primary hover:underline">
                        {g.model || "nieustalony"}
                      </button>
                    </th>
                    <td class="px-4">{tagOf(g.fuel, FUEL_LABEL)}</td>
                    <td class="px-4">{tagOf(g.length, LENGTH_LABEL)}</td>
                    <td class="px-4">{g.years || NO_DATA}</td>
                    <td class="px-4 text-right text-text">{units(g)}</td>
                    <td class="px-4 text-right">{fmtInt(g.active)}</td>
                    <td class="px-4 text-right">{fmtInt(g.waiting)}</td>
                    <td class="px-4 text-right">{fmtInt(g.depot)}</td>
                    <td class="px-4 text-right {g.late > 0 ? 'text-late' : ''}">{fmtInt(g.late)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {:else}
      {#if view !== "search" && (facets.length > 0 || hasActiveFilters(filters))}
        <div class="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
          {#each facets as f (f.id)}
            <button
              type="button"
              aria-haspopup="dialog"
              onclick={() => (sheet = f.id)}
              class="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border pl-3.5 pr-3 text-[13px] font-medium transition-colors {f.value !==
              null
                ? 'border-primary/50 bg-primary-dim text-text'
                : 'border-hairline bg-surface-2 text-text-mute'}"
            >
              {f.value === null ? f.title : `${f.title}: ${f.label(f.value)}`}
              <Svg icon={CHEVRON_DOWN} size={14} />
            </button>
          {/each}
          {#if filters.line}
            <button
              type="button"
              onclick={() => onFiltersChange({ line: "" })}
              aria-label="Usuń filtr Linia: {filters.line}"
              class="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-primary/50 bg-primary-dim pl-3.5 pr-3 text-[13px] font-medium text-text"
            >
              Linia {filters.line}<Svg icon={CLOSE} size={12} />
            </button>
          {/if}
          {#if hasActiveFilters(filters)}
            <button type="button" onclick={() => onFiltersChange(DEFAULT_FILTERS)} class="min-h-11 shrink-0 px-2 text-[13px] font-medium text-primary">
              Wyczyść
            </button>
          {/if}
        </div>
      {/if}

      {#if view === "search"}
        {#if found.total === 0 && modelHits.length === 0}
          <p class="py-6 text-center text-[13px] text-text-mute">Nic nie pasuje do: {q.trim()}</p>
        {/if}
        {#if found.total > 0}
          {@render heading("Pojazdy", found.total, found.total > found.hits.length ? `pierwsze ${found.hits.length}` : "")}
          <div class={LIST}>
            {#each found.hits as v (v.sideNumber)}{@render row(v, found.hits)}{/each}
          </div>
        {/if}
        {#if modelHits.length > 0}
          {@render heading("Modele", modelHits.length)}
          <div class={LIST}>
            {#each modelHits as g (g.model)}{@render modelRow(g)}{/each}
          </div>
        {/if}
      {:else if view === "model"}
        {@const g = groups[0]}
        {@const out = list.filter((v) => vehicleState(v) !== "depot")}
        {@const inDepot = list.filter((v) => vehicleState(v) === "depot")}
        <button type="button" onclick={() => pickModel(null)} class="-ml-1 inline-flex min-h-11 items-center gap-0.5 self-start text-[14px] font-medium text-primary">
          <Svg icon={CHEVRON_LEFT} size={18} />Modele
        </button>
        {#if g}
          {@const back = g.vehicles.filter((v) => vehicleState(v) === "depot" && droveToday(v)).length}
          <div class="flex flex-col gap-2">
            <h2 class="text-[20px] font-bold leading-tight text-text">{g.model || "Model nieustalony"}</h2>
            <p class="text-[13px] text-text-mute">
              {[g.years ? `rocznik ${g.years}` : "", units(g), g.waiting > 0 ? `${fmtInt(g.waiting)} czeka na odjazd` : ""].filter(Boolean).join(" · ")}
            </p>
            <p class="flex flex-wrap gap-1.5">
              {#each [tagOf(g.fuel, FUEL_LABEL), tagOf(g.length, LENGTH_LABEL)] as tag, i (i)}
                <span class="rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-text-mute">{tag}</span>
              {/each}
            </p>
          </div>
          <dl class="grid grid-cols-3 gap-2">
            {#each [["W trasie", g.active], ["Wróciły dziś", back], ["Nie wyjechały", g.depot - back]] as [label, n] (label)}
              <div class="rounded-xl border border-hairline bg-surface px-3 py-2">
                <dt class="truncate text-[12px] text-text-mute">{label}</dt>
                <dd class="text-[17px] font-semibold tabular-nums text-text">{n}</dd>
              </div>
            {/each}
          </dl>
        {/if}
        {#if list.length === 0}
          {@render noMatch()}
        {/if}
        {#if out.length > 0}
          {@render heading("W trasie", out.length)}
          <div class={GRID}>
            {#each out.slice(0, limit) as v (v.sideNumber)}{@render tile(v, out, String(v.built ?? v.year ?? ""))}{/each}
          </div>
          {@render more(out.length)}
        {/if}
        {#if inDepot.length > 0}
          <button
            type="button"
            aria-expanded={depotOpen}
            onclick={() => (depotOpen = !depotOpen)}
            class="flex min-h-[52px] w-full items-center justify-between rounded-[14px] border border-hairline bg-surface px-3.5 text-left"
          >
            <span class="text-[14px] font-semibold text-text">W zajezdni ({inDepot.length})</span>
            <span class="text-[13px] font-medium text-primary">{depotOpen ? "Zwiń" : "Rozwiń"}</span>
          </button>
          {#if depotOpen}
            <div class={GRID}>
              {#each inDepot.slice(0, limit) as v (v.sideNumber)}{@render tile(v, inDepot, String(v.built ?? v.year ?? ""))}{/each}
            </div>
            {@render more(inDepot.length)}
          {/if}
        {/if}
      {:else if view === "all"}
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-[15px] font-semibold text-text">
            W trasie teraz <span class="font-normal tabular-nums text-text-faint">{fmtInt(counts.active)}</span>
          </h2>
          {#if counts.active > 0}
            <button type="button" onclick={() => onFiltersChange({ status: "active" })} class="min-h-11 px-1 text-[13px] font-medium text-primary">
              Wszystkie
            </button>
          {/if}
        </div>
        {#if running.length > 0}
          <div class={STRIP_ROW}>
            {#each running.slice(0, STRIP) as v (v.sideNumber)}{@render tile(v, running, "", "w-32 shrink-0")}{/each}
          </div>
          {#if pinned.length > 0}
            {@render heading("Rzadkie dziś w trasie", pinned.length, `${RARE_MAX} szt. lub mniej`)}
            <div class={STRIP_ROW}>
              {#each pinned.slice(0, STRIP) as v (v.sideNumber)}{@render tile(v, pinned, v.model, "w-44 shrink-0")}{/each}
            </div>
          {:else}
            <div class="flex flex-col gap-0.5 rounded-xl border border-hairline bg-surface px-3 py-2.5">
              <p class="text-[13.5px] font-semibold text-text">Rzadkie dziś w trasie: brak</p>
              <p class="text-[12.5px] text-text-mute">
                Żaden model, którego {rareRule}, nie jest w trasie.{rarest
                  ? ` Najrzadszy w trasie: ${rarest.model} (${fmtInt(sizeOf.get(rarest.model) ?? 0)} szt.).`
                  : ""}
              </p>
            </div>
          {/if}
        {:else if quiet}
          {@render nightNote()}
        {:else}
          <p class="text-[13px] text-text-mute">Przy tych filtrach żaden pojazd nie jedzie.</p>
        {/if}
        {@render heading("Modele", groups.length, "od najliczniejszych")}
        {#if groups.length > 0}
          <div class={LIST}>
            {#each groups as g (g.model)}{@render modelRow(g)}{/each}
          </div>
        {:else}
          {@render noMatch()}
        {/if}
      {:else if view === "active" || view === "rare"}
        {@render heading(view === "rare" ? "Rzadkie w trasie" : "W trasie", list.length, "według linii")}
        {#if list.length > 0}
          <div class={GRID}>
            {#each list.slice(0, limit) as v (v.sideNumber)}{@render tile(v, list, v.model)}{/each}
          </div>
          {@render more(list.length)}
        {:else if view === "rare"}
          {@render empty("Rzadkie dziś w trasie: brak", `Żaden model, którego ${rareRule}, nie jest teraz w trasie.`, clearAction)}
        {:else}
          {@render empty("Nic nie jest teraz w trasie", facetsOn ? "Przy tych filtrach żaden pojazd nie jedzie." : "", clearAction)}
        {/if}
      {:else if view === "late"}
        {#if list.length > 0}
          {@render heading("Spóźnione", list.length, "od największego opóźnienia")}
          <div class={LIST}>
            {#each list.slice(0, limit) as v (v.sideNumber)}{@render row(v, list)}{/each}
          </div>
          {@render more(list.length)}
        {:else}
          <div class="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-3.5">
            <p class="text-[15px] font-medium text-text">Teraz nic nie jest spóźnione</p>
            <p class="text-[13px] text-text-mute">Spóźnione to ponad +3 min. W trasie {fmtInt(counts.active)}.</p>
            {#if worst}
              <p class="mt-1 text-[12.5px] text-text-faint">Najbardziej opóźniony w trasie:</p>
              <div class="{LIST} bg-surface-2">{@render row(worst, [worst])}</div>
            {/if}
          </div>
        {/if}
      {:else if view === "waiting"}
        {#if list.length > 0}
          {@render heading("Czeka na odjazd", list.length, "najbliższy odjazd na górze")}
          <div class={LIST}>
            {#each list.slice(0, limit) as v (v.sideNumber)}{@render row(v, list)}{/each}
          </div>
          {@render more(list.length)}
        {:else}
          {#snippet showRunning()}
            {#if counts.active > 0}
              <button type="button" onclick={() => onFiltersChange({ status: "active" })} class="mt-4 {PILL}">
                Pokaż w trasie ({fmtInt(counts.active)})
              </button>
            {/if}
          {/snippet}
          {@render empty(
            "Żaden pojazd nie czeka teraz na odjazd",
            "Tu pojawią się pojazdy stojące na pętli przed kursem, z godziną odjazdu.",
            showRunning,
          )}
        {/if}
      {:else}
        {@const back = list.filter(droveToday)}
        {@const never = list.filter((v) => !droveToday(v)).sort(bySide)}
        {#if list.length === 0}
          {@render noMatch()}
        {:else}
          {@render heading("Wróciły dziś", back.length, back.length > 0 ? "ostatnie na górze" : "")}
          {#if back.length > 0}
            <div class={LIST}>
              {#each back.slice(0, limit) as v (v.sideNumber)}{@render row(v, back)}{/each}
            </div>
            {@render more(back.length)}
          {/if}
          {#if never.length > 0}
            <button
              type="button"
              aria-expanded={neverOpen}
              onclick={() => (neverOpen = !neverOpen)}
              class="flex min-h-[52px] w-full items-center justify-between rounded-[14px] border border-hairline bg-surface px-3.5 text-left"
            >
              <span class="text-[14px] font-semibold text-text">Dziś nie wyjechały ({never.length})</span>
              <span class="text-[13px] font-medium text-primary">{neverOpen ? "Zwiń" : "Rozwiń"}</span>
            </button>
            {#if neverOpen}
              <div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {#each never as v (v.sideNumber)}
                  <button
                    type="button"
                    onclick={() => open(v, never)}
                    class="min-h-11 rounded-[10px] border border-hairline bg-surface text-[14px] font-medium tabular-nums text-text hover:bg-surface-2"
                  >
                    #{labelOf(v)}
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        {/if}
      {/if}
    {/if}
  </div>
</div>

{#if sheetFacet && !desktop}
  {@const f = sheetFacet}
  <dialog
    bind:this={dialog}
    aria-labelledby="{uid}-sheet"
    onclose={() => (sheet = null)}
    onclick={(e) => {
      if (e.target === dialog) dialog.close();
    }}
    class="mx-auto mb-0 mt-auto w-full max-w-[560px] rounded-t-2xl border-t border-tint/10 bg-surface-2 p-0 text-text shadow-[var(--shadow-float)] backdrop:bg-black/65 motion-safe:animate-rise"
  >
    <div class="flex max-h-[85dvh] flex-col gap-3 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
      <span aria-hidden="true" class="mx-auto h-1 w-9 shrink-0 rounded-full bg-tint/20"></span>
      <div class="flex items-center justify-between gap-3">
        <h2 id="{uid}-sheet" class="text-[17px] font-semibold text-text">{f.title}</h2>
        <button
          type="button"
          aria-label="Zamknij"
          onclick={() => dialog?.close()}
          class="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface-3 text-text-mute hover:text-text"
        >
          <Svg icon={CLOSE} size={16} />
        </button>
      </div>
      <div class="kb-scroll flex min-h-0 flex-col gap-2 overflow-y-auto">
        {@render option("Wszystkie", null, f.value === null, () => pickOption(f, null), true)}
        {#each f.options as o (o.key)}
          {@render option(o.label, o.n, f.value === o.key, () => pickOption(f, f.value === o.key ? null : o.key), true)}
        {/each}
      </div>
    </div>
  </dialog>
{/if}
