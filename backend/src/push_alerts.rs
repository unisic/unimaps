//! Port of lib/push-alerts.ts, the server half of "Powiadom mnie": an alert whose browser handed over a push
//! subscription also fires from here, so it arrives with the app closed. A 30 s tick (armed only while an alert is
//! pending) reads each alerted stop's board once (the departures route's micro-cached board, a zbiorkom one from the
//! local feed) and pushes what `alert_action` decides. The page's own watcher may fire the same alert: one tag, the
//! later notification replaces the earlier one.
//! Bounded: MAX_TOTAL alerts in all (a full store refuses), MAX_PER_SUB per subscription, each one dropped at its
//! `until`. Kept in PUSH_DIR/alerts.v1.json (atomic write, 2 s debounce, 0600) so a restart keeps them.
//! ponytail: one board read per alerted stop per tick, at most 4 at once: 300 alerts on 300 stops = 10 board reads/s
//! against upstream. A shared board snapshot from the poller's scan if it grows.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use url::Url;

use crate::api::zb_live;
use crate::api_helpers::{is_valid_id, zb_enabled};
use crate::fetch::string_err;
use crate::fleet_tracker::blocking_io;
use crate::gzm::{Lookup, NowFn};
use crate::js::num_value;
use crate::kb_api::join_all;
use crate::logger;
use crate::poller_singleton::{Bb, BbKinds, bb};
use crate::shape_store::BoxFut;
use crate::shared::alerts::{ALERT_LEADS, Alert, AlertAction, MAX_ALERTS, alert_action, alert_message};
use crate::shared::cities::zb_city_of;
use crate::stop_board::stop_board;
use crate::web_push::{PushSub, SendFn, live_send, parse_push_sub};

pub const MAX_TOTAL: usize = 300;
/// both cities' alerts of one browser
pub const MAX_PER_SUB: usize = MAX_ALERTS * 2;
const TICK: Duration = Duration::from_secs(30);
/// "za 3 min" is useless later: a phone offline longer never gets it
const PUSH_TTL_SEC: f64 = 300.0;
const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);
const BOARD_CONCURRENCY: usize = 4;

/// One stop's board as an alert reads it: the wire rows and the board's own "now" (epoch s).
#[derive(Debug, Clone, PartialEq)]
pub struct BoardSnap {
    pub rows: Vec<Value>,
    pub now_ts: f64,
}

/// `(designator) => board`: Ok(None) = no usable board this tick (ask again next tick), Err = `String(err)`.
pub type BoardFn = Arc<dyn Fn(String) -> BoxFut<Result<Option<BoardSnap>, String>> + Send + Sync>;

/// `isAlertInput` plus `pick`: the server-side check of what a browser sends, the fields the page stores and
/// nothing else the client put in the JSON.
pub fn alert_input(v: &Value, now_sec: f64) -> Option<Alert> {
    let s = |k: &str| {
        let s = v.get(k)?.as_str()?;
        (!s.is_empty() && s.encode_utf16().count() <= 120).then(|| s.to_owned())
    };
    let (key, designator) = (s("key")?, s("designator")?);
    if !is_valid_id(&designator) {
        return None;
    }
    let (stop_name, line, dest) = (s("stopName")?, s("line")?, s("dest")?);
    let lead_min = v.get("leadMin")?.as_f64()?;
    let until = v.get("until")?.as_f64()?;
    (ALERT_LEADS.contains(&lead_min) && until.is_finite() && until > now_sec && until < now_sec + 24.0 * 3600.0)
        .then_some(Alert {
            key,
            designator,
            stop_name,
            line,
            dest,
            lead_min,
            until,
        })
}

/// `isAlertInput(v, nowSec)`.
pub fn is_alert_input(v: &Value, now_sec: f64) -> bool {
    alert_input(v, now_sec).is_some()
}

struct Entry {
    sub: PushSub,
    alerts: Vec<Alert>,
}

#[derive(Default)]
struct State {
    /// by endpoint, in insertion order (the file's order; `MAX_TOTAL` on load keeps the first ones)
    subs: IndexMap<String, Entry>,
    timer: Option<JoinHandle<()>>,
    save_timer: Option<JoinHandle<()>>,
}

pub struct PushAlerts {
    file: PathBuf,
    send: SendFn,
    board: BoardFn,
    now: NowFn,
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

impl PushAlerts {
    /// Inert: nothing is read, armed or written until `load`.
    pub fn new(file: PathBuf, send: SendFn, board: BoardFn) -> Self {
        Self {
            file,
            send,
            board,
            now: Arc::new(|| jiff::Timestamp::now().as_millisecond()),
            state: Mutex::new(State::default()),
            busy: AtomicBool::new(false),
            write: Mutex::new(()),
        }
    }

    /// The `Date.now()` (epoch ms) of the load validation and the expiry pass.
    pub fn with_now(mut self, now: NowFn) -> Self {
        self.now = now;
        self
    }

    /// The TS constructor's tail: the persisted alerts that still validate (at most MAX_PER_SUB per subscription,
    /// MAX_TOTAL in all) and, inside a runtime, the tick when any is pending.
    pub fn load(self) -> Arc<Self> {
        let me = Arc::new(self);
        let raw = match blocking_io(|| fs::read(&me.file)) {
            Ok(b) => crate::js::json_parse(&String::from_utf8_lossy(&b)).map_err(|e| format!("SyntaxError: {e}")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return me,
            Err(e) => Err(format!("Error: {e}")),
        };
        let raw = match raw {
            Ok(Value::Array(a)) => a,
            Ok(_) => return me,
            Err(e) => {
                logger::warn("push", format!("load failed, starting empty: {e}"));
                return me;
            }
        };
        let now = me.now_sec();
        let mut st = me.st();
        let mut n = 0;
        for e in &raw {
            let (Some(sub), Some(alerts)) = (
                e.get("sub").and_then(parse_push_sub),
                e.get("alerts").and_then(Value::as_array),
            ) else {
                continue;
            };
            let alerts: Vec<Alert> = alerts
                .iter()
                .filter_map(|a| alert_input(a, now))
                .take(MAX_PER_SUB)
                .collect();
            if alerts.is_empty() || n + alerts.len() > MAX_TOTAL {
                continue;
            }
            n += alerts.len();
            st.subs.insert(sub.endpoint.clone(), Entry { sub, alerts });
        }
        me.arm(&mut st);
        drop(st);
        me
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now_sec(&self) -> f64 {
        (self.now)() as f64 / 1000.0
    }

    pub fn size(&self) -> usize {
        self.st().subs.values().map(|e| e.alerts.len()).sum()
    }

    /// false = the store (or this browser's share of it) is full
    pub fn add(self: &Arc<Self>, sub: &PushSub, alert: &Alert) -> bool {
        {
            let mut st = self.st();
            let size: usize = st.subs.values().map(|e| e.alerts.len()).sum();
            let cur = st
                .subs
                .get(&sub.endpoint)
                .map(|e| e.alerts.as_slice())
                .unwrap_or_default();
            let mut rest: Vec<Alert> = cur.iter().filter(|a| a.key != alert.key).cloned().collect();
            if rest.len() >= MAX_PER_SUB || size - cur.len() + rest.len() >= MAX_TOTAL {
                return false;
            }
            rest.push(alert.clone());
            st.subs.insert(
                sub.endpoint.clone(),
                Entry {
                    sub: sub.clone(),
                    alerts: rest,
                },
            );
        }
        self.changed();
        true
    }

    pub fn remove(self: &Arc<Self>, endpoint: &str, key: &str) {
        {
            let mut st = self.st();
            let Some(cur) = st.subs.get_mut(endpoint) else { return };
            if !cur.alerts.iter().any(|a| a.key == key) {
                return;
            }
            cur.alerts.retain(|a| a.key != key);
            if cur.alerts.is_empty() {
                st.subs.shift_remove(endpoint);
            }
        }
        self.changed();
    }

    /// One pass: every alerted stop's board once, the fired / cancelled / expired alerts dropped.
    pub async fn tick(self: &Arc<Self>) {
        if self.busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let _busy = Busy(&self.busy);
        let stops: IndexSet<String> = self
            .st()
            .subs
            .values()
            .flat_map(|e| e.alerts.iter().map(|a| a.designator.clone()))
            .collect();
        let limit = &Semaphore::new(BOARD_CONCURRENCY);
        join_all(stops.iter().map(|d| async move {
            let Ok(_slot) = limit.acquire().await else { return };
            // a failed board: the next tick asks again, `until` still bounds the wait
            match (self.board)(d.clone()).await {
                Ok(Some(b)) => self.decide(d, &b.rows, b.now_ts),
                Ok(None) => {}
                Err(e) => logger::warn("push", format!("board {d}: {e}")),
            }
        }))
        .await;
        // stops no board answered for: their expired alerts still go
        let now = self.now_sec();
        // `until` is finite: every alert passed `alert_input`
        if self.retain(|a| a.until >= now) {
            self.changed();
        }
    }

    /// Keeps the alerts `keep` accepts, dropping a subscription left with none; true = anything went.
    fn retain(&self, mut keep: impl FnMut(&Alert) -> bool) -> bool {
        let mut gone = false;
        self.st().subs.retain(|_, e| {
            let before = e.alerts.len();
            e.alerts.retain(&mut keep);
            gone |= e.alerts.len() != before;
            !e.alerts.is_empty()
        });
        gone
    }

    fn decide(self: &Arc<Self>, designator: &str, rows: &[Value], now_ts: f64) {
        let mut sends = Vec::new();
        let mut done = HashSet::new();
        for e in self.st().subs.values() {
            for a in e.alerts.iter().filter(|a| a.designator == designator) {
                let r = alert_action(a, rows, now_ts);
                if r == AlertAction::Wait {
                    continue;
                }
                done.insert((e.sub.endpoint.clone(), a.key.clone()));
                if let Some(m) = alert_message(a, r) {
                    sends.push((e.sub.clone(), m));
                }
            }
        }
        // the send is called here, in order; its answer is awaited in the background (the TS `void deliver`)
        for (sub, m) in sends {
            let fut = (self.send)(sub.clone(), serde_json::to_value(&m).unwrap_or_default(), PUSH_TTL_SEC);
            let me = Arc::downgrade(self);
            tokio::spawn(async move {
                let status = fut.await;
                if let Some(me) = me.upgrade() {
                    me.delivered(&sub, status);
                }
            });
        }
        if done.is_empty() {
            return;
        }
        let mut st = self.st();
        st.subs.retain(|endpoint, e| {
            e.alerts.retain(|a| !done.contains(&(endpoint.clone(), a.key.clone())));
            !e.alerts.is_empty()
        });
        drop(st);
        self.changed();
    }

    fn delivered(self: &Arc<Self>, sub: &PushSub, status: Result<u16, String>) {
        let host = Url::parse(&sub.endpoint)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default();
        match status {
            // gone: the browser unsubscribed or the user revoked the permission
            Ok(404 | 410) => {
                self.st().subs.shift_remove(&sub.endpoint);
                self.changed();
            }
            Ok(s) if s >= 300 => logger::warn("push", format!("{host} answered {s}")),
            Ok(_) => {}
            Err(e) => logger::warn("push", format!("{host}: {e}")),
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

    /// the tick runs only while an alert is pending; a no-op outside a runtime
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
        let body = file_json(&self.st().subs);
        if let Err(e) = blocking_io(|| write_private(&self.file, &body)) {
            logger::warn("push", format!("save failed: Error: {e}"));
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

/// `JSON.stringify([...subs.values()])`: `{sub, alerts}` per subscription, numbers as JS writes them.
fn file_json(subs: &IndexMap<String, Entry>) -> String {
    let entries = subs.values().map(|e| {
        let alerts: Vec<Value> = e
            .alerts
            .iter()
            .map(|a| {
                json!({
                    "key": a.key,
                    "designator": a.designator,
                    "stopName": a.stop_name,
                    "line": a.line,
                    "dest": a.dest,
                    "leadMin": num_value(a.lead_min),
                    "until": num_value(a.until),
                })
            })
            .collect();
        json!({ "sub": e.sub, "alerts": alerts })
    });
    Value::Array(entries.collect()).to_string()
}

/// tmp + rename; endpoints are capability URLs: owner-only
pub(crate) fn write_private(file: &Path, body: &str) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(body.as_bytes())?;
    drop(f);
    fs::rename(&tmp, file)
}

/// `readBoard`: a zbiorkom stop's board from the city's local feed (None while it loads, for an unknown stop or a
/// disabled city), a BB one through `stop_board` (None when every upstream leg failed: not "no departures").
pub async fn read_board<T: BbKinds>(bb: &Bb<T>, designator: &str) -> Result<Option<BoardSnap>, String> {
    if let Some(slug) = zb_city_of(designator) {
        if !zb_enabled(slug) {
            return Ok(None);
        }
        let Lookup::Found(Value::Object(mut b)) = zb_live(slug).departures(designator, false) else {
            return Ok(None);
        };
        let now_ts = b.get("server_ts").and_then(Value::as_f64);
        return Ok(match (b.remove("rows"), now_ts) {
            (Some(Value::Array(rows)), Some(now_ts)) => Some(BoardSnap { rows, now_ts }),
            _ => None,
        });
    }
    bb.start_poller().await.map_err(string_err)?;
    let b = stop_board(bb, designator).await;
    Ok((b.failed_legs < b.legs).then(|| BoardSnap {
        rows: b.rows.iter().cloned().map(Value::Object).collect(),
        now_ts: bb.now_ms() as f64 / 1000.0,
    }))
}

/// [`read_board`] over the process `bb()` as a [`BoardFn`].
pub fn live_board() -> BoardFn {
    Arc::new(|d| Box::pin(async move { read_board(bb(), &d).await }))
}

/// `getPushAlerts`: the process-wide store over PUSH_DIR/alerts.v1.json; the first call loads it and arms the tick.
pub fn get_push_alerts() -> &'static Arc<PushAlerts> {
    static STORE: LazyLock<Arc<PushAlerts>> = LazyLock::new(|| {
        PushAlerts::new(
            Path::new(&*crate::config::PUSH_DIR).join("alerts.v1.json"),
            live_send(),
            live_board(),
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
    async fn the_file_is_written_as_node_writes_it() {
        let dir = std::env::temp_dir().join(format!("unimaps-push-alerts-{}", std::process::id()));
        let file = dir.join("alerts.v1.json");
        let s = PushAlerts::new(
            file.clone(),
            Arc::new(|_, _, _| Box::pin(async { Ok(201) })),
            Arc::new(|_| Box::pin(async { Ok(None) })),
        )
        .load();
        let sub = PushSub {
            endpoint: "https://fcm.googleapis.com/fcm/send/1".into(),
            keys: PushKeys {
                p256dh: "p".into(),
                auth: "a".into(),
            },
        };
        let alert = Alert {
            key: "kb:e1#4".into(),
            designator: "123".into(),
            stop_name: "Szczyrk Biła".into(),
            line: "120".into(),
            dest: "B\"B".into(),
            lead_min: 5.0,
            until: 1_762_601_800.5,
        };
        assert!(s.add(&sub, &alert));
        tokio::time::sleep(Duration::from_millis(2100)).await;
        let written = fs::read_to_string(&file).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        s.stop();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(
            written,
            r#"[{"sub":{"endpoint":"https://fcm.googleapis.com/fcm/send/1","keys":{"p256dh":"p","auth":"a"}},"alerts":[{"key":"kb:e1#4","designator":"123","stopName":"Szczyrk Biła","line":"120","dest":"B\"B","leadMin":5,"until":1762601800.5}]}]"#
        );
        assert_eq!(mode, 0o600);
    }
}
