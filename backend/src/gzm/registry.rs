//! The process-wide live layers: GZM's resident one and the other zbiorkom cities, created on first use and
//! dropped when idle (lib/gzm.ts getGzm .. safeZbHealth).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use super::parse::HttpZb;
use super::state::{GzmLive, NowFn};
use crate::config;
use crate::gzm_feed::{start_gzm_feed, stop_gzm_feed};
use crate::logger;

/// a resident city requested within this is on screen somewhere: a viewer polls its vehicles at most 20 s apart
pub const ACTIVE_MS: i64 = 30_000;
/// at most one city still on screen is dropped for a newcomer per this
pub const FORCED_DROP_MS: i64 = 60_000;
const SWEEP: Duration = Duration::from_secs(60);

static GZM: LazyLock<Arc<GzmLive>> = LazyLock::new(|| Arc::new(GzmLive::new("gzm", HttpZb)));

/// The process-wide GZM live layer (created on first use, polling only after `start_gzm`).
/// ponytail: no fleet callback yet (TS `feedGzmFleet`): lib/gzm-fleet.ts is not ported; wire it with `with_fleet`.
pub fn get_gzm() -> Arc<GzmLive> {
    Arc::clone(&GZM)
}

/// Starts the feed refresh and the positions loop once per process; a no-op with KB_GZM=0. Needs a tokio runtime.
pub fn start_gzm() {
    if !*config::GZM_ENABLED {
        return;
    }
    let live = get_gzm();
    if live.running() {
        return;
    }
    start_gzm_feed("gzm");
    live.start();
}

/// Health block for /api/health.
pub fn safe_gzm_health() -> Value {
    let mut out = Map::new();
    if !*config::GZM_ENABLED {
        out.insert("enabled".into(), Value::Bool(false));
        return Value::Object(out);
    }
    out.insert("enabled".into(), Value::Bool(true));
    if let Value::Object(h) = get_gzm().health() {
        out.extend(h);
    }
    Value::Object(out)
}

struct ZbEntry {
    live: Arc<GzmLive>,
    /// epoch ms
    last_used: i64,
}

#[derive(Default)]
struct ZbState {
    /// insertion order = TS Map order (LRU ties and the health keys)
    cities: IndexMap<String, ZbEntry>,
    /// never-started stand-ins for cities waiting for a resident slot: feed always loading, so every route answers
    /// warming()
    parked: HashMap<String, Arc<GzmLive>>,
    parked_requests: u64,
    /// epoch ms; None = never
    last_forced_drop: Option<i64>,
    sweeping: bool,
}

/// The non-GZM zbiorkom cities. One global instance (`get_zb` / `start_zb` / `safe_zb_health`); tests build their
/// own with a fake clock and feed hooks.
pub struct ZbRegistry {
    now: NowFn,
    resident: usize,
    idle_min: i64,
    enabled: bool,
    start_feed: fn(&str),
    stop_feed: fn(&str),
    state: Mutex<ZbState>,
}

impl ZbRegistry {
    /// `resident` = KB_ZB_RESIDENT, `idle_min` = KB_ZB_IDLE_MIN, `enabled` = KB_ZB; the feed hooks are
    /// `start_gzm_feed` / `stop_gzm_feed` in production.
    pub fn new(
        now: NowFn,
        resident: usize,
        idle_min: i64,
        enabled: bool,
        start_feed: fn(&str),
        stop_feed: fn(&str),
    ) -> Self {
        Self {
            now,
            resident,
            idle_min,
            enabled,
            start_feed,
            stop_feed,
            state: Mutex::default(),
        }
    }

    fn state(&self) -> MutexGuard<'_, ZbState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The live layer of a non-GZM city, created now when it is not resident. Each call marks the city watched; past
    /// `resident` cities the least recently used one is dropped, one still on screen only once per FORCED_DROP_MS:
    /// until then this city waits as a parked stand-in. Arms the 60 s idle sweep when a tokio runtime is present.
    pub fn get(self: &Arc<Self>, slug: &str) -> Arc<GzmLive> {
        let mut st = self.state();
        self.get_locked(&mut st, slug)
    }

    fn get_locked(self: &Arc<Self>, st: &mut ZbState, slug: &str) -> Arc<GzmLive> {
        let now = (self.now)();
        if let Some(e) = st.cities.get_mut(slug) {
            e.last_used = now;
            e.live.touch();
            return Arc::clone(&e.live);
        }
        while st.cities.len() >= self.resident {
            let Some((lru, used)) = st
                .cities
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, e)| (k.clone(), e.last_used))
            else {
                break;
            };
            // ponytail: N+1 viewed cities used to evict each other on every request (a reparse each, no city ever
            // served); now they take turns, one slot a minute, and a viewer waits up to a minute on 503s. Raise
            // KB_ZB_RESIDENT when /api/health zb.parked_requests keeps growing.
            let viewed = now - used <= ACTIVE_MS;
            if viewed && st.last_forced_drop.is_some_and(|t| now - t < FORCED_DROP_MS) {
                st.parked_requests += 1;
                let live = st.parked.entry(slug.to_owned()).or_insert_with(|| {
                    Arc::new(
                        GzmLive::new(slug, HttpZb)
                            .with_now(Arc::clone(&self.now))
                            .with_feed(Arc::new(|| None)),
                    )
                });
                return Arc::clone(live);
            }
            if viewed {
                st.last_forced_drop = Some(now);
            }
            self.drop_locked(
                st,
                &lru,
                if viewed {
                    "resident cap, still viewed"
                } else {
                    "resident cap"
                },
            );
        }
        st.parked.remove(slug);
        let live = Arc::new(GzmLive::new(slug, HttpZb).with_now(Arc::clone(&self.now)));
        live.touch();
        st.cities.insert(
            slug.to_owned(),
            ZbEntry {
                live: Arc::clone(&live),
                last_used: now,
            },
        );
        if !st.sweeping && tokio::runtime::Handle::try_current().is_ok() {
            st.sweeping = true;
            let reg = Arc::downgrade(self);
            tokio::spawn(sweep_loop(reg));
        }
        live
    }

    fn drop_locked(&self, st: &mut ZbState, slug: &str, why: &str) {
        let Some(e) = st.cities.shift_remove(slug) else {
            return;
        };
        e.live.stop();
        (self.stop_feed)(slug);
        logger::info("gzm", format!("{slug}: dropped ({why})"));
    }

    /// Drops every city idle for `idle_min`; true while cities remain (the sweep task ends otherwise).
    pub fn sweep(&self) -> bool {
        let mut st = self.state();
        let cut = (self.now)() - self.idle_min * 60_000;
        let idle: Vec<String> = st
            .cities
            .iter()
            .filter(|(_, e)| e.last_used < cut)
            .map(|(k, _)| k.clone())
            .collect();
        for slug in idle {
            self.drop_locked(&mut st, &slug, "idle");
        }
        if st.cities.is_empty() {
            st.sweeping = false;
            return false;
        }
        true
    }

    /// Starts a city's feed refresh and positions loop once; a no-op while disabled or while the city is parked.
    /// Needs a tokio runtime.
    pub fn start(self: &Arc<Self>, slug: &str) {
        if !self.enabled {
            return;
        }
        let mut st = self.state();
        let live = self.get_locked(&mut st, slug);
        if live.running() || !st.cities.get(slug).is_some_and(|e| Arc::ptr_eq(&e.live, &live)) {
            return;
        }
        // under the registry lock: a concurrent get cannot drop the city between this check and the start
        (self.start_feed)(slug);
        live.start();
    }

    /// Health of the resident cities for /api/health (informational, never flips status).
    pub fn health(&self) -> Value {
        let (parked_requests, cities): (u64, Vec<(String, Arc<GzmLive>)>) = {
            let st = self.state();
            (
                st.parked_requests,
                st.cities
                    .iter()
                    .map(|(k, e)| (k.clone(), Arc::clone(&e.live)))
                    .collect(),
            )
        };
        let mut out = json!({
            "enabled": self.enabled,
            "resident_max": self.resident,
            "idle_min": self.idle_min,
            "parked_requests": parked_requests,
        });
        if let Value::Object(m) = &mut out {
            for (slug, live) in cities {
                m.insert(slug, live.health());
            }
        }
        out
    }
}

async fn sweep_loop(reg: Weak<ZbRegistry>) {
    loop {
        tokio::time::sleep(SWEEP).await;
        let Some(reg) = reg.upgrade() else {
            return;
        };
        if !reg.sweep() {
            return;
        }
    }
}

static ZB: LazyLock<Arc<ZbRegistry>> = LazyLock::new(|| {
    Arc::new(ZbRegistry::new(
        Arc::new(|| jiff::Timestamp::now().as_millisecond()),
        usize::try_from(*config::ZB_RESIDENT).unwrap_or(1),
        *config::ZB_IDLE_MIN,
        *config::ZB_ENABLED,
        start_gzm_feed,
        stop_gzm_feed,
    ))
});

/// The live layer of a zbiorkom city (a registry slug): GZM's resident one, or the global registry's.
pub fn get_zb(slug: &str) -> Arc<GzmLive> {
    if slug == "gzm" { get_gzm() } else { ZB.get(slug) }
}

/// Starts a city's feed refresh and positions loop once (GZM: `start_gzm`); a no-op while disabled.
pub fn start_zb(slug: &str) {
    if slug == "gzm" {
        start_gzm();
    } else {
        ZB.start(slug);
    }
}

/// Health of the resident non-GZM cities for /api/health.
pub fn safe_zb_health() -> Value {
    ZB.health()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;

    fn registry(clock: &Arc<AtomicI64>) -> Arc<ZbRegistry> {
        let c = Arc::clone(clock);
        Arc::new(ZbRegistry::new(
            Arc::new(move || c.load(Ordering::Relaxed)),
            2,
            30,
            true,
            |_| {},
            |_| {},
        ))
    }

    fn resident(reg: &ZbRegistry) -> Vec<String> {
        let h = reg.health();
        let mut keys: Vec<String> = h
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, v)| v.is_object())
            .map(|(k, _)| k.clone())
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn sweep_drops_idle_cities() {
        let clock = Arc::new(AtomicI64::new(0));
        let reg = registry(&clock);
        reg.get("krakow");
        clock.store(10 * 60_000, Ordering::Relaxed);
        reg.get("lodz");
        clock.store(30 * 60_000 + 1, Ordering::Relaxed);
        assert!(reg.sweep());
        assert_eq!(resident(&reg), ["lodz"]);
        clock.store(41 * 60_000, Ordering::Relaxed);
        assert!(!reg.sweep());
        assert!(resident(&reg).is_empty());
    }
}
