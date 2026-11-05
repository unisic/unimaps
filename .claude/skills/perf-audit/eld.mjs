/**
 * Event-loop and memory sampler for the perf audit, preloaded without touching the app:
 *   node --import ./.claude/skills/perf-audit/eld.mjs dist/server.mjs 2> eld.log
 * Every ELD_MS (default 10 000) one `[eld] {...}` line on stderr: loop delay p50/p99/max in ms (the histogram
 * resolution, 10 ms, is the floor: p50 at ~10 means no lag), event-loop utilisation over the window, heap / rss /
 * external / arrayBuffers in MB (GTFS feeds live in typed arrays: arrayBuffers, not heapUsed) and the active
 * handles by type (Timeout, TCPSocketWrap, FSReqCallback, ...). The interval is unref'd: it never keeps the process up.
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const every = Number(process.env.ELD_MS) || 10_000;
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
let elu = performance.eventLoopUtilization();
setInterval(() => {
  const cur = performance.eventLoopUtilization();
  const d = performance.eventLoopUtilization(cur, elu);
  elu = cur;
  const m = process.memoryUsage();
  const res = {};
  for (const r of process.getActiveResourcesInfo()) res[r] = (res[r] ?? 0) + 1;
  const ms = (ns) => Math.round(ns / 1e4) / 100;
  console.error(
    `[eld] ${JSON.stringify({
      t: new Date().toISOString(),
      lagP50: ms(h.percentile(50)),
      lagP99: ms(h.percentile(99)),
      lagMax: ms(h.max),
      elu: Math.round(d.utilization * 1000) / 1000,
      heapMB: Math.round(m.heapUsed / 1e6),
      rssMB: Math.round(m.rss / 1e6),
      extMB: Math.round(m.external / 1e6),
      abMB: Math.round(m.arrayBuffers / 1e6),
      res,
    })}`,
  );
  h.reset();
}, every).unref();
