<div align="center">

# kb-map

Real-time bus tracking, GTFS / GTFS-RT feed generator, and multi-leg transit journey planner for **Komunikacja Beskidzka** (Bielsko-Biała region, Poland).

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node"></a>
  <a href="https://nextjs.org"><img src="https://img.shields.io/badge/next.js-16-000000?style=flat-square&logo=next.js&logoColor=white" alt="Next.js"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/typescript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="/api/gtfs-rt.pb"><img src="https://img.shields.io/badge/GTFS--RT-protobuf-blue?style=flat-square" alt="GTFS-RT"></a>
</p>

</div>

Official passenger portals only show departures one stop at a time. **kb-map** tracks the entire fleet at once: real-time vehicle positions with live delays on an interactive vector map, an automated GTFS / GTFS-RT feed generator, and a journey planner that computes direct and multi-leg transfers across 950+ stops.

Built with **Next.js 16**, **TypeScript**, and **Leaflet / MapLibre GL**. A background poller runs concurrently in the same Node.js process via `instrumentation.ts` without requiring a separate scraper daemon.

## Features

- **Live Fleet Tracking**: Real-time GPS locations of all running buses updated every 4 s. Headings are computed from actual physical movement (with jitter filtering), with live delay badges (`+4 min`) and active stop progress tracking.
- **Smooth Vehicle Motion**: Between position updates buses are dead-reckoned along their road shape at their cruise speed — they stop short of the next stop, wait while dwelling, and correct smoothly when a new fix arrives instead of jumping. Per-browser switch in the map settings ("Płynny ruch pojazdów", an early feature, off until switched on).
- **Multi-leg Journey Planner**: Connection search supporting direct trips and multi-leg transfers with automatic walkable hub transfers (up to 350 m between platforms or opposite street sides). Fuzzy stop resolution handles Polish diacritics, punctuation (`PIETRZYKOWICE, KOŚCIÓŁ`), and street suffixes seamlessly across calendar boundaries.
- **GTFS & GTFS-Realtime Feeds**: Automatic nightly builds of static multi-day GTFS (`stops`, `routes`, `trips`, `stop_times`, `shapes`, `calendar`) published atomically, plus standard GTFS-RT `VehiclePositions` protobuf at `/api/gtfs-rt.pb`.
- **Interactive UI & PWA**: Vector base map (OpenFreeMap with dark mode and raster fallback), stop departures boards with live countdowns, route timeline sheets with road geometry routed and stored server-side, keyboard command palette (`Cmd/Ctrl+K`), and installable PWA support.
- **Self-Healing Poller**: 3-tier polling architecture (full scan every 90 s, smart scan every 30 s, active vehicle refresh every 10 s) with on-demand candidate discovery, ghost vehicle filtering, and health monitoring (`/api/health`).

## Quick Start

Requirements: **Node.js 20+** (tested on Node 24).

```bash
# Clone and install dependencies
git clone https://github.com/DeBondor/kb-map.git
cd kb-map
npm install

# Run development server (runs scraper + web UI on port 8080)
npm run dev

# Or build for production
npm run build
npm start
```

### Docker

```bash
docker compose up -d --build
```

The app is served at `http://localhost:8080`.

The healthcheck marks the container `unhealthy` when the scan loop stalls or the upstream goes stale (`/api/health` answers 503). Docker does not restart a container for that, `restart: unless-stopped` acts only on process exit, so point an uptime monitor at `/api/health` to get alerted.

## API & Feeds

| Endpoint | Description |
|---|---|
| `/` | Interactive live fleet map & journey planner UI |
| `/api/vehicles` | All active vehicle positions with delays and heading (`JSON`) |
| `/api/gtfs-rt.pb` | Standard **GTFS-RT VehiclePositions** (`protobuf`) |
| `/api/connections?from=...&to=...` | Transit routing engine (direct & transfer itineraries) |
| `/api/stops` | KB and MZK stops merged into one list (~1300 entries; `operator` is `KB`, `MZK` or `BOTH`), with coordinates, direction arrows and platform metadata; `ETag` + 304 |
| `/api/lines` | Active bus lines catalog extracted from GTFS |
| `/api/stop/:id/departures` | Live & scheduled departures for a specific stop |
| `/api/shapes?ids=...` | Stored road geometry (encoded polyline, precision 6, + per-stop distances) for the `shape` ids advertised by `/api/vehicles` and trip responses; immutable-cached |
| `/api/health` | Service health status, vehicle count, feed freshness, MZK / merged stop-list counters (`mzk_stops`, `merged_stops`) and road-shape store counters |

## Road Shapes

Road-following route geometry is computed **on the server** and stored, instead of every browser calling a router:

- **KB**: each distinct stop pattern is routed through [OSRM](https://project-osrm.org/) by a single throttled worker (≥ 1 s between requests on the public demo server, identifying User-Agent, circuit breaker on errors). New patterns are queued as soon as a vehicle or GTFS trip uses them; road shapes are re-routed gradually after `KB_SHAPES_MAX_AGE_DAYS`. Bootstrap is ~600 requests (~11 min), then a few dozen a day.
- **MZK**: the operator's own variant geometry (`getTheoreticalCourseDetails`).
- Stored in `output/shapes/route-shapes.v1.json` (Docker volume `kb-output`), written atomically with a `.bak`; one process owns it (lock file), others are read-only. Delete the file to rebuild from scratch; `/api/health` → `shapes` shows progress.

| Variable | Default | |
|---|---|---|
| `KB_OSRM_URL` | `https://router.project-osrm.org/route/v1/driving` | `off` disables routing (KB buses then move straight towards the next stop) |
| `KB_OSRM_MIN_INTERVAL_MS` | `1100` | min. spacing between OSRM requests (≥ 1000 on the public host) |
| `KB_OSRM_USER_AGENT` | `kb-map/2.0 (+https://github.com/DeBondor/kb-map)` | required by the OSRM usage policy |
| `KB_SHAPES_MAX_AGE_DAYS` | `14` | |
| `KB_SHAPES_FILE` | `output/shapes/route-shapes.v1.json` | |

## Live Delay (GPS-corrected)

Upstream registers a stop only when one of its GPS samples lands in the stop zone. A bus that passes stops without slowing down is not registered, upstream's `vehicle_trip_index` / `next_departure_index` stall behind the bus and the delay derived from them grows +1 min per minute (observed: +5 → +11 min for a bus running on time). `lib/kb-progress.ts` tracks the bus along its trip's stops from GPS (monotone, upstream's last registered stop as a lower bound) and, only while the bus is already beyond the stop upstream calls "next", replaces `delay` by the schedule deviation at the real position. `/api/vehicles` then carries `delay_src` (`gps` | `gps-held` | `unknown`) and `geo_seq` (GPS index of the last passed stop) for that vehicle; `/api/health` → `stale_index` counts such vehicles.

| Variable | Default | |
|---|---|---|
| `KB_GPS_DELAY` | `1` | `0` restores upstream's raw delay (kill switch) |
## Stop Merging (KB + MZK)

`/api/stops` pairs the stops of the two operators that are the same physical pole (`lib/stop-merge.ts`): within 35 m, or within 120 m with matching names, one MZK stop per KB stop, opposite carriageways never paired. The pairing is a global assignment (it does not depend on the order the upstreams list their stops) and uses the travel direction of both sides: KB from the GTFS feed, MZK learned from the stop order of running courses and persisted to `output/mzk-stop-dirs.v1.json` (`KB_MZK_STOP_DIRS_FILE`). A bus station (D.A.) pairs only with MZK stops within 35 m (on its premises) and lists the departures of all of them, e.g. Czechowice-Dz. D.A. lists 2366 and 2367. Bielsko-Biała D.A. is a KB station, so it shows KB only: the MZK "Warszawska/Piastowska Dworzec" stops (89-183 m) are stops of their own. The MZK stop list is reloaded daily and as soon as a running course references a stop it does not know. `/api/health` → `mzk_stops` / `merged_stops` show what the current list is made of.

## Metropolia GZM (second city)

The same process also serves **Metropolia GZM** (Katowice region), isolated from the BB pollers: a GZM failure never touches the BB data or `/api/health` status. On first visit the map asks which city to show and remembers the choice (`kb:city` in localStorage); the top bar switches it later.

- **Schedule** (stops, lines, trips, shapes, brigades): the merged GZM GTFS from zbiorkom.live api6-open, kept as `output/gzm/gtfs.zip`. Checked every 10 min, downloaded again once the service day changed (after 04:00 Warsaw time); a failed download keeps the last good feed and retries after 30 min.
- **Live positions**: zbiorkom positions every 20 s (polled just after zbiorkom's own 20 s grid), joined to a GTFS trip only when every upcoming (stop sequence, scheduled departure) pair matches, brigade as the tie-breaker. A vehicle without a trip (after its last trip of the day, or listed without upcoming stops) shows its position only, without a delay.
- **SDIP** (sdip.transportgzm.pl) overlays fresher positions every 5 s, only while someone requested GZM data within the last 2 min.
- Departures and timetables come from the local feed with the live delay applied (no upstream request per stop); connections search the GZM feed only (no routing between the cities).

Every endpoint that serves a list takes `?city=gzm` (`vehicles`, `stops`, `lines`, `connections`, `fleet`); without it the answer is the BB one, unchanged. Endpoints keyed by an id take the GZM id space instead:

| Thing | Id |
|---|---|
| stop | `gzm:<stop_id>` |
| trip | `gzm:<trip_id>` |
| vehicle (`exec_id`) | `gzm:<operator>_<fleet>` |
| shape | `gzm:<shape_id>.<rev6>` |

An unknown `city` answers 400, `city=gzm` with `KB_GZM=0` answers 404, and stops, lines, trips, departures, timetables and connections answer 503 with `Retry-After: 10` while the feed is still loading (vehicles are served without trip data meanwhile). `/api/health` → `gzm` is informational. `/api/gtfs-rt.pb` stays BB-only.

| Variable | Default | |
|---|---|---|
| `KB_GZM` | `1` | `0` switches GZM off |
| `KB_GZM_GTFS_URL` | `https://api.zbiorkom.live/api6-open/gzm/gtfs/default` | |
| `KB_GZM_POSITIONS_URL` | `https://api.zbiorkom.live/api6-open/gzm/positions/18.3,49.9,19.7,50.7` | |
| `KB_GZM_SDIP` | `1` | `0` disables the SDIP overlay |
| `KB_GZM_SDIP_URL` | `https://sdip.transportgzm.pl/vm/main` | |
| `KB_GZM_DIR` | `output/gzm` | GTFS zip and GZM fleet history |
| `KB_GZM_FLEET_HISTORY_DAYS` | `30` | |

Data: ZTM / Metropolia GZM (CC BY), via zbiorkom.live.

## Static GTFS Generation

To build or refresh the static GTFS schedule manually:

```bash
npm run build:gtfs
```

Options: `--date YYYY-MM-DD` (default: today), `--out <dir>` (default: `output/gtfs`), `--concurrency <N>` (default: 40), `--single-day` (default: multi-day full schedule).

Output is written atomically to `output/gtfs/` (including `kb_gtfs.zip`).
