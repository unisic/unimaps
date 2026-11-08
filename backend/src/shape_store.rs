//! Road-shape store, port of `lib/shape-store.ts` minus its `globalThis` singleton: road-following geometry for KB
//! stop patterns (routed through OSRM by one paced worker) and MZK variants (operator API), kept in one JSON file that
//! a lock file keeps single-writer across processes. File, lock and key formats are the TS ones: Node and Rust may
//! share `output/shapes` and must never both write it.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs::{File, FileTimes};
use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use tokio::runtime::Handle;
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;

use crate::fleet_tracker::blocking_io;
use crate::gzm::NowFn;
use crate::gzm_feed::{ShapeLookup, ShapePayload};
use crate::js::{self, JsNum};
use crate::logger::{error, info, warn};
use crate::mzk_shape::mzk_shape_from_course_details;
use crate::osrm::{HttpOsrm, OsrmFailure, OsrmHttp, OsrmPace, OsrmTransport, book_slot, route_waypoints};
use crate::shape_patterns::KbPattern;
use crate::shared::polyline::{
    LatLng, Polyline, decode_polyline, encode_polyline, point_at, prepare_polyline, project_stops_along, prune_spurs,
    simplify_polyline, tangent_bearing,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShapeSrc {
    Osrm,
    Partial,
    Straight,
    Mzk,
    Gtfs,
}

impl ShapeSrc {
    fn rank(self) -> u8 {
        match self {
            Self::Straight => 1,
            Self::Partial => 2,
            Self::Osrm | Self::Mzk | Self::Gtfs => 3,
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "osrm" => Self::Osrm,
            "partial" => Self::Partial,
            "straight" => Self::Straight,
            "mzk" => Self::Mzk,
            "gtfs" => Self::Gtfs,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Osrm => "osrm",
            Self::Partial => "partial",
            Self::Straight => "straight",
            Self::Mzk => "mzk",
            Self::Gtfs => "gtfs",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShapeGeometry {
    pub pl: Polyline,
    pub stops: Vec<Option<f64>>,
    pub rev: String,
    pub src: ShapeSrc,
}

/// `finalizeShape`'s answer: the wire fields of an entry.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalShape {
    /// encoded polyline, precision 6
    pub poly: String,
    pub len: f64,
    pub stops: Vec<Option<f64>>,
    pub rev: String,
    pub src: ShapeSrc,
}

/// `revOf`: sha1 of `src|poly|len.toFixed(1)|JSON.stringify(stops)`, first 6 hex digits. Part of the wire id, so it
/// must hash the exact bytes the TS wrote (a different rev = every client refetches, every stored id misses).
pub fn rev_of(src: ShapeSrc, poly: &str, len: f64, stops: &[Option<f64>]) -> String {
    // JSON.stringify: a number as String() writes it, a non-finite one as null
    let stops_json = format!(
        "[{}]",
        stops
            .iter()
            .map(|s| s
                .filter(|x| x.is_finite())
                .map_or_else(|| "null".to_owned(), js::number_to_string))
            .collect::<Vec<_>>()
            .join(",")
    );
    // len is already rounded to 0.1, so `{:.1}` and toFixed(1) cannot meet a tie
    let digest = Sha1::digest(format!("{}|{poly}|{len:.1}|{stops_json}", src.as_str()));
    digest[..3].iter().fold(String::with_capacity(6), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// `finalizeShape`: quantize to the wire format, prepare, place the stops.
pub fn finalize_shape(pts: &[LatLng], stop_refs: &[Option<LatLng>], src: ShapeSrc) -> Option<FinalShape> {
    let poly = encode_polyline(pts, 6);
    let pl = prepare_polyline(&decode_polyline(&poly, 6))?;
    let stops: Vec<Option<f64>> = project_stops_along(&pl, stop_refs, 80.0)
        .into_iter()
        .map(|s| s.map(js::round1))
        .collect();
    let len = js::round1(pl.length);
    let rev = rev_of(src, &poly, len, &stops);
    Some(FinalShape {
        poly,
        len,
        stops,
        rev,
        src,
    })
}

const TAG: &str = "shapes";
pub const ALGO_VERSION: f64 = 3.0;
const FORMAT: &str = "kb-map/route-shapes";
const FILE_VERSION: f64 = 1.0;

const DAY_MS: i64 = 86_400_000;
const REFRESH_TICK_MS: i64 = 120_000;
const HEARTBEAT_MS: i64 = 60_000;
const LOCK_STALE_MS: f64 = 300_000.0;
const FLUSH_DEBOUNCE_MS: i64 = 30_000;
const FLUSH_RETRY_MS: i64 = 300_000;
const FIRST_KICK_MS: i64 = 30_000;
const SEEN_TOUCH_MS: f64 = 60_000.0;
const SEEN_FLUSH_MS: i64 = 6 * 3_600_000;
const SEEN_WINDOW_MS: i64 = 7 * DAY_MS;
const GC_UNSEEN_MS: i64 = 30 * DAY_MS;
const PARTIAL_MAX_AGE_MS: i64 = DAY_MS;
const MZK_MAX_AGE_MS: i64 = 7 * DAY_MS;
const MZK_NEG_CACHE_MS: i64 = 600_000;
const MZK_BG_SPACING_MS: i64 = 1_000;
const MAX_ENTRIES: usize = 5000;
const MAX_QUEUE: usize = 1000;
const GEOM_LRU: usize = 300;
const BACKOFF_START_MS: i64 = 60_000;
const BACKOFF_MAX_MS: i64 = 30 * 60_000;

/// `isRoadSrc`: anything better than straight lines between the stops.
pub fn is_road_src(src: ShapeSrc) -> bool {
    src.rank() >= 2
}

/// One stored shape (`ShapeEntry`). Times are epoch ms; every number stays f64 because the file may hold any finite
/// value and it is written back as read.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapeEntry {
    pub src: ShapeSrc,
    /// encoded polyline, precision 6
    pub poly: String,
    pub len: f64,
    /// along-route metres per trip.times index (KB) / stop order (MZK); None = unplaced
    pub stops: Vec<Option<f64>>,
    pub rev: String,
    pub built_at: f64,
    pub seen_at: f64,
    pub fails: f64,
    pub retry_at: f64,
    pub algo: f64,
    /// Some(true): straight because every leg was unroutable, no point retrying soon. None = the TS field is absent
    /// (Some(false) is written as `false`, like the TS after a reset)
    pub unroutable: Option<bool>,
    /// KB rebuild inputs
    pub wp_sig: Option<String>,
    pub wp: Option<String>,
    pub sp: Option<Vec<Option<LatLng>>>,
    pub line: Option<String>,
    pub dir: Option<String>,
}

impl ShapeEntry {
    fn is_unroutable(&self) -> bool {
        self.unroutable == Some(true)
    }
}

fn js_nums(xs: &[Option<f64>]) -> Vec<Option<JsNum>> {
    xs.iter().map(|x| x.map(JsNum)).collect()
}

// ponytail: one key order (the one `validEntry` rebuilds on load) where the TS order depends on how the entry was made
// in this process; JSON readers ignore it, and the TS writes this order too once it has restarted
impl Serialize for ShapeEntry {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("src", &self.src)?;
        m.serialize_entry("poly", &self.poly)?;
        m.serialize_entry("len", &JsNum(self.len))?;
        m.serialize_entry("stops", &js_nums(&self.stops))?;
        m.serialize_entry("rev", &self.rev)?;
        m.serialize_entry("builtAt", &JsNum(self.built_at))?;
        m.serialize_entry("seenAt", &JsNum(self.seen_at))?;
        m.serialize_entry("fails", &JsNum(self.fails))?;
        m.serialize_entry("retryAt", &JsNum(self.retry_at))?;
        m.serialize_entry("algo", &JsNum(self.algo))?;
        if let Some(u) = self.unroutable {
            m.serialize_entry("unroutable", &u)?;
        }
        if let Some(v) = &self.wp_sig {
            m.serialize_entry("wpSig", v)?;
        }
        if let Some(v) = &self.wp {
            m.serialize_entry("wp", v)?;
        }
        if let Some(sp) = &self.sp {
            let sp: Vec<Option<[JsNum; 2]>> = sp.iter().map(|p| p.map(|[a, b]| [JsNum(a), JsNum(b)])).collect();
            m.serialize_entry("sp", &sp)?;
        }
        if let Some(v) = &self.line {
            m.serialize_entry("line", v)?;
        }
        if let Some(v) = &self.dir {
            m.serialize_entry("dir", v)?;
        }
        m.end()
    }
}

fn is_rev6(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// `validEntry`: an entry read from the store file, None when it is unusable. Unknown fields are dropped.
pub fn valid_entry(v: &Value) -> Option<ShapeEntry> {
    let e = v.as_object()?;
    let src = e.get("src").and_then(Value::as_str).and_then(ShapeSrc::parse)?;
    let poly = e.get("poly").and_then(Value::as_str)?;
    let rev = e.get("rev").and_then(Value::as_str).filter(|r| is_rev6(r))?;
    let len = e.get("len").and_then(Value::as_f64)?;
    let stops = e
        .get("stops")
        .and_then(Value::as_array)?
        .iter()
        .map(|s| match s {
            Value::Null => Some(None),
            Value::Number(n) => n.as_f64().map(Some),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let num = |k: &str| e.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let text = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned);
    let sp = e.get("sp").and_then(Value::as_array).map(|a| {
        a.iter()
            .map(|p| match p.as_array().map(Vec::as_slice) {
                Some([lat, lon]) => Some([lat.as_f64()?, lon.as_f64()?]),
                _ => None,
            })
            .collect()
    });
    Some(ShapeEntry {
        src,
        poly: poly.to_owned(),
        len,
        stops,
        rev: rev.to_owned(),
        built_at: num("builtAt"),
        seen_at: num("seenAt"),
        fails: num("fails"),
        retry_at: num("retryAt"),
        algo: num("algo"),
        unroutable: (e.get("unroutable") == Some(&Value::Bool(true))).then_some(true),
        wp_sig: text("wpSig"),
        wp: text("wp"),
        sp,
        line: text("line"),
        dir: text("dir"),
    })
}

/// `pickRefreshCandidate`: the next KB entry due for a background refresh (oldest `built_at` first), or None.
pub fn pick_refresh_candidate<'a, K: AsRef<str> + 'a>(
    entries: impl IntoIterator<Item = (&'a K, &'a ShapeEntry)>,
    now_ms: i64,
    max_age_days: f64,
    skip: Option<&dyn Fn(&str) -> bool>,
) -> Option<String> {
    let now = now_ms as f64;
    let max_age = max_age_days * DAY_MS as f64;
    let mut best = None;
    let mut best_at = f64::INFINITY;
    for (k, e) in entries {
        let key = k.as_ref();
        if !key.starts_with("kb:") || skip.is_some_and(|f| f(key)) {
            continue;
        }
        if now - e.seen_at > SEEN_WINDOW_MS as f64 {
            continue;
        }
        let age = now - e.built_at;
        let straight = e.src == ShapeSrc::Straight;
        let due = (e.algo < ALGO_VERSION && now >= e.retry_at)
            || (e.src == ShapeSrc::Osrm && age > max_age)
            || (e.src == ShapeSrc::Partial && age > PARTIAL_MAX_AGE_MS as f64)
            || (straight && !e.is_unroutable() && now >= e.retry_at)
            || (straight && e.is_unroutable() && age > max_age);
        if due && e.built_at < best_at {
            best = Some(key);
            best_at = e.built_at;
        }
    }
    best.map(str::to_owned)
}

/// `ShapeStatus` on a trip answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShapeStatus {
    Road,
    Pending,
    None,
}

impl ShapeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Road => "road",
            Self::Pending => "pending",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapePrio {
    Urgent,
    Background,
}

/// A queue job's upstream: KB routing (OSRM) or an MZK variant fetch. One worker each, never waiting on each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeKind {
    Kb,
    Mzk,
}

impl ShapeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Kb => "kb",
            Self::Mzk => "mzk",
        }
    }

    fn of(key: &str) -> Option<Self> {
        if key.starts_with("kb:") {
            Some(Self::Kb)
        } else if key.starts_with("mzk:") {
            Some(Self::Mzk)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OsrmState {
    Ok,
    Disabled,
    Paused,
    Blocked,
    ConfigError,
}

impl OsrmState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Disabled => "disabled",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::ConfigError => "config_error",
        }
    }
}

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// Waits the given ms; injectable so a test advances its fake clock instead.
pub type SleepFn = Arc<dyn Fn(i64) -> BoxFut<()> + Send + Sync>;
/// An MZK variant's course details (`MzkApi.getCourseDetails`); Err = the TS fetcher threw.
pub type MzkFetchFn = Arc<dyn Fn(i64) -> BoxFut<Result<Value, String>> + Send + Sync>;

/// `ShapeStoreOptions`. ponytail: no `userAgent`, the transport owns the header (`HttpOsrm` sends `KB_OSRM_UA`).
pub struct ShapeStoreOptions<O> {
    /// how OSRM is reached (`fetchImpl`); its own `throttle` is never called, the store paces every request
    pub fetch: O,
    /// OSRM route service base (.../route/v1/driving); None or empty disables KB routing
    pub osrm_base: Option<String>,
    pub min_interval_ms: i64,
    /// request slots shared with other clients of the same OSRM server; None = this store's own
    pub pace: Option<&'static OsrmPace>,
    pub max_age_days: f64,
    /// persistence file; None = in memory only
    pub file: Option<PathBuf>,
    pub mzk_fetch: Option<MzkFetchFn>,
    /// epoch ms clock
    pub now: NowFn,
    /// paces OSRM requests and MZK fetches; the timers run on tokio time
    pub sleep: SleepFn,
    /// false = no background tasks (tests drive `run_next` by hand)
    pub timers: bool,
}

impl<O> ShapeStoreOptions<O> {
    /// The TS defaults of the optional fields: no OSRM, no file, no MZK, system clock, tokio sleep, timers on. The
    /// required `minIntervalMs`/`maxAgeDays` default to 1000 and 14.
    pub fn new(fetch: O) -> Self {
        Self {
            fetch,
            osrm_base: None,
            min_interval_ms: 1000,
            pace: None,
            max_age_days: 14.0,
            file: None,
            mzk_fetch: None,
            now: Arc::new(|| jiff::Timestamp::now().as_millisecond()),
            sleep: Arc::new(|ms| Box::pin(tokio::time::sleep(ms_dur(ms))) as BoxFut<()>),
            timers: true,
        }
    }
}

fn ms_dur(ms: i64) -> Duration {
    Duration::from_millis(u64::try_from(ms).unwrap_or(0))
}

/// What the MZK poller needs from the store.
pub trait MzkShapeSink: Send + Sync {
    fn touch_mzk(&self, variant_id: f64, prio: ShapePrio);
    fn geometry(&self, key: &str) -> Option<Arc<ShapeGeometry>>;
}

/// `<key>.<rev6>` -> (key, Some(rev)); any other id is its own key (`lastIndexOf(".") > 0` and `/\.[0-9a-f]{6}$/`).
fn split_wire_id(id: &str) -> (&str, Option<&str>) {
    match id.rfind('.') {
        Some(d) if d > 0 && id.len() - d == 7 && is_rev6(&id[d + 1..]) => (&id[..d], Some(&id[d + 1..])),
        _ => (id, None),
    }
}

impl ShapeEntry {
    fn set_shape(&mut self, f: FinalShape) {
        self.src = f.src;
        self.poly = f.poly;
        self.len = f.len;
        self.stops = f.stops;
        self.rev = f.rev;
    }
}

impl ShapeKind {
    fn idx(self) -> usize {
        match self {
            Self::Kb => 0,
            Self::Mzk => 1,
        }
    }
}

type MzkCell = Arc<OnceCell<Option<ShapeEntry>>>;

struct State {
    entries: IndexMap<String, ShapeEntry>,
    /// prepared geometries, least recently used first
    geom_cache: IndexMap<String, Arc<ShapeGeometry>>,
    urgent: Vec<String>,
    background: Vec<String>,
    queued: HashSet<String>,
    // ponytail: uncapped like the TS map, one entry per variant that failed in the last 10 min; maybe_gc prunes it daily
    mzk_neg: HashMap<i64, i64>,
    mzk_inflight: HashMap<i64, MzkCell>,
    // ponytail: uncapped like the TS map, bounded by the GTFS feed's trips and cleared before every reseed
    raw_trip_to_key: HashMap<String, String>,
    mzk_next_slot: i64,
    paused_until: i64,
    backoff_ms: i64,
    /// paused_until a wake-up timer is already armed for (one per pause, not one per idle pump)
    wake_at: i64,
    osrm_state: OsrmState,
    last_error: Option<String>,
    last_build_at: i64,
    builds: u64,
    owns_lock: bool,
    read_only: bool,
    /// a file exists that could not be loaded safely: never overwrite it
    load_blocked: bool,
    file_mtime: f64,
    content_dirty: bool,
    seen_dirty: bool,
    last_flush: i64,
    persist_error: Option<String>,
    write_seq: u64,
    started: bool,
    /// a worker task runs, per ShapeKind
    pumping: [bool; 2],
    timers: Vec<JoinHandle<()>>,
    flush_timer: Option<JoinHandle<()>>,
    last_gc: i64,
    /// `stop_tangents()` and the hash of the (key, rev) pairs it was built from
    stop_tangents: Option<(u64, Arc<Vec<[f64; 3]>>)>,
}

impl State {
    /// A 24 h block lapses on its own: try again (the next refusal re-blocks).
    fn expire_block(&mut self, now: i64) {
        if self.osrm_state == OsrmState::Blocked && self.paused_until <= now {
            self.osrm_state = OsrmState::Ok;
        }
    }

    /// A recent fetch of this variant failed (a failed refresh keeps built_at, so this is its only backoff).
    fn backed_off(&self, id: i64, now: i64) -> bool {
        self.mzk_neg.get(&id).is_some_and(|&until| until > now)
    }
}

/// The road-shape store (`ShapeStore`). Built by [`ShapeStore::new`]; nothing runs until [`ShapeStore::start`].
pub struct ShapeStore<O = HttpOsrm> {
    me: Weak<Self>,
    fetch: O,
    osrm_base: Option<String>,
    min_interval_ms: i64,
    pace: Option<&'static OsrmPace>,
    own_pace: OsrmPace,
    max_age_days: f64,
    file: Option<PathBuf>,
    mzk_fetch: Option<MzkFetchFn>,
    now: NowFn,
    sleep: SleepFn,
    timers: bool,
    state: Mutex<State>,
    /// one flush at a time: an older snapshot must not land after a newer one
    flush_lock: Mutex<()>,
}

/// The store's own pacing in front of the transport (`throttle: () => this.throttle()`).
struct Paced<'a, O>(&'a ShapeStore<O>);

impl<O: OsrmTransport + Send + Sync + 'static> OsrmTransport for Paced<'_, O> {
    async fn throttle(&self) {
        let s = self.0;
        let wait = book_slot(s.pace(), s.min_interval_ms, s.now());
        if wait > 0 {
            (s.sleep)(wait).await;
        }
    }

    fn get(&self, url: &str) -> impl Future<Output = Result<OsrmHttp, String>> + Send {
        self.0.fetch.get(url)
    }
}

fn retry_at(now: f64, fails: f64) -> f64 {
    now + (300_000.0 * 2f64.powf(fails)).min(6.0 * 3_600_000.0)
}

fn secs(ms: i64) -> String {
    js::number_to_string(js::round(ms as f64 / 1000.0))
}

impl<O: OsrmTransport + Send + Sync + 'static> ShapeStore<O> {
    pub fn new(o: ShapeStoreOptions<O>) -> Arc<Self> {
        let osrm_base = o.osrm_base.filter(|b| !b.is_empty());
        let osrm_state = if osrm_base.is_some() {
            OsrmState::Ok
        } else {
            OsrmState::Disabled
        };
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            fetch: o.fetch,
            osrm_base,
            min_interval_ms: o.min_interval_ms,
            pace: o.pace,
            own_pace: Mutex::new(0),
            max_age_days: o.max_age_days,
            file: o.file,
            mzk_fetch: o.mzk_fetch,
            now: o.now,
            sleep: o.sleep,
            timers: o.timers,
            state: Mutex::new(State {
                entries: IndexMap::new(),
                geom_cache: IndexMap::new(),
                urgent: Vec::new(),
                background: Vec::new(),
                queued: HashSet::new(),
                mzk_neg: HashMap::new(),
                mzk_inflight: HashMap::new(),
                raw_trip_to_key: HashMap::new(),
                mzk_next_slot: 0,
                paused_until: 0,
                backoff_ms: BACKOFF_START_MS,
                wake_at: 0,
                osrm_state,
                last_error: None,
                last_build_at: 0,
                builds: 0,
                owns_lock: false,
                read_only: false,
                load_blocked: false,
                file_mtime: 0.0,
                content_dirty: false,
                seen_dirty: false,
                last_flush: 0,
                persist_error: None,
                write_seq: 0,
                started: false,
                pumping: [false; 2],
                timers: Vec::new(),
                flush_timer: None,
                last_gc: 0,
                stop_tangents: None,
            }),
            flush_lock: Mutex::new(()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    fn pace(&self) -> &OsrmPace {
        self.pace.unwrap_or(&self.own_pace)
    }

    /* ------------------------------------------------------------ public API */

    /// Ensure an entry for a KB pattern exists; queue routing while it isn't road yet.
    pub fn touch_kb(&self, p: &KbPattern, prio: ShapePrio) {
        let now = self.now() as f64;
        let mut guard = self.lock();
        let st = &mut *guard;
        if let Some(e) = st.entries.get_mut(&p.key) {
            if now - e.seen_at > SEEN_TOUCH_MS {
                e.seen_at = now;
                st.seen_dirty = true;
            }
            if e.wp_sig.as_deref() != Some(p.wp_sig.as_str()) {
                // stops moved / detour edited: keep serving the old geometry, rebuild with the new inputs
                e.wp_sig = Some(p.wp_sig.clone());
                e.wp = Some(encode_polyline(&p.waypoints, 6));
                e.sp = Some(p.stop_pts.clone());
                e.retry_at = 0.0;
                e.unroutable = Some(false);
                if !is_road_src(e.src)
                    && let Some(f) = finalize_shape(&p.waypoints, &p.stop_pts, ShapeSrc::Straight)
                {
                    e.set_shape(f);
                }
                e.built_at = e.built_at.min(1.0);
                self.mark_content(st);
                if self.osrm_base.is_some() {
                    self.enqueue(st, &p.key, prio);
                }
                return;
            }
        } else {
            if st.entries.len() >= MAX_ENTRIES {
                return;
            }
            let Some(f) = finalize_shape(&p.waypoints, &p.stop_pts, ShapeSrc::Straight) else {
                return;
            };
            st.entries.insert(
                p.key.clone(),
                ShapeEntry {
                    src: f.src,
                    poly: f.poly,
                    len: f.len,
                    stops: f.stops,
                    rev: f.rev,
                    built_at: 0.0,
                    seen_at: now,
                    fails: 0.0,
                    retry_at: 0.0,
                    algo: ALGO_VERSION,
                    unroutable: None,
                    wp_sig: Some(p.wp_sig.clone()),
                    wp: Some(encode_polyline(&p.waypoints, 6)),
                    sp: Some(p.stop_pts.clone()),
                    line: Some(p.line.clone()),
                    dir: Some(p.dir.clone()),
                },
            );
            self.mark_content(st);
        }
        let due = st
            .entries
            .get(&p.key)
            .is_some_and(|e| e.src == ShapeSrc::Straight && !e.is_unroutable() && now >= e.retry_at);
        if self.osrm_base.is_some() && due {
            self.enqueue(st, &p.key, prio);
        }
    }

    /// Note a running MZK variant (`touchMzk`, prio defaults to background there); fetch its shape in the background
    /// when unknown or older than 7 days. ponytail: an id past 2^53 may be keyed with other digits than the TS prints
    /// (past i64 it saturates); real variant ids are below 1e10 (the load filter's `\d{1,10}`).
    pub fn touch_mzk(&self, variant_id: f64, prio: ShapePrio) {
        if self.mzk_fetch.is_none() || variant_id.fract() != 0.0 || variant_id <= 0.0 {
            return;
        }
        let id = variant_id as i64;
        let key = format!("mzk:{id}");
        let now = self.now();
        let nowf = now as f64;
        let mut guard = self.lock();
        let st = &mut *guard;
        let exists = match st.entries.get_mut(&key) {
            Some(e) => {
                if nowf - e.seen_at > SEEN_TOUCH_MS {
                    e.seen_at = nowf;
                    st.seen_dirty = true;
                }
                if nowf - e.built_at <= MZK_MAX_AGE_MS as f64 {
                    return;
                }
                true
            }
            None => false,
        };
        if st.backed_off(id, now) {
            return;
        }
        let prio = if exists { ShapePrio::Background } else { prio };
        self.enqueue(st, &key, prio);
    }

    /// Decoded MZK variant polyline, fetched on demand (deduped). For trip views.
    pub async fn get_mzk_shape(&self, variant_id: i64) -> Option<Vec<LatLng>> {
        let stored = self
            .lock()
            .entries
            .get(&format!("mzk:{variant_id}"))
            .map(|e| e.poly.clone());
        let poly = match stored {
            Some(p) => p,
            None => self.fetch_mzk(variant_id, false).await?.poly,
        };
        Some(decode_polyline(&poly, 6))
    }

    /// Forget the raw-trip -> pattern map (before re-seeding from a new feed).
    pub fn clear_raw_trips(&self) {
        self.lock().raw_trip_to_key.clear();
    }

    /// Remember which GTFS raw trip ids use which pattern (for connection legs).
    pub fn register_raw_trips(&self, raw_trip_ids: &[String], key: &str) {
        let mut st = self.lock();
        for id in raw_trip_ids {
            st.raw_trip_to_key.insert(id.clone(), key.to_owned());
        }
    }

    pub fn key_for_raw_trip(&self, raw_trip_id: &str) -> Option<String> {
        self.lock().raw_trip_to_key.get(raw_trip_id).cloned()
    }

    /// A copy of the stored entry.
    pub fn get_entry(&self, key: &str) -> Option<ShapeEntry> {
        self.lock().entries.get(key).cloned()
    }

    /// Edits the stored entry in place, as the TS tests do through the object `getEntry` returns; false = no entry.
    /// Driven directly by tests.
    pub fn edit_entry(&self, key: &str, f: impl FnOnce(&mut ShapeEntry)) -> bool {
        self.lock().entries.get_mut(key).map(f).is_some()
    }

    /// `[lat, lon, bearing]` of every road shape (OSRM / MZK, not `partial`: its straight legs are the chord again) at
    /// each of its placed stops, the bearing over ±15 m of road, sorted by lat: what `snap_dirs` turns a stop's
    /// arrows to. The same Arc while no road entry's rev changed (a hash over the keys and revs per call, ~400 entries);
    /// a rebuild decodes every road polyline under the state lock (~360 shapes, ~11k points).
    pub fn stop_tangents(&self) -> Arc<Vec<[f64; 3]>> {
        let mut st = self.lock();
        let road = |e: &ShapeEntry| matches!(e.src, ShapeSrc::Osrm | ShapeSrc::Mzk);
        let mut h = DefaultHasher::new();
        for (k, e) in st.entries.iter().filter(|(_, e)| road(e)) {
            (k, &e.rev).hash(&mut h);
        }
        let sig = h.finish();
        if let Some((s, t)) = &st.stop_tangents
            && *s == sig
        {
            return t.clone();
        }
        let mut out = Vec::new();
        for e in st.entries.values().filter(|e| road(e)) {
            let Some(pl) = prepare_polyline(&decode_polyline(&e.poly, 6)) else {
                continue;
            };
            for &s in e.stops.iter().flatten() {
                if let Some(b) = tangent_bearing(&pl, s, 15.0, 15.0) {
                    let p = point_at(&pl, s, None);
                    out.push([p.lat, p.lon, b]);
                }
            }
        }
        out.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let t = Arc::new(out);
        st.stop_tangents = Some((sig, t.clone()));
        t
    }

    /// Prepared geometry for along-route math (LRU of 300, per key and rev).
    pub fn geometry(&self, key: &str) -> Option<Arc<ShapeGeometry>> {
        let mut guard = self.lock();
        let st = &mut *guard;
        let e = st.entries.get(key)?;
        if let Some((i, _, g)) = st.geom_cache.get_full(key)
            && g.rev == e.rev
        {
            let g = g.clone();
            let last = st.geom_cache.len() - 1;
            st.geom_cache.move_index(i, last);
            return Some(g);
        }
        let pl = prepare_polyline(&decode_polyline(&e.poly, 6))?;
        let g = Arc::new(ShapeGeometry {
            pl,
            stops: e.stops.clone(),
            rev: e.rev.clone(),
            src: e.src,
        });
        st.geom_cache.insert(key.to_owned(), g.clone());
        if st.geom_cache.len() > GEOM_LRU {
            st.geom_cache.shift_remove_index(0);
        }
        Some(g)
    }

    /// Wire id `<key>.<rev>`, only for road geometry (straight shapes aren't served).
    pub fn wire_id(&self, key: &str) -> Option<String> {
        let st = self.lock();
        st.entries
            .get(key)
            .filter(|e| is_road_src(e.src))
            .map(|e| format!("{key}.{}", e.rev))
    }

    pub fn status(&self, key: Option<&str>) -> ShapeStatus {
        let Some(key) = key.filter(|k| !k.is_empty()) else {
            return ShapeStatus::None;
        };
        let now = self.now();
        let mut st = self.lock();
        let unroutable = match st.entries.get(key) {
            Some(e) if is_road_src(e.src) => return ShapeStatus::Road,
            Some(e) => e.is_unroutable(),
            None => false,
        };
        if key.starts_with("mzk:") {
            return if self.mzk_fetch.is_some() {
                ShapeStatus::Pending
            } else {
                ShapeStatus::None
            };
        }
        st.expire_block(now);
        // blocked/misconfigured: don't send every browser to the router that just refused us
        let refused = matches!(st.osrm_state, OsrmState::ConfigError | OsrmState::Blocked);
        if self.osrm_base.is_none() || refused || unroutable {
            ShapeStatus::None
        } else {
            ShapeStatus::Pending
        }
    }

    /// Stored payloads for /api/shapes, keys in JS object order. Never touches the network.
    pub fn lookup(&self, ids: &[String]) -> ShapeLookup {
        let mut out = ShapeLookup {
            exact: true,
            ..ShapeLookup::default()
        };
        {
            let st = self.lock();
            for id in ids {
                let (key, rev) = split_wire_id(id);
                let Some(e) = st.entries.get(key).filter(|e| is_road_src(e.src)) else {
                    out.missing.push(id.clone());
                    out.exact = false;
                    continue;
                };
                if rev != Some(e.rev.as_str()) {
                    out.exact = false;
                }
                out.shapes.insert(
                    id.clone(),
                    ShapePayload {
                        id: format!("{key}.{}", e.rev),
                        src: e.src,
                        poly: e.poly.clone(),
                        len: JsNum(e.len),
                        stops: js_nums(&e.stops),
                    },
                );
            }
        }
        js::sort_object_keys(&mut out.shapes);
        out
    }

    /// The `/api/health` `shapes` block, in TS key order.
    pub fn health(&self) -> Map<String, Value> {
        let now = self.now();
        let mut st = self.lock();
        let (mut osrm, mut partial, mut straight, mut mzk, mut gtfs) = (0u64, 0u64, 0u64, 0u64, false);
        for e in st.entries.values() {
            match e.src {
                ShapeSrc::Osrm => osrm += 1,
                ShapeSrc::Partial => partial += 1,
                ShapeSrc::Straight => straight += 1,
                ShapeSrc::Mzk => mzk += 1,
                ShapeSrc::Gtfs => gtfs = true,
            }
        }
        let state = Self::effective_state(&mut st, now);
        let mut m = Map::new();
        m.insert("entries".into(), st.entries.len().into());
        m.insert("road".into(), (osrm + partial).into());
        m.insert("osrm".into(), osrm.into());
        m.insert("partial".into(), partial.into());
        m.insert("straight".into(), straight.into());
        m.insert("mzk".into(), mzk.into());
        if gtfs {
            // counts.gtfs is undefined + 1 = NaN there, which JSON writes as null
            m.insert("gtfs".into(), Value::Null);
        }
        m.insert("queued".into(), st.queued.len().into());
        m.insert("builds".into(), st.builds.into());
        m.insert("osrm_state".into(), state.as_str().into());
        let paused = (st.paused_until > now).then(|| js::num_value(js::round(st.paused_until as f64 / 1000.0)));
        m.insert("osrm_paused_until".into(), paused.unwrap_or(Value::Null));
        let built = (st.last_build_at != 0).then(|| js::num_value(js::round(st.last_build_at as f64 / 1000.0)));
        m.insert("last_build_at".into(), built.unwrap_or(Value::Null));
        m.insert("last_error".into(), json!(st.last_error));
        m.insert("persist_error".into(), json!(st.persist_error));
        m.insert("read_only".into(), st.read_only.into());
        m
    }

    fn effective_state(st: &mut State, now: i64) -> OsrmState {
        st.expire_block(now);
        if st.osrm_state == OsrmState::Ok && st.paused_until > now {
            OsrmState::Paused
        } else {
            st.osrm_state
        }
    }

    /* ------------------------------------------------------------ worker */

    fn enqueue(&self, st: &mut State, key: &str, prio: ShapePrio) {
        if st.read_only {
            return;
        }
        if st.queued.contains(key) {
            if prio == ShapePrio::Urgent
                && let Some(i) = st.background.iter().position(|k| k == key)
            {
                let k = st.background.remove(i);
                st.urgent.push(k);
            }
            return;
        }
        if st.queued.len() >= MAX_QUEUE {
            return;
        }
        st.queued.insert(key.to_owned());
        match prio {
            ShapePrio::Urgent => st.urgent.push(key.to_owned()),
            ShapePrio::Background => st.background.push(key.to_owned()),
        }
        if self.timers && st.started {
            self.kick_locked(st);
        }
    }

    fn kick(&self) {
        let mut st = self.lock();
        self.kick_locked(&mut st);
    }

    /// One worker task per kind while it has work; a panic in one is logged and the next kick starts it again.
    fn kick_locked(&self, st: &mut State) {
        if st.read_only || !st.started {
            return;
        }
        let Ok(rt) = Handle::try_current() else {
            return;
        };
        for kind in [ShapeKind::Kb, ShapeKind::Mzk] {
            if st.pumping[kind.idx()] {
                continue;
            }
            let Some(me) = self.me.upgrade() else {
                return;
            };
            st.pumping[kind.idx()] = true;
            let pump = me.clone();
            let worker = rt.spawn(async move { while pump.step(Some(kind), true).await {} });
            // a worker that ends normally drops its own flag (step); this covers a panic or a cancel
            rt.spawn(async move {
                if let Err(e) = worker.await {
                    if e.is_panic() {
                        error(TAG, format!("{} worker crashed: {e}", kind.as_str()));
                    }
                    me.lock().pumping[kind.idx()] = false;
                }
            });
        }
    }

    fn can_route_kb(&self, st: &mut State, now: i64) -> bool {
        st.expire_block(now);
        self.osrm_base.is_some() && st.osrm_state == OsrmState::Ok && st.paused_until <= now
    }

    /// Process one queued job (of `kind`, or any). False when nothing runnable is queued. Driven directly by tests.
    pub async fn run_next(&self, kind: Option<ShapeKind>) -> bool {
        self.step(kind, false).await
    }

    /// `worker`: the kick loop's own call, which drops `pumping[kind]` in the same critical section that finds
    /// nothing to do, so a key queued right after it starts a fresh worker (the TS `finally`).
    async fn step(&self, kind: Option<ShapeKind>, worker: bool) -> bool {
        let now = self.now();
        let (key, mzk_wait) = {
            let mut guard = self.lock();
            let st = &mut *guard;
            let can_kb = self.can_route_kb(st, now);
            let pick = |q: &mut Vec<String>| {
                let i = q.iter().position(|k| {
                    kind.is_none_or(|kd| ShapeKind::of(k) == Some(kd)) && (can_kb || !k.starts_with("kb:"))
                })?;
                Some(q.remove(i))
            };
            let Some(key) = pick(&mut st.urgent).or_else(|| pick(&mut st.background)) else {
                // paused with work left: wake up when the pause ends
                if self.timers && !st.queued.is_empty() && st.paused_until > now && st.wake_at != st.paused_until {
                    st.wake_at = st.paused_until;
                    let ms = st.paused_until - now + 50;
                    self.later(st, ms, Self::kick);
                }
                if worker && let Some(kd) = kind {
                    st.pumping[kd.idx()] = false;
                }
                return false;
            };
            st.queued.remove(&key);
            let wait = st.mzk_next_slot - now;
            (key, wait)
        };
        if let Some(id) = key.strip_prefix("mzk:") {
            if mzk_wait > 0 {
                (self.sleep)(mzk_wait).await;
            }
            let next = self.now() + MZK_BG_SPACING_MS;
            self.lock().mzk_next_slot = next;
            if let Ok(id) = id.parse::<i64>() {
                self.fetch_mzk(id, true).await;
            }
        } else {
            self.build_kb(&key).await;
        }
        self.maybe_gc();
        true
    }

    async fn build_kb(&self, key: &str) {
        let Some(base) = self.osrm_base.as_deref() else {
            return;
        };
        let wp = {
            let st = self.lock();
            match st.entries.get(key) {
                Some(ShapeEntry {
                    wp: Some(wp),
                    sp: Some(_),
                    ..
                }) => wp.clone(),
                _ => return,
            }
        };
        let wps = decode_polyline(&wp, 6);
        let r = route_waypoints(base, &wps, &Paced(self)).await;
        let now = self.now();
        let ok = match r {
            Ok(ok) => ok,
            Err(f) => {
                let mut st = self.lock();
                self.osrm_failed(&mut st, key, f, now);
                return;
            }
        };
        let src = if ok.straight_legs == 0 {
            ShapeSrc::Osrm
        } else if ok.straight_legs >= ok.total_legs {
            ShapeSrc::Straight
        } else {
            ShapeSrc::Partial
        };
        let cleaned = simplify_polyline(&prune_spurs(&ok.pts, &wps, 150.0, 10.0), 2.0);
        let sp = self.lock().entries.get(key).and_then(|e| e.sp.clone());
        let built = sp.and_then(|sp| finalize_shape(&cleaned, &sp, src));
        let nowf = now as f64;
        let mut guard = self.lock();
        let st = &mut *guard;
        st.backoff_ms = BACKOFF_START_MS;
        st.builds += 1;
        st.last_build_at = now;
        // gone meanwhile (GC, or a reload by the heartbeat): nothing to commit to
        let Some(e) = st.entries.get_mut(key) else {
            return;
        };
        match built {
            Some(b) if b.src.rank() >= e.src.rank() => {
                e.set_shape(b);
                e.built_at = nowf;
                e.algo = ALGO_VERSION;
                if src == ShapeSrc::Straight {
                    e.fails += 1.0;
                    e.unroutable = Some(true);
                    e.retry_at = retry_at(nowf, e.fails);
                } else {
                    e.fails = 0.0;
                    e.retry_at = 0.0;
                    e.unroutable = Some(false);
                }
                st.geom_cache.shift_remove(key);
            }
            _ => {
                // never downgrade a stored road geometry; keep it and re-check on the normal cadence
                e.fails += 1.0;
                e.retry_at = retry_at(nowf, e.fails);
                if is_road_src(e.src) {
                    e.built_at = nowf;
                }
            }
        }
        self.mark_content(st);
    }

    fn osrm_failed(&self, st: &mut State, key: &str, f: crate::osrm::Failure, now: i64) {
        st.last_error = Some(format!("{}: {}", f.kind.as_str(), f.detail));
        match f.kind {
            OsrmFailure::Config => {
                if st.osrm_state != OsrmState::ConfigError {
                    error(TAG, format!("OSRM config error, routing stopped: {}", f.detail));
                }
                st.osrm_state = OsrmState::ConfigError;
            }
            OsrmFailure::Blocked => {
                error(TAG, format!("OSRM refused us ({}), pausing 24 h", f.detail));
                st.osrm_state = OsrmState::Blocked;
                st.paused_until = now + DAY_MS;
            }
            OsrmFailure::Ratelimited => {
                st.paused_until = now + (f.retry_after_sec.unwrap_or(60.0).max(60.0) * 1000.0) as i64;
                warn(
                    TAG,
                    format!("OSRM rate limited, pausing {} s", secs(st.paused_until - now)),
                );
            }
            OsrmFailure::Unavailable | OsrmFailure::Unroutable => {
                st.paused_until = now + st.backoff_ms;
                warn(
                    TAG,
                    format!("OSRM unavailable ({}), pausing {} s", f.detail, secs(st.backoff_ms)),
                );
                st.backoff_ms = (st.backoff_ms * 2).min(BACKOFF_MAX_MS);
            }
        }
        // not the pattern's fault: put it back at the front, nothing committed
        if st.queued.insert(key.to_owned()) {
            st.urgent.insert(0, key.to_owned());
        }
    }

    /// `fetchMzk`: one fetch per variant in flight, joined by every caller; a failure backs the variant off 10 min.
    async fn fetch_mzk(&self, variant_id: i64, background: bool) -> Option<ShapeEntry> {
        let key = format!("mzk:{variant_id}");
        let cell = {
            let mut st = self.lock();
            match st.mzk_inflight.get(&variant_id) {
                Some(c) => c.clone(),
                None => {
                    self.mzk_fetch.as_ref()?;
                    if st.backed_off(variant_id, self.now()) {
                        return st.entries.get(&key).cloned();
                    }
                    let c = MzkCell::default();
                    st.mzk_inflight.insert(variant_id, c.clone());
                    c
                }
            }
        };
        let out = cell
            .get_or_init(|| self.fetch_mzk_once(variant_id, &key, background))
            .await
            .clone();
        let mut st = self.lock();
        if st.mzk_inflight.get(&variant_id).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            st.mzk_inflight.remove(&variant_id);
        }
        out
    }

    async fn fetch_mzk_once(&self, variant_id: i64, key: &str, background: bool) -> Option<ShapeEntry> {
        let fetcher = self.mzk_fetch.clone()?;
        let raw = fetcher(variant_id).await;
        let shape = raw.as_ref().ok().and_then(mzk_shape_from_course_details);
        let built = shape.as_ref().and_then(|s| finalize_shape(&s.pts, &[], ShapeSrc::Mzk));
        let now = self.now();
        let mut guard = self.lock();
        let st = &mut *guard;
        let (Some(shape), Some(built)) = (shape, built) else {
            if let Err(err) = &raw
                && !background
            {
                warn(TAG, format!("MZK variant {variant_id} fetch failed: {err}"));
            }
            st.mzk_neg.insert(variant_id, now + MZK_NEG_CACHE_MS);
            return st.entries.get(key).cloned();
        };
        // stops come from the segment boundaries, already in our metric
        let stops: Vec<Option<f64>> = shape.stops.iter().map(|s| s.map(js::round1)).collect();
        let rev = rev_of(ShapeSrc::Mzk, &built.poly, built.len, &stops);
        let e = ShapeEntry {
            src: ShapeSrc::Mzk,
            poly: built.poly,
            len: built.len,
            stops,
            rev,
            built_at: now as f64,
            seen_at: now as f64,
            fails: 0.0,
            retry_at: 0.0,
            algo: ALGO_VERSION,
            unroutable: None,
            wp_sig: None,
            wp: None,
            sp: None,
            line: None,
            dir: None,
        };
        if !st.entries.contains_key(key) && st.entries.len() >= MAX_ENTRIES {
            return None;
        }
        st.entries.insert(key.to_owned(), e.clone());
        st.geom_cache.shift_remove(key);
        self.mark_content(st);
        Some(e)
    }

    /// Queue the oldest due KB refresh and the first stale MZK variant still running. Driven directly by tests.
    pub fn refresh_tick(&self) {
        let now = self.now();
        let mut guard = self.lock();
        let st = &mut *guard;
        if st.read_only {
            return;
        }
        let queued = &st.queued;
        let skip = |k: &str| queued.contains(k);
        let key = pick_refresh_candidate(&st.entries, now, self.max_age_days, Some(&skip));
        if let Some(key) = key
            && self.osrm_base.is_some()
        {
            self.enqueue(st, &key, ShapePrio::Background);
        }
        let nowf = now as f64;
        let stale = st
            .entries
            .iter()
            .find(|(k, e)| {
                let backed = k
                    .strip_prefix("mzk:")
                    .and_then(|id| id.parse().ok())
                    .is_some_and(|id| st.backed_off(id, now));
                k.starts_with("mzk:")
                    && nowf - e.built_at > MZK_MAX_AGE_MS as f64
                    && nowf - e.seen_at < SEEN_WINDOW_MS as f64
                    && !backed
            })
            .map(|(k, _)| k.clone());
        if let Some(k) = stale {
            self.enqueue(st, &k, ShapePrio::Background);
        }
    }

    fn maybe_gc(&self) {
        let now = self.now();
        let mut guard = self.lock();
        let st = &mut *guard;
        if now - st.last_gc < DAY_MS {
            return;
        }
        st.last_gc = now;
        let before = st.entries.len();
        st.entries.retain(|_, e| now as f64 - e.seen_at <= GC_UNSEEN_MS as f64);
        let dropped = before - st.entries.len();
        let entries = &st.entries;
        st.geom_cache.retain(|k, _| entries.contains_key(k));
        st.mzk_neg.retain(|_, until| *until > now);
        if dropped > 0 {
            info(TAG, format!("GC dropped {dropped} unused shapes"));
            self.mark_content(st);
        }
    }

    /* ------------------------------------------------------------ timers */

    /// One-shot task, tracked so stop() can abort it. No tokio runtime = nothing scheduled.
    fn later(&self, st: &mut State, ms: i64, f: fn(&Self)) {
        let Ok(rt) = Handle::try_current() else {
            return;
        };
        let me = self.me.clone();
        st.timers.retain(|t| !t.is_finished());
        st.timers.push(rt.spawn(async move {
            tokio::time::sleep(ms_dur(ms)).await;
            if let Some(s) = me.upgrade() {
                s.run_task(f);
            }
        }));
    }

    fn every(&self, st: &mut State, ms: i64, f: fn(&Self)) {
        let Ok(rt) = Handle::try_current() else {
            return;
        };
        let me = self.me.clone();
        st.timers.push(rt.spawn(async move {
            loop {
                tokio::time::sleep(ms_dur(ms)).await;
                let Some(s) = me.upgrade() else { break };
                if !s.lock().started {
                    break;
                }
                s.run_task(f);
            }
        }));
    }

    fn run_task(&self, f: fn(&Self)) {
        if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(self))) {
            let msg = p
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            error(TAG, format!("timer task failed: {msg}"));
        }
    }

    /// Debounced flush: one pending at a time (`flushTimer`). Timers off, no runtime or no file = none.
    fn flush_later(&self, st: &mut State, ms: i64) {
        if !self.timers || st.flush_timer.is_some() || self.file.is_none() {
            return;
        }
        let Ok(rt) = Handle::try_current() else {
            return;
        };
        let me = self.me.clone();
        st.flush_timer = Some(rt.spawn(async move {
            tokio::time::sleep(ms_dur(ms)).await;
            if let Some(s) = me.upgrade() {
                s.lock().flush_timer = None;
                s.flush(false);
            }
        }));
    }

    fn mark_content(&self, st: &mut State) {
        st.content_dirty = true;
        self.flush_later(st, FLUSH_DEBOUNCE_MS);
    }
}

/* ------------------------------------------------------------ persistence */

/// The file as `flush` writes it, in TS key order.
#[derive(Serialize)]
struct FileOut<'a> {
    format: &'static str,
    version: JsNum,
    algo: JsNum,
    #[serde(rename = "savedAt")]
    saved_at: JsNum,
    shapes: &'a IndexMap<String, ShapeEntry>,
}

/// `${path}${suffix}`.
fn suffixed(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn mtime_ms(p: &Path) -> std::io::Result<f64> {
    let m = std::fs::metadata(p)?.modified()?;
    Ok(m.duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0))
}

/// `Date.now()`: the lock is shared with other processes, so it runs on the system clock, never the injected one.
fn sys_now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `os.hostname()`, read once.
static HOSTNAME: LazyLock<String> = LazyLock::new(|| {
    let mut buf = [0u8; 256];
    // SAFETY: buf is valid for writes of its whole length, which is the length passed
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
});

struct LockOwner {
    pid: Option<f64>,
    host: Option<String>,
    mtime_ms: f64,
}

/// None = no lock file. A lock that can't be stat'ed counts as fresh, one that can't be parsed as held by someone
/// else (half-written by a racing peer, or left empty by a crash): held until it goes stale.
fn lock_owner(lock: &Path) -> Option<LockOwner> {
    let mtime_ms = match mtime_ms(lock) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return None,
        Err(_) => sys_now_ms(),
    };
    let cur = std::fs::read(lock)
        .ok()
        .and_then(|b| crate::js::json_parse(&String::from_utf8_lossy(&b)).ok());
    Some(LockOwner {
        pid: cur.as_ref().and_then(|v| v.get("pid")).and_then(Value::as_f64),
        host: cur
            .as_ref()
            .and_then(|v| v.get("host"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        mtime_ms,
    })
}

fn is_mine(o: Option<&LockOwner>) -> bool {
    o.is_some_and(|o| o.pid == Some(f64::from(std::process::id())) && o.host.as_deref() == Some(HOSTNAME.as_str()))
}

/// `^(kb:[0-9a-f]{12}|mzk:\d{1,10})$`
fn valid_key(k: &str) -> bool {
    if let Some(h) = k.strip_prefix("kb:") {
        h.len() == 12 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    } else if let Some(d) = k.strip_prefix("mzk:") {
        (1..=10).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit())
    } else {
        false
    }
}

/// `String(v)` for the log line; ponytail: an array or object prints as JSON, not JS's `1,2` / `[object Object]`.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(|| n.to_string(), js::number_to_string),
        Some(v) => v.to_string(),
    }
}

impl<O: OsrmTransport + Send + Sync + 'static> ShapeStore<O> {
    pub fn start(&self) {
        blocking_io(|| {
            {
                let mut st = self.lock();
                if st.started {
                    return;
                }
                st.started = true;
            }
            self.load_io();
            let owns = self.try_lock_io();
            let mut guard = self.lock();
            let st = &mut *guard;
            st.owns_lock = owns;
            st.read_only = !owns;
            if !owns {
                let file = self
                    .file
                    .as_deref()
                    .map(|f| f.display().to_string())
                    .unwrap_or_default();
                warn(TAG, format!("store file locked by another process, read-only ({file})"));
            }
            if !self.timers {
                return;
            }
            self.every(st, HEARTBEAT_MS, Self::heartbeat);
            self.every(st, REFRESH_TICK_MS, Self::refresh_tick);
            self.later(st, FIRST_KICK_MS, Self::kick);
        });
    }

    /// Stops the timers, flushes and releases the lock. A worker mid-job finishes that job.
    pub fn stop(&self) {
        blocking_io(|| {
            {
                let mut st = self.lock();
                for t in st.timers.drain(..) {
                    t.abort();
                }
                st.wake_at = 0;
                if let Some(t) = st.flush_timer.take() {
                    t.abort();
                }
            }
            self.flush_io(true);
            let owns = self.lock().owns_lock;
            if let Some(file) = &self.file
                && owns
            {
                let lock = suffixed(file, ".lock");
                if is_mine(lock_owner(&lock).as_ref()) {
                    // already gone is fine
                    let _ = std::fs::remove_file(lock);
                }
            }
            let mut st = self.lock();
            st.owns_lock = false;
            st.started = false;
        });
    }

    /// Persist synchronously (content changes, or seen_at-only every 6 h / on shutdown). Driven directly by tests.
    pub fn flush(&self, force: bool) {
        blocking_io(|| self.flush_io(force));
    }

    /// Dirty flags are cleared at the snapshot and restored on failure: a change made while the file is being written
    /// stays dirty. ponytail: the snapshot is serialized under the state lock (a few ms for a few MB).
    fn flush_io(&self, force: bool) {
        let Some(file) = &self.file else {
            return;
        };
        let _one = self.flush_lock.lock().unwrap_or_else(PoisonError::into_inner);
        let now = self.now();
        let (data, tmp, was) = {
            let mut st = self.lock();
            if !st.owns_lock || st.load_blocked {
                return;
            }
            let due = st.content_dirty || (st.seen_dirty && (force || now - st.last_flush > SEEN_FLUSH_MS));
            if !due {
                return;
            }
            st.write_seq += 1;
            let tmp = suffixed(file, &format!(".tmp-{}-{}", std::process::id(), st.write_seq));
            let data = serde_json::to_string(&FileOut {
                format: FORMAT,
                version: JsNum(FILE_VERSION),
                algo: JsNum(ALGO_VERSION),
                saved_at: JsNum(js::round(now as f64 / 1000.0)),
                shapes: &st.entries,
            });
            let was = (st.content_dirty, st.seen_dirty);
            st.content_dirty = false;
            st.seen_dirty = false;
            (data, tmp, was)
        };
        let write = |data: String| -> std::io::Result<f64> {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = File::create(&tmp)?;
            f.write_all(data.as_bytes())?;
            f.sync_all()?;
            drop(f);
            if file.exists() {
                std::fs::copy(file, suffixed(file, ".bak"))?;
            }
            std::fs::rename(&tmp, file)?;
            mtime_ms(file)
        };
        let r = data
            .map_err(|e| e.to_string())
            .and_then(|d| write(d).map_err(|e| e.to_string()));
        let mut guard = self.lock();
        let st = &mut *guard;
        match r {
            Ok(m) => {
                st.file_mtime = m;
                st.last_flush = now;
                st.persist_error = None;
            }
            Err(msg) => {
                st.content_dirty |= was.0;
                st.seen_dirty |= was.1;
                error(TAG, format!("store save failed: {msg}"));
                st.persist_error = Some(msg);
                // nothing to clean when the tmp file was never created
                let _ = std::fs::remove_file(&tmp);
                self.flush_later(st, FLUSH_RETRY_MS);
            }
        }
    }

    /// Load the store file (falling back to .bak). Unknown/corrupt files are set aside. Driven directly by tests.
    pub fn load(&self) {
        blocking_io(|| self.load_io());
    }

    fn load_io(&self) {
        let Some(file) = &self.file else {
            return;
        };
        let bak = suffixed(file, ".bak");
        for p in [file.as_path(), bak.as_path()] {
            let bytes = match std::fs::read(p) {
                Ok(b) => b,
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                Err(e) => {
                    error(TAG, format!("cannot read {}: {e}, store is read-only", p.display()));
                    self.lock().load_blocked = true;
                    return;
                }
            };
            let parsed = crate::js::json_parse(&String::from_utf8_lossy(&bytes))
                .ok()
                .filter(|v| v.get("format").and_then(Value::as_str) == Some(FORMAT));
            let Some(parsed) = parsed else {
                warn(
                    TAG,
                    format!("{} is not a valid shape store, setting it aside", p.display()),
                );
                if p == file.as_path() {
                    let aside = suffixed(
                        file,
                        &format!(
                            ".corrupt-{}",
                            js::number_to_string(js::round(self.now() as f64 / 1000.0))
                        ),
                    );
                    if std::fs::rename(p, aside).is_err() {
                        self.lock().load_blocked = true;
                        return;
                    }
                }
                continue;
            };
            let version = parsed.get("version");
            if version.and_then(Value::as_f64).is_none_or(|v| v > FILE_VERSION) {
                warn(
                    TAG,
                    format!(
                        "{} has a newer format (v{}), not touching it",
                        p.display(),
                        js_string(version)
                    ),
                );
                self.lock().load_blocked = true;
                return;
            }
            let mut next = IndexMap::new();
            if let Some(shapes) = parsed.get("shapes").and_then(Value::as_object) {
                for (k, v) in shapes {
                    if valid_key(k)
                        && let Some(e) = valid_entry(v)
                    {
                        next.insert(k.clone(), e);
                    }
                }
            }
            let n = next.len();
            let mtime = mtime_ms(p).ok();
            let mut st = self.lock();
            st.entries = next;
            st.geom_cache.clear();
            if let Some(m) = mtime {
                st.file_mtime = m;
            }
            if p != file.as_path() {
                st.content_dirty = true;
            }
            drop(st);
            info(TAG, format!("loaded {n} stored shapes from {}", p.display()));
            return;
        }
    }

    /// Take the single-writer lock: atomic create when free; a stale lock (no heartbeat for 5 min) is replaced via
    /// write-tmp + rename. Verified by re-reading, so two racing processes can't both win.
    fn try_lock_io(&self) -> bool {
        let Some(file) = &self.file else {
            return true;
        };
        let lock = suffixed(file, ".lock");
        let pid = std::process::id();
        let body =
            json!({ "pid": pid, "host": HOSTNAME.as_str(), "at": js::num_value(js::round(sys_now_ms() / 1000.0)) })
                .to_string();
        let attempt = || -> std::io::Result<bool> {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let cur = lock_owner(&lock);
            if is_mine(cur.as_ref()) {
                return Ok(true);
            }
            match cur {
                None => {
                    let mut f = File::options().write(true).create_new(true).open(&lock)?;
                    f.write_all(body.as_bytes())?;
                }
                Some(o) if sys_now_ms() - o.mtime_ms >= LOCK_STALE_MS => {
                    let tmp = suffixed(&lock, &format!(".tmp-{pid}"));
                    std::fs::write(&tmp, &body)?;
                    std::fs::rename(&tmp, &lock)?;
                }
                Some(_) => return Ok(false),
            }
            Ok(is_mine(lock_owner(&lock).as_ref()))
        };
        attempt().unwrap_or_else(|e| {
            if e.kind() != ErrorKind::AlreadyExists {
                warn(TAG, format!("cannot take lock {}: {e}", lock.display()));
            }
            false
        })
    }

    /// Owner: still ours? then refresh the lock's mtime and flush. Read-only: follow the writer's file and take over
    /// a stale lock. Driven directly by tests.
    pub fn heartbeat(&self) {
        blocking_io(|| self.heartbeat_io());
    }

    fn heartbeat_io(&self) {
        let Some(file) = &self.file else {
            return;
        };
        let lock = suffixed(file, ".lock");
        let owns = self.lock().owns_lock;
        if owns {
            // after a long stall a peer may have taken over a stale lock
            if !is_mine(lock_owner(&lock).as_ref()) {
                warn(TAG, "store lock taken over by another process, now read-only");
                let mut st = self.lock();
                st.owns_lock = false;
                st.read_only = true;
                st.urgent.clear();
                st.background.clear();
                st.queued.clear();
                return;
            }
            let t = SystemTime::now();
            // a failure is checked again next beat
            let _ = File::open(&lock).and_then(|f| f.set_times(FileTimes::new().set_accessed(t).set_modified(t)));
            self.flush_io(false);
            return;
        }
        let known = self.lock().file_mtime;
        if mtime_ms(file).is_ok_and(|m| m != known) {
            self.load_io();
        }
        if self.try_lock_io() {
            {
                let mut st = self.lock();
                st.owns_lock = true;
                st.read_only = false;
            }
            self.load_io();
            info(TAG, "acquired store lock, worker enabled");
            self.kick();
        }
    }
}

impl<O: OsrmTransport + Send + Sync + 'static> MzkShapeSink for ShapeStore<O> {
    fn touch_mzk(&self, variant_id: f64, prio: ShapePrio) {
        ShapeStore::touch_mzk(self, variant_id, prio);
    }

    fn geometry(&self, key: &str) -> Option<Arc<ShapeGeometry>> {
        ShapeStore::geometry(self, key)
    }
}

impl<O: OsrmTransport + Send + Sync + 'static> crate::route_info::KbShapeSink for ShapeStore<O> {
    fn touch_kb(&self, p: &KbPattern, prio: ShapePrio) {
        ShapeStore::touch_kb(self, p, prio);
    }

    fn geometry(&self, key: &str) -> Option<Arc<ShapeGeometry>> {
        ShapeStore::geometry(self, key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = r#"{"src":"osrm","poly":"_p~iF~ps|U","len":12.5,"stops":[0,null,12.5],"rev":"0a1b2c","builtAt":1700000000000,"seenAt":1700000000001,"fails":0,"retryAt":0,"algo":3,"unroutable":true,"wpSig":"s","wp":"w","sp":[[49.8,19.04],null],"line":"1","dir":"A"}"#;

    #[test]
    fn entry_round_trips_in_valid_entry_key_order() {
        let v: Value = serde_json::from_str(ENTRY).expect("fixture");
        let e = valid_entry(&v).expect("valid");
        assert_eq!(serde_json::to_string(&e).expect("json"), ENTRY);
    }

    /// Node and Rust share output/shapes: the lock body and the store file must be the TS bytes.
    #[test]
    fn file_and_lock_keep_the_ts_format() {
        let dir = std::env::temp_dir().join(format!("unimaps-shape-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let file = dir.join("route-shapes.v1.json");
        let lock = suffixed(&file, ".lock");
        let bak = format!(
            r#"{{"format":"kb-map/route-shapes","version":1,"shapes":{{"kb:0123456789ab":{ENTRY},"bad key":{ENTRY}}}}}"#
        );
        std::fs::write(suffixed(&file, ".bak"), bak).expect("bak");
        std::fs::write(&lock, r#"{"pid":0,"host":"elsewhere","at":0}"#).expect("lock");
        let s = ShapeStore::new(ShapeStoreOptions {
            file: Some(file.clone()),
            timers: false,
            now: Arc::new(|| 1_700_000_000_000),
            ..ShapeStoreOptions::new(HttpOsrm)
        });

        // a live foreign writer: read-only, the .bak is served but nothing is written
        s.start();
        assert_eq!(s.health().get("read_only"), Some(&Value::Bool(true)));
        assert!(s.get_entry("kb:0123456789ab").is_some());
        assert!(s.get_entry("bad key").is_none());
        s.flush(true);
        assert!(!file.exists());

        // its lock goes stale: the heartbeat takes it over, the next flush writes the main file
        let old = SystemTime::now() - Duration::from_secs(301);
        File::open(&lock)
            .and_then(|f| f.set_times(FileTimes::new().set_modified(old)))
            .expect("age lock");
        s.heartbeat();
        assert_eq!(s.health().get("read_only"), Some(&Value::Bool(false)));
        let body: Value = serde_json::from_slice(&std::fs::read(&lock).expect("lock")).expect("lock json");
        let keys: Vec<&str> = body
            .as_object()
            .map(|o| o.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(keys, ["pid", "host", "at"]);
        assert_eq!(body["pid"], json!(std::process::id()));
        s.flush(false);
        assert_eq!(
            std::fs::read_to_string(&file).expect("file"),
            format!(
                r#"{{"format":"kb-map/route-shapes","version":1,"algo":3,"savedAt":1700000000,"shapes":{{"kb:0123456789ab":{ENTRY}}}}}"#
            )
        );

        s.stop();
        assert!(!lock.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
