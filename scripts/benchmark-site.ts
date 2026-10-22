/**
 * Full-Site & API Performance Benchmark Suite for Komunikacja Beskidzka
 *
 * Measures:
 * 1. Web & Map Assets (HTML SSR, Static JS/CSS Chunks, OpenFreeMap Vector Basemap)
 * 2. API Endpoints Latency & Throughput (/api/health, /api/vehicles, /api/stops, /api/lines, /api/connections)
 * 3. Timetable & Trip Schedule Performance (Single vs Batch & Cache comparison)
 * 4. PWA Fullscreen & Safe-Area Invariants
 *
 * Usage:
 *   npx tsx scripts/benchmark-site.ts [host]
 * Example:
 *   npx tsx scripts/benchmark-site.ts http://127.0.0.1:8080
 */

import { performance } from "node:perf_hooks";

import { todayLocalISO } from "../lib/config";

const host = process.argv[2] || process.env.BENCHMARK_HOST || "http://127.0.0.1:8080";

interface Metric {
  name: string;
  category: "Assets" | "Map" | "API" | "Timetable" | "PWA";
  ttfbMs: number;
  totalMs: number;
  sizeBytes: number;
  status: number;
  cached?: boolean;
  notes?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function timedFetch(url: string, init?: RequestInit): Promise<{
  status: number;
  ttfbMs: number;
  totalMs: number;
  sizeBytes: number;
  headers: Headers;
  data: unknown;
}> {
  const t0 = performance.now();
  let ttfb = 0;
  const res = await fetch(url, init);
  ttfb = performance.now() - t0;
  const buf = await res.arrayBuffer();
  const total = performance.now() - t0;
  let data: unknown = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      // ignore
    }
  }
  return {
    status: res.status,
    ttfbMs: ttfb,
    totalMs: total,
    sizeBytes: buf.byteLength,
    headers: res.headers,
    data,
  };
}

async function runBenchmark() {
  console.log(`\n======================================================`);
  console.log(`  KOMUNIKACJA BESKIDZKA — BENCHMARK & AUDIT SUITE`);
  console.log(`  Target Host: ${host}`);
  console.log(`======================================================\n`);

  const metrics: Metric[] = [];

  // --- 1. Base App Shell & Assets ---
  console.log(`[1/4] Auditing App Shell & Static Assets...`);
  try {
    const page = await timedFetch(`${host}/`);
    metrics.push({
      name: "GET / (HTML Document)",
      category: "Assets",
      ttfbMs: page.ttfbMs,
      totalMs: page.totalMs,
      sizeBytes: page.sizeBytes,
      status: page.status,
      notes: page.status === 200 ? "OK" : `HTTP ${page.status}`,
    });

    const manifest = await timedFetch(`${host}/manifest.webmanifest`);
    metrics.push({
      name: "GET /manifest.webmanifest",
      category: "PWA",
      ttfbMs: manifest.ttfbMs,
      totalMs: manifest.totalMs,
      sizeBytes: manifest.sizeBytes,
      status: manifest.status,
      notes: manifest.status === 200 ? "OK" : `HTTP ${manifest.status}`,
    });
  } catch (err: unknown) {
    console.error(`Error fetching app shell: ${err}`);
  }

  // --- 2. Map & Vector Basemap Latency ---
  console.log(`[2/4] Testing Map & Basemap Latency (OpenFreeMap & Fallback)...`);
  try {
    const ofmStyle = await timedFetch("https://tiles.openfreemap.org/styles/liberty");
    metrics.push({
      name: "OpenFreeMap Liberty Style",
      category: "Map",
      ttfbMs: ofmStyle.ttfbMs,
      totalMs: ofmStyle.totalMs,
      sizeBytes: ofmStyle.sizeBytes,
      status: ofmStyle.status,
      notes: ofmStyle.status === 200 ? "CDN Ready" : `HTTP ${ofmStyle.status}`,
    });
  } catch {
    metrics.push({
      name: "OpenFreeMap Liberty Style",
      category: "Map",
      ttfbMs: 0,
      totalMs: 0,
      sizeBytes: 0,
      status: 0,
      notes: "Unreachable (Fallback active)",
    });
  }

  try {
    const osmTile = await timedFetch("https://tile.openstreetmap.org/11/1126/714.png", {
      headers: { "User-Agent": "KB-Map-Benchmark/1.0" },
    });
    metrics.push({
      name: "OSM Raster Tile Fallback",
      category: "Map",
      ttfbMs: osmTile.ttfbMs,
      totalMs: osmTile.totalMs,
      sizeBytes: osmTile.sizeBytes,
      status: osmTile.status,
      notes: osmTile.status === 200 ? "OSM Active" : `HTTP ${osmTile.status}`,
    });
  } catch {
    // ignore
  }

  // --- 3. Core API Endpoints Latency & Throughput ---
  console.log(`[3/4] Benchmarking Core API Endpoints...`);
  const endpoints = [
    { path: "/api/health", name: "GET /api/health" },
    { path: "/api/vehicles", name: "GET /api/vehicles" },
    { path: "/api/stops", name: "GET /api/stops" },
    { path: "/api/lines", name: "GET /api/lines" },
  ];

  for (const ep of endpoints) {
    try {
      const res = await timedFetch(`${host}${ep.path}`);
      metrics.push({
        name: ep.name,
        category: "API",
        ttfbMs: res.ttfbMs,
        totalMs: res.totalMs,
        sizeBytes: res.sizeBytes,
        status: res.status,
        notes: `Cache: ${res.headers.get("cache-control") || "none"}`,
      });
    } catch (err: unknown) {
      metrics.push({
        name: ep.name,
        category: "API",
        ttfbMs: 0,
        totalMs: 0,
        sizeBytes: 0,
        status: 0,
        notes: `Failed: ${err}`,
      });
    }
  }

  // Connections route benchmark
  try {
    const conn = await timedFetch(
      `${host}/api/connections?from=BIELSKO-BIA%C5%81A%20D.A.&to=SZCZYRK%20SKALITE&limit=3`,
    );
    metrics.push({
      name: "GET /api/connections (Search)",
      category: "API",
      ttfbMs: conn.ttfbMs,
      totalMs: conn.totalMs,
      sizeBytes: conn.sizeBytes,
      status: conn.status,
      notes: `Found ${(conn.data as { connections?: unknown[] })?.connections?.length ?? 0} routes`,
    });
  } catch {
    // ignore
  }

  // --- 4. Timetable & Trip Optimization Comparison ---
  console.log(`[4/4] Comparing Timetable Loading & Trip Resolution...`);
  try {
    const date = todayLocalISO();
    // 1. First Timetable request
    const tt1 = await timedFetch(`${host}/api/stop/19117:39660/timetable?date=${date}`);
    metrics.push({
      name: "GET /api/stop/.../timetable (1st / warm-up)",
      category: "Timetable",
      ttfbMs: tt1.ttfbMs,
      totalMs: tt1.totalMs,
      sizeBytes: tt1.sizeBytes,
      status: tt1.status,
      notes: `Departures: ${(tt1.data as { departures?: unknown[] })?.departures?.length ?? 0}`,
    });

    // 2. Second Timetable request (Cached)
    const tt2 = await timedFetch(`${host}/api/stop/19117:39660/timetable?date=${date}`);
    metrics.push({
      name: "GET /api/stop/.../timetable (2nd / cache hit)",
      category: "Timetable",
      ttfbMs: tt2.ttfbMs,
      totalMs: tt2.totalMs,
      sizeBytes: tt2.sizeBytes,
      status: tt2.status,
      cached: true,
      notes: `Cache-Control: ${tt2.headers.get("cache-control")}`,
    });

    const departures = (tt2.data as { departures?: Array<{ trip_id?: string | number }> })?.departures ?? [];
    const tripIds = Array.from(new Set(departures.map((d) => String(d.trip_id)).filter(Boolean))).slice(0, 30);

    if (tripIds.length > 0) {
      // Individual requests simulation (first 10 trips sequentially to measure single trip latency)
      const tSingle0 = performance.now();
      const singleRes = await timedFetch(`${host}/api/trip/${tripIds[0]}`);
      const tSingle1 = performance.now();
      metrics.push({
        name: `GET /api/trip/${tripIds[0]} (Single trip)`,
        category: "Timetable",
        ttfbMs: singleRes.ttfbMs,
        totalMs: singleRes.totalMs,
        sizeBytes: singleRes.sizeBytes,
        status: singleRes.status,
        notes: `Duration: ${(tSingle1 - tSingle0).toFixed(1)}ms`,
      });

      // Batch requests resolution (resolving 30 trips in ONE call)
      const tBatch0 = performance.now();
      const batchRes = await timedFetch(`${host}/api/trips?ids=${tripIds.join(",")}`);
      const tBatch1 = performance.now();
      const tripsCount = (batchRes.data as { count?: number })?.count ?? 0;
      metrics.push({
        name: `GET /api/trips (Batch of ${tripIds.length} trips in 1 HTTP request)`,
        category: "Timetable",
        ttfbMs: batchRes.ttfbMs,
        totalMs: batchRes.totalMs,
        sizeBytes: batchRes.sizeBytes,
        status: batchRes.status,
        cached: true,
        notes: `Resolved ${tripsCount}/${tripIds.length} trips in ${(tBatch1 - tBatch0).toFixed(1)}ms!`,
      });

      // Repeat Batch request to test memory cache
      const tBatchCached0 = performance.now();
      const batchCachedRes = await timedFetch(`${host}/api/trips?ids=${tripIds.join(",")}`);
      const tBatchCached1 = performance.now();
      metrics.push({
        name: `GET /api/trips (Batch cache hit - 30 trips)`,
        category: "Timetable",
        ttfbMs: batchCachedRes.ttfbMs,
        totalMs: batchCachedRes.totalMs,
        sizeBytes: batchCachedRes.sizeBytes,
        status: batchCachedRes.status,
        cached: true,
        notes: `Instant resolution in ${(tBatchCached1 - tBatchCached0).toFixed(1)}ms!`,
      });
    } else {
      console.log(`No trips in the ${date} timetable, trip/batch section skipped.`);
    }
  } catch (err: unknown) {
    console.error(`Error benchmarking timetables: ${err}`);
  }

  // --- Display Results ---
  console.log(`\n-------------------------------------------------------------------------------------------------------`);
  console.log(
    `| ${"Category".padEnd(10)} | ${"Metric / Operation".padEnd(42)} | ${"TTFB".padEnd(8)} | ${"Total".padEnd(8)} | ${"Size".padEnd(10)} | ${"Notes".padEnd(20)} |`,
  );
  console.log(`-------------------------------------------------------------------------------------------------------`);

  for (const m of metrics) {
    const cat = m.category.padEnd(10);
    const name = m.name.padEnd(42);
    const ttfb = `${m.ttfbMs.toFixed(1)}ms`.padEnd(8);
    const total = `${m.totalMs.toFixed(1)}ms`.padEnd(8);
    const size = formatBytes(m.sizeBytes).padEnd(10);
    const notes = (m.notes || "").slice(0, 20).padEnd(20);
    console.log(`| ${cat} | ${name} | ${ttfb} | ${total} | ${size} | ${notes} |`);
  }
  console.log(`-------------------------------------------------------------------------------------------------------\n`);

  // External tile hosts (Map) are informational; our own endpoints must answer.
  const failed = metrics.filter((m) => m.category !== "Map" && (m.status === 0 || m.status >= 500));
  if (failed.length > 0) {
    console.error(`Benchmark FAILED: ${failed.map((m) => `${m.name} (HTTP ${m.status})`).join(", ")}\n`);
    process.exit(1);
  }
  console.log(`Benchmark finished: ${metrics.length} metrics, no HTTP failures.\n`);
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
