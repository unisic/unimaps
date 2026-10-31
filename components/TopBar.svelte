<script lang="ts" module>
  import type { GeoHit } from "@/lib/client/api";
  import type { GeoPos } from "@/components/hooks.svelte";
  import type { BaseLayerId, TopBarSearchHandle } from "@/components/topbar";
  import type { LineInfo, Stop, Vehicle } from "@/lib/client/types";

  export interface TopBarProps {
    count: number | null;
    offline: boolean;
    stopsVisible: boolean;
    onToggleStops: () => void;
    /** Metrorower stations layer; absent where the city has no bike share */
    bikesVisible?: boolean;
    onToggleBikes?: () => void;
    baseLayer: BaseLayerId;
    onBaseLayer: (id: BaseLayerId) => void;
    /** opens the service-announcements sheet ("Utrudnienia") */
    onOpenAnnouncements: () => void;
    /** opens the "Inne miasto" sheet (every city but BB and GZM) */
    onOpenCity: () => void;
    // Search props
    stops: Stop[];
    geoPos: GeoPos | null;
    onLocate: () => void;
    onPickStop: (s: Stop) => void;
    onPickVehicle: (v: Vehicle) => void;
    lineFilter: ReadonlySet<string> | null;
    onOpenLine: (l: LineInfo) => void;
    onClearLineFilter: () => void;
    onClearView: () => void;
    onOpenNearby: () => void;
    onOpenConnections?: () => void;
    /** an address from the search; absent = no address search */
    onPickPlace?: (g: GeoHit) => void;
    searchRef?: { current: TopBarSearchHandle | null };
    operatorFilter: "all" | "kb" | "mzk";
    onOperatorFilter: (op: "all" | "kb" | "mzk") => void;
    onShowToast?: (msg: string) => void;
  }
</script>

<script lang="ts">
  import Icon from "@/components/Icon.svelte";
  import {
    ArrowRightIcon,
    BugIcon,
    CardsIcon,
    DownloadSimpleIcon,
    MegaphoneSimpleIcon,
    MoonIcon,
    NavigationArrowIcon,
    SlidersHorizontalIcon,
    SunIcon,
    XIcon,
    type IconDef,
  } from "@/components/icon-paths";
  import CityCard from "@/components/city/CityCard.svelte";
  import OpensMore from "@/components/city/OpensMore.svelte";
  import OthersCard from "@/components/city/OthersCard.svelte";
  import TopBarSearch from "@/components/TopBarSearch.svelte";
  import { BASE_LAYERS } from "@/components/topbar";
  import Segmented from "@/components/ui/Segmented.svelte";
  import SwitchRow from "@/components/ui/SwitchRow.svelte";
  import { announcementsOf } from "@/lib/client/announcements";
  import { CITY, getPageCity, switchCity, withCity } from "@/lib/client/city";
  import { IOS_INSTALL_HINT, install, promptInstall } from "@/lib/client/install";
  import { setSmoothMotion, smoothMotion } from "@/lib/client/smoothMotion";
  import { setThemePref, themePref, type ThemePref } from "@/lib/client/theme";

  let {
    count,
    offline,
    stopsVisible,
    onToggleStops,
    bikesVisible,
    onToggleBikes,
    baseLayer,
    onBaseLayer,
    onOpenAnnouncements,
    onOpenCity,
    stops,
    geoPos,
    onLocate,
    onPickStop,
    onPickVehicle,
    lineFilter,
    onOpenLine,
    onClearLineFilter,
    onClearView,
    onOpenNearby,
    onOpenConnections,
    onPickPlace,
    searchRef,
    operatorFilter,
    onOperatorFilter,
    onShowToast,
  }: TopBarProps = $props();

  const OP_DOT = { kb: "bg-kb", mzk: "bg-mzk", gzm: "bg-gzm" } as const;

  const OPERATOR_OPTIONS: { id: "all" | "kb" | "mzk"; label: string; title?: string }[] = [
    { id: "all", label: "Wszyscy" },
    { id: "kb", label: "KB", title: "Komunikacja Beskidzka" },
    { id: "mzk", label: "MZK", title: "MZK Bielsko-Biała" },
  ];

  const THEME_OPTIONS: Array<{ id: ThemePref; label: string }> = [
    { id: "system", label: "Auto" },
    { id: "light", label: "Jasny" },
    { id: "dark", label: "Ciemny" },
  ];

  const LAYER_LEAD: Record<BaseLayerId, IconDef> = {
    kb: SunIcon,
    dark: MoonIcon,
  };

  const LAYER_OPTIONS = (Object.keys(BASE_LAYERS) as BaseLayerId[]).map((id) => ({ id, label: BASE_LAYERS[id].name }));

  let menu = $state(false);
  const openCity = () => {
    menu = false;
    onOpenCity();
  };
  const closeMenuOnDropdown = (isOpen: boolean) => {
    if (isOpen) menu = false;
  };
  let root = $state<HTMLDivElement>();
  const city = getPageCity();
  const bb = city === "bb";
  /* the announcements store (and its poll) only runs while its button is rendered: it subscribes on read.
     It notifies at most once per 15 min: no extra work in the 5 s cycle */
  const announcements = announcementsOf(city);

  /* close the menu on outside tap */
  $effect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) menu = false;
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  });
</script>

{#snippet operatorDot(op: keyof typeof OP_DOT)}
  <span class="h-2 w-2 shrink-0 rounded-full {OP_DOT[op]}" aria-hidden="true"></span>
{/snippet}

{#snippet operatorLead(id: "all" | "kb" | "mzk")}
  {#if id !== "all"}{@render operatorDot(id)}{/if}
{/snippet}

{#snippet layerLead(id: BaseLayerId)}
  <Icon icon={LAYER_LEAD[id]} />
{/snippet}

{#snippet menuLabel(text: string)}
  <p class="px-3 pb-1.5 pt-2 text-[12px] font-medium text-text-faint">{text}</p>
{/snippet}

<div
  bind:this={root}
  class="absolute left-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[1002] w-[min(440px,calc(100vw-24px))] md:left-1/2 md:-translate-x-1/2"
>
  <!-- Search pill with live inline search input -->
  <div class="surface flex h-12 items-center gap-1 rounded-full pl-3.5 pr-1.5">
    <TopBarSearch
      {stops}
      {geoPos}
      {onLocate}
      {onPickStop}
      {onPickVehicle}
      {lineFilter}
      {onOpenLine}
      {onClearLineFilter}
      {onToggleStops}
      {stopsVisible}
      {baseLayer}
      {onBaseLayer}
      {onClearView}
      {onOpenNearby}
      {onOpenConnections}
      {onPickPlace}
      {searchRef}
      {onShowToast}
      onDropdownChange={closeMenuOnDropdown}
    />

    <!-- Active operator filter: visible only while it hides part of the fleet -->
    {#if operatorFilter !== "all"}
      <button
        type="button"
        onclick={() => onOperatorFilter("all")}
        aria-label="Filtr przewoźnika: {operatorFilter.toUpperCase()}. Pokaż wszystkich"
        title="Pokaż wszystkich przewoźników"
        class="tap flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-tint/8 pl-2.5 pr-2 text-[12px] font-semibold text-text hover:bg-tint/12"
      >
        {@render operatorDot(operatorFilter)}{operatorFilter.toUpperCase()}<Icon
          icon={XIcon}
          class="text-[11px] text-text-mute"
        />
      </button>
    {/if}

    <!-- Online vehicles count -->
    <span
      class="flex shrink-0 items-center gap-1.5 px-2 text-[12.5px] font-semibold tabular-nums text-text-mute"
      title={offline ? "Brak połączenia" : "Pojazdy online"}
    >
      <span class="h-1.5 w-1.5 rounded-full {offline ? 'bg-danger' : 'animate-pulse-dot bg-good'}" aria-hidden="true"
      ></span>{count ?? "…"}
    </span>

    {#if bb || city === "gzm"}
      <button
        type="button"
        aria-label={announcements.unseen ? "Utrudnienia w ruchu (nowe komunikaty)" : "Utrudnienia w ruchu"}
        title="Utrudnienia w ruchu"
        onclick={() => {
          menu = false;
          searchRef?.current?.blur();
          onOpenAnnouncements();
        }}
        class="tap relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-[19px] text-text-mute hover:bg-tint/8 hover:text-text md:h-9 md:w-9 md:text-[18px]"
      >
        <Icon icon={MegaphoneSimpleIcon} />
        {#if announcements.unseen}
          <span
            class="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-surface animate-pop md:right-1.5 md:top-1.5"
            aria-hidden="true"
          ></span>
        {/if}
      </button>
    {/if}

    <!-- Map settings button -->
    <button
      type="button"
      aria-label="Ustawienia mapy"
      aria-expanded={menu}
      title="Ustawienia mapy"
      onclick={() => {
        menu = !menu;
        searchRef?.current?.blur();
      }}
      class="tap grid h-10 w-10 shrink-0 place-items-center rounded-full text-[19px] md:h-9 md:w-9 md:text-[18px] {menu
        ? 'bg-tint/10 text-text'
        : 'text-text-mute hover:bg-tint/8 hover:text-text'}"
    >
      <Icon icon={SlidersHorizontalIcon} />
    </button>
  </div>

  <!-- Settings dropdown menu -->
  {#if menu}
    <div class="surface mt-2 rounded-[20px] p-2 text-[13.5px] animate-drop">
      {@render menuLabel("Miasto")}
      <div class="px-1">
        <CityCard id="bb" current={bb} onClick={() => switchCity("bb")} />
        <CityCard id="gzm" current={city === "gzm"} onClick={() => switchCity("gzm")} />
        <!-- every other city lives in the sheet; the current one is shown here in its place -->
        {#if bb || city === "gzm"}
          <OthersCard onClick={openCity} />
        {:else}
          <CityCard id={city} current onClick={openCity}>
            {#snippet trailing()}
              <OpensMore />
            {/snippet}
          </CityCard>
        {/if}
      </div>

      {#if bb}
        {@render menuLabel("Przewoźnik")}
        <div class="px-1">
          <Segmented
            label="Wybór przewoźnika"
            value={operatorFilter}
            options={OPERATOR_OPTIONS}
            onChange={onOperatorFilter}
            lead={operatorLead}
          />
        </div>
      {/if}

      {@render menuLabel("Motyw")}
      <div class="px-1">
        <Segmented label="Motyw aplikacji" value={themePref.current} options={THEME_OPTIONS} onChange={setThemePref} />
      </div>

      {#if LAYER_OPTIONS.length > 1}
        {@render menuLabel("Mapa")}
        <div class="px-1">
          <Segmented label="Styl mapy" value={baseLayer} options={LAYER_OPTIONS} onChange={onBaseLayer} lead={layerLead} />
        </div>
      {/if}

      <div class="mt-2 border-t border-hairline pt-1">
        <SwitchRow checked={stopsVisible} onToggle={onToggleStops} label="Przystanki na mapie" />
        {#if onToggleBikes}
          <SwitchRow
            checked={!!bikesVisible}
            onToggle={onToggleBikes}
            label="Metrorower na mapie"
            hint="Stacje i liczba dostępnych rowerów"
          />
        {/if}
        <SwitchRow
          checked={smoothMotion.current}
          onToggle={() => setSmoothMotion(!smoothMotion.current)}
          label="Płynny ruch pojazdów"
          hint="Szacuje pozycję autobusu między aktualizacjami"
        />
      </div>

      <!-- the fleet tracker exists for BB (MZK) and GZM only: /brygady?city=<other> would show BB -->
      {#if bb || city === "gzm"}
        <a
          href="/brygady{withCity('', city)}"
          class="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-text transition-colors hover:bg-tint/5"
        >
          <Icon icon={CardsIcon} class="text-[17px] text-text-mute" />
          <span class="flex-1">Karty brygad i tabor na żywo</span>
          {@render arrow()}
        </a>
      {/if}
      {#if install.current === "prompt"}
        <button
          type="button"
          onclick={() => void promptInstall()}
          class="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-text transition-colors hover:bg-tint/5"
        >
          <Icon icon={DownloadSimpleIcon} class="text-[17px] text-text-mute" />
          <span class="flex-1">Zainstaluj aplikację</span>
          {@render arrow()}
        </button>
      {/if}
      {#if install.current === "ios"}
        <div class="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-text">
          <Icon icon={DownloadSimpleIcon} class="mt-0.5 shrink-0 text-[17px] text-text-mute" />
          <span class="flex flex-col gap-0.5">
            <span>Zainstaluj aplikację</span>
            <span class="text-[12px] leading-snug text-text-mute">
              {IOS_INSTALL_HINT}. Powiadomienia o odjazdach działają tylko w zainstalowanej aplikacji.
            </span>
          </span>
        </div>
      {/if}
      <a
        href="https://github.com/unisic/unimaps/issues/new"
        target="_blank"
        rel="noopener"
        class="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-text transition-colors hover:bg-tint/5"
      >
        <Icon icon={BugIcon} class="text-[17px] text-text-mute" />
        <span class="flex-1">Zgłoś błąd lub pomysł</span>
        {@render arrow()}
      </a>

      <div
        class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-hairline px-3 pb-1.5 pt-3 text-[12px] text-text-mute"
      >
        {#if !bb}
          <span class="inline-flex items-center gap-1.5">
            {@render operatorDot("gzm")}{CITY[city].name}
          </span>
        {:else}
          <span class="inline-flex items-center gap-1.5">
            {@render operatorDot("kb")}KB
          </span>
          <span class="inline-flex items-center gap-1.5">
            {@render operatorDot("mzk")}MZK
          </span>
        {/if}
        <span class="inline-flex items-center gap-1.5">
          <Icon icon={NavigationArrowIcon} weight="fill" class="rotate-45 text-[11px]" />kierunek jazdy
        </span>
      </div>
      <p class="px-3 pb-1.5 text-[11px] leading-snug text-text-faint [&_a]:text-text-mute [&_a:hover]:text-text">
        Mapa: ©
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>,
        <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, ©
        <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>. Trasy:
        <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a
        >{#if CITY[city].attribution}. Dane: {CITY[city].attribution}{/if}.
        <a href="/prywatnosc">Prywatność i dane</a>
      </p>
    </div>
  {/if}
</div>

{#snippet arrow()}
  <Icon
    icon={ArrowRightIcon}
    class="text-[14px] text-text-faint transition-transform duration-200 group-hover:translate-x-0.5"
  />
{/snippet}
