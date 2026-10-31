/**
 * The city a page load shows: "bb" (Bielsko-Biała, KB + MZK), "gzm" (Metropolia GZM) or any other zbiorkom
 * city of lib/shared/cities.ts. Fixed for the whole page life: switching city is a full navigation, so module
 * state keyed at load is safe. BB is the default everywhere: its fetch URLs, storage keys and links carry no
 * city marker; every other city adds `city=<slug>` and suffixes its storage keys with `:<slug>`.
 */

import {
  isZbSlug,
  ZB_CITIES,
  ZB_SLUGS,
  zbCityOf,
  type ZbCity,
  type ZbSlug,
} from "@/lib/shared/cities";

export type City = "bb" | ZbSlug;

export interface CityConfig {
  name: string;
  /** the operator line under the city name in the city chooser */
  agency: string;
  center: [number, number];
  zoom: number;
  /** zoom from which stop markers are drawn (GZM has ~7400 stops, so one level later) */
  stopMinZoom: number;
  /** the operator's mark in the city chooser (a logo under /logos/ sits on a white tile); null = monogram */
  logo: string | null;
  /** a zbiorkom city's operator colour (vehicle pills, stops, line badges); null = BB, which colours by operator */
  color: string | null;
  /** lines drawn in their own colour (Warsaw's metro) */
  lineColors?: Readonly<Record<string, string>>;
  vehiclesRefreshMs: number;
  /** extra data credit, plain text (no markup): rendered in the menu and in the Leaflet attribution */
  attribution: string | null;
}

/* operator marks in public/logos (sources and licences: public/logos/SOURCES.md); the rest get a monogram */
const LOGO_SVG = new Set(["elk", "krasnik", "opole", "poznan", "przemysl", "szczecin", "warsaw", "zielonaGora"]);
const LOGO_PNG = new Set([
  "bialystok", "boleslawiec", "chelm", "cieszyn", "czestochowa", "elblag", "gorzow", "kalisz", "kielce",
  "kolobrzeg", "konin", "koszalin", "krakow", "kutno", "legnica", "leszno", "lodz", "mielec", "olsztyn",
  "ostroleka", "ostrowiecSwietokrzyski", "oswiecim", "pila", "piotrkowTrybunalski", "plock", "radom",
  "rzeszow", "siedlce", "skarzyskoKamienna", "slupsk", "stalowaWola", "swinoujscie", "tarnow", "tomaszowMazowiecki",
  "torun", "tricity", "wroclaw", "zywiec",
]);

function zbConfig(slug: ZbSlug): CityConfig {
  const c: ZbCity = ZB_CITIES[slug];
  return {
    name: c.name,
    agency: c.agency,
    center: c.center,
    zoom: c.zoom,
    stopMinZoom: c.stopMinZoom ?? 14,
    logo: LOGO_SVG.has(slug) ? `/logos/${slug}.svg` : LOGO_PNG.has(slug) ? `/logos/${slug}.png` : null,
    color: c.color ?? "#475569",
    lineColors: c.lineColors,
    // zbiorkom publishes positions on a 20 s grid and the server polls it only while a page asks
    vehiclesRefreshMs: 10_000,
    attribution: c.agency,
  };
}

export const CITY: Record<City, CityConfig> = {
  bb: {
    name: "Bielsko-Biała",
    agency: "Komunikacja Beskidzka i MZK Bielsko-Biała",
    center: [49.822, 19.046],
    zoom: 11,
    stopMinZoom: 14,
    logo: "/brand.svg",
    color: null,
    vehiclesRefreshMs: 4000,
    attribution: null,
  },
  ...(Object.fromEntries(ZB_SLUGS.map((s) => [s, zbConfig(s)])) as Record<
    ZbSlug,
    CityConfig
  >),
  gzm: {
    name: "Metropolia GZM",
    agency: "Autobusy, tramwaje i trolejbusy ZTM",
    center: [50.2615, 19.0273],
    zoom: 11,
    stopMinZoom: 15,
    logo: "/gzm-logo.svg",
    color: ZB_CITIES.gzm.color,
    // the server's SDIP overlay moves a vehicle every ~5 s (p50); it polls SDIP only while this is requested
    vehiclesRefreshMs: 5000,
    attribution: "ZTM / Metropolia GZM (CC BY), Metrorower (nextbike GBFS)",
  },
};

/** every zbiorkom city but GZM, by Polish name: the "Inne miasto" lists */
export const OTHER_CITIES: readonly { id: ZbSlug; label: string }[] =
  ZB_SLUGS.filter((s) => s !== "gzm")
    .map((id) => ({ id, label: CITY[id].name }))
    .sort((a, b) => a.label.localeCompare(b.label, "pl"));


/** Shown instead of a generic error while the server answers 503 "Data is loading" (a city's feed still loading). */
export const GZM_LOADING =
  "Dane miasta jeszcze się wczytują, spróbuj za chwilę.";

const KEY = "kb:city";
const APP_PARAMS = ["stop", "exec", "trip", "lines", "map"] as const;

export function isCity(v: unknown): v is City {
  return v === "bb" || isZbSlug(v);
}

/* the page's city for code outside React (the imperative Leaflet icon factory): set once before MapApp mounts */
let pageCity: City = "bb";
export function setPageCity(c: City): void {
  pageCity = c;
  // stop markers draw in var(--color-gzm), the colour of every zbiorkom city's dialect: this city's own
  const color = CITY[c].color;
  if (color) document.documentElement.style.setProperty("--color-gzm", color);
}
export const getPageCity = (): City => pageCity;

/** A storage key of the city: BB keeps the bare key, every other city suffixes its slug. */
export const cityKey = (base: string, city: City): string =>
  city === "bb" ? base : `${base}:${city}`;

/** The city of an id from any id space: a zbiorkom id carries its "<slug>:" prefix, all others are BB. */
export function cityOfId(id: string | number | null | undefined): City {
  return zbCityOf(id) ?? "bb";
}

/**
 * Which city a page load shows. The URL decides first: ?city=<slug> or a prefixed stop/exec/trip id names
 * that city, any other app param (an old BB deep link) means BB. Without either, the stored choice; null
 * when there is none (show the picker).
 */
export function resolveCity(search: string, stored: string | null): City | null {
  const p = new URLSearchParams(search);
  const c = p.get("city");
  if (isCity(c)) return c;
  for (const k of ["stop", "exec", "trip"]) {
    const id = cityOfId(p.get(k));
    if (id !== "bb") return id;
  }
  if (APP_PARAMS.some((k) => p.has(k))) return "bb";
  return isCity(stored) ? stored : null;
}

/** A "?..." search string with the city marker; BB is returned unchanged. */
export function withCity(search: string, city: City): string {
  if (city === "bb") return search;
  const p = new URLSearchParams(search);
  p.set("city", city);
  return `?${p.toString()}`;
}

/** An API path for the city; BB is returned unchanged. */
export function cityUrl(path: string, city: City): string {
  if (city === "bb") return path;
  return `${path}${path.includes("?") ? "&" : "?"}city=${city}`;
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

/* a full navigation: every store, poll and cache of the page is keyed to one city */
export function switchCity(next: City): void {
  saveCity(next);
  window.location.assign(next === "bb" ? "/" : `/?city=${next}`);
}
