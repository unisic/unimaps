/**
 * Vehicle data and photos from phototrans.eu for the GZM and MZK Bielsko-Biała fleet cards.
 * phototrans' Cloudflare refuses datacenter IPs (production got 403 on every lookup), so the server
 * never contacts it: `npm run build:phototrans` crawls the operators' current fleet from a home
 * connection into lib/phototrans.json, esbuild bundles that file into dist/server.mjs, and the
 * browser loads each thumbnail from phototrans itself.
 */
import type { FleetFuelType, FleetLengthCategory, VehiclePhoto, VehicleTech } from "./shared/fleet";
import data from "./phototrans.json" with { type: "json" };

export const PT_BASE = "https://phototrans.eu/";

/** one phototrans vehicle group (a model series of one operator) */
export interface PtGroup {
  /** phototrans operator id */
  op: number;
  model: string;
  producer: string;
  body: string;
  engine: string;
  gearbox: string;
  doors: string;
  /** "Year Of Get" of the group: the year the operator took it over */
  since: number | null;
  /** fleet section: "Bus", "Tram" or "Trolleybus" */
  kind: string;
  modules: number | null;
}

export interface PtVehicle {
  /** index into `groups` */
  g: number;
  /** phototrans vehicle page id */
  v: number;
  /** production year */
  b: number | null;
  /** newest photos first: [thumbnail path "<dir>/<photo id>", author, date YYYY-MM-DD or ""] */
  p: string[][];
}

export interface PtIndex {
  generated: string;
  groups: PtGroup[];
  /** key `<city>:<side number>`: "gzm:108_410", "bb:123" (leading zeros dropped) */
  vehicles: Record<string, PtVehicle>;
}

const INDEX: PtIndex = data;

export const ptKey = (city: "bb" | "gzm", side: string) => `${city}:${side.replace(/(^|_)0+(?=\d)/g, "$1")}`;

export interface PtLookup {
  group: PtGroup;
  len: FleetLengthCategory | null;
  fuel: FleetFuelType | null;
  tech: VehicleTech;
  photos: VehiclePhoto[];
}

/** The index entry of one fleet vehicle, null when phototrans has none. */
export function ptVehicle(city: "bb" | "gzm", side: string): PtLookup | null {
  const key = ptKey(city, side);
  const v = Object.hasOwn(INDEX.vehicles, key) ? INDEX.vehicles[key] : undefined;
  const group = v ? INDEX.groups[v.g] : undefined;
  if (!v || !group) return null;
  return {
    group,
    len: lengthOf(group.model, group.modules, group.kind),
    fuel: fuelOf(group.model, group.engine, group.kind),
    tech: {
      ...(group.body ? { body: group.body } : {}),
      ...(group.engine ? { engine: group.engine } : {}),
      ...(group.gearbox ? { gearbox: group.gearbox } : {}),
      ...(group.doors ? { doors: group.doors } : {}),
      ...(v.b !== null ? { built: v.b } : {}),
      ...(group.since !== null ? { since: group.since } : {}),
      page: `${PT_BASE}15,${v.v},${group.op}.html`,
    },
    photos: v.p.map(([thumb, author, date]) => ({
      thumb: `${PT_BASE}images/photos/thumbnail/${thumb}.jpg`,
      page: `${PT_BASE}14,${thumb.slice(thumb.indexOf("/") + 1)},0.html`,
      author,
      date: date || null,
    })),
  };
}

// ---- page parsers (used by scripts/build-phototrans.ts) ----

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** fleet sections of an operator page that carry passengers */
const KINDS = new Set(["Bus", "Tram", "Trolleybus"]);

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const year = (s: string): number | null => (/^\d{4}$/.test(s) ? Number(s) : null);

export interface PtOperatorGroup {
  id: number;
  kind: string;
  model: string;
  producer: string;
  body: string;
  engine: string;
  gearbox: string;
  since: number | null;
  /** vehicles in service, the N of the row's "N/M" (a current group keeps its withdrawn ones: Jelcz M11 = 1/67) */
  active: number | null;
}

/** The current-fleet groups (bus, tram, trolleybus) of an operator page `24,<op>,0.html`. */
export function parseOperatorPage(html: string): PtOperatorGroup[] {
  const from = html.indexOf("<h4>Current fleet");
  if (from < 0) return [];
  const to = html.indexOf("<h4>Historic Fleet", from);
  const out: PtOperatorGroup[] = [];
  for (const part of html.slice(from, to < 0 ? undefined : to).split("<h5>").slice(1)) {
    const kind = part.slice(0, part.indexOf("<")).trim();
    if (!KINDS.has(kind)) continue;
    for (const row of part.matchAll(/<tr><td><a href="2415,\d+,(\d+),0\.html">[\s\S]*?<\/tr>/g)) {
      // numbers, model, manufacturer, body, chassis, engine, gearbox, year of get, year of remove, photos, in service/all
      const c = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
      if (c.length < 9) continue;
      const active = /^(\d+)\/\d+$/.exec(c[10] ?? "");
      out.push({
        id: Number(row[1]),
        kind,
        model: c[1],
        producer: c[2],
        body: c[3],
        engine: c[5],
        gearbox: c[6],
        since: year(c[7]),
        active: active ? Number(active[1]) : null,
      });
    }
  }
  return out;
}

export interface PtGroupPage {
  doors: string;
  modules: number | null;
  /** in-service vehicles only: fleet number as printed, vehicle page id, photo count */
  vehicles: { number: string; id: number; photos: number }[];
  /** rows in service, numbered or not: the N of the operator page's "N/M" (a vehicle without a number has no key) */
  inService: number;
}

/** Group page `2415,<op>,<group>,0.html`: its details and its vehicles still in service. */
export function parseGroupPage(html: string): PtGroupPage {
  const details = new Map<string, string>();
  for (const m of html.matchAll(/<td class="gensmall">([^<]+)<\/td><td class="gensmall" style="font-weight: bold">([\s\S]*?)<\/td>/g)) {
    details.set(text(m[1]), text(m[2]));
  }
  const vehicles: PtGroupPage["vehicles"] = [];
  // one block per vehicle: its number cell opens it (rowspan=2), the photo link closes it. The cell's class is the
  // vehicle's status: row_service in service, row_spisan withdrawn (a "current" group keeps its withdrawn vehicles:
  // PKM Sosnowiec's Jelcz M11 lists 66, one of them running), and a withdrawn number is often reused
  const parts = html.split(/<td class="?(row_\w+)"? rowspan=2>/);
  let inService = 0;
  for (let i = 1; i + 1 < parts.length; i += 2) {
    if (parts[i] !== "row_service") continue;
    inService++;
    const block = parts[i + 1];
    const num = /<b>([\s\S]*?)<\/b>/.exec(block);
    const link = /href="15,(\d+),\d+\.html">[^<]*\((\d+)\/\d+\)/.exec(block);
    const number = num ? text(num[1].split(/<br\s*\/?>/)[0]) : "";
    if (number && link) vehicles.push({ number, id: Number(link[1]), photos: Number(link[2]) });
  }
  const modules = Number(details.get("No. of modules"));
  return { doors: details.get("Design of doors") ?? "", modules: modules > 0 ? modules : null, vehicles, inService };
}

/** Vehicle page `15,<id>,<op>.html`: production year and the newest `max` photos. */
export function parseVehiclePage(html: string, max: number): { built: number | null; photos: string[][] } {
  const built = /<span class="genmed">Built<\/span><\/td><td class="row2"><span class="genmed">(\d{4})/.exec(html);
  const photos: string[][] = [];
  for (const block of html.split("class=rowtable>").slice(1)) {
    if (photos.length >= max) break;
    const img = /<img src="\/?images\/photos\/thumbnail\/(\d+\/\d+)\.jpg/.exec(block);
    const author = /Author: <a href="16,\d+,0\.html">([^<]+)<\/a>/.exec(block);
    if (!img || !author) continue;
    const d = /<b>(\d{1,2}) ([a-z]+) (\d{4})<\/b>/.exec(block);
    const month = d ? MONTHS.indexOf(d[2]) + 1 : 0;
    photos.push([img[1], text(author[1]), d && month ? `${d[3]}-${String(month).padStart(2, "0")}-${d[1].padStart(2, "0")}` : ""]);
  }
  return { built: built ? Number(built[1]) : null, photos };
}

/**
 * Length class from the model name and module count.
 * ponytail: reads the first standalone 1-2 digit length in the name ("Urbino 12", "Sancity 9LF");
 * a name without one stays null. A length field on phototrans would replace this.
 */
export function lengthOf(model: string, modules: number | null, kind: string): FleetLengthCategory | null {
  if (kind === "Tram") return null;
  if (modules !== null && modules >= 2) return "MEGA";
  const m = /(?<![\w.,])(\d{1,2}(?:[.,]\d{1,2})?)(?:m|M|LF)?(?![\w.,])/.exec(model);
  const len = m ? Number(m[1].replace(",", ".")) : NaN;
  if (!(len >= 6 && len <= 25)) return null;
  return len < 9.5 ? "MINI" : len < 11.5 ? "MIDI" : len <= 15 ? "MAXI" : "MEGA";
}

/** Propulsion from the model name and engine (a tram or trolleybus runs on the wire). */
export function fuelOf(model: string, engine: string, kind: string): FleetFuelType | null {
  const s = `${model} ${engine}`;
  if (/hydrogen|wodor|\bH2\b/i.test(s)) return "hydrogen";
  // "eCitaro", "e-Atak", "Irizar ie bus"
  if (kind === "Tram" || kind === "Trolleybus" || /electric|elektr|\bie\b/i.test(s) || /\be-?[A-Z]/.test(model)) return "electric";
  if (/hybrid/i.test(s)) return "hybrid";
  if (/\b[CL]NG\b/i.test(s)) return "cng";
  return engine ? "diesel" : null;
}
