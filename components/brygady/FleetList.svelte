<script module lang="ts">
  import type { FleetCity, FleetSummaryItem } from "@/lib/client/fleet";
  import { compareLineNames, matchesFleetQuery } from "@/lib/shared/fleet";

  import { hasActiveFilters, type FleetFilters, type FleetSort, type StatusFilter } from "./fleetFilters";

  function vehicleState(v: FleetSummaryItem): Exclude<StatusFilter, "all"> {
    if (v.status !== "active") return "depot";
    return v.notStarted ? "waiting" : "active";
  }

  const STATE_RANK = { active: 0, waiting: 1, depot: 2 } as const;

  const bySide = (a: FleetSummaryItem, b: FleetSummaryItem) => a.sideNumber.localeCompare(b.sideNumber, "pl", { numeric: true });

  /** A running vehicle matches its current line; one off duty matches the lines it served today. */
  function matchesLine(v: FleetSummaryItem, line: string): boolean {
    if (!line) return true;
    if (v.status === "active") return v.lineName === line;
    return v.lines.includes(line);
  }

  function sortVehicles(list: FleetSummaryItem[], sort: FleetSort): FleetSummaryItem[] {
    const out = [...list];
    switch (sort) {
      case "side":
        return out.sort(bySide);
      case "km":
        return out.sort((a, b) => b.kmToday - a.kmToday || bySide(a, b));
      case "delay":
        // the most delayed first; vehicles without a measured delay at the end
        return out.sort((a, b) => (b.delaySec ?? -Infinity) - (a.delaySec ?? -Infinity) || bySide(a, b));
      default:
        return out.sort(
          (a, b) =>
            STATE_RANK[vehicleState(a)] - STATE_RANK[vehicleState(b)] ||
            compareLineNames(a.lineName ?? a.lastLineName ?? "~", b.lineName ?? b.lastLineName ?? "~") ||
            bySide(a, b),
        );
    }
  }

  const STATUS_CHIPS: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "Wszystkie" },
    { key: "active", label: "W trasie" },
    { key: "waiting", label: "Czeka na odjazd" },
    { key: "depot", label: "Nie kursuje" },
  ];

  /** ponytail: GZM lists ~1 400 vehicles; 200 cards per step keep the DOM small. Upgrade: a virtual list. */
  const PAGE_ROWS = 200;

  const SORT_LABEL: Record<FleetSort, string> = {
    line: "Linia",
    side: "Numer boczny",
    delay: "Opóźnienie",
    km: "Km dziś",
  };
</script>

<script lang="ts">
  import LineBadge from "@/components/ui/LineBadge.svelte";

  import { clockFromEpoch, FLEET_CITY, FUEL_LABEL, FUEL_LABEL_PLURAL, fmtInt, fmtKm, pluralPl, SERIES_FILL } from "./common";
  import DelayBadge from "./DelayBadge.svelte";
  import { fuelIcon, SEARCH } from "./icons";
  import Svg from "./Svg.svelte";

  let {
    vehicles,
    filters,
    onFiltersChange,
    onOpen,
    nowEpoch,
    city = "bb",
  }: {
    vehicles: FleetSummaryItem[];
    filters: FleetFilters;
    onFiltersChange: (patch: Partial<FleetFilters>) => void;
    onOpen: (side: string) => void;
    nowEpoch: number;
    city?: FleetCity;
  } = $props();

  const uid = $props.id();
  const searchId = `${uid}-q`;
  const q = $derived(filters.q);
  const brand = $derived(FLEET_CITY[city]);
  // "Pokaż więcej" counts for the filters it was pressed under; any filter change starts over
  const filterKey = $derived(`${q}\n${filters.status}\n${filters.fuel}\n${filters.line}\n${filters.sort}`);
  let more = $state({ key: "", rows: PAGE_ROWS });
  const limit = $derived(more.key === filterKey ? more.rows : PAGE_ROWS);

  const lineOptions = $derived.by(() => {
    const set = new Set<string>();
    for (const v of vehicles) {
      if (v.lineName) set.add(v.lineName);
      for (const l of v.lines) set.add(l);
    }
    return [...set].sort(compareLineNames);
  });

  const fuelOptions = $derived.by(() => {
    const set = new Set(vehicles.map((v) => v.fuelType));
    return (["diesel", "hybrid", "electric", "hydrogen"] as const).filter((f) => set.has(f));
  });

  // filters other than the status chip, so each chip can show its own count
  const base = $derived(
    vehicles.filter((v) => (filters.fuel === "all" || v.fuelType === filters.fuel) && matchesLine(v, filters.line) && matchesFleetQuery(v, q)),
  );

  const counts = $derived.by(() => {
    const c = { all: base.length, active: 0, waiting: 0, depot: 0 };
    for (const v of base) c[vehicleState(v)]++;
    return c;
  });

  const shown = $derived(sortVehicles(filters.status === "all" ? base : base.filter((v) => vehicleState(v) === filters.status), filters.sort));

  const runningNow = $derived(vehicles.filter((v) => v.status === "active").length);
  const filtered = $derived(hasActiveFilters(filters));
</script>

{#snippet select(key: string, label: string, value: string, onChange: (v: string) => void, options: [string, string][])}
  {@const id = `${uid}-${key}`}
  <div class="min-w-0">
    <label for={id} class="mb-1 block text-[11.5px] font-medium text-text-faint">
      {label}
    </label>
    <div class="relative">
      <select
        {id}
        {value}
        onchange={(e) => onChange(e.currentTarget.value)}
        class="h-10 w-full appearance-none truncate rounded-lg border border-hairline bg-surface pl-3 pr-8 text-[13px] text-text focus:border-primary/60 focus:outline-none"
      >
        {#each options as [v, l] (v)}
          <option value={v}>
            {l}
          </option>
        {/each}
      </select>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 right-2.5 my-auto text-text-faint"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  </div>
{/snippet}

{#snippet statusPill(v: FleetSummaryItem)}
  {@const s = vehicleState(v)}
  {#if s === "active"}
    <span class="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-good">
      <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-good"></span>W trasie
    </span>
  {:else if s === "waiting"}
    <span class="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-text-mute">
      <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full border border-text-mute"></span>
      Czeka
    </span>
  {:else}
    <span class="shrink-0 text-[12px] font-medium text-text-faint">Nie kursuje</span>
  {/if}
{/snippet}

<!-- GZM: the trip's brigade next to the line badge ("69" + "bryg. 1" reads as 69/1). -->
{#snippet brigade(v: FleetSummaryItem)}
  {#if v.brigade}
    <span title="Brygada {v.lineName}/{v.brigade}" class="shrink-0 text-[12px] text-text-mute tabular-nums">
      bryg. {v.brigade}
    </span>
  {/if}
{/snippet}

{#snippet vehicleCard(v: FleetSummaryItem, operator: "MZK" | "GZM")}
  {@const s = vehicleState(v)}
  {@const courses = v.coursesCountToday}
  {@const lastSeenToday = v.lastSeenAt > 0 && nowEpoch - v.lastSeenAt < 86400}
  <!-- "0,0 km, 0 kursów" under "Dziś nie wyjechał na trasę" only repeats it -->
  {@const drove = courses > 0 || v.kmToday > 0}
  {@const fuel = v.fuelType !== null && v.fuelType !== "diesel" ? v.fuelType : null}
  {@const hasTags = fuel !== null || v.lengthCategory === "MEGA"}
  <button
    type="button"
    onclick={() => onOpen(v.sideNumber)}
    class="flex h-full w-full flex-col gap-2.5 rounded-2xl border p-3.5 text-left transition-[background-color,border-color] {s === 'depot'
      ? 'border-hairline bg-surface/60 hover:bg-surface'
      : 'border-hairline bg-surface hover:border-tint/15 hover:bg-surface-2'}"
  >
    <span class="flex items-start justify-between gap-3">
      <span class="min-w-0">
        <span class="block text-[15px] font-semibold text-text tabular-nums">#{v.label ?? v.sideNumber}</span>
        <span class="block truncate text-[12.5px] text-text-mute"
          >{v.company ? `${v.company}${v.model ? `, ${v.model}` : ""}` : v.model}{#if v.year}<span class="text-text-faint">{` (${v.year})`}</span>{/if}</span
        >
      </span>
      {@render statusPill(v)}
    </span>

    {#if s === "active" && v.lineName}
      <span class="flex min-w-0 items-center gap-2">
        <LineBadge line={v.lineName} {operator} />
        {@render brigade(v)}
        <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">{v.direction}</span>
        {#if v.delaySec !== undefined}<DelayBadge sec={v.delaySec} />{/if}
      </span>
      <span class="block truncate text-[12.5px] text-text-mute">
        {v.atStop && v.currentStopName
          ? `Na przystanku ${v.currentStopName}`
          : v.nextStopName
            ? `Następny: ${v.nextStopName}`
            : v.currentStopName
              ? `Przy ${v.currentStopName}`
              : "Pozycja nieznana"}
      </span>
      <span aria-hidden="true" class="block h-1 overflow-hidden rounded-full bg-surface-3">
        <span class="block h-full rounded-full" style:width="{Math.min(100, Math.max(0, v.progressPct ?? 0))}%" style:background={SERIES_FILL}
        ></span>
      </span>
    {:else if s === "waiting" && v.lineName}
      <span class="flex min-w-0 items-center gap-2">
        <LineBadge line={v.lineName} {operator} />
        {@render brigade(v)}
        <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">{v.direction}</span>
      </span>
      <span class="block truncate text-[12.5px] text-text-mute"
        >{v.startTime ? `Odjazd o ${v.startTime}` : "Czeka na odjazd"}{v.firstStopName ? ` z ${v.firstStopName}` : ""}</span
      >
    {:else}
      <span class="block truncate text-[12.5px] text-text-mute">
        {lastSeenToday
          ? `Ostatnio w trasie o ${clockFromEpoch(v.lastSeenAt)}${v.lastLineName ? `, linia ${v.lastLineName}` : ""}`
          : "Dziś nie wyjechał na trasę"}
      </span>
    {/if}

    {#if drove || hasTags}
      <span class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline pt-2.5 text-[12px] text-text-mute">
        {#if fuel}
          {@const glyph = fuelIcon(fuel)}
          <span class="inline-flex items-center gap-1 text-text">
            {#if glyph}<Svg icon={glyph} size={13} />{/if}
            {FUEL_LABEL[fuel]}
          </span>
        {/if}
        {#if v.lengthCategory === "MEGA"}<span>Przegubowy</span>{/if}
        {#if drove}
          <span class="tabular-nums">{fmtKm(v.kmToday)}</span>
          <span class="tabular-nums"
            >{courses} {pluralPl(courses, "kurs", "kursy", "kursów")}{#if v.cancelledCoursesToday > 0}<span class="text-danger"
                >, {v.cancelledCoursesToday} {pluralPl(v.cancelledCoursesToday, "przerwany", "przerwane", "przerwanych")}</span
              >{/if}</span
          >
        {/if}
      </span>
    {/if}
  </button>
{/snippet}

<div>
  <div class="space-y-3">
    <div class="relative">
      <label for={searchId} class="sr-only">
        Szukaj pojazdu
      </label>
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
        value={filters.q}
        oninput={(e) => onFiltersChange({ q: e.currentTarget.value })}
        placeholder={city === "gzm" ? "Numer taborowy, linia, brygada, kierunek" : "Numer boczny, linia, model, kierunek"}
        class="h-11 w-full rounded-xl border border-hairline bg-surface pl-10 pr-11 text-[14px] text-text placeholder:text-text-faint focus:border-primary/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {#if filters.q}
        <button
          type="button"
          onclick={() => onFiltersChange({ q: "" })}
          aria-label="Wyczyść wyszukiwanie"
          class="absolute inset-y-0 right-1 my-auto grid h-9 w-9 place-items-center rounded-lg text-text-mute hover:bg-tint/8 hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>

    <div role="group" aria-label="Stan pojazdu" class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0">
      {#each STATUS_CHIPS as c (c.key)}
        {@const on = filters.status === c.key}
        <button
          type="button"
          aria-pressed={on}
          onclick={() => onFiltersChange({ status: c.key })}
          class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors {on
            ? 'border-primary/50 bg-primary-dim text-text'
            : 'border-hairline bg-surface text-text-mute hover:text-text'}"
        >
          {c.label}
          <span class="tabular-nums {on ? 'text-text' : 'text-text-faint'}">{counts[c.key]}</span>
        </button>
      {/each}
    </div>

    <!-- GZM publishes no propulsion data: no "Napęd" filter without a single known value -->
    <div class="grid gap-2 {fuelOptions.length > 0 ? 'grid-cols-3' : 'grid-cols-2'}">
      {#if fuelOptions.length > 0}
        {@render select(
          "fuel",
          "Napęd",
          filters.fuel,
          (v) => onFiltersChange({ fuel: v as FleetFilters["fuel"] }),
          [["all", "Wszystkie"], ...fuelOptions.map((f) => [f, FUEL_LABEL_PLURAL[f]] as [string, string])],
        )}
      {/if}
      {@render select("line", "Linia", filters.line, (v) => onFiltersChange({ line: v }), [
        ["", "Wszystkie"],
        ...(filters.line && !lineOptions.includes(filters.line) ? [filters.line, ...lineOptions] : lineOptions).map(
          (l) => [l, `Linia ${l}`] as [string, string],
        ),
      ])}
      {@render select(
        "sort",
        "Sortuj",
        filters.sort,
        (v) => onFiltersChange({ sort: v as FleetSort }),
        (Object.keys(SORT_LABEL) as FleetSort[]).map((k) => [k, SORT_LABEL[k]]),
      )}
    </div>

    <div class="flex min-h-8 items-center justify-between gap-3 text-[12.5px] text-text-mute">
      <p aria-live="polite" class="tabular-nums">
        {filtered ? `Pokazano ${fmtInt(shown.length)} z ${fmtInt(vehicles.length)}` : `${fmtInt(vehicles.length)} pojazdów ${brand.short}`}
      </p>
      {#if filtered}
        <button
          type="button"
          onclick={() => onFiltersChange({ q: "", status: "all", fuel: "all", line: "" })}
          class="min-h-8 rounded-lg px-2 font-medium text-primary hover:bg-primary-dim"
        >
          Wyczyść filtry
        </button>
      {/if}
    </div>
  </div>

  {#if runningNow === 0 && !filtered}
    <p class="mb-3 rounded-xl border border-hairline bg-surface px-4 py-3 text-[13px] text-text-mute">
      Żaden {brand.veh} {brand.short} nie jest teraz w trasie, nocą to normalne. Karta pojazdu pokazuje jego dzisiejsze kursy.
    </p>
  {/if}

  {#if shown.length > 0}
    <ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Pojazdy">
      {#each shown.slice(0, limit) as v (v.sideNumber)}
        <li>
          {@render vehicleCard(v, brand.operator)}
        </li>
      {/each}
    </ul>
    {#if shown.length > limit}
      <div class="mt-4 text-center">
        <button
          type="button"
          onclick={() => (more = { key: filterKey, rows: limit + PAGE_ROWS })}
          class="min-h-10 rounded-full bg-surface-3 px-5 text-[13px] font-semibold text-text hover:bg-tint/12"
          >Pokaż więcej<span class="ml-1.5 font-normal text-text-mute tabular-nums">
            ({fmtInt(limit)} z {fmtInt(shown.length)})
          </span></button
        >
      </div>
    {/if}
  {:else}
    <div class="rounded-2xl border border-hairline bg-surface px-4 py-12 text-center">
      <p class="text-[14px] font-medium text-text">Brak pojazdów dla tych filtrów</p>
      <p class="mt-1 text-[13px] text-text-mute">
        {filters.q.trim() ? `Nic nie pasuje do „${filters.q.trim()}”.` : "Zmień stan, napęd albo linię."}
      </p>
      <button
        type="button"
        onclick={() => onFiltersChange({ q: "", status: "all", fuel: "all", line: "" })}
        class="mt-4 min-h-10 rounded-full bg-surface-3 px-4 text-[13px] font-semibold text-text hover:bg-tint/12"
      >
        Wyczyść filtry
      </button>
    </div>
  {/if}
</div>
