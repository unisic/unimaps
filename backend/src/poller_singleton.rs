//! `lib/poller-singleton.ts`: the BB services of the process (the KB poller, the MZK poller, the road-shape store,
//! the routes' own KbApi) and what the routes read from them. Construction is inert: nothing loads, spawns or
//! fetches until `start_poller` (or a lazy `poller()` / `mzk_poller()`) runs inside a tokio runtime.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::IndexMap;
use jiff::Timestamp;
use serde_json::{Map, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::config;
use crate::fetch::string_err;
use crate::fleet_tracker::{blocking_io, get_fleet_tracker};
use crate::gzm::{HttpZb, NowFn, ZbTransport};
use crate::gzm_fleet::flush_gzm_fleet;
use crate::js;
use crate::kb_api::{KbApi, KbSource};
use crate::logger;
use crate::merged_stops::{MergedInput, MergedStopsCache, MergedView};
use crate::mzk_api::{MzkApi, MzkSource};
use crate::mzk_poller::{MZK_STALE_SEC, MzkPoller, joined};
use crate::osrm::{HttpOsrm, OSRM_PACE, OsrmTransport};
use crate::poller::{LivePoller, LivePollerOptions, panic_msg};
use crate::route_info::{WireIdFn, vehicle_extras};
use crate::shape_patterns::{raw_trip_id, read_gtfs_pattern_seeds};
use crate::shape_store::{MzkFetchFn, ShapePrio, ShapeStore, ShapeStoreOptions};
use crate::stop_directions::get_stop_directions;
use crate::time::agency_clock;
use crate::types::VehiclesResponse;
use crate::vehicle::{VehiclePos, vehicle_to_json};

const TAG: &str = "rt";
/// After a failed start, no new start for this long; also the KB retry period.
const START_RETRY_COOLDOWN_MS: i64 = 30_000;
const SEED_DELAY: Duration = Duration::from_secs(3 * 60);

/// The concrete services behind [`Bb`]: [`LiveKinds`] in the process, fakes in tests.
pub trait BbKinds: Send + Sync + 'static {
    type Kb: KbSource + Send + Sync + 'static;
    type Mzk: MzkSource + Send + Sync + 'static;
    type Osrm: OsrmTransport + Send + Sync + 'static;
}

/// The upstream clients of the running process.
pub struct LiveKinds;

impl BbKinds for LiveKinds {
    type Kb = KbApi<HttpZb>;
    type Mzk = MzkApi<HttpZb>;
    type Osrm = HttpOsrm;
}

/// A GTFS seeding run (`() => seedShapesFromGtfs(st)`); it does its file IO through `blocking_io`.
pub type SeedFn = Arc<dyn Fn() + Send + Sync>;
/// `startGtfsRefresh(onBuilt, mzkApi)`, called once after the first KB start that succeeds.
pub type GtfsRefreshHook<M> = Arc<dyn Fn(SeedFn, Arc<M>) + Send + Sync>;

type MzkPositions = Arc<IndexMap<String, Arc<VehiclePos>>>;
/// The settled start: None while it runs.
type StartRx = watch::Receiver<Option<Result<(), String>>>;

#[derive(Default)]
struct StartCtl {
    /// `startPromise`: Some while a start runs and after it succeeded
    rx: Option<StartRx>,
    /// `lastStartFailAt`, epoch ms
    last_fail_at: i64,
}

struct VehiclesMemo {
    kb_key: String,
    mzk_positions: MzkPositions,
    value: Arc<VehiclesResponse>,
}

/// The TS `SingletonState`. Fields are reached through the accessors: `poller()` and `mzk_poller()` kick off a
/// background start like `getPoller()` / `getMzkPoller()`.
pub struct Bb<T: BbKinds = LiveKinds> {
    api: Arc<T::Kb>,
    poller: Arc<LivePoller<T::Kb>>,
    mzk_api: Arc<T::Mzk>,
    mzk_poller: Arc<MzkPoller<T::Mzk>>,
    shapes: Arc<ShapeStore<T::Osrm>>,
    gtfs_dir: PathBuf,
    gtfs_refresh: Option<GtfsRefreshHook<T::Mzk>>,
    merged: MergedStopsCache,
    /// last `/api/vehicles` payload per operator filter (at most 3: "", "kb", "mzk")
    vehicles_memo: Mutex<HashMap<&'static str, VehiclesMemo>>,
    start: Arc<Mutex<StartCtl>>,
    now: NowFn,
}

static BB: LazyLock<Bb> = LazyLock::new(Bb::live);

/// The process-wide BB services (`state()`); building it reads env config only.
pub fn bb() -> &'static Bb {
    &BB
}

/// `routeKbApi`: the passthrough routes' client, half the poller's upstream concurrency and at most 600 requests
/// waiting for a slot (a flood is refused with "queue full" instead of queueing behind the poller).
pub fn route_kb_api<Z: ZbTransport>(transport: Z) -> KbApi<Z> {
    let n = usize::try_from((*config::DEFAULT_CONCURRENCY / 2).max(1)).unwrap_or(1);
    KbApi::new(transport).with_concurrency(n).with_max_pending(600)
}

fn lock<X>(m: &Mutex<X>) -> MutexGuard<'_, X> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The start's outcome once settled; None = it was dropped unsettled (runtime shutdown).
async fn settled(rx: &mut StartRx) -> Option<Result<(), String>> {
    rx.wait_for(Option::is_some).await.ok().and_then(|v| (*v).clone())
}

/// `TS catch { log.error(tag, `${what}: ${err}`) }` around a sync step that must not abort the caller.
fn guarded<R>(tag: &str, what: &str, f: impl FnOnce() -> R) -> Option<R> {
    catch_unwind(AssertUnwindSafe(f))
        .map_err(|p| logger::error(tag, format!("{what}: {}", panic_msg(&*p))))
        .ok()
}

/// `mzk:<course>:<variant>` -> `mzk:<course>` (`id.slice(0, id.indexOf(":", 4))`: without a second colon the
/// last character goes, as in the TS).
fn mzk_course_key(id: &str) -> &str {
    match id.get(4..).and_then(|rest| rest.find(':')) {
        Some(i) => id.split_at(4 + i).0,
        None => id.char_indices().next_back().map_or(id, |(i, _)| id.split_at(i).0),
    }
}

/// The variant of `/^mzk:\d+:(\d+)$/`.
fn mzk_variant(trip_id: &str) -> Option<&str> {
    let (course, variant) = trip_id.strip_prefix("mzk:")?.split_once(':')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (digits(course) && digits(variant)).then_some(variant)
}

fn wire_vehicle(v: &VehiclePos, wire: &WireIdFn, now_epoch: f64, operator: &str) -> Map<String, Value> {
    let mut o = vehicle_to_json(v);
    o.extend(vehicle_extras(v, Some(wire), now_epoch));
    o.insert("operator".into(), operator.into());
    o
}

impl Bb<LiveKinds> {
    /// The TS `state()` construction: one MzkApi shared by the routes, the MZK poller and the shape store's MZK
    /// fetcher; the KB poller gets its own unbounded KbApi. GTFS refresh hook: `gtfs_refresh::start_gtfs_refresh`.
    fn live() -> Self {
        let mzk_api = MzkApi::new(HttpZb);
        let fetch_api = mzk_api.clone();
        let mzk_fetch: MzkFetchFn = Arc::new(move |id| {
            let m = fetch_api.clone();
            Box::pin(async move { m.fetch_theoretical_course(id as f64).await })
        });
        // ponytail: one store per Bb instead of the TS getStoreSingleton; bb() is the only live Bb
        let shapes = ShapeStore::new(ShapeStoreOptions {
            osrm_base: config::OSRM_URL.clone(),
            min_interval_ms: *config::OSRM_MIN_INTERVAL_MS,
            pace: Some(&OSRM_PACE),
            max_age_days: *config::SHAPES_MAX_AGE_DAYS as f64,
            file: Some(PathBuf::from(config::SHAPES_FILE.as_str())),
            mzk_fetch: Some(mzk_fetch),
            ..ShapeStoreOptions::new(HttpOsrm)
        });
        let poller = LivePoller::new(KbApi::new(HttpZb), LivePollerOptions::default());
        let mzk_poller = MzkPoller::new(mzk_api.clone()).with_global_fleet();
        Self::from_parts(route_kb_api(HttpZb), poller, mzk_api, mzk_poller, shapes)
            .with_gtfs_refresh(Arc::new(crate::gtfs_refresh::start_gtfs_refresh::<MzkApi<HttpZb>>))
    }
}

impl<T: BbKinds> Bb<T> {
    /// Wires `shapes` into both pollers (`{ shapes }` / `mzkPoller.shapes = shapes`). Defaults: system clock,
    /// `config::GTFS_DIR`, no GTFS refresh hook. Nothing is started.
    pub fn from_parts(
        api: T::Kb,
        poller: LivePoller<T::Kb>,
        mzk_api: T::Mzk,
        mzk_poller: MzkPoller<T::Mzk>,
        shapes: Arc<ShapeStore<T::Osrm>>,
    ) -> Self {
        poller.set_shapes(Some(shapes.clone()));
        mzk_poller.set_shapes(Some(shapes.clone()));
        Self {
            api: Arc::new(api),
            poller: Arc::new(poller),
            mzk_api: Arc::new(mzk_api),
            mzk_poller: Arc::new(mzk_poller),
            shapes,
            gtfs_dir: PathBuf::from(config::GTFS_DIR.as_str()),
            gtfs_refresh: None,
            merged: MergedStopsCache::new(),
            vehicles_memo: Mutex::default(),
            start: Arc::default(),
            now: Arc::new(|| Timestamp::now().as_millisecond()),
        }
    }

    /// Epoch-ms clock of the start cooldown, the vehicles payload, `bb_live_delay` and the merged view's stamp.
    pub fn with_now(mut self, now: NowFn) -> Self {
        self.merged = MergedStopsCache::new().with_now(now.clone());
        self.now = now;
        self
    }

    /// Where `seedShapesFromGtfs` reads the built feed.
    pub fn with_gtfs_dir(mut self, dir: PathBuf) -> Self {
        self.gtfs_dir = dir;
        self
    }

    /// `startGtfsRefresh`, run after the first successful KB start with the GTFS seeding and the MZK client.
    /// `Bb::live()` sets `gtfs_refresh::start_gtfs_refresh`; without a hook no rebuild is ever scheduled.
    pub fn with_gtfs_refresh(mut self, hook: GtfsRefreshHook<T::Mzk>) -> Self {
        self.gtfs_refresh = Some(hook);
        self
    }

    /// The services' `Date.now()` (epoch ms, `with_now`).
    pub fn now_ms(&self) -> i64 {
        (self.now)()
    }

    /// `getApi`: the passthrough routes' client, never the poller's.
    pub fn api(&self) -> &Arc<T::Kb> {
        &self.api
    }

    /// `getMzkApi`.
    pub fn mzk_api(&self) -> &Arc<T::Mzk> {
        &self.mzk_api
    }

    /// `getShapes`.
    pub fn shapes(&self) -> &Arc<ShapeStore<T::Osrm>> {
        &self.shapes
    }

    /// `getPoller`: kicks off a background start when none is running or done.
    pub fn poller(&self) -> &Arc<LivePoller<T::Kb>> {
        self.ensure_started();
        &self.poller
    }

    /// `getMzkPoller`: kicks off a background start when none is running or done.
    pub fn mzk_poller(&self) -> &Arc<MzkPoller<T::Mzk>> {
        self.ensure_started();
        &self.mzk_poller
    }

    /// `startPoller`: idempotent. KB and MZK start concurrently; a failed KB start while MZK came up is retried
    /// every 30 s in the background until it succeeds. Err only when both failed ("Both KB and MZK poller starts
    /// failed", the next call within 30 s gets "poller start failed recently, retry pending"). The start runs in
    /// its own task: a caller dropped mid-wait never abandons it. Must be called inside a tokio runtime: the TS
    /// synchronous prefix (shape store load, start task spawn) runs at the call, so a caller that spawns the
    /// returned future still reads a loaded store right after.
    pub fn start_poller(&self) -> impl Future<Output = Result<(), String>> + Send + 'static {
        let begun = self.begin_start();
        async move {
            let (mut rx, _) = begun?;
            settled(&mut rx)
                .await
                .unwrap_or_else(|| Err("poller start abandoned".to_owned()))
        }
    }

    /// The pending or settled start (false) or a new one (true); Err = still cooling down after a failure.
    fn begin_start(&self) -> Result<(StartRx, bool), String> {
        let (tx, rx) = {
            let mut ctl = lock(&self.start);
            if let Some(rx) = &ctl.rx {
                return Ok((rx.clone(), false));
            }
            if (self.now)() - ctl.last_fail_at < START_RETRY_COOLDOWN_MS {
                return Err("poller start failed recently, retry pending".to_owned());
            }
            let (tx, rx) = watch::channel(None);
            ctl.rx = Some(rx.clone());
            (tx, rx)
        };
        self.shapes.start();
        let job = Arc::new(Starter::<T> {
            poller: Arc::clone(&self.poller),
            mzk_api: Arc::clone(&self.mzk_api),
            mzk_poller: Arc::clone(&self.mzk_poller),
            shapes: Arc::clone(&self.shapes),
            gtfs_dir: self.gtfs_dir.clone(),
            gtfs_refresh: self.gtfs_refresh.clone(),
        });
        let ctl = Arc::clone(&self.start);
        let now = Arc::clone(&self.now);
        tokio::spawn(async move {
            let res = job.run().await;
            if res.is_err() {
                let mut c = lock(&ctl);
                c.last_fail_at = now();
                c.rx = None;
            }
            tx.send_replace(Some(res));
        });
        Ok((rx, true))
    }

    /// `if (!startPromise) void startPoller().catch(log)`; a no-op outside a tokio runtime.
    fn ensure_started(&self) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let log = |e: String| logger::error(TAG, format!("background poller start failed: {}", string_err(e)));
        match self.begin_start() {
            Ok((mut rx, true)) => {
                tokio::spawn(async move {
                    if let Some(Err(e)) = settled(&mut rx).await {
                        log(e);
                    }
                });
            }
            Ok((_, false)) => {}
            Err(e) => log(e),
        }
    }

    /// `getMergedStopsView`: the ONE memoized merged KB+MZK stop list, rebuilt exactly when an input changes.
    /// ponytail: the KB bearings come from the process-wide `get_stop_directions()` (config::GTFS_DIR), not
    /// `with_gtfs_dir`; inject them when a test needs the merged view.
    pub fn merged_stops_view(&self) -> Arc<MergedView> {
        let kb = self.poller.stops();
        let (mzk, mzk_dirs) = {
            let mut st = self.mzk_poller.state();
            (Arc::clone(&st.stops), st.stop_dirs.dirs())
        };
        self.merged.get(&MergedInput {
            kb,
            mzk,
            kb_dirs: get_stop_directions(),
            mzk_dirs,
        })
    }

    /// `kbShapeRef(trip, prio)`: `shape_id` (when the store has one) + `shape_status` for an upstream trip object
    /// (times / line.name / direction); touches the store so an unseen pattern is queued. Never panics.
    pub fn kb_shape_ref(&self, trip: &Value, prio: ShapePrio) -> Map<String, Value> {
        let none = || Map::from_iter([("shape_status".to_owned(), Value::from("none"))]);
        guarded("shapes", "kbShapeRef failed", || {
            let times = trip
                .get("times")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            let text = |v: Option<&Value>| {
                if js::truthy(v) {
                    js::value_to_string(v)
                } else {
                    String::new()
                }
            };
            let line = text(trip.get("line").and_then(|l| l.get("name")));
            let dir = text(trip.get("direction"));
            let Some(p) = self.poller.kb_pattern_for(times, &line, &dir) else {
                return none();
            };
            self.shapes.touch_kb(&p, prio);
            let mut o = Map::new();
            if let Some(id) = self.shapes.wire_id(&p.key).filter(|id| !id.is_empty()) {
                o.insert("shape_id".into(), id.into());
            }
            o.insert("shape_status".into(), self.shapes.status(Some(&p.key)).as_str().into());
            o
        })
        .unwrap_or_else(none)
    }

    /// `lineShapeRef`: the shape id of a line-view pattern, MZK from the variant of `mzk:<course>:<variant>`, KB
    /// from its GTFS stop ids (= internal ids). None = straight stop-to-stop lines. Never panics.
    pub fn line_shape_ref(&self, trip_id: &str, stop_ids: &[String], line: &str, headsign: &str) -> Option<String> {
        guarded("shapes", "lineShapeRef failed", || {
            if let Some(variant) = mzk_variant(trip_id) {
                let variant_id = js::number(variant);
                self.shapes.touch_mzk(variant_id, ShapePrio::Background);
                return self
                    .shapes
                    .wire_id(&format!("mzk:{}", js::number_to_string(variant_id)));
            }
            let times: Vec<Value> = stop_ids
                .iter()
                .map(|id| {
                    Value::Object(Map::from_iter([(
                        "designator".to_owned(),
                        js::num_value(js::number(id)),
                    )]))
                })
                .collect();
            let p = self.poller.kb_pattern_for(&times, line, headsign)?;
            self.shapes.touch_kb(&p, ShapePrio::Background);
            self.shapes.wire_id(&p.key)
        })
        .flatten()
    }

    /// `getCombinedVehicles(operator)`: the `/api/vehicles` body, KB then MZK (an MZK fix older than
    /// MZK_STALE_SEC is dropped); "kb" / "mzk" (any case) filter, anything else is the unfiltered entry. The same
    /// Arc until the KB snapshot key or the MZK positions map changes.
    pub fn combined_vehicles(&self, operator: Option<&str>) -> Arc<VehiclesResponse> {
        let now_epoch = (self.now)() as f64 / 1000.0;
        let memo_key = match operator.map(str::to_lowercase).as_deref() {
            Some("kb") => "kb",
            Some("mzk") => "mzk",
            _ => "",
        };
        let kb_key = self.poller.snapshot_key(now_epoch);
        let mzk_positions = Arc::clone(&self.mzk_poller.state().positions);
        if let Some(m) = lock(&self.vehicles_memo).get(memo_key)
            && m.kb_key == kb_key
            && Arc::ptr_eq(&m.mzk_positions, &mzk_positions)
        {
            return Arc::clone(&m.value);
        }
        let wire = |k: &str| self.shapes.wire_id(k);
        let mut vehicles = Vec::new();
        if memo_key != "mzk" {
            for v in self.poller.live_vehicles(now_epoch) {
                vehicles.push(wire_vehicle(&v, &wire, now_epoch, "KB"));
            }
        }
        if memo_key != "kb" {
            for v in mzk_positions
                .values()
                .filter(|v| now_epoch - v.updated_at <= MZK_STALE_SEC)
            {
                vehicles.push(wire_vehicle(v, &wire, now_epoch, "MZK"));
            }
        }
        let (kb_good, kb_scans, kb_last) = {
            let st = self.poller.state();
            (st.last_good_refresh, st.scan_count, st.last_scan)
        };
        let (mzk_good, mzk_scans, mzk_last) = {
            let st = self.mzk_poller.state();
            (st.last_good_refresh, st.scan_count, st.last_scan)
        };
        let value = Arc::new(VehiclesResponse {
            timestamp: js::JsNum(kb_good.max(mzk_good)),
            scan_count: kb_scans + mzk_scans,
            last_scan: js::JsNum(kb_last.max(mzk_last)),
            count: vehicles.len(),
            vehicles,
        });
        lock(&self.vehicles_memo).insert(
            memo_key,
            VehiclesMemo {
                kb_key,
                mzk_positions,
                value: Arc::clone(&value),
            },
        );
        value
    }

    /// `bbLiveDelay`: the live delay (s) of a running trip for the connection search, None when no bus reports
    /// one. KB legs are keyed by the static trip id (`rawTripId`), MZK legs `mzk:<course>:<variant>` by the
    /// course; only today's service date (Warsaw) matches.
    /// ponytail: a trip still running after midnight is keyed to today, so it keeps its timetable times; a
    /// fractional delay truncates toward zero like the GZM search's
    pub fn bb_live_delay(&self) -> Option<impl Fn(&str, &str) -> Option<i32> + Send + Sync + use<T>> {
        let now_ms = (self.now)();
        let now_epoch = now_ms as f64 / 1000.0;
        let mut delays: HashMap<String, i32> = HashMap::new();
        for v in self.poller.live_vehicles(now_epoch) {
            if let (Some(trip), Some(d)) = (v.sched_trip_id.as_ref().filter(|t| !t.is_empty()), v.delay) {
                delays.insert(trip.clone(), d as i32);
            }
        }
        let mzk_positions = Arc::clone(&self.mzk_poller.state().positions);
        for v in mzk_positions.values() {
            if let Some(d) = v.delay
                && now_epoch - v.updated_at <= MZK_STALE_SEC
            {
                delays.insert(format!("mzk:{}", v.trip_id), d as i32);
            }
        }
        if delays.is_empty() {
            return None;
        }
        let today = Timestamp::from_millisecond(now_ms)
            .map(|t| agency_clock(t).0.to_string())
            .unwrap_or_default();
        Some(move |id: &str, date: &str| {
            if date != today {
                return None;
            }
            let key = if id.starts_with("mzk:") {
                mzk_course_key(id)
            } else {
                raw_trip_id(id)
            };
            delays.get(key).copied()
        })
    }

    /// `getCombinedLines`: the KB entries, then the MZK poller's lines.
    pub fn combined_lines(&self, kb_lines: Vec<Value>) -> Vec<Value> {
        let mzk = Arc::clone(&self.mzk_poller.state().lines);
        kb_lines
            .into_iter()
            .chain(mzk.iter().filter_map(|l| serde_json::to_value(l).ok()))
            .collect()
    }

    /// The TS signal handler's body: stop and flush the shape store, flush the MZK and GZM fleet histories, stop
    /// both pollers. ponytail: no signal registration here, main.rs owns the signals and calls this once.
    pub async fn shutdown(&self, sig: &str) {
        logger::info(TAG, format!("{sig} received, stopping pollers"));
        guarded("shapes", "store stop failed", || self.shapes.stop());
        guarded("fleet", "history flush failed", || get_fleet_tracker().flush_sync());
        guarded("gzm-fleet", "history flush failed", flush_gzm_fleet);
        tokio::join!(self.poller.stop(), self.mzk_poller.stop());
    }
}

/// What the spawned start needs of a [`Bb`].
struct Starter<T: BbKinds> {
    poller: Arc<LivePoller<T::Kb>>,
    mzk_api: Arc<T::Mzk>,
    mzk_poller: Arc<MzkPoller<T::Mzk>>,
    shapes: Arc<ShapeStore<T::Osrm>>,
    gtfs_dir: PathBuf,
    gtfs_refresh: Option<GtfsRefreshHook<T::Mzk>>,
}

impl<T: BbKinds> Starter<T> {
    /// The `Promise.allSettled([startKb, mzkPoller.start()])` of `startPoller`.
    async fn run(self: Arc<Self>) -> Result<(), String> {
        let kb = self.spawn_kb();
        let mzk_poller = Arc::clone(&self.mzk_poller);
        let mzk = tokio::spawn(async move {
            mzk_poller.start().await;
            let n = mzk_poller.state().stops.len();
            logger::info(TAG, format!("MZK poller up, {n} stops loaded"));
            Ok(())
        });
        let (kb, mzk) = tokio::join!(joined(kb), joined(mzk));
        if let Err(e) = &kb {
            logger::warn(TAG, format!("KB poller start warning: {e}"));
            if mzk.is_ok() {
                self.retry_kb();
            }
        }
        if let Err(e) = &mzk {
            logger::warn(TAG, format!("MZK poller start warning: {e}"));
        }
        if kb.is_err() && mzk.is_err() {
            return Err("Both KB and MZK poller starts failed".to_owned());
        }
        Ok(())
    }

    fn spawn_kb(self: &Arc<Self>) -> JoinHandle<Result<(), String>> {
        let me = Arc::clone(self);
        tokio::spawn(me.start_kb())
    }

    /// `startKb`: the KB poller, then the GTFS refresh hook and one seeding 3 min later.
    async fn start_kb(self: Arc<Self>) -> Result<(), String> {
        self.poller.start().await?;
        let n = self.poller.stops().len();
        logger::info(TAG, format!("KB poller up, {n} stops loaded"));
        if let Some(hook) = &self.gtfs_refresh {
            let me = Arc::clone(&self);
            hook(Arc::new(move || blocking_io(|| me.seed())), Arc::clone(&self.mzk_api));
        }
        tokio::spawn(async move {
            tokio::time::sleep(SEED_DELAY).await;
            blocking_io(|| self.seed());
        });
        Ok(())
    }

    /// `retryKbStart`: every 30 s until a KB start succeeds.
    fn retry_kb(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(START_RETRY_COOLDOWN_MS as u64)).await;
                match joined(me.spawn_kb()).await {
                    Ok(()) => break,
                    Err(e) => logger::warn(TAG, format!("KB poller start retry failed: {e}")),
                }
            }
        });
    }

    /// `seedShapesFromGtfs`: queue every stop pattern of the built feed for background routing. Sync file IO.
    fn seed(&self) {
        let seeded = guarded("shapes", "GTFS seeding failed", || {
            if !self.gtfs_dir.join("stop_times.txt").exists() {
                return None;
            }
            let seeds = read_gtfs_pattern_seeds(&self.gtfs_dir);
            if !seeds.is_empty() {
                self.shapes.clear_raw_trips();
            }
            let mut n = 0;
            for seed in &seeds {
                let Some(p) = self.poller.kb_pattern_for(&seed.times, &seed.line, &seed.dir) else {
                    continue;
                };
                self.shapes.register_raw_trips(&seed.raw_trip_ids, &p.key);
                self.shapes.touch_kb(&p, ShapePrio::Background);
                n += 1;
            }
            Some(n)
        });
        if let Some(Some(n)) = seeded {
            logger::info("shapes", format!("seeded {n} GTFS stop patterns"));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;
    use crate::mzk_api::{MzkLine, MzkRunningVehicle, MzkStopPoint};
    use crate::osrm::OsrmHttp;
    use crate::types::Stop;

    #[test]
    fn mzk_course_key_keeps_the_ts_slice() {
        assert_eq!(mzk_course_key("mzk:123:456"), "mzk:123");
        assert_eq!(mzk_course_key("mzk:123"), "mzk:12", "indexOf -1 = slice(0, -1)");
        assert_eq!(mzk_course_key("mzk:"), "mzk");
    }

    #[test]
    fn mzk_variant_matches_the_ts_regex() {
        assert_eq!(mzk_variant("mzk:12:345"), Some("345"));
        for id in ["mzk:12:", "mzk::3", "mzk:1:2:3", "mzk:1:2\n", "mzk:a:2", "kb:1:2"] {
            assert_eq!(mzk_variant(id), None, "{id:?}");
        }
    }

    struct DownKb(Arc<AtomicU32>);

    impl KbSource for DownKb {
        async fn fetch_revision(&self) -> String {
            "1".to_owned()
        }
        async fn fetch_stops(&self, _: Option<&str>) -> Result<Vec<Stop>, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err("upstream down".to_owned())
        }
        async fn fetch_multiple_departures(&self, _: &[String]) -> Result<Value, String> {
            Err("down".to_owned())
        }
        async fn fetch_trip_execution(&self, _: &str, _: i64) -> Result<Value, String> {
            Err("down".to_owned())
        }
    }

    struct DownMzk;

    impl MzkSource for DownMzk {
        async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
            Err("down".to_owned())
        }
        async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
            Err("down".to_owned())
        }
        async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
            Err("down".to_owned())
        }
        async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
            Err("down".to_owned())
        }
    }

    struct NoOsrm;

    impl OsrmTransport for NoOsrm {
        async fn throttle(&self) {}
        async fn get(&self, _: &str) -> Result<OsrmHttp, String> {
            Err("no osrm".to_owned())
        }
    }

    struct Fakes;

    impl BbKinds for Fakes {
        type Kb = DownKb;
        type Mzk = DownMzk;
        type Osrm = NoOsrm;
    }

    /// The spawned start settles the waiters and keeps retrying a dead KB while MZK is up.
    #[tokio::test(start_paused = true)]
    async fn failed_kb_start_is_retried_in_the_background() {
        let kb_starts = Arc::new(AtomicU32::new(0));
        let shapes = ShapeStore::new(ShapeStoreOptions {
            timers: false,
            ..ShapeStoreOptions::new(NoOsrm)
        });
        let base = tokio::time::Instant::now();
        let bb = Bb::<Fakes>::from_parts(
            DownKb(Arc::new(AtomicU32::new(0))),
            LivePoller::new(DownKb(Arc::clone(&kb_starts)), LivePollerOptions::default()),
            DownMzk,
            MzkPoller::new(DownMzk).with_stop_dirs_file(None),
            shapes,
        )
        .with_gtfs_dir(PathBuf::from("/nonexistent"))
        .with_now(Arc::new(move || 1_800_000_000_000 + base.elapsed().as_millis() as i64));
        let all = bb.combined_vehicles(None);
        assert!(
            Arc::ptr_eq(&all, &bb.combined_vehicles(Some("anything"))),
            "an unknown filter shares the entry"
        );
        assert!(!Arc::ptr_eq(&all, &bb.combined_vehicles(Some("KB"))));
        assert_eq!(bb.start_poller().await, Ok(()));
        assert_eq!(kb_starts.load(Ordering::SeqCst), 1);
        assert_eq!(bb.start_poller().await, Ok(()), "a settled start is shared");
        tokio::time::sleep(Duration::from_secs(61)).await;
        assert_eq!(kb_starts.load(Ordering::SeqCst), 3);
        bb.mzk_poller.stop().await;
    }
}
