/**
 * Crawls phototrans.eu into lib/phototrans.json: the current fleet of every mapped operator, each
 * vehicle's production year and its newest photos. Run it from a home connection (phototrans'
 * Cloudflare answers a datacenter IP with 403), then commit the file. One request per second; the
 * pages of a run are kept under --cache so a rerun the same day resumes, and removed after a
 * successful run (~1700 pages, ~170 MB while it runs, ~30 min).
 *
 * Usage:
 *   npm run build:phototrans
 *   npm run build:phototrans -- --cache output/phototrans-cache --photos 5
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { parseGroupPage, parseOperatorPage, parseVehiclePage, PT_BASE, ptKey, type PtGroup, type PtVehicle } from "../lib/phototrans";

/**
 * Fleet key prefix -> phototrans operator id. Without a phototrans operator so far: GZM companies
 * 2 (ZTM), 107 (Kłosok), 116 (Lazar), 117 (PKS Grodzisk), 131 (PKS Południe), 134 (PKS Gostynin); METEOR
 * (118) has phototrans operator 39, but with no current fleet listed (2026-11-03).
 */
const OPERATORS: { city: "bb" | "gzm"; prefix: string; op: number }[] = [
  { city: "bb", prefix: "", op: 35 }, // MZK Bielsko-Biała
  { city: "gzm", prefix: "104_", op: 72 }, // PKM Świerklaniec
  { city: "gzm", prefix: "108_", op: 69 }, // PKM Katowice
  { city: "gzm", prefix: "109_", op: 34442 }, // SimKol
  { city: "gzm", prefix: "110_", op: 149 }, // Transgór
  { city: "gzm", prefix: "114_", op: 212 }, // Nowak Transport
  { city: "gzm", prefix: "119_", op: 45 }, // PKM Sosnowiec
  { city: "gzm", prefix: "120_", op: 119 }, // PKM Gliwice
  { city: "gzm", prefix: "122_", op: 534 }, // Pawelec
  { city: "gzm", prefix: "125_", op: 123 }, // Tramwaje Śląskie
  { city: "gzm", prefix: "283_", op: 50 }, // PKM Tychy
  { city: "gzm", prefix: "284_", op: 274 }, // TLT
];

const UA = "unimaps-fleet-index/1.0 (+https://map.unisic.app)";
const PACE_MS = 1000;
const OUT = path.join("lib", "phototrans.json");

const { values } = parseArgs({
  options: {
    cache: { type: "string", default: path.join("output", "phototrans-cache") },
    photos: { type: "string", default: "5" },
  },
});
const maxPhotos = Math.max(0, Math.trunc(Number(values.photos)) || 0);
const cacheDir = path.join(values.cache as string, new Date().toISOString().slice(0, 10));
fs.mkdirSync(cacheDir, { recursive: true });

let nextAt = 0;
let fetched = 0;

async function get(page: string): Promise<string> {
  const file = path.join(cacheDir, page);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  for (let attempt = 1; ; attempt++) {
    await sleep(Math.max(0, nextAt - Date.now()));
    nextAt = Date.now() + PACE_MS;
    // the body is read inside the retry: a connection cut mid-body ("terminated") is retried like a failed fetch
    const res = await fetch(PT_BASE + page, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    })
      .then(async (r) => ({ status: r.status, html: r.ok ? await r.text() : null }))
      .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
    if (!(res instanceof Error) && res.html !== null) {
      fs.writeFileSync(file, res.html);
      if (++fetched % 100 === 0) console.log(`[phototrans] ${fetched} pages fetched`);
      return res.html;
    }
    if (!(res instanceof Error) && res.status === 403) {
      throw new Error(`${page}: HTTP 403 from phototrans' Cloudflare, run this from a home connection`);
    }
    const why = res instanceof Error ? res.message : `HTTP ${res.status}`;
    if (attempt >= 4) throw new Error(`${page}: ${why}`);
    console.warn(`[phototrans] ${page}: ${why}, retry ${attempt} in ${30 * attempt} s`);
    await sleep(30_000 * attempt);
  }
}

async function main(): Promise<void> {
  const groups: PtGroup[] = [];
  const vehicles: Record<string, PtVehicle> = {};
  /** photo count phototrans lists for a key: a number twice in one fleet keeps the better documented vehicle */
  const listed = new Map<string, number>();
  for (const o of OPERATORS) {
    const opGroups = parseOperatorPage(await get(`24,${o.op},0.html`));
    // a fleet that parses empty is a layout change, not an operator without vehicles
    if (opGroups.length === 0) throw new Error(`operator ${o.op}: no current fleet parsed`);
    let count = 0;
    for (const og of opGroups) {
      const gp = parseGroupPage(await get(`2415,${o.op},${og.id},0.html`));
      const g =
        groups.push({
          op: o.op,
          model: og.model,
          producer: og.producer,
          body: og.body,
          engine: og.engine,
          gearbox: og.gearbox,
          doors: gp.doors,
          since: og.since,
          kind: og.kind,
          modules: gp.modules,
        }) - 1;
      for (const veh of gp.vehicles) {
        // our fleet numbers are digits only
        if (!/^\d{1,6}$/.test(veh.number)) continue;
        const key = ptKey(o.city, o.prefix + veh.number);
        if ((listed.get(key) ?? -1) >= veh.photos) continue;
        listed.set(key, veh.photos);
        const page = parseVehiclePage(await get(`15,${veh.id},${o.op}.html`), maxPhotos);
        vehicles[key] = { g, v: veh.id, b: page.built, p: page.photos };
        count++;
      }
    }
    console.log(`[phototrans] operator ${o.op} (${o.city}:${o.prefix}): ${opGroups.length} groups, ${count} vehicles`);
  }

  // one entry per line: a rerun diffs vehicle by vehicle
  const keys = Object.keys(vehicles).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const body = [
    "{",
    `  "generated": ${JSON.stringify(new Date().toISOString().slice(0, 10))},`,
    `  "groups": [\n${groups.map((g) => `    ${JSON.stringify(g)}`).join(",\n")}\n  ],`,
    `  "vehicles": {\n${keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(vehicles[k])}`).join(",\n")}\n  }`,
    "}\n",
  ].join("\n");
  JSON.parse(body);
  fs.writeFileSync(`${OUT}.tmp`, body);
  fs.renameSync(`${OUT}.tmp`, OUT);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const withPhotos = keys.filter((k) => vehicles[k].p.length > 0).length;
  console.log(`[phototrans] ${OUT}: ${groups.length} groups, ${keys.length} vehicles, ${withPhotos} with photos, ${fetched} pages fetched`);
}

main().catch((err: unknown) => {
  console.error(`[phototrans] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
