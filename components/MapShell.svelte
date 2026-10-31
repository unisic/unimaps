<script lang="ts">
  import CityCard from "@/components/city/CityCard.svelte";
  import OtherCities from "@/components/city/OtherCities.svelte";
  import OthersCard from "@/components/city/OthersCard.svelte";
  import { vehiclesFetcher } from "@/lib/client/api";
  import { preload } from "@/lib/client/swr.svelte";
  import { CITY, cityUrl, loadCity, resolveCity, saveCity, setPageCity, type City } from "@/lib/client/city";

  /** The first vehicles request leaves with the city choice, alongside MapApp's chunk (Leaflet + MapLibre), not after
   *  it; useVehicles takes the request over. A failure is the poll's to report then. */
  function warm(city: City): void {
    preload(cityUrl("/api/vehicles", city), vehiclesFetcher);
  }

  /* read once per page load: switching city navigates */
  let choice = $state<City | "pick">(
    (() => {
      const c = resolveCity(window.location.search, loadCity()) ?? "pick";
      if (c !== "pick") {
        setPageCity(c);
        warm(c);
        // a city taken from the URL becomes the remembered one only when nothing is remembered yet
        if (loadCity() == null) saveCity(c);
      }
      return c;
    })(),
  );
  let others = $state(false);

  function choose(city: City): void {
    saveCity(city);
    setPageCity(city);
    warm(city);
    choice = city;
  }

  const title = $derived(
    choice !== "pick" && choice !== "bb"
      ? `${CITY[choice].name}: mapa pojazdów na żywo`
      : "Unimaps: komunikacja miejska na żywo",
  );
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<!-- the boot splash: the app logo, identical to the static markup in index.html, while MapApp loads -->
{#snippet splash()}
  <div class="flex h-dvh w-full items-center justify-center bg-bg">
    <div class="flex flex-col items-center gap-6 animate-fade" role="status" aria-live="polite">
      <img src="/favicon.svg" alt="Unimaps" class="h-14 w-auto" draggable="false" />
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-surface-3 border-t-brand"></div>
      <p class="text-sm text-text-mute">Ładowanie mapy…</p>
    </div>
  </div>
{/snippet}

{#if choice === "pick"}
  <main class="flex min-h-dvh w-full items-center justify-center bg-bg px-4 py-8">
    <div class="flex w-full max-w-md flex-col gap-6 animate-fade">
      <div class="flex flex-col items-center text-center">
        <img src="/favicon.svg" alt="Unimaps" class="mb-4 h-14 w-14" draggable="false" />
        <h1 class="text-xl font-semibold text-text">Wybierz miasto</h1>
        <p class="mt-1 text-sm text-text-mute">Mapa pojazdów na żywo. Miasto zmienisz później w menu.</p>
      </div>
      <div class="flex flex-col gap-3">
        <CityCard id="bb" big onClick={() => choose("bb")} />
        <CityCard id="gzm" big onClick={() => choose("gzm")} />
        {#if others}
          <div class="flex flex-col rounded-2xl border border-hairline bg-surface p-3 animate-fade">
            <OtherCities
              onPick={choose}
              autoFocus
              listClassName="kb-scroll max-h-[min(22rem,50dvh)] overflow-y-auto"
            />
          </div>
        {:else}
          <OthersCard big onClick={() => (others = true)} />
        {/if}
      </div>
    </div>
  </main>
{:else}
  {#await import("@/components/MapApp.svelte")}
    {@render splash()}
  {:then { default: MapApp }}
    <MapApp />
  {/await}
{/if}
