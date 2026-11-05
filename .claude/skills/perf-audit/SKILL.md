---
name: perf-audit
description: Performance and concurrency audit of Unimaps (one Node 24 process serving the API, the pollers and the static Svelte 5 + Leaflet client). Use when asked for a performance audit, "make it fast", idle CPU, memory growth, event-loop stalls, slow endpoints, map jank, PWA battery drain, or /perf-audit. Measures the shipped build first, never guesses, never puts load on the live upstreams, and ends with an evidence-backed report plus the minimal fixes that follow from it.
---

You are a senior performance engineer auditing Unimaps. You do not believe a performance claim, including your
own and including every number in CLAUDE.md, until a measurement taken in this session supports it.

Goals: fast request path, quiet idle, no memory growth, no CPU waste, a free event loop, a smooth map. Measure,
find the root cause, fix, measure again.

## Ground rules for this repo

Read these before taking a single number. Breaking one invalidates the audit.

1. **Shipped build only.** `npm run build`, then `node dist/server.mjs` (what `Dockerfile` runs, `node:24-alpine`;
   `package.json` engines `>=24`). Run `node -v` first: a different major is reported next to every number.
   `npm run dev` (tsx watch + Vite middleware) numbers are never reported as production numbers.
2. **Never put load on an upstream.** The pollers already poll KiedyPrzyjedzie, MZK OnTime, zbiorkom and SDIP at
   their own rhythm. That is the baseline, never something to raise. Load-test only routes answered from memory or
   local files, through `load.mjs` (it refuses the rest). Never loop: BB `/api/stop/<id>/departures|timetable`,
   `/api/trip*`, `/api/trip_execution`, `/api/geocode` (Photon), `/api/fleet*`, `/api/announcements`, and any GZM trip
   open (it starts an OSRM match on the public host). Never run `build:gtfs` or `build:phototrans` for an audit.
   `npm run benchmark:site` makes a handful of upstream calls (timetable, trip, trips): once is fine, never in a loop.
3. **Isolated instance.** Run the audit server on its own port and its own copy of `output/` (every path in
   `lib/config.ts` derives from `KB_OUTPUT_DIR`). Two processes on one `output/` share the shape-store lock and the
   fleet-history day files, and a production service worker on the dev port hijacks dev pages:
   ```bash
   S=<scratchpad>; cp -a output "$S/audit-output"
   KB_OUTPUT_DIR="$S/audit-output" PORT=8090 HOST=127.0.0.1 \
     node --import ./.claude/skills/perf-audit/eld.mjs dist/server.mjs 2> "$S/eld.log" > "$S/server.log" &
   ```
   With `output/gtfs` present no GTFS rebuild starts at boot. If the log shows a `lib/gtfs-refresh.ts` rebuild
   during a window (it hits upstream hard and skews everything), discard that window and rerun.
4. **Rate limit.** All local requests share one bucket unless each virtual client sends its own `x-forwarded-for`
   (`clientIp()` in `lib/rate-limit.ts` takes the last entry; `server/http.ts` sets it from the socket when absent).
   A load test without it measures 429s. `load.mjs` does this; report it.
5. **Live data varies.** Vehicle counts follow the clock (0 after midnight is normal). Record Europe/Warsaw time and
   the `/api/health` counters with every measurement, and compare only windows from the same hour band.
6. **Single process by design.** In-memory state (pollers, rate limit, caches, shape-store worker). Never propose
   multi-instance or serverless as a fix.
7. **Parity is pinned.** `test/` pins Python-parity semantics. A fix in `lib/` keeps `npm test` green without
   touching an expectation.

## 0. Stack (known: verify it has not changed)

Check `package.json`, `Dockerfile`, `vite.config.ts`, `server/routes.ts` and CLAUDE.md against this summary. Any
difference goes into the report.

| Part | What it is | Concurrency model |
| --- | --- | --- |
| Server | TypeScript, `node:http` (`server/http.ts`), esbuild bundle `dist/server.mjs`, Node 24 | one event loop; no `worker_threads`/`child_process` in `lib/` or `server/` (verify with `grep -rn "worker_threads\|child_process\|new Worker" lib server`) |
| Client | Svelte 5 runes, Vite static build in `out/`, Leaflet 1.9 + MapLibre GL (OpenFreeMap tiles) | browser main thread + one rAF loop (`lib/client/vehicleAnimator.ts`); MapLibre parses tiles in its own web workers |
| Data | in-memory Maps, typed arrays (GZM/zbiorkom feeds), JSON files in `output/` | sync and async fs on the same loop |

Failure modes this model permits, and the only ones you audit:
* server: loop stalls from synchronous work, unbounded Maps/queues, timers outliving their owner, unawaited
  promises and unhandled rejections, an async result applied after newer state replaced it, fd/socket leaks,
  missing fetch timeouts, GC pauses from allocation churn.
* client: long tasks, layout/style/composite storms, rAF or polling while hidden, effects re-running on every
  reactive read (CLAUDE.md: wrap non-deps in `untrack()`), Leaflet layers/listeners not removed, a stale fetch
  overwriting newer state (`tripSeq` in `MapApp.svelte`).
* Never report data races or lock-ordering deadlocks: there are no shared-memory threads and no locks, only the
  shape-store lock file between processes.

Entry points and hot paths (from CLAUDE.md, confirm in code before relying on any):
* boot: `server/main.ts` `boot()`, `lib/poller-singleton.ts` `startPoller()`, GZM feed parse (`lib/gzm-feed.ts`),
  stop merge (`lib/merged-stops.ts`), shape-store seed.
* request path: `server/http.ts` dispatch, `/api/vehicles` (BB `toJson()`; `?city=gzm` prebuilt body +
  `gzipSync` once per body change, `server/api/vehicles/route.ts`), `/api/stops` (ETag/304), `/api/connections`
  (RAPTOR, synchronous on the loop; see the `ponytail:` note in `lib/gzm.ts`), `/api/line` (O(trips) scan),
  `/api/shapes` (store read), GZM departures from the local feed.
* recurring: `LivePoller` (`lib/poller.ts`), `MzkPoller` (`lib/mzk-poller.ts`), `GzmLive` (`lib/gzm.ts`: zbiorkom +
  SDIP), zbiorkom cities (`getZb`/`startZb`, idle drop), shape store + OSRM (`lib/shape-store.ts`, `lib/osrm.ts`,
  `lib/gzm-match.ts`), fleet trackers (`lib/fleet-tracker.ts`), push ticks (`lib/push-alerts.ts`,
  `lib/push-news.ts`), `lib/gtfs-refresh.ts`.
* client: `MapShell.svelte` -> `MapApp.svelte`, `VehicleLayer` + `lib/client/fleetMarkers.ts` (`DENSE_FLEET`),
  `vehicleAnimator.ts`/`vehicleMotion.ts`, `StopsLayer`, `VectorBaseLayer`, `swr.svelte.ts`, `live-poll.ts`,
  `shapes.ts` (`fetchNewerShape`), `announcements.ts`.

## Tool mapping (fill the availability column before measuring)

Run `for t in strace perf pidstat bpftrace; do command -v $t || echo "$t missing"; done` and say which tools
were missing and what you used instead.

| Need | Server (Node 24, `dist/server.mjs`) | Client (Chromium, prod page from :8090) |
| --- | --- | --- |
| loop lag, ELU, memory over time | `eld.mjs` preload (above): `[eld]` line every `ELD_MS` | Performance monitor panel: CPU, JS heap, DOM nodes, JS event listeners, layouts/s, style recalcs/s |
| CPU profile | `node --cpu-prof --cpu-prof-dir="$S/prof" dist/server.mjs`, stop with SIGINT (exit handler in `server/http.ts`; confirm the `.cpuprofile` appeared), open in DevTools; targeted: `--inspect=127.0.0.1:9229` + chrome://inspect | Performance panel, 4x CPU throttle for a mid phone, screenshots on |
| heap and leaks | `--heapsnapshot-signal=SIGUSR2 --diagnostic-dir="$S/heap"`, `kill -USR2 <pid>` at T0 and T1, DevTools Memory > Comparison and retainers; `--heap-prof` for allocation sampling. A snapshot blocks the loop and doubles memory: take it outside a measured window | Memory panel: heap snapshots before/after 30 open-close cycles, filter "Detached"; allocation sampling |
| GC | `--trace-gc` for one window (verbose) | Performance panel GC events |
| wakeups, syscalls | `strace -f -c -p <pid>` (60 s), `perf stat -e task-clock,context-switches -p <pid> -- sleep 300`, `pidstat -u -w -p <pid> 10`; else `/proc/<pid>/stat` utime+stime and `/proc/<pid>/status` ctxt switches sampled twice | Performance panel idle recording: timers fired, frames |
| handles, fds | `res` in `eld.mjs` output; `ls /proc/<pid>/fd \| wc -l` sampled | n/a |
| load | `node .claude/skills/perf-audit/load.mjs <base> <s> <clients> <paths...>`; router: `npm run benchmark` | Lighthouse (mobile) for cold load; Long Tasks: `new PerformanceObserver(l => console.log(l.getEntries())).observe({type: "longtask", buffered: true})` |
| driving the browser | n/a | `claude-in-chrome` skill when available; otherwise exact manual steps in the report |

No new dependency for tooling: no autocannon, no clinic in `package.json`.

## 1. Architecture map

CLAUDE.md "Architecture" is the map. Verify each part you rely on against the code and note every drift. Then
list, with file:line:
* long-lived roots: `grep -rn 'Symbol.for("kb-gtfs' lib server`, module-level `new Map`/`new Set`/arrays in
  `lib/` and `server/`, client module stores (`external()` users: `favorites.ts`, `announcements.ts`).
* every timer: `grep -rn "setInterval\|setTimeout\|setImmediate\|requestAnimationFrame" lib server components app`.
* every synchronous fs/zlib call on the server: `grep -rn "Sync(" lib server --include=*.ts`.
* every outbound `fetch(` and whether it carries a timeout (`AbortSignal.timeout`) and a concurrency cap
  (`p-limit` 40 in `lib/kb-api.ts`, OSRM pace, SDIP).
* ownership: who starts and who stops each loop (`supervise()`, `GzmLive.stop()`, `dropZb`), and which listeners
  `MapApp` and the layers add to `map` and remove on destroy.

## 2. Memory

Leak here means unbounded reachable growth under GC, or leaked fds/sockets/timers. Prove each one with a heap
diff, an object count that grows per iteration and never falls, a positive live-bytes slope tied to one operation,
or a retainer path. RSS alone proves nothing.

Bounds documented in CLAUDE.md, each to verify in code (the bound and the eviction path), not to trust:
geocode memo 1000 / 24 h and 4 in flight, connections memo LRU 256, push 300 alerts / 6 per subscription,
news 500 subscriptions, gzm-match queue 20, `KB_ZB_RESIDENT` 2 cities + `KB_ZB_IDLE_MIN` 30, fleet history 28
(MZK) / 14 (GZM) days, frequencies expansion 20 000 trips per feed, departures-board micro-cache 4 s, the poller's
404 cache, `positions` with ghost pruning. Also check what has no documented bound: rate-limit buckets (keyed by a
client-supplied header on a directly exposed instance), board-cache keys, `GzmShapes` partial overlays, client
`swr()` entries.

Bounds multiply: GZM (always resident) + `KB_ZB_RESIDENT` x 25-60 MB per zbiorkom feed + fleet histories
(~5 + ~8 MB). Compute the reachable total and compare it with the container's memory.

Lifecycle loops (30 to 100 cycles, back to the same idle state, wait for cleanup, compare live bytes):
* server: cycle zbiorkom cities past `KB_ZB_RESIDENT`, using only slugs whose zip is already in
  `output/gzm/<slug>/gtfs.zip` (disk, not zbiorkom); `KB_ZB_IDLE_MIN=1` on the audit instance shortens the drop.
  `heapMB` and `abMB` must come back to baseline.
* client: open/close a stop sheet, a trip, the line view, a connection search, 30 times each, then GC and compare
  heap, detached nodes, listeners and `Object.keys(map._layers).length`.

## 3. CPU

Profile, never read code to guess. States: boot to ready, steady idle (BB pollers only), a full-scan tick (90 s
cycle), GZM watched (SDIP every 5 s) vs unwatched, `/api/vehicles?city=gzm` load, a `/api/connections` burst,
right after load stops. Hypotheses worth confirming or killing (not findings until measured): `gzipSync` per GZM
body change, synchronous `JSON.stringify` + `writeFileSync` in the shape store and fleet tracker, RAPTOR on the
loop, the `/api/line` scan, feed parse chunking, `toJson()` rebuilt per request vs per change.

Client: pan and zoom over GZM (~1000 vehicles) at zoom 12 (canvas dots) and 15 (pills), with smooth motion on and
off (`kb:smoothMotion`). Count layouts and composites per frame; a pill is a composited layer.

## 4. Idle

Server idle = no HTTP client for 5+ minutes. The BB pollers keep working by design; everything else must go quiet:
SDIP after 120 s without a GZM request, zbiorkom city positions after `WATCH_MS`, push ticks without pending
alerts/subscribers, the shape-store worker between entries. Report ELU, loop lag, CPU time, wakeups, the `res`
census and the heap slope over the window, at two sizes (BB only, and BB + GZM + one zbiorkom city resident).

Client idle = map open, no input, 5 minutes, then the tab hidden for 5 minutes. Visible: frames and CPU from the
animator plus the 4 s (BB) / 5 s (GZM) poll. Hidden: rAF, `swr` polling, `live-poll`, `fetchNewerShape` and the
map must all stop (count network requests and timers fired while hidden).

For every recurring source answer: why, how often, required, could it be event-driven, does it stop when idle or
hidden, does it stop when its owner goes away.

## 5. Concurrency (event loop)

* synchronous work on the loop, timed: anything over 50 ms on the request path is a finding with its stack.
* fire-and-forget: `void` promises and `.catch(() => {})` that hide real failures; `process.on("unhandledRejection")`
  behaviour.
* stale results: the poller's atomic stop-list swap, SDIP vs zbiorkom overlay ordering, `tripSeq` on the client,
  in-flight dedupe in `MzkApi`; name what makes each one safe (generation stamp, identity check, single writer).
* backpressure: `p-limit` queue depth under a slow upstream, the OSRM job queue, push sends, upstream retry loops
  and their backoff.
* re-entrancy: `supervise()` restarting a loop whose previous iteration still awaits.

## 6. Hangs and stalls

* every outbound `fetch` without a timeout can pin a poll loop forever; list them.
* shutdown: SIGTERM -> `server.close()` + exit after 100 ms, after the poller-singleton handlers flush stores
  synchronously. Time it with the stores at full size.
* GC pauses long enough to look like a stall (`--trace-gc` during GZM load).
* client: long tasks over 50 ms during open, pan, zoom, city boot; INP of opening a stop sheet.

## 7. Responsive path

Server: p50/p95/p99 of `/api/vehicles` (BB and GZM) and `/api/stops` while, in turn, a full scan runs, a
connections burst runs, a zbiorkom feed parses. The tail is the result, the mean hides the stall.
Client: frame p95 and worst frame during pan/zoom with the GZM fleet; time from city pick to first vehicles on the
map (MapShell preloads the first `/api/vehicles` in parallel with the map chunk; verify it still overlaps).

## 8. Timer and recurring-work inventory

Documented in CLAUDE.md, each to verify in code (interval, owner, stop condition) and measure:
server: LivePoller 90 s / 30 s / 10 s, MzkPoller 5 s, stop-list reloads (daily; MZK on unknown symbol, at most
10 min), GzmLive zbiorkom 10 s + SDIP 5 s while watched (5 min pause after 3 failures), zbiorkom city positions
while watched + 60 s idle sweep, gtfs-refresh daily, shape store one entry per 2 min + OSRM >= 1 s pace, push
alerts 30 s while pending, push news 15 min while subscribed, fleet history save debounce 30 s (MZK) / 120 s (GZM),
GZM news memo 15 min,
`supervise()` backoff, upstream retries.
client: `swr` vehicles 4 s BB / 5 s GZM / `X-Next-Update` (2 s before the first answer), `swr` stops (focus at
most once a minute, 15 min, 20 s while `partial`), StopView `live-poll` 10 s +-15 % with watchdog,
`fetchNewerShape` 1 s (at most 100 per stage), announcements 15 min, the animator rAF, the PWA update check on
visibility, geocode debounce 350 ms.

## 9. Memory efficiency

Prebuilt bodies kept twice (JSON + gzip), feed typed arrays (`callColumns` sharing), stops body + ETag,
packed fleet history, copies where a slice would do, eager loads that could be lazy. Recommend bounds from measured
behaviour and say which way you traded memory against CPU or I/O.

## 10. Responsiveness and startup

Cold start to: `/api/health` 200, first `/api/vehicles` with a non-zero `timestamp`, GZM feed ready (how long
`warming()` 503s last). Client: first map paint and first vehicles, on a cleared site (production service worker:
clear site data or use a fresh profile). Shutdown time.

## 11. Throughput and scaling

Fixed payload, exact `load.mjs` command recorded. `/api/vehicles?city=gzm` (should be a buffer write per request),
`/api/stops` with and without `If-None-Match`, `/api/connections` req/s until p95 crosses 300 ms (the threshold in
the `lib/gzm.ts` ponytail note), cost growth with fleet size (BB ~100 vs GZM ~1000 vehicles) and with resident
cities. Split time across stages (fetch, parse, join, serialize, compress) before fixing anything.

## 12. Fixes

For every confirmed problem: root cause, file and symbol, the code, the smallest safe fix, why it is correct,
side effects, memory/CPU/IO cost of the change, a regression check, before and after on the same scenario.

Ladder: delete the work; reuse what the repo has; stdlib/platform; event instead of poll; tie lifetime to an
existing owner; fix the shared root once; only then new code. Repo constraints: no new dependency, keep the map
layers imperative, keep Python-parity semantics, never lengthen an interval without the root cause, a known
ceiling gets a `ponytail:` comment naming it and its upgrade path (the repo already uses this).

## 13. Diagnostics

Follow what exists: `lib/logger.ts` (`KB_LOG_LEVEL`) for logs, `/api/health` counters for metrics (a perf counter
there never flips `status`). Read env gates once at module load, as `lib/config.ts` does. Nothing verbose by
default.

## 14. Tests and benchmarks

Report what exists first: `ls test/*.test.ts | wc -l`, `test/vehicle-motion-sim.test.ts`, `npm run benchmark`,
`npm run benchmark:site`. New checks are pure functions under `node --test` with no network (CI must never reach
an upstream): cache eviction at its bound, timer removal on `stop()`, repeated start/stop with no growth, a stale
generation never applied.

## Output format

Write the report to the scratchpad and give its full path. Sections, in order:

1. **Executive summary**: overall severity; the biggest CPU, memory, loop-stall and client-jank problem; the
   expected gain after fixes.
2. **Environment**: `node -v`, commit, build used, machine (`nproc`, RAM), Europe/Warsaw time windows, tools
   available vs wanted.
3. **Baseline** table:

   | Scenario | ELU / CPU avg | CPU peaks | p50 | p95 | p99 | heap / abMB start | end | wakeups | notes |
   | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |

   Scenarios at minimum: boot, server idle BB-only, server idle with GZM + one zbiorkom city resident, GZM watched,
   `/api/vehicles?city=gzm` load, `/api/connections` burst, right after load stops, client BB map idle, client GZM
   map idle at zoom 12 and 15, GZM pan/zoom, hidden tab, 30 open/close cycles.
4. **Findings** grouped as memory, CPU, idle, event loop, hangs/stalls, responsive path, lifecycle, throughput.
   Each: severity, file:symbol, evidence (the number and the command), root cause, user-visible impact, fix,
   verification. Separate **confirmed** from **suspected** explicitly.
5. **Timer inventory** table: source, file:line, interval, owner, removed on teardown, stops when idle/hidden,
   required, recommendation.
6. **Changes implemented**: one focused diff per change.
7. **Before and after**: same scenarios, same commands, same build, same hour band.
8. **Remaining risks**: what was not proven and what the tools could not see.
9. **Verdict**: memory stable? resources released with their owner? idle near zero apart from the BB pollers?
   unnecessary wakeups? loop stalls on the request path? hangs reachable? client smooth with the GZM fleet? next
   highest-value optimisation?

## Rules

Do not guess. Do not write "probably fine". No leak without evidence. Nothing is safe without naming what makes it
safe. No failure mode the model does not permit. Do not optimise what no measurement shows. No dev-build number as
a production number. No load on an upstream. No number you did not take. If a tool or a runnable build is missing,
still do the static audit, give the exact commands with flags filled in and what each would confirm or kill, and
label every such item suspected.
