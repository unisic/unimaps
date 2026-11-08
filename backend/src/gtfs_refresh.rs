//! lib/gtfs-refresh.ts: the in-process daily rebuild of the KB GTFS feed and, after it, the MZK timetable. A missing
//! feed is built at the first check (fresh volume); a feed dated before today is rebuilt once it is past
//! `GTFS_BUILD_HOUR` agency time. A failed build keeps the old files and backs off 30 min (each build its own
//! backoff); one build at a time. Inert until [`start_gtfs_refresh`] / [`GtfsRefresh::start`].

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use jiff::Timestamp;
use tokio::runtime::Handle;

use crate::config;
use crate::fetch::string_err;
use crate::fleet_tracker::blocking_io;
use crate::gtfs_builder::{BuildGtfsOptions, build_gtfs, gtfs_feed_date};
use crate::gzm::{HttpZb, NowFn};
use crate::kb_api::KbApi;
use crate::logger;
use crate::mzk_api::MzkSource;
use crate::mzk_timetable::{build_mzk_timetable, mzk_timetable_date, save_mzk_timetable};
use crate::poller_singleton::SeedFn;
use crate::shape_store::BoxFut;

const CHECK_INTERVAL: Duration = Duration::from_secs(10 * 60);
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const FAIL_BACKOFF_MS: i64 = 30 * 60_000;

/// One KB feed build: (date "YYYY-MM-DD", output dir). Live: [`build_gtfs`] with its own `KbApi` at
/// `GTFS_BUILD_CONCURRENCY`.
pub type BuildFeedFn = Arc<dyn Fn(String, PathBuf) -> BoxFut<Result<(), String>> + Send + Sync>;

#[derive(Default)]
struct RefreshState {
    building: bool,
    /// epoch ms before which no KB build may start (failure backoff)
    next_attempt_at: i64,
    mzk_next_attempt_at: i64,
}

fn lock(m: &Mutex<RefreshState>) -> MutexGuard<'_, RefreshState> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Clears `building` when a build attempt ends, also on a panic, so one bad build never stops the refresh.
struct Building<'a>(&'a Mutex<RefreshState>);

impl Drop for Building<'_> {
    fn drop(&mut self) {
        lock(self.0).building = false;
    }
}

/// The TS `RefreshState` with its checks. Paths, clock and the KB build are injectable for tests.
pub struct GtfsRefresh<M> {
    on_built: SeedFn,
    mzk_api: Arc<M>,
    build_feed: BuildFeedFn,
    gtfs_dir: PathBuf,
    timetable_file: PathBuf,
    now: NowFn,
    state: Mutex<RefreshState>,
}

impl<M: MzkSource + 'static> GtfsRefresh<M> {
    /// Live defaults: `config::GTFS_DIR`, `config::MZK_TIMETABLE_FILE`, system clock, [`build_gtfs`] over a fresh
    /// `KbApi` per build. Nothing is started.
    pub fn new(on_built: SeedFn, mzk_api: Arc<M>) -> Self {
        let build_feed: BuildFeedFn = Arc::new(|date, out_dir| {
            Box::pin(async move {
                let n = usize::try_from(*config::GTFS_BUILD_CONCURRENCY).unwrap_or(1);
                let api = KbApi::new(HttpZb).with_concurrency(n);
                build_gtfs(
                    &api,
                    &BuildGtfsOptions {
                        date,
                        out_dir,
                        ..BuildGtfsOptions::default()
                    },
                )
                .await
            })
        });
        Self {
            on_built,
            mzk_api,
            build_feed,
            gtfs_dir: PathBuf::from(config::GTFS_DIR.as_str()),
            timetable_file: PathBuf::from(config::MZK_TIMETABLE_FILE.as_str()),
            now: Arc::new(|| Timestamp::now().as_millisecond()),
            state: Mutex::default(),
        }
    }

    pub fn with_build_feed(mut self, build_feed: BuildFeedFn) -> Self {
        self.build_feed = build_feed;
        self
    }

    /// Where the feed is built and its date read.
    pub fn with_gtfs_dir(mut self, dir: PathBuf) -> Self {
        self.gtfs_dir = dir;
        self
    }

    pub fn with_timetable_file(mut self, file: PathBuf) -> Self {
        self.timetable_file = file;
        self
    }

    /// Epoch ms: backoffs, today's Warsaw date and hour, the timetable's `builtAt`.
    pub fn with_now(mut self, now: NowFn) -> Self {
        self.now = now;
        self
    }

    /// The TS timers: the first check after 60 s, then one every 10 min, each in its own task (a long build is
    /// skipped over by the `building` flag, as with `setInterval`). The loop dies with the runtime (the TS unref);
    /// no-op outside a runtime.
    pub fn start(self: Arc<Self>) {
        let Ok(rt) = Handle::try_current() else {
            return;
        };
        rt.spawn(async move {
            tokio::time::sleep(FIRST_CHECK_DELAY).await;
            loop {
                let me = Arc::clone(&self);
                tokio::spawn(async move { me.check().await });
                tokio::time::sleep(CHECK_INTERVAL).await;
            }
        });
        logger::info(
            "gtfs",
            format!(
                "auto-rebuild armed (daily after {}:00 {}, bootstrap when feed missing)",
                *config::GTFS_BUILD_HOUR,
                *config::AGENCY_TIMEZONE
            ),
        );
    }

    /// One check: the KB feed, then the MZK timetable.
    pub async fn check(&self) {
        self.maybe_build().await;
        self.maybe_build_mzk().await;
    }

    /// Today's Warsaw date and hour (`warsawHour`) on the injected clock.
    fn clock(&self) -> (String, i64) {
        let ts = Timestamp::from_millisecond((self.now)()).unwrap_or_else(|_| Timestamp::now());
        let (date, secs) = crate::time::agency_clock(ts);
        (date.to_string(), i64::from(secs / 3600))
    }

    /// The `building` flag, taken when no build runs and the backoff `next_at` has passed.
    fn claim(&self, next_at: impl Fn(&RefreshState) -> i64) -> Option<Building<'_>> {
        let now = (self.now)();
        let mut st = lock(&self.state);
        if st.building || now < next_at(&st) {
            return None;
        }
        st.building = true;
        Some(Building(&self.state))
    }

    async fn maybe_build(&self) {
        let Some(_building) = self.claim(|st| st.next_attempt_at) else {
            return;
        };
        let dir = self.gtfs_dir.clone();
        let feed_date = blocking_io(|| gtfs_feed_date(&dir));
        let (today, hour) = self.clock();
        match &feed_date {
            None => logger::info("gtfs", "no feed found, bootstrap build starting"),
            Some(d) if *d != today && hour >= *config::GTFS_BUILD_HOUR => {
                logger::info("gtfs", format!("feed dated {d}, rebuilding for {today}"));
            }
            Some(_) => return,
        }
        match (self.build_feed)(today.clone(), dir).await {
            Ok(()) => {
                crate::stop_directions::invalidate_stop_directions();
                crate::lines::invalidate_lines();
                crate::gtfs_trips::invalidate_gtfs_trips();
                crate::router::invalidate_router();
                logger::info("gtfs", format!("feed rebuilt for {today}"));
                (self.on_built)();
            }
            Err(e) => {
                lock(&self.state).next_attempt_at = (self.now)() + FAIL_BACKOFF_MS;
                logger::error(
                    "gtfs",
                    format!("feed rebuild failed (retry in 30 min): {}", string_err(e)),
                );
            }
        }
    }

    async fn maybe_build_mzk(&self) {
        let Some(_building) = self.claim(|st| st.mzk_next_attempt_at) else {
            return;
        };
        let file = self.timetable_file.clone();
        let built = blocking_io(|| mzk_timetable_date(&file));
        let (today, hour) = self.clock();
        match &built {
            None => logger::info("mzk-tt", "no MZK timetable found, building"),
            Some(b) if *b != today && hour >= *config::GTFS_BUILD_HOUR => {
                logger::info("mzk-tt", format!("MZK timetable from {b}, rebuilding"));
            }
            Some(_) => return,
        }
        let res = match build_mzk_timetable(&*self.mzk_api, &today, &self.now).await {
            Ok(tt) => blocking_io(|| save_mzk_timetable(&tt, &file)).map_err(|e| e.to_string()),
            Err(e) => Err(e),
        };
        match res {
            Ok(()) => crate::router::invalidate_router(),
            Err(e) => {
                lock(&self.state).mzk_next_attempt_at = (self.now)() + FAIL_BACKOFF_MS;
                logger::error(
                    "mzk-tt",
                    format!("MZK timetable build failed (retry in 30 min): {}", string_err(e)),
                );
            }
        }
    }
}

/// `startGtfsRefresh(onBuilt, mzkApi)`: arms the live [`GtfsRefresh`] once per process (a later call is a no-op);
/// nothing when `KB_GTFS_AUTOBUILD=0` or outside a tokio runtime.
pub fn start_gtfs_refresh<M: MzkSource + 'static>(on_built: SeedFn, mzk_api: Arc<M>) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if !*config::GTFS_AUTOBUILD || Handle::try_current().is_err() || STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    Arc::new(GtfsRefresh::new(on_built, mzk_api)).start();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, AtomicUsize};

    use serde_json::Value;

    use super::*;
    use crate::mzk_api::{MzkLine, MzkRunningVehicle, MzkStopPoint};

    /// Counts calendar fetches (the first step of an MZK build), which always fail.
    #[derive(Default)]
    struct Mzk(AtomicUsize);

    impl MzkSource for Mzk {
        async fn fetch_running_vehicles(&self) -> Result<Vec<MzkRunningVehicle>, String> {
            Ok(Vec::new())
        }
        async fn fetch_vehicles(&self) -> Result<Vec<Value>, String> {
            Ok(Vec::new())
        }
        async fn fetch_stops(&self) -> Result<Vec<MzkStopPoint>, String> {
            Ok(Vec::new())
        }
        async fn fetch_lines(&self) -> Result<Vec<MzkLine>, String> {
            Ok(Vec::new())
        }
        async fn fetch_calendar(&self) -> Result<Vec<Value>, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err("HTTP 503".into())
        }
    }

    #[tokio::test]
    async fn failed_builds_back_off_on_their_own_timers() {
        let missing = std::env::temp_dir().join(format!("unimaps-gtfs-refresh-{}", std::process::id()));
        let builds = Arc::new(AtomicUsize::new(0));
        let seeded = Arc::new(AtomicUsize::new(0));
        let now = Arc::new(AtomicI64::new(1_762_650_000_000));
        let mzk = Arc::new(Mzk::default());
        let b = Arc::clone(&builds);
        let s = Arc::clone(&seeded);
        let n = Arc::clone(&now);
        let refresh = GtfsRefresh::new(Arc::new(move || _ = s.fetch_add(1, Ordering::SeqCst)), Arc::clone(&mzk))
            .with_gtfs_dir(missing.join("gtfs"))
            .with_timetable_file(missing.join("mzk.json"))
            .with_now(Arc::new(move || n.load(Ordering::SeqCst)))
            .with_build_feed(Arc::new(move |_, _| {
                let first = b.fetch_add(1, Ordering::SeqCst) == 0;
                Box::pin(async move { if first { Err("HTTP 503".into()) } else { Ok(()) } })
            }));
        let counts = || {
            (
                builds.load(Ordering::SeqCst),
                seeded.load(Ordering::SeqCst),
                mzk.0.load(Ordering::SeqCst),
            )
        };

        refresh.check().await;
        assert_eq!(counts(), (1, 0, 1));
        now.fetch_add(29 * 60_000, Ordering::SeqCst);
        refresh.check().await;
        assert_eq!(counts(), (1, 0, 1));
        now.fetch_add(60_000, Ordering::SeqCst);
        refresh.check().await;
        assert_eq!(counts(), (2, 1, 2));
        assert!(!lock(&refresh.state).building);
    }
}
