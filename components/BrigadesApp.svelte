<script module lang="ts">
  /*
   * /brygady: the MZK Bielsko-Biała fleet (or Metropolia GZM with `?city=gzm` or a saved
   * `kb:city`), live. View state lives in the URL
   * (`?tabor=<side>` opens a vehicle, `?widok=statystyki` the charts) and is written with
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
  import { CaretLeftIcon } from "@/components/icon-paths";
  import { localUpdatedAt, readBrygadyCity, type FleetStats } from "@/lib/client/fleet";
  import { useFleet } from "@/lib/client/fleet.svelte";

  import { clockFromEpoch, FLEET_CITY, fmtDelayMin, fmtInt, fmtKm, pluralPl } from "./brygady/common";
  import { DEFAULT_FILTERS, type FleetFilters } from "./brygady/fleetFilters";
  import FleetList from "./brygady/FleetList.svelte";
  import FleetStatsView from "./brygady/FleetStatsView.svelte";
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
  let filters = $state.raw<FleetFilters>(DEFAULT_FILTERS);
  const nowEpoch = useEpochNow(30_000);
  const clockNow = useEpochNow(1000);
  let tabsEl: HTMLDivElement | undefined = $state();
  const inert = $derived(side !== null);

  const syncSearch = () => (search = window.location.search);

  function patchFilters(patch: Partial<FleetFilters>) {
    filters = { ...filters, ...patch };
  }

  function openVehicle(s: string) {
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
    filters = { ...filters, q: "", status: "all", fuel: "all", line };
    setTab("pojazdy");
    requestAnimationFrame(() => tabsEl?.scrollIntoView({ block: "start" }));
  }

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

{#snippet liveClock(updatedAt: number)}
  {@const now = clockNow.current}
  {@const age = updatedAt > 0 ? now - updatedAt : null}
  {@const stale = age !== null && age > STALE_AFTER_SEC}
  <div class="shrink-0 pr-2 text-right">
    <p class="text-[15px] font-semibold leading-tight text-text tabular-nums">{clockFromEpoch(now, true)}</p>
    <p class="flex items-center justify-end gap-1.5 text-[11.5px] {stale ? 'text-late' : 'text-text-faint'}">
      {#if age === null}
        czekam na dane
      {:else if stale}
        {`dane sprzed ${Math.max(2, Math.round(age / 60))} min`}
      {:else}
        <span aria-hidden="true" class="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good"></span>
        dane aktualne
      {/if}
    </p>
  </div>
{/snippet}

{#snippet tile(label: string, value: string, note: string | Snippet)}
  <div class="h-full rounded-2xl border border-hairline bg-surface px-4 py-3">
    <dt class="text-[12px] font-medium text-text-mute">{label}</dt>
    <dd class="mt-0.5 text-[22px] font-bold leading-tight text-text tabular-nums">{value}</dd>
    <dd class="mt-0.5 text-[12px] leading-snug text-text-faint">
      {#if typeof note === "string"}{note}{:else}{@render note()}{/if}
    </dd>
  </div>
{/snippet}

{#snippet kpiStrip(stats: FleetStats)}
  {@const running = stats.activeCount - stats.waitingCount}
  {@const measured = stats.measuredCount > 0}
  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {@render tile(
      "W trasie",
      fmtInt(running),
      `z ${fmtInt(stats.totalFleet)} pojazdów${stats.waitingCount > 0 ? `, ${stats.waitingCount} czeka` : ""}`,
    )}
    {@render tile(
      "Punktualność",
      measured ? `${stats.onTimePercentage}%` : "–",
      measured ? `od −1 do +3 min, ${stats.measuredCount} ${pluralPl(stats.measuredCount, "pojazd", "pojazdy", "pojazdów")}` : "brak pomiarów",
    )}
    {@render tile(
      "Mediana opóźnienia",
      stats.medianDelaySec !== null ? fmtDelayMin(stats.medianDelaySec) : "–",
      measured ? `średnio ${fmtDelayMin(stats.averageDelaySec)}` : "brak pomiarów",
    )}
    {@render tile(
      "Linie w ruchu",
      fmtInt(stats.activeLines.length),
      `${fmtInt(stats.seenTodayCount)} ${pluralPl(stats.seenTodayCount, "pojazd wyjechał", "pojazdy wyjechały", "pojazdów wyjechało")} dziś`,
    )}
    {#snippet todayNote()}
      {fmtInt(stats.coursesCompletedToday)} {pluralPl(stats.coursesCompletedToday, "kurs", "kursy", "kursów")}{#if stats.coursesCancelledToday > 0}<span
          class="text-danger">, {fmtInt(stats.coursesCancelledToday)} {pluralPl(stats.coursesCancelledToday, "przerwany", "przerwane", "przerwanych")}</span
        >{/if}
    {/snippet}
    <div class="col-span-2 sm:col-span-1">
      {@render tile("Dziś", fmtKm(stats.kmToday), todayNote)}
    </div>
  </dl>
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
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {#each [0, 1, 2, 3, 4] as i (i)}
        <div class="skeleton h-[5.75rem] rounded-2xl {i === 4 ? 'col-span-2 sm:col-span-1' : ''}"></div>
      {/each}
    </div>
    <div class="skeleton mt-5 h-11 w-56 rounded-lg"></div>
    <div class="skeleton mt-4 h-11 w-full rounded-xl"></div>
    <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each [0, 1, 2, 3, 4, 5] as i (i)}
        <div class="skeleton h-40 rounded-2xl"></div>
      {/each}
    </div>
  </div>
{/snippet}

<div inert={inert} class="min-h-dvh bg-bg text-text">
  <header class="sticky top-0 z-30 border-b border-hairline bg-bg pt-[env(safe-area-inset-top)]">
    <div class="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-2 sm:px-4">
      <a
        href="/"
        aria-label="Wróć do mapy"
        class="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-mute transition-colors hover:bg-tint/8 hover:text-text"
      >
        <Icon icon={CaretLeftIcon} />
      </a>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-[17px] font-bold leading-tight text-text">Brygady i tabor</h1>
        <p class="truncate text-[12.5px] text-text-mute">{`${FLEET_CITY[city].name}, na żywo`}</p>
      </div>
      {#if fleet.data}
        {@render liveClock(localUpdatedAt(fleet.data))}
      {/if}
    </div>
  </header>
  <main class="mx-auto w-full max-w-6xl px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-4">
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
      {@render kpiStrip(data.stats)}
      <div bind:this={tabsEl} class="scroll-mt-[calc(env(safe-area-inset-top)+4.5rem)]">
        {@render tabs()}
      </div>
      <div role="tabpanel" id="panel-{tab}" aria-labelledby="tab-{tab}" class="mt-4 animate-fade">
        {#if tab === "pojazdy"}
          <FleetList
            vehicles={data.vehicles}
            {filters}
            onFiltersChange={patchFilters}
            onOpen={openVehicle}
            nowEpoch={nowEpoch.current}
            {city}
          />
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
  </main>
</div>
{#if side}
  {#key side}
    <VehicleSheet {side} {seed} onClose={closeVehicle} />
  {/key}
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
