"use client";

import dynamic from "next/dynamic";
import { useEffect, useSyncExternalStore } from "react";
import { CITY, CityContext, loadCity, resolveCity, saveCity, type City } from "@/lib/client/city";

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

function getChoice(): City | "pick" {
  if (chosen === undefined) chosen = resolveCity(window.location.search, loadCity()) ?? "pick";
  return chosen;
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function choose(city: City): void {
  saveCity(city);
  chosen = city;
  subs.forEach((f) => f());
}

function CityPicker() {
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
          <button
            type="button"
            onClick={() => choose("bb")}
            className="flex items-center gap-4 rounded-2xl border border-hairline bg-surface p-4 text-left transition-colors hover:bg-surface-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={CITY.bb.logo} alt="" className="h-12 w-12 shrink-0 object-contain" draggable={false} />
            <span className="flex flex-col">
              <span className="text-base font-semibold text-text">{CITY.bb.name}</span>
              <span className="text-sm text-text-mute">Komunikacja Beskidzka i MZK Bielsko-Biała</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => choose("gzm")}
            className="flex items-center gap-4 rounded-2xl border border-hairline bg-surface p-4 text-left transition-colors hover:bg-surface-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={CITY.gzm.logo} alt="" className="h-12 w-12 shrink-0 object-contain" draggable={false} />
            <span className="flex flex-col">
              <span className="text-base font-semibold text-text">{CITY.gzm.name}</span>
              <span className="text-sm text-text-mute">Autobusy, tramwaje i trolejbusy ZTM</span>
            </span>
          </button>
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

  if (choice === null) return <Splash />;
  if (choice === "pick") return <CityPicker />;
  return (
    <CityContext.Provider value={choice}>
      <MapApp />
    </CityContext.Provider>
  );
}
