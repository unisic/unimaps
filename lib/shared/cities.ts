/**
 * Cities served from zbiorkom.live's open api6 (merged GTFS + live positions), keyed by their zbiorkom
 * slug. The slug is the `?city=` value, the id prefix (`krakow:<stop_id>`, `krakow:<type>_<vehicle>`)
 * and the storage-key suffix. Shared by the server and the client: no Node imports.
 * "gzm" is the first and fullest of them (SDIP overlay, fleet history, news); the rest get the
 * feed and the positions only, loaded on first request (lib/gzm-feed.ts).
 */
import data from "./cities.json" with { type: "json" };

export interface ZbCity {
  name: string;
  /** operator / organiser: the data credit and the stop and trip labels */
  agency: string;
  center: [number, number];
  zoom: number;
  /** zoom from which stop markers are drawn (default 14; the ~7000-stop networks one level later) */
  stopMinZoom?: number;
  /** vehicle pills, stops and line badges: the main colour of the operator's logo (public/logos), darkened to
   *  4.5:1 under white text; absent (no logo, or a grey one) = slate */
  color?: string;
  /** lines in their own colour instead of `color` (the feed's route_color, same 4.5:1 rule) */
  lineColors?: Readonly<Record<string, string>>;
}

/** The data lives in cities.json: the Rust backend (backend/src/shared/cities.rs) reads the same file. A JSON
 *  import widens `center` to number[]; test/zb-cities.test.ts pins the shape. */
export const ZB_CITIES: Readonly<Record<ZbSlug, ZbCity>> = data as unknown as Record<ZbSlug, ZbCity>;

export type ZbSlug = keyof typeof data;

export const ZB_SLUGS = Object.keys(ZB_CITIES) as ZbSlug[];

export function isZbSlug(v: unknown): v is ZbSlug {
  return typeof v === "string" && Object.hasOwn(ZB_CITIES, v);
}

/** The zbiorkom city of a prefixed id ("krakow:1234", "gzm:283_4285"); null for a BB id (kb:, mzk:, plain). */
export function zbCityOf(id: unknown): ZbSlug | null {
  if (typeof id !== "string") return null;
  const i = id.indexOf(":");
  const p = i < 0 ? "" : id.slice(0, i);
  return isZbSlug(p) ? p : null;
}
