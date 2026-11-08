//! lib/push-news.ts, "Powiadamiaj o utrudnieniach": a web push when a city's announcements list gains an item. One
//! subscription per browser with the cities it chose; a TICK tick (armed only while anyone is subscribed) fetches
//! each wanted city's list (`announcements::fetch_announcements`, the same memoized sources the route serves) and
//! pushes the headline of what is new. "New" = an `operator:id:rev` key not seen before, so an edited item notifies
//! again; the first list of a city is only recorded. Seen keys are a bounded, insertion-ordered set (MAX_SEEN per
//! city), so a leg that fails for a tick and comes back does not re-notify. Kept in PUSH_DIR/news.v1.json (0600,
//! atomic write).
//! ponytail: one fetch per city per tick for everyone; 500 subs = 500 pushes in a burst every 15 min at worst.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use url::Url;

use crate::announcements::{Announcements, announcement_key, announcement_title, fetch_announcements};
use crate::fleet_tracker::blocking_io;
use crate::logger;
use crate::poller_singleton::bb;
use crate::push_alerts::write_private;
use crate::shape_store::BoxFut;
use crate::web_push::{PushSub, SendFn, live_send, parse_push_sub};

pub const MAX_SUBS: usize = 500;
const MAX_SEEN: usize = 500;
const TICK: Duration = Duration::from_secs(15 * 60);
/// news keeps: a phone offline for the afternoon still gets it
const PUSH_TTL_SEC: f64 = 4.0 * 3600.0;
const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);

/// The cities with a news source (`announcements::fetch_announcements`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum City {
    Bb = 0,
    Gzm = 1,
}

const CITIES: [City; 2] = [City::Bb, City::Gzm];

impl City {
    pub fn as_str(self) -> &'static str {
        match self {
            City::Bb => "bb",
            City::Gzm => "gzm",
        }
    }
}

impl fmt::Display for City {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `isCity` as a parse: "bb" or "gzm", nothing else.
pub fn parse_city(v: &Value) -> Option<City> {
    match v.as_str()? {
        "bb" => Some(City::Bb),
        "gzm" => Some(City::Gzm),
        _ => None,
    }
}

/// One city's list, as `fetchAnnouncements` (Err = `String(err)` of a rejection).
pub type ListFn = Arc<dyn Fn(City) -> BoxFut<Result<Announcements, String>> + Send + Sync>;

struct Entry {
    sub: PushSub,
    cities: Vec<City>,
}

#[derive(Default)]
struct State {
    /// by endpoint, in insertion order (the file's order; MAX_SUBS on load keeps the first ones)
    subs: IndexMap<String, Entry>,
    /// per `City as usize`, oldest first
    seen: [IndexSet<String>; 2],
    timer: Option<JoinHandle<()>>,
    save_timer: Option<JoinHandle<()>>,
}

pub struct PushNews {
    file: PathBuf,
    send: SendFn,
    list: ListFn,
    state: Mutex<State>,
    busy: AtomicBool,
    /// one writer of the file at a time, each with the state as it is when it writes
    write: Mutex<()>,
}

struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl PushNews {
    /// Inert: nothing is read, armed or written until `load`.
    pub fn new(file: PathBuf, send: SendFn, list: ListFn) -> Self {
        Self {
            file,
            send,
            list,
            state: Mutex::new(State::default()),
            busy: AtomicBool::new(false),
            write: Mutex::new(()),
        }
    }

    /// The TS constructor's tail: the persisted subscriptions (at most MAX_SUBS) and seen keys (the last MAX_SEEN
    /// per city) and, inside a runtime, the tick when anyone is subscribed.
    pub fn load(self) -> Arc<Self> {
        let me = Arc::new(self);
        let raw = match blocking_io(|| fs::read(&me.file)) {
            Ok(b) => crate::js::json_parse(&String::from_utf8_lossy(&b)).map_err(|e| format!("SyntaxError: {e}")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return me,
            Err(e) => Err(format!("Error: {e}")),
        };
        let raw = match raw {
            Ok(v) => v,
            Err(e) => {
                logger::warn("push-news", format!("load failed, starting empty: {e}"));
                return me;
            }
        };
        let mut st = me.st();
        for e in raw.get("subs").and_then(Value::as_array).into_iter().flatten() {
            let (Some(sub), Some(cities)) = (
                e.get("sub").and_then(parse_push_sub),
                e.get("cities").and_then(Value::as_array),
            ) else {
                continue;
            };
            let cities: Vec<City> = cities.iter().filter_map(parse_city).collect();
            if cities.is_empty() || st.subs.len() >= MAX_SUBS {
                continue;
            }
            st.subs.insert(sub.endpoint.clone(), Entry { sub, cities });
        }
        for city in CITIES {
            let Some(keys) = raw
                .get("seen")
                .and_then(|s| s.get(city.as_str()))
                .and_then(Value::as_array)
            else {
                continue;
            };
            let seen = &mut st.seen[city as usize];
            for k in keys.iter().skip(keys.len().saturating_sub(MAX_SEEN)) {
                if let Some(k) = k.as_str() {
                    seen.insert(k.to_owned());
                }
            }
        }
        me.arm(&mut st);
        drop(st);
        me
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn size(&self) -> usize {
        self.st().subs.len()
    }

    /// false = store full (the caller answers 503)
    pub fn add(self: &Arc<Self>, sub: &PushSub, city: City) -> bool {
        let mut st = self.st();
        if let Some(e) = st.subs.get_mut(&sub.endpoint) {
            if !e.cities.contains(&city) {
                e.cities.push(city);
            }
            e.sub = sub.clone();
        } else {
            if st.subs.len() >= MAX_SUBS {
                return false;
            }
            st.subs.insert(
                sub.endpoint.clone(),
                Entry {
                    sub: sub.clone(),
                    cities: vec![city],
                },
            );
        }
        drop(st);
        self.changed();
        true
    }

    pub fn remove(self: &Arc<Self>, endpoint: &str, city: City) {
        let mut st = self.st();
        let Some(e) = st.subs.get_mut(endpoint) else { return };
        e.cities.retain(|c| *c != city);
        if e.cities.is_empty() {
            st.subs.shift_remove(endpoint);
        }
        drop(st);
        self.changed();
    }

    /// One pass: each wanted city's list once, its new items pushed to that city's subscribers.
    // ponytail: the subscribers are snapshotted before the list fetch; the TS reads each entry's `sub` at delivery,
    // so a key change for the same endpoint during that fetch reaches the old keys here
    pub async fn tick(self: &Arc<Self>) {
        if self.busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let _busy = Busy(&self.busy);
        for city in CITIES {
            let subs: Vec<PushSub> = self
                .st()
                .subs
                .values()
                .filter(|e| e.cities.contains(&city))
                .map(|e| e.sub.clone())
                .collect();
            if subs.is_empty() {
                continue;
            }
            let items = match (self.list)(city).await {
                Ok(a) => a.announcements,
                Err(e) => {
                    logger::warn("push-news", format!("{city}: list failed: {e}"));
                    continue;
                }
            };
            let (fresh, first) = {
                let mut st = self.st();
                let seen = &mut st.seen[city as usize];
                let fresh: Vec<_> = items.iter().filter(|a| !seen.contains(&announcement_key(a))).collect();
                if fresh.is_empty() {
                    continue;
                }
                let first = seen.is_empty();
                for a in &fresh {
                    seen.insert(announcement_key(a));
                }
                let over = seen.len().saturating_sub(MAX_SEEN);
                seen.drain(..over);
                (fresh, first)
            };
            self.changed();
            if first {
                continue;
            }
            let title = fresh.first().map(|a| announcement_title(a)).unwrap_or_default();
            let body = if fresh.len() > 1 {
                format!("{title} (+{})", fresh.len() - 1)
            } else {
                title
            };
            let msg = json!({
                "title": "Utrudnienia",
                "body": body,
                "tag": format!("news:{city}"),
                "url": if city == City::Gzm { "/?city=gzm" } else { "/" },
            });
            for sub in subs {
                self.deliver(sub, &msg).await;
            }
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
            Ok(s) if s >= 300 => logger::warn("push-news", format!("{host} answered {s}")),
            Ok(_) => {}
            Err(e) => logger::warn("push-news", format!("{host}: {e}")),
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

    /// the tick runs only while anyone is subscribed; a no-op outside a runtime
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
                    // its own task, as setInterval: disarming from inside a tick must not cut that tick short
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
        let body = file_json(&self.st());
        if let Err(e) = blocking_io(|| write_private(&self.file, &body)) {
            logger::warn("push-news", format!("save failed: Error: {e}"));
        }
    }

    /// Ends the tick and drops a pending save (as the TS, which clears the debounce timer unsaved).
    pub fn stop(&self) {
        let mut st = self.st();
        for t in [st.timer.take(), st.save_timer.take()].into_iter().flatten() {
            t.abort();
        }
    }
}

/// `JSON.stringify({subs: [...subs.values()], seen: {bb, gzm}})`.
// ponytail: a sub keeps only endpoint and keys; the TS stores the whole request object (`expirationTime` too)
fn file_json(st: &State) -> String {
    let subs: Vec<Value> = st
        .subs
        .values()
        .map(|e| json!({ "sub": e.sub, "cities": e.cities }))
        .collect();
    let [bb, gzm] = &st.seen;
    json!({ "subs": subs, "seen": { "bb": bb, "gzm": gzm } }).to_string()
}

/// [`fetch_announcements`] over the process `bb()` as a [`ListFn`].
pub fn live_list() -> ListFn {
    Arc::new(|city| Box::pin(async move { fetch_announcements(bb(), city.as_str()).await }))
}

/// `getPushNews`: the process-wide store over PUSH_DIR/news.v1.json; the first call loads it and arms the tick.
pub fn get_push_news() -> &'static Arc<PushNews> {
    static STORE: LazyLock<Arc<PushNews>> = LazyLock::new(|| {
        PushNews::new(
            Path::new(&*crate::config::PUSH_DIR).join("news.v1.json"),
            live_send(),
            live_list(),
        )
        .load()
    });
    &STORE
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;
    use crate::web_push::PushKeys;

    #[tokio::test(start_paused = true)]
    async fn the_file_is_written_as_node_writes_it_with_the_seen_bound() {
        let dir = std::env::temp_dir().join(format!("unimaps-push-news-{}", std::process::id()));
        let file = dir.join("news.v1.json");
        let s = PushNews::new(
            file.clone(),
            Arc::new(|_, _, _| Box::pin(async { Ok(201) })),
            Arc::new(|city| {
                Box::pin(async move {
                    let n = if city == City::Bb { 501 } else { 0 };
                    let announcements = (1..=n)
                        .filter_map(|id| match json!({ "id": id, "rev": 1, "operator": "KB" }) {
                            Value::Object(m) => Some(m),
                            _ => None,
                        })
                        .collect();
                    Ok(Announcements {
                        announcements,
                        hash: String::new(),
                    })
                })
            }),
        )
        .load();
        let sub = PushSub {
            endpoint: "https://fcm.googleapis.com/fcm/send/1".into(),
            keys: PushKeys {
                p256dh: "p".into(),
                auth: "a".into(),
            },
        };
        assert!(s.add(&sub, City::Bb));
        assert!(s.add(&sub, City::Gzm));
        s.tick().await;
        tokio::time::sleep(Duration::from_millis(2100)).await;
        let written = fs::read_to_string(&file).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        s.stop();
        fs::remove_dir_all(&dir).ok();
        assert!(written.starts_with(
            r#"{"subs":[{"sub":{"endpoint":"https://fcm.googleapis.com/fcm/send/1","keys":{"p256dh":"p","auth":"a"}},"cities":["bb","gzm"]}],"seen":{"bb":["KB:2:1","KB:3:1","#
        ));
        assert!(written.ends_with(r#","KB:501:1"],"gzm":[]}}"#));
        assert_eq!(mode, 0o600);
    }
}
