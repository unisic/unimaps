# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Komunikacja Beskidzka live bus map: a Next.js 16 (App Router, TypeScript strict) app where **one Node process** serves the Leaflet map UI, a JSON API, a GTFS-RT VehiclePositions protobuf feed, and runs the live scraper poller in-process. The upstream is `https://komunikacjabeskidzka.kiedyprzyjedzie.pl` (KiedyPrzyjedzie). The `lib/` layer is a deliberate behavioral-parity TypeScript port of a former Python codebase — see Gotchas. README.md (Polish) documents endpoints and env vars in detail.

## Commands

```bash
npm run dev          # next dev on port 8080 (poller starts too — dev mode scrapes upstream)
npm run build        # next build (output: "standalone")
npm start            # node scripts/start-server.mjs — syncs .next/static + public into
                     #   .next/standalone, then runs node .next/standalone/server.js
                     #   (falls back to `next start` if no standalone build exists)
npm run lint         # eslint .
npm run typecheck    # tsc --noEmit
npm test             # node --import tsx --test "test/**/*.test.ts" — pure-function tests
npm run build:gtfs -- --date 2026-07-05   # static GTFS builder CLI (logic lives in lib/gtfs-builder.ts)
                     #   flags: --date YYYY-MM-DD, --out DIR, --concurrency N, --no-zip
```

Verification is `npm run typecheck` + `npm run lint` + `npm test` + exercising the running app (`/api/health` shows status/scan counters). CI (`.github/workflows/ci.yml`) runs all four plus `next build` and `npm audit --audit-level=high`; it must never run `build:gtfs` (hits the live upstream). Tests in `test/` **pin Python-parity semantics** — a failing parity test means a regression in lib code, never "fix" the expectation.

Default port is **8080** everywhere (dev, start script, Dockerfile, compose), not 3000. Docker: `docker compose up -d --build`; healthchecks hit `/api/health`.

Config is via `KB_*` env vars (see `.env.example`), all optional. `lib/config.ts` reads them **at module load** — changing one requires a process restart.

## Architecture

### Backend data flow

```
instrumentation.ts register()            (Next instrumentation hook, nodejs runtime only)
  └─> lib/poller-singleton.ts startPoller()   (idempotent; singleton on globalThis)
        └─> lib/poller.ts LivePoller          (background loop, in-memory positions Map)
              └─> lib/kb-api.ts KbApi         (fetch + p-limit concurrency 40, retries)
                    └─> upstream API
```

- Routes under `app/api/` read poller snapshots: `/api/vehicles` (`toJson()`), `/api/gtfs-rt.pb` (`toProtobuf()`, gtfs-realtime-bindings), `/api/stops`, `/api/health`. Every route **also** `await startPoller()` as a lazy fallback, so the poller starts even if instrumentation didn't fire.
- Passthrough routes (`/api/trip/[tripId]`, `/api/trip_execution`, `/api/stop/[designator]/departures|timetable`, `/api/announcements`) proxy the upstream directly, gated by `lib/rate-limit.ts` (in-memory per-IP token bucket) and `lib/api-helpers.ts` validation.
- Poller rhythm (defaults, `lib/config.ts`): full scan of all ~956 stops every 90 s, smart incremental scan every 30 s, position refresh of active vehicles every 10 s (+ work time; upstream itself only moves a KB position every ~6–18 s). MZK (`lib/mzk-poller.ts`) polls its whole fleet every 5 s. It discovers `trip_execution_id`s from departures (the only way to get positions — they live in a different ID space than static `trip_id`). The loop runs under `supervise()` — a crash restarts it with capped backoff (`loopRestarts` in health). The stop list reloads daily (`KB_STOPS_RELOAD_SEC`) with an atomic map swap; a failed reload keeps the old list.
- `/api/health` returns `"degraded"` + HTTP 503 (flips Docker healthchecks) when the scan loop stalls or upstream contact exceeds `KB_HEALTH_STALE_SEC` (1200 s > the 600 s overnight all-cached window). Deliberately no vehicle-count condition — 0 at night is normal.
- `lib/gtfs-refresh.ts` (armed from `startPoller()`, HMR-safe singleton) rebuilds the GTFS feed in-process: immediately when `output/gtfs` is missing (fresh Docker volume), else daily after `KB_GTFS_BUILD_HOUR` Warsaw time, then invalidates the stop-directions/lines caches. It exists because the standalone image ships no tsx/scripts — builder logic lives in `lib/gtfs-builder.ts`, `scripts/build-gtfs.ts` is just the CLI. Compose mounts the named volume `kb-output:/app/output`.
- `lib/shape-store.ts` is the **road-shape store**: road-following geometry for KB stop patterns (`lib/shape-patterns.ts` — keyed by stop ids + applied detour, routed server-side through OSRM by `lib/osrm.ts`, one throttled worker, ≥1 s between requests on the public demo host) and MZK variants (operator API, `lib/mzk-shape.ts`). Persisted to `output/shapes/route-shapes.v1.json` (atomic sync writes + `.bak`, lock file = single writer; a non-owner is read-only), refreshed gradually (one entry per 2 min, road shapes after `KB_SHAPES_MAX_AGE_DAYS`), seeded from the GTFS patterns after start and every nightly build. A new pattern gets a straight entry at once; a road entry is never downgraded; OSRM failures pause the worker (circuit breaker) and never touch `/api/health` status. `/api/shapes?ids=` only reads the store (never routes/fetches), ids are `<key>.<rev6>` so exact hits are `immutable`.
- The pollers attach route info per vehicle (`lib/route-info.ts`, isolated in try/catch so it can never abort a refresh): shape key, `fixAt` (KB has no upstream fix time — midpoint of the poll window that saw the change; MZK `lastPingDate`), along-route `distM`, and a cruise `speed` taken only from consecutive moving fixes outside stop zones. `vehicleExtras()` puts them on the wire (`shape`, `dist_m`, `fix_at`, `next_stop_seq`, `speed`) — `vehicleToJson` (the Python port) stays untouched. `/api/vehicles` also sends `X-Server-Time` (a header, so unchanged payloads still dedupe in SWR). Trip responses carry `shape_id` + `shape_status` (`road|pending|none`); `/api/connections` legs carry `shape_id`.
- `lib/stop-directions.ts` derives stop direction arrows from pre-built GTFS files in `output/gtfs/`; missing files silently yield no arrows. Cached per process until `invalidateStopDirections()`/`invalidateLines()` (called after a rebuild); `/api/stops` re-serializes when either the stop-list or the directions-map identity changes.

### Frontend

All components are `"use client"`. `app/page.tsx` → `components/MapShell.tsx`, which is the **single SSR boundary**: `dynamic(import MapApp, { ssr: false })` because Leaflet touches `window` at import time. Never import leaflet/maplibre outside that boundary.

- `MapApp.tsx` is the single stateful root — no state library; all state flows down as props. It re-renders on every changed 4 s vehicle poll, so children (TopBar, VehicleLayer, StopsLayer, TripLayer, StopView, TripView) are `memo()`-ized and every callback prop must be `useCallback`-stable.
- Data fetching: SWR only for `/api/vehicles` (4 s poll, the app heartbeat; `vehiclesFetcher` records receive time + `X-Server-Time` in the `vehiclesClock` WeakMap) and `/api/stops` (once). Everything else is manual `fetch` with AbortController via `lib/client/api`.
- Trip opening uses generation-counter cancellation (`genRef` in MapApp): every async step re-checks `gen !== genRef.current` before setState. New async paths there must do the same or stale trips overwrite newer ones.
- `VectorBaseLayer` (MapLibre GL vector tiles from OpenFreeMap inside Leaflet's tile pane), `StopsLayer` (raw `L.layerGroup`, viewport-culled and diffed, zoom ≥ 14) and `VehicleLayer` (raw `L.layerGroup` diffed by vehicle id) are imperative escape hatches — do not convert them to declarative react-leaflet markers (a `<Marker position>` would snap every animated vehicle back to its raw fix on each poll).
- **Vehicle motion ("Płynny ruch pojazdów").** `lib/client/vehicleAnimator.ts` (one per map, ref-counted) is the ONLY writer of live-vehicle marker positions and arrow angles. It drives the pure dead-reckoning engine `lib/client/vehicleMotion.ts` (along the road shape at the server's cruise speed, capped before the next stop, held while dwelling, smooth catch-up and never visibly driving backwards; tuned with `test/vehicle-motion-sim.test.ts`) from a rAF loop outside React — fleet at a zoom-scaled rate, the tracked bus every frame, paused only while a zoom animation runs (a frame gate, never a sticky flag) and while the tab is hidden. Fleet shapes come from `/api/shapes` (`lib/client/shapes.ts`) at zoom ≥ 13 in view. The per-browser switch is `lib/client/smoothMotion.ts` (`kb:smoothMotion`, default on unless `prefers-reduced-motion`); off = passthrough (raw fixes + the 0.9 s CSS glide). `VehicleLayer` ingests every poll even while hidden so tracks stay warm.
- `VehicleLayer` hides its markers while a trip is open; `TripLayer` draws the tracked vehicle itself, matched from the poll by `vehicle.id === trip.execId`, as an animator view on the SAME track as the fleet marker (no jump on open/close). It overrides the track's shape with the drawn route only when that isn't the fleet shape (`trip.shapeId !== vehicle.shape`). KB/MZK trips and connection legs draw server-stored shapes; browser OSRM (`fetchRoute`) is only the fallback while a shape is still `pending`.
- Deep links: view state lives in the URL (`?stop=`, `?exec=`, `?trip=`, `?lines=`, `?map=` — codec in `lib/client/urlState.ts`) via the **plain History API, never `next/navigation`** (`useSearchParams` would subscribe the whole map tree to every `moveend` replaceState). MapApp's single sync effect is the only URL writer; `popstate` is close-only (Android back closes sheets, state stays authoritative). `exec=` and `trip=` are separate params because the two trip-ID spaces can't be told apart heuristically.
- Announcements ("Utrudnienia"): `lib/client/announcements.ts` is a module-level `useSyncExternalStore` store (same pattern as `favorites.ts`) polling `/api/announcements` every 15 min; unread = upstream `hash` vs `kb:annSeen` in localStorage. Never wire it into the 4 s poll cycle.
- PWA updates: `public/sw.js` deliberately does **not** `skipWaiting()` on install — a new SW waits until `PwaRegister`'s toast posts `SKIP_WAITING`, and the reload on `controllerchange` only fires after explicit accept (`clients.claim()` fires it on first install too — an unconditional reload would refresh every new visitor).

### Single-process assumption

Poller singleton, rate-limit buckets, stop-directions cache and the road-shape store worker are all in-memory state in one long-lived Node process (the shape store file is additionally lock-guarded: a second process sharing `output/` stays read-only). Serverless or multi-instance deployment breaks rate limiting and multiplies upstream load. The singleton lives on `globalThis` under `Symbol.for("kb-gtfs.poller-singleton")` specifically to survive dev-mode HMR — never construct `LivePoller`/`KbApi` directly; go through `lib/poller-singleton.ts`.

## Gotchas

- **Python parity is intentional.** `pyTruthy`, `parseIntStrict`, etc. in `lib/kb-api.ts` replicate Python truthiness/`int()` semantics and are used across lib and routes; do not "simplify" them to JS truthiness. Likewise "JSON parse errors are not retried" is parity, not an oversight. An empty `{}` from a passthrough route means "upstream returned nothing" (e.g. vehicle not departed yet), not an error.
- **404 cache must not re-stamp.** In `lib/poller.ts` a candidate skipped due to a fresh cached 404 keeps its original timestamp — scan interval (180 s) < 404 cache (240 s), so re-stamping would slide the TTL forever and permanently hide a late-dispatched bus.
- **Ghost vehicles.** Upstream never 404s dead trips; it keeps returning the last position. Filtering relies on movement anchors (`anchorLat/anchorLon/lastMovedAt`, 15 m epsilon), staleness (frozen 300 s with no delay estimate), and `pruneDead`. The internal `positions` Map may contain vehicles that `liveVehicles()`/`toJson()` deliberately hide.
- **Time math is agency-local.** All schedule math uses seconds-since-midnight in Europe/Warsaw via `Intl` (`nowSecs()`), not server-local time, with ±43200 s midnight wrap — servers run UTC.
- **Upstream data quirks.** Positions can be bogus (0,0) — rejected via hardcoded SERVICE_AREA bbox (lat 48.8–50.5, lon 18.0–20.5). Stop coords arrive as micro-degrees (÷1e6). `trip_execution_id` is base64-encoded (`b64ExecId`) before hitting upstream URLs. `/api/departures?places=` silently caps the response at **6 boards per request** (extra stops are just absent) — hence `KB_BATCH_SIZE=6`; a board absent from the reply means truncation, not an empty stop (empty stops still get a board with empty rows), so the poller must not stamp the empty-cache for it.
- **Two stop ID spaces.** `Stop.urlId` (URL designator, may contain `:`) vs numeric `internalId`/`stopId`. On the frontend, trip time entries match `time.designator → Stop.id` and `time.place_id → Stop.designator` — not interchangeable.
- **Vehicle icons key on line/color/operator/hasHeading — never the heading.** The animator rotates the `.veh-arrow` element in place (unwrapped angles so CSS never spins the long way); `setIcon` rewrites the DOM and replays the pop animation, so putting the bearing back into an icon key makes markers blink on every turn. `TripLayer` keeps an `eslint-disable react-hooks/exhaustive-deps` on its marker effect on purpose (raw live coords only seed a new marker).
- **Motion clocks.** The engine runs on one local monotonic clock (`performance.now()`); server epoch seconds (`fix_at`) are mapped via the `X-Server-Time` offset. Never feed `Date.now()` or the KB `timestamp`/`updated_at` (= our fetch time) in as a fix time.
- **New passthrough routes must keep the security trio:** `isValidId`/`isValidDate` input validation (blocks URL injection into upstream paths), `upstreamError()` (generic 502, never leaks upstream details), and the rate-limit gate. `/api/trip_execution` skips `isValidId` deliberately because the id is base64-encoded first.
- Route handlers use the Next 15+ async params shape: `ctx.params` is a Promise and must be awaited. All API routes set `dynamic = "force-dynamic"` and `runtime = "nodejs"`.
- `output/` is generated (GTFS feeds, logs), gitignored, and eslint-ignored — not stray files.
- 0 vehicles after midnight is normal; buses run ~4:30–22:00.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
