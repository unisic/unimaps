<script module lang="ts">
  import type { FleetCity } from "@/lib/client/fleet";

  /*
   * /brygady: the MZK Bielsko-Biała fleet (or Metropolia GZM with `?city=gzm` or a saved
   * `kb:city`; the header's switch links `?city=bb` / `?city=gzm`), live. View state lives in the URL
   * (`?tabor=<side>` opens a vehicle, `?widok=statystyki` the charts, the gallery's filters as
   * `status=`, `naped=`, ...: fleetFilters.ts) and is written with
   * the plain History API; `search` mirrors location.search after each write and on popstate.
   * Opening a vehicle pushes an entry (Android back closes the sheet); a deep-linked sheet
   * closes with replaceState instead, so "close" never navigates away from the page.
   */

  type Tab = "pojazdy" | "statystyki";

  const TABS: { key: Tab; label: string }[] = [
    { key: "pojazdy", label: "Pojazdy" },
    { key: "statystyki", label: "Statystyki" },
  ];

  /** Data older than this is called out in the header (the poller writes every ~5 s). */
  const STALE_AFTER_SEC = 90;
  /** the KPI tiles (and their skeleton): a grid from sm up */
  const KPI_GRID = "gap-3 sm:grid sm:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]";
  /** on a phone: one swipeable row bleeding to the screen edges */
  const KPI_SWIPE = "-mx-4 flex snap-x scroll-px-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0";
  const KPI_TILE = "w-40 shrink-0 snap-start rounded-2xl border px-3.5 py-3 text-left sm:w-auto";

  const CITIES: { key: FleetCity; short: string; name: string }[] = [
    { key: "bb", short: "BB", name: "Bielsko-Biała" },
    { key: "gzm", short: "GZM", name: "Metropolia GZM" },
  ];

  /** "niedziela, 8 listopada" */
  const DAY_FMT = new Intl.DateTimeFormat("pl-PL", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Warsaw" });

  function cleanSide(raw: string | null): string | null {
    const s = raw?.replace(/^#/, "").trim();
    return s && s.length <= 16 ? s : null;
  }

  function urlWith(mutate: (p: URLSearchParams) => void): string {
    const u = new URL(window.location.href);
    mutate(u.searchParams);
    return `${u.pathname}${u.search}${u.hash}`;
  }

  function sheetEntry(): boolean {
    return Boolean((window.history.state as { kbTabor?: boolean } | null)?.kbTabor);
  }
</script>

<script lang="ts">
  import { onMount, type Snippet } from "svelte";

  import Icon from "@/components/Icon.svelte";
  import { CaretLeftIcon, HeartIcon } from "@/components/icon-paths";
  import { localUpdatedAt, readBrygadyCity, type FleetStats } from "@/lib/client/fleet";
  import { useFleet } from "@/lib/client/fleet.svelte";
  import { VERY_LATE_SEC, type FleetSummaryItem } from "@/lib/shared/fleet";

  import { delayClass } from "@/lib/client/format";
  import { clockFromEpoch, FLEET_CITY, fleetOf, fmtDelayMin, fmtInt, fmtKm, pluralPl } from "./brygady/common";
  import { DEFAULT_FILTERS, filtersFromParams, filtersToParams, type FleetFilters, type StatusFilter } from "./brygady/fleetFilters";
  import FleetList from "./brygady/FleetList.svelte";
  import FleetStatsView from "./brygady/FleetStatsView.svelte";
  import { isLate } from "./brygady/gallery";
  import { useEpochNow } from "./brygady/hooks.svelte";
  import { ALERT, ARROW_UP } from "./brygady/icons";
  import Svg from "./brygady/Svg.svelte";
  import VehicleSheet from "./brygady/VehicleSheet.svelte";

  /* the page is client-rendered: the city (URL, else localStorage) is known before the first frame */
  const city = readBrygadyCity(location.search);

  let search = $state(location.search);
  const params = $derived(new URLSearchParams(search));
  const side = $derived(cleanSide(params.get("tabor")));
  const tab: Tab = $derived(params.get("widok") === "statystyki" ? "statystyki" : "pojazdy");
  const fleet = useFleet(() => side !== null, city);
  let filters = $state.raw<FleetFilters>(filtersFromParams(new URLSearchParams(location.search)));
  const clockNow = useEpochNow(1000);
  const brand = FLEET_CITY[city];
  let tabsEl: HTMLDivElement | undefined = $state();
  const inert = $derived(side !== null);

  const syncSearch = () => (search = window.location.search);

  function setFilters(next: FleetFilters) {
    filters = next;
    // a filter is no history step; the entry's state stays (an open vehicle's kbTabor)
    window.history.replaceState(
      window.history.state,
      "",
      urlWith((p) => filtersToParams(next, p)),
    );
    syncSearch();
  }

  const patchFilters = (patch: Partial<FleetFilters>) => setFilters({ ...filters, ...patch });

  /** the list the card was opened from, for its prev/next buttons (a deep link or a chart opens without one) */
  let order = $state.raw<readonly string[]>([]);
  const at = $derived(side ? order.indexOf(side) : -1);

  function openVehicle(s: string, from: readonly string[] = []) {
    if (!sheetEntry()) order = from;
    const url = urlWith((p) => p.set("tabor", s));
    if (sheetEntry()) window.history.replaceState({ kbTabor: true }, "", url);
    else window.history.pushState({ kbTabor: true }, "", url);
    syncSearch();
  }

  function closeVehicle() {
    if (sheetEntry()) window.history.back();
    else window.history.replaceState({}, "", urlWith((p) => p.delete("tabor")));
    syncSearch();
  }

  function setTab(t: Tab) {
    window.history.replaceState(
      {},
      "",
      urlWith((p) => (t === "statystyki" ? p.set("widok", "statystyki") : p.delete("widok"))),
    );
    syncSearch();
  }

  function pickLine(line: string) {
    setFilters({ ...DEFAULT_FILTERS, line });
    setTab("pojazdy");
    requestAnimationFrame(() => tabsEl?.scrollIntoView({ block: "start" }));
  }

  /** a KPI tile as a filter switch: a second click takes the filter off */
  function showInGallery(patch: Partial<FleetFilters>) {
    patchFilters(patch);
    if (tab !== "pojazdy") setTab("pojazdy");
  }

  const statusPick = (s: StatusFilter) => ({ on: filters.status === s, patch: { status: filters.status === s ? "all" : s } as Partial<FleetFilters> });

  const updatedAt = $derived(fleet.data ? localUpdatedAt(fleet.data) : 0);
  const age = $derived(updatedAt > 0 ? clockNow.current - updatedAt : null);
  const stale = $derived(age !== null && age > STALE_AFTER_SEC);
  const freshness = $derived(age === null ? "czekam na dane" : stale ? `dane sprzed ${Math.max(2, Math.round(age / 60))} min` : "");

  const seed = $derived(side ? fleet.data?.vehicles.find((v) => v.sideNumber === side) : undefined);

  // app/head.ts metadata is static (the BB title); GZM retitles on the client
  onMount(() => {
    if (city !== "gzm") return;
    const prev = document.title;
    document.title = "Brygady i tabor Metropolii GZM | Unimaps";
    return () => {
      document.title = prev;
    };
  });

  let showTop = $state(false);
  $effect(() => {
    if (side !== null) return;
    showTop = false;
    const onScroll = () => (showTop = window.scrollY > 900);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  });

  function onTabsKeyDown(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.key === tab);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(TABS[next].key);
    document.getElementById(`tab-${TABS[next].key}`)?.focus();
  }
</script>

<svelte:window onpopstate={syncSearch} />

{#snippet liveClock()}
  <div class="hidden shrink-0 pl-1 pr-2 text-right sm:block">
    <p class="text-[15px] font-semibold leading-tight text-text tabular-nums">{clockFromEpoch(clockNow.current, true)}</p>
    <p class="flex items-center justify-end gap-1.5 text-[11.5px] {stale ? 'text-late' : 'text-text-faint'}">
      {#if freshness}
        {freshness}
      {:else}
        <span aria-hidden="true" class="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good"></span>
        dane aktualne
      {/if}
    </p>
  </div>
{/snippet}

{#snippet tile(
  label: string,
  value: string,
  note: string | Snippet,
  tone = "text-text",
  pick?: { on: boolean; patch: Partial<FleetFilters> },
)}
  {#snippet body()}
    <span class="block text-[12.5px] text-text-mute">{label}</span>
    <span class="mt-0.5 block text-[24px] font-semibold leading-tight tracking-[-0.02em] tabular-nums {tone}">{value}</span>
    <span class="mt-0.5 block text-[12px] leading-snug text-text-faint">
      {#if typeof note === "string"}{note}{:else}{@render note()}{/if}
    </span>
  {/snippet}
  {#if pick}
    <button
      type="button"
      aria-pressed={pick.on}
      onclick={() => showInGallery(pick.patch)}
      class="{KPI_TILE} transition-colors {pick.on ? 'border-primary/50 bg-primary-dim' : 'border-hairline bg-surface hover:bg-surface-2'}"
    >
      {@render body()}
      <span class="mt-1 block text-[12px] font-medium text-primary">{pick.on ? "Wyłącz filtr" : "Pokaż w galerii"}</span>
    </button>
  {:else}
    <div class="{KPI_TILE} border-hairline bg-surface">{@render body()}</div>
  {/if}
{/snippet}

{#snippet kpiStrip(stats: FleetStats, vehicles: FleetSummaryItem[])}
  {@const running = stats.activeCount - stats.waitingCount}
  {@const measured = stats.measuredCount > 0}
  {@const late = vehicles.filter(isLate)}
  {@const veryLate = late.filter((v) => (v.delaySec ?? 0) > VERY_LATE_SEC).length}
  <!-- the phone's catalogue starts at the search box (its status chips carry the counts); there the tiles
       are one swipeable row on the Statystyki tab -->
  <section aria-label="Dziś: {brand.name}" class="{KPI_GRID} {tab === 'pojazdy' ? 'hidden' : KPI_SWIPE}">
    {@render tile(
      "W trasie",
      fmtInt(running),
      `z ${fleetOf(city, stats.totalFleet)}${stats.waitingCount > 0 ? `, ${stats.waitingCount} ${pluralPl(stats.waitingCount, "czeka", "czekają", "czeka")}` : ""}`,
      undefined,
      statusPick("active"),
    )}
    {@render tile(
      "Spóźnione",
      fmtInt(late.length),
      `ponad +3 min${veryLate > 0 ? `, ${fmtInt(veryLate)} ponad +10 min` : ""}`,
      late.length > 0 ? "text-late" : undefined,
      statusPick("late"),
    )}
    {@render tile(
      "Punktualność",
      measured ? `${stats.onTimePercentage}%` : "–",
      measured ? `od −1 do +3 min, ${stats.measuredCount} ${pluralPl(stats.measuredCount, "pojazd", "pojazdy", "pojazdów")}` : "brak pomiarów",
      !measured ? undefined : stats.onTimePercentage >= 80 ? "text-good" : "text-late",
    )}
    {@render tile(
      "Mediana opóźnienia",
      stats.medianDelaySec !== null ? fmtDelayMin(stats.medianDelaySec) : "–",
      measured ? `średnio ${fmtDelayMin(stats.averageDelaySec)}` : "brak pomiarów",
      stats.medianDelaySec !== null ? delayClass(stats.medianDelaySec) : undefined,
    )}
    {#snippet cancelledNote()}
      {#if stats.coursesCancelledToday > 0}
        <span class="text-danger">
          {fmtInt(stats.coursesCancelledToday)}
          {pluralPl(stats.coursesCancelledToday, "przerwany", "przerwane", "przerwanych")}
        </span>
      {:else}
        żaden nie przerwany
      {/if}
    {/snippet}
    {@render tile("Kursy dziś", fmtInt(stats.coursesCompletedToday), cancelledNote)}
    {@render tile(
      "Km dziś",
      fmtKm(stats.kmToday),
      `${fmtInt(stats.activeLines.length)} ${pluralPl(stats.activeLines.length, "linia", "linie", "linii")} w ruchu`,
    )}
    {@render tile(
      "Elektryczne",
      fmtInt(stats.electricCount),
      [
        stats.hybridCount > 0 ? `${fmtInt(stats.hybridCount)} ${pluralPl(stats.hybridCount, "hybrydowy", "hybrydowe", "hybrydowych")}` : "",
        stats.hydrogenCount > 0 ? `${fmtInt(stats.hydrogenCount)} ${pluralPl(stats.hydrogenCount, "wodorowy", "wodorowe", "wodorowych")}` : "",
      ]
        .filter(Boolean)
        .join(", ") || "w taborze",
      undefined,
      { on: filters.fuel === "electric", patch: { fuel: filters.fuel === "electric" ? "all" : "electric" } },
    )}
  </section>
{/snippet}

{#snippet tabs()}
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <!-- roving tabindex: the focused tab inside takes the keys, the list itself is not a tab stop -->
  <div role="tablist" aria-label="Widok" onkeydown={onTabsKeyDown} class="mt-5 flex gap-1 border-b border-hairline">
    {#each TABS as t (t.key)}
      {@const on = t.key === tab}
      <button
        id="tab-{t.key}"
        type="button"
        role="tab"
        aria-selected={on}
        aria-controls={on ? `panel-${t.key}` : undefined}
        tabindex={on ? 0 : -1}
        onclick={() => setTab(t.key)}
        class="-mb-px min-h-11 border-b-2 px-4 text-[14px] font-semibold transition-colors {on
          ? 'border-primary text-text'
          : 'border-transparent text-text-mute hover:text-text'}"
      >
        {t.label}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet loadingBody()}
  <div aria-label="Ładowanie floty" role="status">
    <div class="{KPI_GRID} hidden">
      {#each [0, 1, 2, 3, 4, 5, 6] as i (i)}
        <div class="skeleton h-[6.75rem] rounded-2xl"></div>
      {/each}
    </div>
    <div class="skeleton h-11 w-56 rounded-lg sm:mt-5"></div>
    <div class="skeleton mt-4 h-11 w-full max-w-[560px] rounded-xl"></div>
    <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as i (i)}
        <div class="skeleton aspect-[4/5] rounded-2xl"></div>
      {/each}
    </div>
  </div>
{/snippet}

<div inert={inert} class="min-h-dvh bg-bg text-text">
  <header class="sticky top-0 z-30 border-b border-hairline bg-bg pt-[env(safe-area-inset-top)]">
    <div class="mx-auto flex h-16 w-full max-w-[1440px] items-center gap-2 px-2 sm:px-4 lg:px-6">
      <a
        href="/"
        aria-label="Wróć do mapy"
        class="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-tint/8 hover:text-text"
      >
        <Icon icon={CaretLeftIcon} />
      </a>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-[17px] font-bold leading-tight text-text">Brygady i tabor</h1>
        <p class="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-mute">
          <!-- a phone has no room for the clock: its time rides here -->
          <span aria-hidden="true" class="h-1.5 w-1.5 shrink-0 rounded-full sm:hidden {stale ? 'bg-late' : 'bg-good'}"></span>
          <span class="truncate sm:hidden">{`${brand.name} · ${freshness || clockFromEpoch(clockNow.current)}`}</span>
          <span class="hidden truncate sm:inline">{`${brand.name} · ${DAY_FMT.format(clockNow.current * 1000)} · katalog taboru`}</span>
        </p>
      </div>
      <nav aria-label="Miasto" class="flex shrink-0 gap-0.5 rounded-full border border-hairline bg-surface p-0.5 sm:p-1">
        {#each CITIES as c (c.key)}
          <a
            href="/brygady?city={c.key}"
            aria-current={c.key === city ? "page" : undefined}
            class="grid min-h-11 min-w-12 place-items-center rounded-full px-3 text-[13px] font-semibold transition-colors sm:min-h-9 sm:font-medium {c.key ===
            city
              ? 'bg-primary-dim text-text'
              : 'text-text-mute hover:text-text'}"
          >
            <span aria-hidden="true" class="sm:hidden">{c.short}</span>
            <span class="sr-only sm:not-sr-only">{c.name}</span>
          </a>
        {/each}
      </nav>
      {#if fleet.data}
        {@render liveClock()}
      {/if}
      <a
        href="https://ko-fi.com/unisic"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Wesprzyj nas"
        title="Wesprzyj nas"
        class="hidden h-11 w-11 shrink-0 place-items-center rounded-full text-primary transition-colors hover:bg-tint/8 sm:grid"
      >
        <Icon icon={HeartIcon} weight="fill" />
      </a>
    </div>
  </header>
  <main class="mx-auto w-full max-w-[1440px] px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-4 lg:px-8">
    {#if fleet.data}
      {@const data = fleet.data}
      {#if fleet.error}
        <div
          role="status"
          class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-late/30 bg-late/8 px-4 py-2.5 text-[13px] text-text"
        >
          <Svg icon={ALERT} size={15} class="shrink-0 text-late" />
          <span class="flex-1">
            Nie udało się odświeżyć danych.{data.stats.updatedAt > 0 ? ` Ostatnia aktualizacja o ${clockFromEpoch(data.stats.updatedAt)}.` : ""}
          </span>
          <button
            type="button"
            onclick={() => void fleet.mutate()}
            class="min-h-8 rounded-lg px-2 font-semibold text-primary hover:bg-primary-dim"
          >
            Odśwież
          </button>
        </div>
      {/if}
      {@render kpiStrip(data.stats, data.vehicles)}
      <div bind:this={tabsEl} class="scroll-mt-[calc(env(safe-area-inset-top)+4.5rem)]">
        {@render tabs()}
      </div>
      <div role="tabpanel" id="panel-{tab}" aria-labelledby="tab-{tab}" class="mt-4 animate-fade">
        {#if tab === "pojazdy"}
          <FleetList vehicles={data.vehicles} {filters} onFiltersChange={patchFilters} onOpen={openVehicle} {city} />
        {:else}
          <FleetStatsView {data} onPickLine={pickLine} onOpenVehicle={openVehicle} {city} />
        {/if}
      </div>
    {:else if fleet.error && !fleet.isLoading}
      <div class="rounded-2xl border border-hairline bg-surface px-4 py-14 text-center">
        <p class="text-[15px] font-medium text-text">Nie udało się pobrać danych floty</p>
        <p class="mt-1 text-[13px] text-text-mute">Sprawdź połączenie. Strona spróbuje ponownie sama.</p>
        <button
          type="button"
          onclick={() => void fleet.mutate()}
          class="mt-4 min-h-10 rounded-full bg-brand px-5 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hi"
        >
          Spróbuj ponownie
        </button>
      </div>
    {:else}
      {@render loadingBody()}
    {/if}
    {#if city === "gzm"}
      <footer class="mt-10 border-t border-hairline pt-4 text-[12px] leading-relaxed text-text-faint">
        Dane na żywo: ZTM / Metropolia GZM (CC BY). Kursy, opóźnienia i kilometry zbieramy od rana, gdy
        pojazd jest w trasie. Brygady i następny kurs pochodzą z rozkładu GZM, kilometry z długości kursów w rozkładzie.
      </footer>
    {:else}
      <footer class="mt-10 border-t border-hairline pt-4 text-[12px] leading-relaxed text-text-faint">
        Dane na żywo z systemu MZK Bielsko-Biała. Kursy, opóźnienia i kilometry zbieramy od rana, gdy pojazd jest w trasie.
        MZK nie publikuje numerów brygad ani rozkładów pracy pojazdów, więc następny kurs jest tylko szacunkiem.
      </footer>
    {/if}
    <!-- the header's heart has no room on a phone -->
    <a href="https://ko-fi.com/unisic" target="_blank" rel="noopener noreferrer" class="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-primary sm:hidden">
      <Icon icon={HeartIcon} weight="fill" />Wesprzyj nas
    </a>
  </main>
</div>
{#if side}
  <VehicleSheet
    {side}
    {seed}
    onClose={closeVehicle}
    prev={at > 0 ? order[at - 1] : undefined}
    next={at >= 0 ? order[at + 1] : undefined}
    onStep={openVehicle}
  />
{/if}
{#if side === null && showTop}
  <button
    type="button"
    onclick={() => window.scrollTo({ top: 0 })}
    aria-label="Przewiń na górę"
    class="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-20 grid h-12 w-12 animate-pop place-items-center rounded-full border border-hairline bg-surface-2 text-text shadow-[var(--shadow-float)] transition-colors hover:bg-surface-3"
  >
    <Svg icon={ARROW_UP} size={18} />
  </button>
{/if}
