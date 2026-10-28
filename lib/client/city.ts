/**
 * The city a page load shows: "bb" (Bielsko-Biała, KB + MZK) or "gzm" (Metropolia GZM). Fixed for
 * the whole page life: switching city is a full navigation, so module state keyed at load is safe.
 * BB is the default everywhere: its fetch URLs, storage keys and links carry no city marker.
 */
import { createContext } from "react";

export type City = "bb" | "gzm";

export interface CityConfig {
  name: string;
  center: [number, number];
  zoom: number;
  /** zoom from which stop markers are drawn (GZM has ~7400 stops, so one level later) */
  stopMinZoom: number;
  logo: string;
  vehiclesRefreshMs: number;
  /** extra data credit, plain text (no markup): rendered in the menu and in the Leaflet attribution */
  attribution: string | null;
}

export const CITY: Record<City, CityConfig> = {
  bb: {
    name: "Bielsko-Biała",
    center: [49.822, 19.046],
    zoom: 11,
    stopMinZoom: 14,
    logo: "/brand.svg",
    vehiclesRefreshMs: 4000,
    attribution: null,
  },
  gzm: {
    name: "Metropolia GZM",
    center: [50.2615, 19.0273],
    zoom: 11,
    stopMinZoom: 15,
    logo: "/gzm-logo.svg",
    // the server's SDIP overlay moves a vehicle every ~5 s (p50); it polls SDIP only while this is requested
    vehiclesRefreshMs: 5000,
    attribution: "ZTM / Metropolia GZM (CC BY), zbiorkom.live",
  },
};

export const CityContext = createContext<City>("bb");

/** Shown instead of a generic error while the server answers 503 "Data is loading" (GZM feed still loading). */
export const GZM_LOADING = "Dane GZM jeszcze się wczytują, spróbuj za chwilę.";

const KEY = "kb:city";
const APP_PARAMS = ["stop", "exec", "trip", "lines", "map"] as const;

function isCity(v: unknown): v is City {
  return v === "bb" || v === "gzm";
}

/** The city of an id from either city's id space: GZM ids carry a "gzm:" prefix, all others are BB. */
export function cityOfId(id: string | number | null | undefined): City {
  return typeof id === "string" && id.startsWith("gzm:") ? "gzm" : "bb";
}

/**
 * Which city a page load shows. The URL decides first: ?city=gzm or a gzm: stop/exec/trip id means
 * GZM, any other app param (an old BB deep link) means BB. Without either, the stored choice; null
 * when there is none (show the picker).
 */
export function resolveCity(search: string, stored: string | null): City | null {
  const p = new URLSearchParams(search);
  if (p.get("city") === "gzm") return "gzm";
  if (["stop", "exec", "trip"].some((k) => cityOfId(p.get(k)) === "gzm")) return "gzm";
  if (APP_PARAMS.some((k) => p.has(k))) return "bb";
  return isCity(stored) ? stored : null;
}

/** A "?..." search string with the city marker: GZM gets city=gzm, BB is returned unchanged. */
export function withCity(search: string, city: City): string {
  if (city === "bb") return search;
  const p = new URLSearchParams(search);
  p.set("city", "gzm");
  return `?${p.toString()}`;
}

/** An API path for the city: GZM gets city=gzm, BB is returned unchanged. */
export function cityUrl(path: string, city: City): string {
  if (city === "bb") return path;
  return `${path}${path.includes("?") ? "&" : "?"}city=gzm`;
}

export function loadCity(): City | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return isCity(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveCity(city: City): void {
  try {
    window.localStorage.setItem(KEY, city);
  } catch {
    /* storage blocked: the picker shows again next time */
  }
}
