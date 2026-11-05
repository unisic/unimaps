/**
 * Fixed-mix HTTP load for the perf audit, against a LOCAL server and local-only routes:
 *   node .claude/skills/perf-audit/load.mjs <base url> <seconds> <clients> <path> [path...]
 *   node .claude/skills/perf-audit/load.mjs http://127.0.0.1:8090 60 20 "/api/vehicles?city=gzm" /api/stops
 * Each virtual client owns an x-forwarded-for (its own rate-limit bucket: clientIp() in lib/rate-limit.ts takes the
 * last entry), walks the paths round robin with one request in flight, and the run prints one JSON line per path:
 * count, req/s, p50/p95/p99/max ms and status counts. Latencies are kept per request: memory grows with the run.
 */
import { performance } from "node:perf_hooks";

const [base, secs, clients, ...paths] = process.argv.slice(2);
if (!base || !(Number(secs) > 0) || !(Number(clients) > 0) || paths.length === 0) {
  console.error("usage: load.mjs <base url> <seconds> <clients> <path> [path...]");
  process.exit(2);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) {
  console.error(`refused: ${base} is not a local server`);
  process.exit(2);
}
// answered from memory or local files only: every other route reaches KiedyPrzyjedzie, MZK OnTime, zbiorkom,
// Photon or OSRM (a GZM trip opens an OSRM match), and the audit never puts load on them
const LOCAL =
  /^\/(?:$|\?|assets\/|[a-z]+(?:\.html)?(?:\?|$)|api\/(?:vehicles|stops|connections|line|shapes|health|gtfs-rt\.pb)(?:[?/]|$)|api\/stop\/gzm:)/;
for (const p of paths) {
  if (!LOCAL.test(p)) {
    console.error(`refused: ${p} may reach an upstream`);
    process.exit(2);
  }
}

const end = performance.now() + Number(secs) * 1000;
const stats = new Map(paths.map((p) => [p, { ms: [], status: {} }]));

async function client(i) {
  const headers = { "x-forwarded-for": `10.77.${i >> 8}.${i & 255}` };
  for (let n = i; performance.now() < end; n++) {
    const p = paths[n % paths.length];
    const t0 = performance.now();
    let code;
    try {
      const r = await fetch(base + p, { headers });
      await r.arrayBuffer();
      code = r.status;
    } catch (err) {
      code = err?.cause?.code ?? "error";
    }
    const s = stats.get(p);
    s.ms.push(performance.now() - t0);
    s.status[code] = (s.status[code] ?? 0) + 1;
  }
}

await Promise.all(Array.from({ length: Number(clients) }, (_, i) => client(i)));
const at = (a, f) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * f))] * 10) / 10;
for (const [path, s] of stats) {
  const a = s.ms.sort((x, y) => x - y);
  if (a.length === 0) continue;
  const rps = Math.round((a.length / Number(secs)) * 10) / 10;
  console.log(JSON.stringify({ path, n: a.length, rps, p50: at(a, 0.5), p95: at(a, 0.95), p99: at(a, 0.99), max: at(a, 1), status: s.status }));
}
