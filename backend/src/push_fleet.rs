//! "Powiadom, gdy wyjedzie" (/brygady): a web push when a vehicle starts a course. A browser POSTs
//! `{subscription, side}` for a vehicle that is not running; a TICK tick (armed only while a watch is pending) asks
//! the vehicle's fleet tracker (`FleetTracker::begun_course`: GZM for `<company>_<fleet>`, MZK for the rest) and
//! pushes once when it runs a begun course, then drops the watch. An unfired watch lapses after WATCH_SEC. At most
//! MAX_SUBS browsers with MAX_PER_SUB watches each, kept in PUSH_DIR/fleet.v1.json (0600, atomic write).
//! ponytail: the trackers are asked under this store's lock (one short tracker lock per watch, never the other way
//! round); MAX_SUBS * MAX_PER_SUB = 3000 map lookups per tick at worst.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::IndexMap;
use indexmap::map::Entry as MapEntry;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use url::Url;

use crate::api_helpers::is_valid_id;
use crate::config::GZM_ENABLED;
use crate::fleet_tracker::{blocking_io, get_fleet_tracker};
use crate::gzm_fleet::{get_gzm_fleet_tracker, is_gzm_side};
use crate::logger;
use crate::push_alerts::write_private;
use crate::shared::fleet::FleetCurrentCourse;
use crate::web_push::{PushSub, SendFn, live_send};

pub const MAX_SUBS: usize = 500;
pub const MAX_PER_SUB: usize = 6;
const TICK: Duration = Duration::from_secs(30);
/// a watch set in the evening still covers the next morning's run out
pub const WATCH_SEC: i64 = 24 * 3600;
/// "wyjechał" is news for a quarter of an hour
const PUSH_TTL_SEC: f64 = 15.0 * 60.0;
const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);

/// The label and the begun course of a vehicle, None while it runs none (`FleetTracker::begun_course`).
pub type StartedFn = Arc<dyn Fn(&str) -> Option<(Option<String>, FleetCurrentCourse)> + Send + Sync>;

/// A side number the trackers key: GZM `<company>_<fleet>`, MZK an id of at most 16 characters without `_`.
pub fn is_fleet_side(side: &str) -> bool {
    is_gzm_side(side) || (side.len() <= 16 && !side.contains('_') && is_valid_id(side))
}

#[derive(Serialize, Deserialize)]
struct Watch {
    side: String,
    /// epoch secs
    until: i64,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    sub: PushSub,
    watches: Vec<Watch>,
}

#[derive(Deserialize)]
struct FileBody {
    subs: Vec<Entry>,
}

#[derive(Default)]
struct State {
    /// by endpoint; an entry without watches is removed
    subs: IndexMap<String, Entry>,
    timer: Option<JoinHandle<()>>,
    save_timer: Option<JoinHandle<()>>,
}

pub struct PushFleet {
    file: PathBuf,
    send: SendFn,
    started: StartedFn,
    state: Mutex<State>,
    /// one writer of the file at a time, each with the state as it is when it writes
    write: Mutex<()>,
}

fn now_sec() -> i64 {
    Timestamp::now().as_second()
}

impl PushFleet {
    /// Inert: nothing is read, armed or written until `load`.
    pub fn new(file: PathBuf, send: SendFn, started: StartedFn) -> Self {
        Self {
            file,
            send,
            started,
            state: Mutex::new(State::default()),
            write: Mutex::new(()),
        }
    }

    /// The persisted watches still pending (MAX_SUBS browsers, MAX_PER_SUB each) and, inside a runtime, the tick.
    pub fn load(self) -> Arc<Self> {
        let me = Arc::new(self);
        let body = match blocking_io(|| fs::read(&me.file)) {
            Ok(b) => serde_json::from_slice::<FileBody>(&b).map_err(|e| e.to_string()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return me,
            Err(e) => Err(e.to_string()),
        };
        let body = match body {
            Ok(b) => b,
            Err(e) => {
                logger::warn("push-fleet", format!("load failed, starting empty: {e}"));
                return me;
            }
        };
        let now = now_sec();
        let mut st = me.st();
        for mut e in body.subs {
            e.watches.retain(|w| w.until > now && is_fleet_side(&w.side));
            e.watches.truncate(MAX_PER_SUB);
            if !e.watches.is_empty() && st.subs.len() < MAX_SUBS {
                st.subs.insert(e.sub.endpoint.clone(), e);
            }
        }
        me.arm(&mut st);
        drop(st);
        me
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Watches `side` for this browser (again: the deadline moves on); false = full, MAX_SUBS browsers or
    /// MAX_PER_SUB watches here (the caller answers 503).
    pub fn add(self: &Arc<Self>, sub: &PushSub, side: &str) -> bool {
        let until = now_sec() + WATCH_SEC;
        let mut st = self.st();
        let full = st.subs.len() >= MAX_SUBS;
        let e = match st.subs.entry(sub.endpoint.clone()) {
            MapEntry::Occupied(o) => o.into_mut(),
            MapEntry::Vacant(_) if full => return false,
            MapEntry::Vacant(v) => v.insert(Entry {
                sub: sub.clone(),
                watches: Vec::new(),
            }),
        };
        e.sub = sub.clone();
        if let Some(w) = e.watches.iter_mut().find(|w| w.side == side) {
            w.until = until;
        } else if e.watches.len() < MAX_PER_SUB {
            e.watches.push(Watch {
                side: side.to_owned(),
                until,
            });
        } else {
            return false;
        }
        drop(st);
        self.changed();
        true
    }

    pub fn remove(self: &Arc<Self>, endpoint: &str, side: &str) {
        let mut st = self.st();
        let Some(e) = st.subs.get_mut(endpoint) else { return };
        e.watches.retain(|w| w.side != side);
        if e.watches.is_empty() {
            st.subs.shift_remove(endpoint);
        }
        drop(st);
        self.changed();
    }

    pub fn size(&self) -> usize {
        self.st().subs.values().map(|e| e.watches.len()).sum()
    }

    /// One pass: lapsed watches dropped, each vehicle that runs a begun course pushed to its watchers.
    pub async fn tick(self: &Arc<Self>) {
        let now = now_sec();
        let mut fire = Vec::new();
        let mut dirty = false;
        {
            let mut st = self.st();
            for e in st.subs.values_mut() {
                let before = e.watches.len();
                e.watches.retain(|w| {
                    if w.until <= now {
                        return false;
                    }
                    let Some((label, course)) = (self.started)(&w.side) else {
                        return true;
                    };
                    fire.push((e.sub.clone(), message(&w.side, label, &course)));
                    false
                });
                dirty |= e.watches.len() != before;
            }
            st.subs.retain(|_, e| !e.watches.is_empty());
        }
        if dirty {
            self.changed();
        }
        for (sub, msg) in fire {
            self.deliver(sub, &msg).await;
        }
    }

    async fn deliver(self: &Arc<Self>, sub: PushSub, msg: &Value) {
        let host = Url::parse(&sub.endpoint)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default();
        let endpoint = sub.endpoint.clone();
        match (self.send)(sub, msg.clone(), PUSH_TTL_SEC).await {
            // gone: the browser unsubscribed or the user revoked the permission
            Ok(404 | 410) => {
                self.st().subs.shift_remove(&endpoint);
                self.changed();
            }
            Ok(s) if s >= 300 => logger::warn("push-fleet", format!("{host} answered {s}")),
            Ok(_) => {}
            Err(e) => logger::warn("push-fleet", format!("{host}: {e}")),
        }
    }

    fn changed(self: &Arc<Self>) {
        if Handle::try_current().is_err() {
            self.save();
            return;
        }
        let mut st = self.st();
        self.arm(&mut st);
        if st.save_timer.is_some() {
            return;
        }
        let me = Arc::downgrade(self);
        st.save_timer = Some(tokio::spawn(async move {
            tokio::time::sleep(SAVE_DEBOUNCE).await;
            if let Some(me) = me.upgrade() {
                me.st().save_timer = None;
                me.save();
            }
        }));
    }

    /// the tick runs only while a watch is pending; a no-op outside a runtime
    fn arm(self: &Arc<Self>, st: &mut State) {
        if !st.subs.is_empty() && st.timer.is_none() {
            if Handle::try_current().is_err() {
                return;
            }
            let me = Arc::downgrade(self);
            st.timer = Some(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(TICK).await;
                    let Some(me) = me.upgrade() else { return };
                    // its own task: disarming from inside a tick must not cut that tick short
                    tokio::spawn(async move { me.tick().await });
                }
            }));
        } else if st.subs.is_empty()
            && let Some(t) = st.timer.take()
        {
            t.abort();
        }
    }

    fn save(&self) {
        let _w = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let body = json!({ "subs": self.st().subs.values().collect::<Vec<_>>() }).to_string();
        if let Err(e) = blocking_io(|| write_private(&self.file, &body)) {
            logger::warn("push-fleet", format!("save failed: {e}"));
        }
    }

    /// Ends the tick and drops a pending save.
    pub fn stop(&self) {
        let mut st = self.st();
        for t in [st.timer.take(), st.save_timer.take()].into_iter().flatten() {
            t.abort();
        }
    }
}

/// "Autobus #237 wyjechał" / "Linia 21 do Osiedle Wapienica, odjazd 05:12"; a tap opens the vehicle's card.
fn message(side: &str, label: Option<String>, c: &FleetCurrentCourse) -> Value {
    let gzm = is_gzm_side(side);
    let label = label.unwrap_or_else(|| side.rsplit('_').next().unwrap_or(side).to_owned());
    json!({
        "title": format!("{} #{label} wyjechał", if gzm { "Pojazd" } else { "Autobus" }),
        "body": format!("Linia {} do {}, odjazd {}", c.line_name, c.last_stop_name, c.start_time),
        "tag": format!("fleet:{side}"),
        "url": format!("/brygady?tabor={side}"),
    })
}

/// [`FleetTracker::begun_course`] of the process trackers as a [`StartedFn`].
///
/// [`FleetTracker::begun_course`]: crate::fleet_tracker::FleetTracker::begun_course
pub fn live_started() -> StartedFn {
    Arc::new(|side| {
        if !is_gzm_side(side) {
            get_fleet_tracker().begun_course(side)
        } else if *GZM_ENABLED {
            get_gzm_fleet_tracker().begun_course(side)
        } else {
            None
        }
    })
}

/// The process-wide store over PUSH_DIR/fleet.v1.json; the first call loads it and arms the tick.
pub fn get_push_fleet() -> &'static Arc<PushFleet> {
    static STORE: LazyLock<Arc<PushFleet>> = LazyLock::new(|| {
        PushFleet::new(
            Path::new(&*crate::config::PUSH_DIR).join("fleet.v1.json"),
            live_send(),
            live_started(),
        )
        .load()
    });
    &STORE
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::web_push::PushKeys;

    fn sub(n: u32) -> PushSub {
        PushSub {
            endpoint: format!("https://fcm.googleapis.com/fcm/send/{n}"),
            keys: PushKeys {
                p256dh: "p".into(),
                auth: "a".into(),
            },
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_watch_fires_once_when_the_vehicle_starts_and_the_file_follows() {
        let dir = std::env::temp_dir().join(format!("unimaps-push-fleet-{}", std::process::id()));
        let file = dir.join("fleet.v1.json");
        let running = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
        let (r, s) = (running.clone(), sent.clone());
        let course: FleetCurrentCourse = serde_json::from_value(json!({
            "id": "c", "lineName": "21", "direction": "", "firstStopName": "", "lastStopName": "Wapienica",
            "startTime": "05:12", "endTime": "05:50", "startSecs": 0, "endSecs": 0, "delaySec": 0, "stopsCount": 0,
            "currentStopIndex": 0, "currentStopName": "", "lat": 0, "lon": 0, "progressPct": 0,
            "status": "in_progress",
        }))
        .unwrap();
        let store = PushFleet::new(
            file.clone(),
            Arc::new(move |_, msg, _| {
                s.lock().unwrap().push(msg);
                Box::pin(async { Ok(201) })
            }),
            Arc::new(move |side| (r.load(Ordering::Relaxed) && side == "237").then(|| (None, course.clone()))),
        )
        .load();
        for side in ["237", "1", "2", "3", "4", "5"] {
            assert!(store.add(&sub(1), side));
        }
        assert!(!store.add(&sub(1), "6"), "MAX_PER_SUB");
        assert!(store.add(&sub(1), "237"), "a repeat only moves the deadline");
        store.tick().await;
        assert!(sent.lock().unwrap().is_empty());
        running.store(true, Ordering::Relaxed);
        store.tick().await;
        store.tick().await;
        tokio::time::sleep(Duration::from_millis(2100)).await;
        let written = fs::read_to_string(&file).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        store.stop();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(
            *sent.lock().unwrap(),
            [json!({
                "title": "Autobus #237 wyjechał",
                "body": "Linia 21 do Wapienica, odjazd 05:12",
                "tag": "fleet:237",
                "url": "/brygady?tabor=237",
            })]
        );
        assert_eq!(store.size(), 5);
        assert!(
            written.contains(r#""side":"1""#) && !written.contains(r#""side":"237""#),
            "{written}"
        );
        assert_eq!(mode, 0o600);
    }
}
