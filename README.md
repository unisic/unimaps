<div align="center">

<img src="public/favicon.svg" width="160" height="160" alt="Unimaps" />

# Unimaps

A live public transport map for Bielsko-Biała, Metropolia GZM and over 50 other Polish cities.

</div>

<img width="1280" height="800" alt="Unimaps: live buses in Bielsko-Biała" src="docs/screenshot.png" />

Operator portals show departures one stop at a time. Unimaps shows the whole
fleet at once: every running vehicle with its delay, stop departure boards,
trip timelines on road geometry and a journey planner. It also publishes a
GTFS feed and a GTFS-Realtime feed.

Unimaps runs as one Node.js process: Next.js 16 serves the map, the JSON API and
the feeds, and the pollers run in the same process. No separate scraper daemon
and no database.

## Features

- Live positions every 4 to 5 s, with delays. KB delays are corrected from GPS
  when upstream's stop index stalls behind the bus.
- Departure boards and full timetables per stop. Nearby departures, departure
  alerts, and favourite stops kept for offline use.
- Trip timelines on road-following shapes, routed and stored on the server
- Journey planner (range RAPTOR) from and to a stop, an address or your
  location, leaving at or arriving by a time, with walking transfers between
  stops up to 350 m apart
- Line view: every stop pattern a line runs today, with each stop's departures
- Light and dark theme, following the system setting by default
- Fleet and brigade view at `/brygady`
- Optional smooth motion that dead-reckons buses along their route between
  fixes, an installable PWA, and a `Ctrl+K` search for stops, lines and
  vehicles

## Cities

| City | Operators | Sources |
|---|---|---|
| Bielsko-Biała | Komunikacja Beskidzka (KB), MZK Bielsko-Biała | KiedyPrzyjedzie (KB), OnTime (MZK), stops of both merged into one list |
| Metropolia GZM | ZTM: buses, trams, trolleybuses | GTFS and positions, SDIP overlay every 5 s |
| 53 other cities (`lib/shared/cities.ts`: Warsaw, Kraków, Łódź, Wrocław, Poznań, Tricity, Szczecin, Lublin, …) | the local operator of each | GTFS and positions |

On first visit the map asks for a city and remembers it. `?city=<slug>` opens a city (`gzm`, `warsaw`, `krakow`, …).
The cities are isolated: a GZM or other-city failure never touches Bielsko-Biała data. The other cities are
loaded on first request and only while watched: at most `KB_ZB_RESIDENT` timetables stay in memory, each
dropped after `KB_ZB_IDLE_MIN` minutes without a request; their positions are polled only while a page asks.
They have no fleet history, SDIP overlay, announcements or bike layer.

## Run

Requires Node.js 24 or newer.

```bash
git clone https://github.com/unisic/unimaps.git
cd unimaps
npm install
npm run dev          # map + pollers on http://localhost:8080
```

Production:

```bash
npm run build
npm start            # standalone server on port 8080
```

Docker:

```bash
docker compose up -d --build
```

The healthcheck marks the container `unhealthy` when the scan loop stalls or
upstream goes stale (`/api/health` answers 503). `restart: unless-stopped`
acts only on process exit, so point an uptime monitor at `/api/health`.

Checks: `npm run typecheck`, `npm run lint`, `npm test`.

## API

| Endpoint | |
|---|---|
| `/api/vehicles` | Live vehicles with delay, heading, route shape and along-route distance |
| `/api/gtfs-rt.pb` | GTFS-Realtime `VehiclePositions` (Bielsko-Biała) |
| `/api/stops` | Merged stop list with direction arrows, `ETag` + 304 |
| `/api/stop/:id/departures` | Live and scheduled departures |
| `/api/stop/:id/timetable` | Full day timetable |
| `/api/trip/:id`, `/api/trip_execution`, `/api/trips` | Trip timelines |
| `/api/connections?from=&to=` | Journey planner; `from=` / `to=geo:LAT,LON` starts or ends at every stop within `walk` metres (200 to 1500, default 800); `time=HH:MM&arriveBy=true` makes `time` the latest arrival |
| `/api/geocode?q=` | Street, address and place search within the city (Photon, OpenStreetMap) |
| `/api/push` | Web push for departure alerts: `GET` the VAPID key, `POST {subscription, alert}`, `DELETE {subscription, key}` (`KB_PUSH=0` = 404) |
| `/api/push/news` | Web push for new announcements: `POST` / `DELETE {subscription, city}` |
| `/api/lines` | Line catalogue |
| `/api/line?name=` | One line's stop patterns and per-stop departures for a day (`op=KB\|MZK`, `date=YYYY-MM-DD`) |
| `/api/shapes?ids=` | Stored road geometry, immutable-cached |
| `/api/fleet`, `/api/fleet/:side`, `/api/fleet/timeline` | Fleet and brigades |
| `/api/announcements` | Service announcements: KB + MZK, or the ZTM news page for `?city=gzm` |
| `/api/bikes?city=gzm` | Metrorower stations with the bikes available now (nextbike GBFS, 60 s memo, ETag + gzip) |
| `/api/health` | Status, scan counters, feed age, shape store |

List endpoints take `?city=<slug>` (`gzm`, `warsaw`, …); without it they answer for Bielsko-Biała.
Ids of those cities carry the slug as prefix (`gzm:<stop_id>`, `gzm:<trip_id>`,
`gzm:<operator>_<fleet>`; `warsaw:<stop_id>`, `warsaw:<type>_<vehicle id>`). While a feed loads, its endpoints answer 503
with `Retry-After: 10`.

## Configuration

All settings are optional `KB_*` environment variables, read once at start.
`.env.example` documents every one. The ones you are most likely to touch:

| Variable | Default | |
|---|---|---|
| `KB_OSRM_URL` | `https://router.project-osrm.org/route/v1/driving` | `off` disables server-side road routing |
| `KB_OSRM_MIN_INTERVAL_MS` | `1100` | at least 1000 on the public OSRM host |
| `KB_GEOCODER_URL` | `https://photon.komoot.io/api/` | `off` disables the address search |
| `KB_USER_AGENT` | `unimaps/2.0 (+https://github.com/unisic/unimaps)` | sent to every upstream |
| `KB_GPS_DELAY` | `1` | `0` keeps upstream's raw KB delay |
| `KB_GZM` | `1` | `0` switches Metropolia GZM off |
| `KB_GZM_SDIP` | `1` | `0` disables the SDIP position overlay |
| `KB_GZM_NEWS_URL` | `https://rj.transportgzm.pl/v2/news/` | ZTM news page scraped as GZM announcements, `off` disables |
| `KB_GZM_GBFS_URL` | `https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_zz` | Metrorower GBFS root for the bike-stations layer, `off` disables |
| `KB_ZB` | `1` | `0` switches the other cities off (404) |
| `KB_ZB_API_URL` | `https://api.zbiorkom.live/api6-open` | feed API root of the other cities (`<slug>/gtfs/default`, `<slug>/positions/<bbox>`) |
| `KB_ZB_RESIDENT` | `2` | how many of those cities keep their timetable in memory at once (100-230 MB heap each, LRU) |
| `KB_ZB_IDLE_MIN` | `30` | minutes without a request after which a city's timetable is dropped |

Generated state lives in `output/` (Docker volume `kb-output`): the static
GTFS feed, road shapes, learned stop directions and fleet history. Delete a
file to rebuild it.

## Static GTFS

The server rebuilds the Bielsko-Biała GTFS feed every night. To build it by
hand:

```bash
npm run build:gtfs -- --date 2026-11-02 --out output/gtfs
```

Flags: `--date YYYY-MM-DD` (default today), `--out DIR`, `--concurrency N`,
`--no-zip`, `--single-day`. Output is written atomically, including
`kb_gtfs.zip`.

## Data

Unimaps is an independent project, not affiliated with any operator. Data
comes from:

- Komunikacja Beskidzka: [komunikacjabeskidzka.kiedyprzyjedzie.pl](https://komunikacjabeskidzka.kiedyprzyjedzie.pl)
- MZK Bielsko-Biała: [rozklady.bielsko.pl](https://rozklady.bielsko.pl)
- Metropolia GZM: ZTM / Metropolia GZM (CC BY), plus SDIP
- Other cities: each operator's GTFS and vehicle positions (`output/gzm/<slug>/gtfs.zip`)
- Map: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, tiles by [OpenFreeMap](https://openfreemap.org)
- Road routing: [OSRM](https://project-osrm.org)

`/prywatnosc` (Polish) states what the app handles: the IP only in memory for
rate limiting, coordinates only for a journey search, a push subscription only
while one of its alerts is pending, everything else in the browser.

## License

GPLv3 or later. See [LICENSE](LICENSE).
