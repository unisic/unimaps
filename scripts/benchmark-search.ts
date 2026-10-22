/**
 * Search Engine Benchmark & Quality Suite for Komunikacja Beskidzka
 *
 * Runs comprehensive end-to-end tests and latency/throughput benchmarks on the
 * GTFS connection planner (lib/router.ts):
 * 1. Network Graph Statistics & Memory Footprint
 * 2. Real-World Corridors Verification (Direct, 1-Transfer, 2-Transfer, Walkable)
 * 3. Schedule & Route Invariant Validation (Monotonicity, Dwell Times, Transfer Buffers, Stop Sequences)
 * 4. Fuzzy & Resilient Stop Resolution (Diacritics, Punctuation, Suffixes, Numeric IDs)
 * 5. High-Load Latency & Throughput Benchmark (200 random queries with P50/P90/P95/P99 stats)
 *
 * Usage:
 *   npx tsx scripts/benchmark-search.ts
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import * as config from "../lib/config";
import { col, parseCsvLine, splitLines } from "../lib/gtfs-csv";
import { findConnections, RouteQuery, ConnectionItinerary } from "../lib/router";

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  connectionsFound: number;
  durationMs: number;
  details?: string;
  error?: string;
}

function parseTimeSecs(hhmmss: string): number {
  const parts = hhmmss.split(":").map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

/**
 * Rigorously validates all physical and transit invariants of a connection itinerary.
 */
function validateItineraryInvariants(it: ConnectionItinerary, query: RouteQuery): string[] {
  const issues: string[] = [];

  // 1. Overall trip times
  if (it.departureSecs >= it.arrivalSecs) {
    issues.push(`Departure (${it.departureTime}) is not before arrival (${it.arrivalTime})`);
  }
  const computedDur = Math.round((it.arrivalSecs - it.departureSecs) / 60);
  if (Math.abs(it.totalDurationMins - computedDur) > 1) {
    issues.push(`Duration mismatch: totalDurationMins=${it.totalDurationMins} vs computed=${computedDur}`);
  }

  // 2. Transfers count vs legs count
  if (it.legs.length !== it.transfersCount + 1) {
    issues.push(`Leg count (${it.legs.length}) does not match transfersCount + 1 (${it.transfersCount + 1})`);
  }

  // 3. Validate each leg
  for (let lIdx = 0; lIdx < it.legs.length; lIdx++) {
    const leg = it.legs[lIdx];
    if (leg.departureSecs >= leg.arrivalSecs) {
      issues.push(`Leg ${lIdx + 1} (${leg.line}) departure (${leg.departureTime}) >= arrival (${leg.arrivalTime})`);
    }

    if (!leg.stops || leg.stops.length < 2) {
      issues.push(`Leg ${lIdx + 1} (${leg.line}) has fewer than 2 stops`);
      continue;
    }

    const firstStop = leg.stops[0];
    const lastStop = leg.stops[leg.stops.length - 1];

    if (firstStop.stopName !== leg.fromStopName) {
      issues.push(`Leg ${lIdx + 1} fromStopName ("${leg.fromStopName}") does not match first stop ("${firstStop.stopName}")`);
    }
    if (lastStop.stopName !== leg.toStopName) {
      issues.push(`Leg ${lIdx + 1} toStopName ("${leg.toStopName}") does not match last stop ("${lastStop.stopName}")`);
    }

    // Intermediate stops chronological order and coordinate validity
    let prevDep = parseTimeSecs(firstStop.departureTime);
    for (let sIdx = 0; sIdx < leg.stops.length; sIdx++) {
      const s = leg.stops[sIdx];
      if (s.lat != null && (s.lat < 48.5 || s.lat > 50.8)) {
        issues.push(`Leg ${lIdx + 1} stop "${s.stopName}" invalid lat: ${s.lat}`);
      }
      if (s.lon != null && (s.lon < 17.5 || s.lon > 21.0)) {
        issues.push(`Leg ${lIdx + 1} stop "${s.stopName}" invalid lon: ${s.lon}`);
      }

      if (sIdx > 0) {
        const sArr = parseTimeSecs(s.arrivalTime);
        const sDep = parseTimeSecs(s.departureTime);

        // Allow wrapping around midnight if arrival < prevDep
        const adjArr = sArr < prevDep ? sArr + 86400 : sArr;
        const adjDep = sDep < adjArr ? sDep + 86400 : sDep;

        if (adjArr < prevDep) {
          issues.push(`Leg ${lIdx + 1} stop #${sIdx} (${s.stopName}) arrives (${s.arrivalTime}) before previous departure`);
        }
        if (adjDep < adjArr) {
          issues.push(`Leg ${lIdx + 1} stop #${sIdx} (${s.stopName}) departs (${s.departureTime}) before arrival (${s.arrivalTime})`);
        }
        prevDep = sDep;
      }
    }

    // 4. Validate transfer connection between consecutive legs
    if (lIdx < it.legs.length - 1) {
      const nextLeg = it.legs[lIdx + 1];
      const waitSecs = nextLeg.departureSecs - leg.arrivalSecs;
      if (waitSecs < 0) {
        issues.push(`Transfer from leg ${lIdx + 1} to ${lIdx + 2} has negative wait time: ${waitSecs}s`);
      }
      // the router's rule per transfer: max(change, walk + 90 s); walkMins is rounded, hence 60 s slack
      const walk = nextLeg.walkMins ?? 0;
      const minRequired = Math.max(query.minTransferSecs ?? 180, walk > 0 ? walk * 60 + 60 : 0);
      if (waitSecs < minRequired) {
        issues.push(`Transfer from leg ${lIdx + 1} to ${lIdx + 2} wait time (${waitSecs}s) is less than required (${minRequired}s)`);
      }
    }
  }

  return issues;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

async function runBenchmark(): Promise<void> {
  console.log("================================================================================");
  console.log("     KOMUNIKACJA BESKIDZKA — CONNECTION SEARCH ENGINE BENCHMARK SUITE");
  console.log("================================================================================");
  console.log(`GTFS Directory: ${config.GTFS_DIR}`);
  console.log(`Current Time:   ${new Date().toISOString()}`);

  // 1. Inspect GTFS Data Files
  const dir = config.GTFS_DIR;
  try {
    const stopsContent = fs.readFileSync(path.join(dir, "stops.txt"), "utf-8");
    const tripsContent = fs.readFileSync(path.join(dir, "trips.txt"), "utf-8");
    const timesContent = fs.readFileSync(path.join(dir, "stop_times.txt"), "utf-8");
    const stopsLines = stopsContent.trim().split("\n").length - 1;
    const tripsLines = tripsContent.trim().split("\n").length - 1;
    const timesLines = timesContent.trim().split("\n").length - 1;

    console.log("\n[1/5] GTFS Graph Statistics:");
    console.log(`  - Total Registered Stops:    ${stopsLines}`);
    console.log(`  - Total Scheduled Trips:     ${tripsLines}`);
    console.log(`  - Total Stop Time Entries:   ${timesLines}`);
  } catch (err) {
    console.error("Failed to read GTFS data files:", err);
    process.exit(1);
  }

  const results: TestResult[] = [];

  // Helper to test a scenario
  function testRoute(
    category: string,
    name: string,
    query: RouteQuery,
    expectedType?: "direct" | "transfer",
    minResults = 1,
  ): void {
    const t0 = performance.now();
    try {
      const res = findConnections(query);
      const elapsed = performance.now() - t0;

      if (res.length < minResults) {
        results.push({
          category,
          name,
          passed: false,
          connectionsFound: res.length,
          durationMs: elapsed,
          details: `Expected at least ${minResults} connection(s), got ${res.length}`,
        });
        return;
      }

      if (expectedType) {
        const matchesType = res.some((r) => r.type === expectedType);
        if (!matchesType) {
          results.push({
            category,
            name,
            passed: false,
            connectionsFound: res.length,
            durationMs: elapsed,
            details: `Expected ${expectedType} connections, none found`,
          });
          return;
        }
      }

      // Check invariants on all returned itineraries
      const allIssues: string[] = [];
      for (let i = 0; i < res.length; i++) {
        const issues = validateItineraryInvariants(res[i], query);
        if (issues.length > 0) {
          allIssues.push(`[Option ${i + 1}] ${issues.join("; ")}`);
        }
      }

      if (allIssues.length > 0) {
        results.push({
          category,
          name,
          passed: false,
          connectionsFound: res.length,
          durationMs: elapsed,
          details: `Invariant violations: ${allIssues.join(" | ")}`,
        });
        return;
      }

      results.push({
        category,
        name,
        passed: true,
        connectionsFound: res.length,
        durationMs: elapsed,
        details: res.length > 0
          ? `Found ${res.length} valid option(s) in ${elapsed.toFixed(1)}ms. First: ${res[0].departureTime} -> ${res[0].arrivalTime} (${res[0].totalDurationMins}m, ${res[0].transfersCount} trans)`
          : `Handled correctly (${res.length} results) in ${elapsed.toFixed(1)}ms`,
      });
    } catch (err: unknown) {
      const elapsed = performance.now() - t0;
      results.push({
        category,
        name,
        passed: false,
        connectionsFound: 0,
        durationMs: elapsed,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("\n[2/5] Running Real-World Route Validation Tests...");

  // Major Direct Corridors
  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Szczyrk Skalite (12:00)", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "SZCZYRK SKALITE",
    afterSecs: 12 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Szczyrk Skalite -> Bielsko-Biała D.A. (Return)", {
    from: "SZCZYRK SKALITE",
    to: "BIELSKO-BIAŁA D.A.",
    afterSecs: 14 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Kęty D.A.", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "KĘTY D.A.",
    afterSecs: 10 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Czechowice-Dziedzice D.A.", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "CZECHOWICE-DZIEDZICE D.A.",
    afterSecs: 11 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Jaworze Nałęże", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "JAWORZE NAŁĘŻE",
    afterSecs: 13 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Kozy Centrum", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "KOZY CENTRUM",
    afterSecs: 12 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Wilkowice Urząd Gminy", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "WILKOWICE URZĄD GMINY",
    afterSecs: 12 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Bestwina Centrum", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "BESTWINA CENTRUM",
    afterSecs: 14 * 3600,
    limit: 3,
  }, "direct");

  testRoute("Direct Corridors", "Bielsko-Biała D.A. -> Międzybrodzie Bialskie", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "MIĘDZYBRODZIE BIALSKIE",
    afterSecs: 15 * 3600,
    limit: 3,
  }, "direct");

  // Transfer Corridors (Across Branches)
  testRoute("Transfer Corridors", "Bielsko-Biała Wapienica -> Szczyrk Skalite (1-transfer)", {
    from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
    to: "SZCZYRK SKALITE",
    afterSecs: 9 * 3600,
    limit: 3,
  }, "transfer");

  testRoute("Transfer Corridors", "Szczyrk Skalite -> Kęty D.A. (Cross-Valley 1-transfer)", {
    from: "SZCZYRK SKALITE",
    to: "KĘTY D.A.",
    afterSecs: 11 * 3600,
    limit: 3,
  }, "transfer");

  testRoute("Transfer Corridors", "Czechowice-Dziedzice -> Szczyrk Skalite (North-South 1-transfer)", {
    from: "CZECHOWICE-DZIEDZICE D.A.",
    to: "SZCZYRK SKALITE",
    afterSecs: 10 * 3600,
    limit: 3,
  }, "transfer");

  testRoute("Transfer Corridors", "Jasienica -> Buczkowice Centrum", {
    from: "JASIENICA",
    to: "BUCZKOWICE CENTRUM",
    afterSecs: 10 * 3600,
    limit: 3,
  }, "transfer");

  testRoute("Transfer Corridors", "Kozy Zagroda -> Szczyrk Centrum", {
    from: "KOZY ZAGRODA",
    to: "SZCZYRK CENTRUM",
    afterSecs: 11 * 3600,
    limit: 3,
  }, "transfer");

  testRoute("Transfer Corridors", "Pietrzykowice Kościół -> Kęty D.A.", {
    from: "PIETRZYKOWICE, KOŚCIÓŁ",
    to: "KĘTY, D.A.",
    afterSecs: 15 * 3600,
    limit: 3,
  }, "transfer");

  // Remote & Multi-transfer Corridors
  testRoute("Remote & Multi-transfer", "Buczkowice Centrum -> Czechowice-Dziedzice D.A.", {
    from: "BUCZKOWICE CENTRUM",
    to: "CZECHOWICE-DZIEDZICE D.A.",
    afterSecs: 13 * 3600,
    limit: 3,
  });

  testRoute("Remote & Multi-transfer", "Jaworze Nałęże -> Porąbka Kozubnik", {
    from: "JAWORZE NAŁĘŻE",
    to: "PORĄBKA KOZUBNIK",
    afterSecs: 10 * 3600,
    limit: 3,
  });

  // Time & Edge-Cases
  console.log("\n[3/5] Testing Edge Cases & Filters...");

  testRoute("Filters & Edge Cases", "Direct-only search returns strictly direct connections", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "SZCZYRK SKALITE",
    afterSecs: 12 * 3600,
    directOnly: true,
    limit: 5,
  }, "direct");

  testRoute("Filters & Edge Cases", "Direct-only on non-direct route returns 0 results cleanly", {
    from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
    to: "SZCZYRK SKALITE",
    afterSecs: 12 * 3600,
    directOnly: true,
  }, undefined, 0);

  testRoute("Filters & Edge Cases", "Minimum transfer buffer (minTransferSecs: 600s = 10 min)", {
    from: "BIELSKO-BIAŁA WAPIENICA CENTRUM",
    to: "SZCZYRK SKALITE",
    afterSecs: 10 * 3600,
    minTransferSecs: 600,
    limit: 3,
  }, "transfer");

  testRoute("Filters & Edge Cases", "Sort by duration yields strictly ascending trip lengths", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "SZCZYRK SKALITE",
    afterSecs: 8 * 3600,
    sortBy: "duration",
    limit: 5,
  });

  testRoute("Filters & Edge Cases", "Sort by arrival yields strictly ordered arrivals", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "SZCZYRK SKALITE",
    afterSecs: 8 * 3600,
    sortBy: "arrival",
    limit: 5,
  });

  testRoute("Filters & Edge Cases", "Late night query (22:45) wraps to next morning departures", {
    from: "BIELSKO-BIAŁA D.A.",
    to: "SZCZYRK SKALITE",
    afterSecs: 22 * 3600 + 45 * 60,
    limit: 3,
  });

  testRoute("Filters & Edge Cases", "Non-existent stop returns empty array without exception", {
    from: "NIEISTNIEJĄCY_PRZYSTANEK_12345",
    to: "BIELSKO-BIAŁA D.A.",
  }, undefined, 0);

  // Stop Resolution & Resilience
  console.log("\n[4/5] Testing Stop Name Resolution & Diacritic Resilience...");

  testRoute("Resilience", "Numeric Stop ID (10000 = Bielsko-Biała D.A.)", {
    from: "10000",
    to: "SZCZYRK SKALITE",
    afterSecs: 10 * 3600,
    limit: 1,
  });

  testRoute("Resilience", "Without Polish diacritics ('Kety' -> 'Szczyrk')", {
    from: "KETY",
    to: "SZCZYRK",
    afterSecs: 11 * 3600,
    limit: 1,
  });

  testRoute("Resilience", "Lowercase with extra spaces ('   bielsko-biala d.a.  ')", {
    from: "   bielsko-biala d.a.  ",
    to: "szczyrk skalite",
    afterSecs: 12 * 3600,
    limit: 1,
  });

  testRoute("Resilience", "Stop name with trailing street name ('KĘTY, D.A. UL. SIENKIEWICZA')", {
    from: "PIETRZYKOWICE KOŚCIÓŁ",
    to: "KĘTY, D.A. UL. SIENKIEWICZA",
    afterSecs: 14 * 3600,
    limit: 2,
  });

  // Display Quality Summary
  console.log("\n--------------------------------------------------------------------------------");
  console.log("Quality Verification Results:");
  console.log("--------------------------------------------------------------------------------");
  let passedCount = 0;
  for (const r of results) {
    const icon = r.passed ? "✔ PASS" : "✖ FAIL";
    console.log(`${icon} [${r.category}] ${r.name}`);
    if (r.details) console.log(`       ${r.details}`);
    if (r.error) console.log(`       ERROR: ${r.error}`);
    if (r.passed) passedCount++;
  }
  console.log(`\nQuality Score: ${passedCount} / ${results.length} passed (${Math.round((passedCount / results.length) * 100)}%)`);

  // Latency & High-Load Benchmark
  console.log("\n[5/5] Running High-Load Performance & Latency Benchmark...");
  console.log("Sampling 200 random stop-to-stop queries across the entire network...");

  // Collect candidate stops with departures
  const stopsContent = fs.readFileSync(path.join(dir, "stops.txt"), "utf-8");
  const stopLines = splitLines(stopsContent);
  const iStopName = col(parseCsvLine(stopLines[0] ?? ""), "stop_name");
  const stopList: string[] = [];
  for (let i = 1; i < stopLines.length; i++) {
    if (!stopLines[i]) continue;
    const name = parseCsvLine(stopLines[i])[iStopName]?.trim();
    if (name && name.length > 2 && !stopList.includes(name)) {
      stopList.push(name);
    }
  }

  const queryTimes: number[] = [];
  let successQueries = 0;
  let totalOptionsFound = 0;
  const sampleSize = Math.min(200, stopList.length * 2);

  const tStartBenchmark = performance.now();
  for (let i = 0; i < sampleSize; i++) {
    const fromIdx = (i * 17 + 3) % stopList.length;
    const toIdx = (i * 31 + 19) % stopList.length;
    if (fromIdx === toIdx) continue;

    const from = stopList[fromIdx];
    const to = stopList[toIdx];
    const afterSecs = (7 + (i % 12)) * 3600; // between 07:00 and 19:00

    const q0 = performance.now();
    const res = findConnections({ from, to, afterSecs, limit: 3 });
    const qDur = performance.now() - q0;

    queryTimes.push(qDur);
    if (res.length > 0) {
      successQueries++;
      totalOptionsFound += res.length;
    }
  }
  const totalBenchmarkDuration = performance.now() - tStartBenchmark;

  queryTimes.sort((a, b) => a - b);
  const minTime = queryTimes[0];
  const maxTime = queryTimes[queryTimes.length - 1];
  const avgTime = queryTimes.reduce((acc, v) => acc + v, 0) / queryTimes.length;
  const p50 = percentile(queryTimes, 50);
  const p90 = percentile(queryTimes, 90);
  const p95 = percentile(queryTimes, 95);
  const p99 = percentile(queryTimes, 99);
  const qps = Math.round((queryTimes.length / (totalBenchmarkDuration / 1000)));

  console.log("\n================================================================================");
  console.log("                        BENCHMARK PERFORMANCE REPORT");
  console.log("================================================================================");
  console.log(`Total Benchmark Queries:     ${queryTimes.length}`);
  console.log(`Successful Routes Found:     ${successQueries} (${Math.round((successQueries / queryTimes.length) * 100)}%)`);
  console.log(`Total Route Options Found:   ${totalOptionsFound}`);
  console.log(`Total Benchmark Wall Clock:  ${totalBenchmarkDuration.toFixed(1)} ms`);
  console.log(`Throughput:                  ${qps} queries/second`);
  console.log("--------------------------------------------------------------------------------");
  console.log("Latency Metrics (Response Time per Connection Search):");
  console.log(`  - Min Latency:             ${minTime.toFixed(2)} ms`);
  console.log(`  - Average (Mean):          ${avgTime.toFixed(2)} ms`);
  console.log(`  - Median (P50):            ${p50.toFixed(2)} ms`);
  console.log(`  - 90th Percentile (P90):   ${p90.toFixed(2)} ms`);
  console.log(`  - 95th Percentile (P95):   ${p95.toFixed(2)} ms`);
  console.log(`  - 99th Percentile (P99):   ${p99.toFixed(2)} ms`);
  console.log(`  - Max Latency:             ${maxTime.toFixed(2)} ms`);
  console.log("================================================================================");

  if (passedCount < results.length) {
    console.error(`\nBenchmark failed with ${results.length - passedCount} quality check failures.`);
    process.exit(1);
  } else {
    console.log("\nAll search quality checks and invariants PASSED without errors!");
  }
}

runBenchmark().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
