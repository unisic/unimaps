"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, useSyncExternalStore } from "react";
import { preload } from "swr";

import { CityCard, OtherCities, OthersCard } from "@/components/CityChooser";
import { vehiclesFetcher } from "@/lib/client/api";
import { CITY, CityContext, cityUrl, loadCity, resolveCity, saveCity, setPageCity, type City } from "@/lib/client/city";

/** The boot splash: the app logo, identical on the server, during the picker and while MapApp loads. */
function Splash() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-6 animate-fade" role="status" aria-live="polite">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/favicon.svg"
          alt="Unimaps"
          className="h-14 w-auto"
          draggable={false}
        />
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-3 border-t-brand" />
        <p className="text-sm text-text-mute">Ładowanie mapy…</p>
      </div>
    </div>
  );
}

/* ---- city choice: a tiny external store, so the first client render needs no setState in an effect.
   Read once per page load: switching city navigates. ---- */
let chosen: City | "pick" | undefined;

const MapApp = dynamic(() => import("@/components/MapApp"), {
  ssr: false,
  loading: () => <Splash />,
});
const subs = new Set<() => void>();

/** The first vehicles request leaves with the city choice, alongside MapApp's chunk (Leaflet + MapLibre), not after
 *  it; useVehicles takes the promise over. A failure is SWR's to report then. */
function warm(city: City): void {
  preload(cityUrl("/api/vehicles", city), vehiclesFetcher).catch(() => {});
}

function getChoice(): City | "pick" {
  if (chosen === undefined) {
    chosen = resolveCity(window.location.search, loadCity()) ?? "pick";
    if (chosen !== "pick") {
      setPageCity(chosen);
      warm(chosen);
    }
  }
  return chosen;
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function choose(city: City): void {
  saveCity(city);
  setPageCity(city);
  warm(city);
  chosen = city;
  subs.forEach((f) => f());
}

function CityPicker() {
  const [others, setOthers] = useState(false);
  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-bg px-4 py-8">
      <div className="flex w-full max-w-md flex-col gap-6 animate-fade">
        <div className="flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/favicon.svg" alt="Unimaps" className="mb-4 h-14 w-14" draggable={false} />
          <h1 className="text-xl font-semibold text-text">Wybierz miasto</h1>
          <p className="mt-1 text-sm text-text-mute">Mapa pojazdów na żywo. Miasto zmienisz później w menu.</p>
        </div>
        <div className="flex flex-col gap-3">
          <CityCard id="bb" big onClick={() => choose("bb")} />
          <CityCard id="gzm" big onClick={() => choose("gzm")} />
          {others ? (
            <div className="flex flex-col rounded-2xl border border-hairline bg-surface p-3 animate-fade">
              <OtherCities
                onPick={choose}
                autoFocus
                listClassName="kb-scroll max-h-[min(22rem,50dvh)] overflow-y-auto"
              />
            </div>
          ) : (
            <OthersCard big onClick={() => setOthers(true)} />
          )}
        </div>
      </div>
    </main>
  );
}

export default function MapShell() {
  // null on the server and during hydration: the splash, identical on both sides
  const choice = useSyncExternalStore(subscribe, getChoice, () => null);
  const city = choice === "pick" ? null : choice;
  useEffect(() => {
    // a city taken from the URL becomes the remembered one only when nothing is remembered yet
    if (city && loadCity() == null) saveCity(city);
  }, [city]);

  // React 19 hoists <title> into <head>; rendering it here (not document.title in an effect) survives
  // Next's late metadata commit, which otherwise resets an effect-set title once after hydration
  const title =
    city && city !== "bb"
      ? `${CITY[city].name}: mapa pojazdów na żywo`
      : "Unimaps: komunikacja miejska na żywo";
  return (
    <>
      <title>{title}</title>
      {choice === null ? (
        <Splash />
      ) : choice === "pick" ? (
        <CityPicker />
      ) : (
        <CityContext.Provider value={choice}>
          <MapApp />
        </CityContext.Provider>
      )}
    </>
  );
}
