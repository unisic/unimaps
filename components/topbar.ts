/* Shared by TopBar, TopBarSearch, VectorBaseLayer and MapApp: the basemap choices, their load status, the search handle. */

export type BaseLayerId = "kb" | "dark";

export type BaseLayer =
  | {
      /** MapLibre GL vector style (OpenFreeMap) — crisp, keyless, like zbiorkom */
      kind: "vector";
      name: string;
      style: string;
      /** optional CSS filter on the basemap canvas to tune brightness/contrast */
      filter?: string;
      /** paint overrides by layer id, applied when the style loads (a recolour costs nothing per frame, a filter does) */
      paint?: Record<string, Record<string, string>>;
    }
  | {
      /** classic raster XYZ tiles */
      kind: "raster";
      name: string;
      url: string;
      attribution: string;
    };

const OFM = (style: string) => `https://tiles.openfreemap.org/styles/${style}`;

/* OpenFreeMap's "dark" draws #181818 roads on a #0c0c0c ground under #656565 names: nothing to read at arm's length.
   Still black, but roads step up by class, water and green get a hue, and names are light on a ground-coloured halo.
   Layer ids as the style had them on 2026-11-13; an id it drops is skipped. */
const GROUND = "#0a0a0e";
const ROAD = { path: "#2b2b35", minor: "#34343f", major: "#474756", motorway: "#5c5c6e", casing: "#1b1b23" };
const RAIL = { "line-color": "#3f3f4b" };
const PLACE = { "text-color": "#cbc9d6", "text-halo-color": "rgba(10,10,14,0.85)" };
const DARK_PAINT: Record<string, Record<string, string>> = {
  background: { "background-color": GROUND },
  landuse_residential: { "fill-color": "#0e0e13" },
  water: { "fill-color": "#13212f" },
  waterway: { "line-color": "#13212f" },
  water_name: { "text-color": "#6f8fb3", "text-halo-color": GROUND },
  landcover_wood: { "fill-color": "#111a15" },
  landuse_park: { "fill-color": "#111a15" },
  building: { "fill-color": "#16161c", "fill-outline-color": "#24242d" },
  highway_path: { "line-color": ROAD.path },
  highway_minor: { "line-color": ROAD.minor },
  highway_major_casing: { "line-color": ROAD.casing },
  highway_major_inner: { "line-color": ROAD.major },
  highway_major_subtle: { "line-color": ROAD.major },
  highway_motorway_casing: { "line-color": ROAD.casing },
  highway_motorway_inner: { "line-color": ROAD.motorway },
  highway_motorway_subtle: { "line-color": ROAD.motorway },
  railway_transit: RAIL,
  railway_minor: RAIL,
  railway: RAIL,
  highway_name_other: { "text-color": "#a3a1b1", "text-halo-color": GROUND },
  highway_name_motorway: { "text-color": "#a3a1b1", "text-halo-color": GROUND },
  boundary_state: { "line-color": "#4a4a58" },
  "boundary_country_z5-": { "line-color": "#5a5a6a" },
  ...Object.fromEntries(
    ["other", "suburb", "village", "town", "city", "city_large", "state"].map((k) => [`place_${k}`, PLACE]),
  ),
};

export const BASE_LAYERS: Record<BaseLayerId, BaseLayer> = {
  kb: {
    kind: "vector",
    name: "Jasna",
    style: OFM("liberty"),
  },
  dark: {
    kind: "vector",
    name: "Ciemna",
    style: OFM("dark"),
    paint: DARK_PAINT,
  },
};

export const RASTER_FALLBACK: Record<BaseLayerId, { url: string; attribution: string; className?: string }> = {
  kb: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  dark: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: "raster-dark-filter",
  },
};

export type BasemapStatus = "loading" | "ready" | "failed";
export interface TopBarSearchHandle {
  focus: () => void;
  blur: () => void;
  clear: () => void;
}

