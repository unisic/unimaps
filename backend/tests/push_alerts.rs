//! test/push-alerts.test.ts: the server-side "Powiadom mnie" store over fake send and board fns.
//! test/push-alerts-remote.test.ts is not ported: it covers the Node-only KB_ZB_REMOTE shim, Rust reads a zbiorkom
//! board in-process (tests/push_alerts_zb.rs).

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use unimaps::push_alerts::{BoardFn, BoardSnap, PushAlerts, is_alert_input};
use unimaps::shared::alerts::Alert;
use unimaps::web_push::{PushKeys, PushSub, SendFn};

static NOW: LazyLock<f64> = LazyLock::new(|| jiff::Timestamp::now().as_millisecond() as f64 / 1000.0);

fn sub(n: u32) -> PushSub {
    PushSub {
        endpoint: format!("https://fcm.googleapis.com/fcm/send/{n}"),
        keys: PushKeys {
            p256dh: "x".into(),
            auth: "y".into(),
        },
    }
}

fn merged(mut base: Value, over: Value) -> Value {
    if let (Some(b), Value::Object(o)) = (base.as_object_mut(), over) {
        b.extend(o);
    }
    base
}

fn alert(over: Value) -> Alert {
    let base = json!({
        "key": "kb:e1#4",
        "designator": "123",
        "stopName": "Szczyrk Biła",
        "line": "120",
        "dest": "Bielsko-Biała",
        "leadMin": 5,
        "until": *NOW + 1800.0,
    });
    serde_json::from_value(merged(base, over)).unwrap()
}

fn row(over: Value) -> Value {
    let base = json!({
        "operator": "KB",
        "row_key": "kb:e1#4",
        "line_name": "120",
        "plan_ts": *NOW + 600.0,
        "eta_ts": *NOW + 600.0,
    });
    merged(base, over)
}

type Sent = Arc<Mutex<Vec<(String, Value)>>>;

struct Store {
    s: Arc<PushAlerts>,
    sent: Sent,
    file: PathBuf,
}

fn temp_file() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir()
        .join(format!(
            "unimaps-push-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ))
        .join("alerts.json")
}

fn status_send(sent: Sent, status: u16) -> SendFn {
    Arc::new(move |to: PushSub, msg: Value, _ttl: f64| {
        sent.lock().unwrap().push((to.endpoint, msg));
        Box::pin(async move { Ok(status) })
    })
}

fn store(rows: impl Fn() -> Vec<Value> + Send + Sync + 'static, status: u16) -> Store {
    let file = temp_file();
    let sent: Sent = Arc::default();
    let rows = Arc::new(rows);
    let board: BoardFn = Arc::new(move |_d: String| {
        let rows = rows();
        Box::pin(async move { Ok(Some(BoardSnap { rows, now_ts: *NOW })) })
    });
    let s = PushAlerts::new(file.clone(), status_send(sent.clone(), status), board).load();
    Store { s, sent, file }
}

fn cleanup(file: &std::path::Path) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn validates_what_a_browser_sends() {
    let v = |over: Value| serde_json::to_value(alert(over)).unwrap();
    assert!(is_alert_input(&v(json!({})), *NOW));
    assert!(!is_alert_input(&v(json!({ "leadMin": 4 })), *NOW));
    assert!(!is_alert_input(&v(json!({ "until": *NOW - 1.0 })), *NOW));
    assert!(!is_alert_input(&v(json!({ "until": *NOW + 25.0 * 3600.0 })), *NOW));
    assert!(!is_alert_input(&v(json!({ "designator": "../x" })), *NOW));
    assert!(!is_alert_input(&v(json!({ "dest": "x".repeat(121) })), *NOW));
}

#[tokio::test(start_paused = true)]
async fn caps_one_browser_at_6_alerts_re_adding_the_same_key_replaces_it() {
    let Store { s, file, .. } = store(Vec::new, 201);
    for i in 0..6 {
        assert!(s.add(&sub(1), &alert(json!({ "key": format!("k{i}") }))));
    }
    assert!(!s.add(&sub(1), &alert(json!({ "key": "k6" }))));
    assert!(s.add(&sub(1), &alert(json!({ "key": "k0", "leadMin": 10 }))));
    assert_eq!(s.size(), 6);
    s.remove(&sub(1).endpoint, "k0");
    assert_eq!(s.size(), 5);
    s.stop();
    cleanup(&file);
}

#[tokio::test(start_paused = true)]
async fn waits_fires_once_inside_the_lead_then_forgets_the_alert() {
    let eta = Arc::new(Mutex::new(*NOW + 600.0));
    let e = eta.clone();
    let Store { s, sent, file } = store(move || vec![row(json!({ "eta_ts": *e.lock().unwrap() }))], 201);
    s.add(&sub(1), &alert(json!({})));
    s.tick().await;
    assert_eq!(sent.lock().unwrap().len(), 0);
    *eta.lock().unwrap() = *NOW + 240.0;
    s.tick().await;
    s.tick().await;
    let got: Vec<(Value, Value)> = sent
        .lock()
        .unwrap()
        .iter()
        .map(|(_, m)| (m["title"].clone(), m["tag"].clone()))
        .collect();
    assert_eq!(got, vec![(json!("120 za 4 min"), json!("kb:e1#4"))]);
    assert_eq!(s.size(), 0);
    s.stop();
    cleanup(&file);
}

#[tokio::test(start_paused = true)]
async fn a_gone_subscription_410_is_dropped_with_all_its_alerts() {
    let Store { s, file, .. } = store(|| vec![row(json!({ "canceled": true }))], 410);
    s.add(&sub(1), &alert(json!({})));
    s.add(&sub(1), &alert(json!({ "key": "other" })));
    s.tick().await;
    tokio::task::yield_now().await;
    assert_eq!(s.size(), 0);
    s.stop();
    cleanup(&file);
}

#[tokio::test(start_paused = true)]
async fn persists_across_a_restart_dropping_what_no_longer_validates() {
    let Store { s, file, .. } = store(Vec::new, 201);
    let real = PushSub {
        endpoint: "https://fcm.googleapis.com/fcm/send/1".into(),
        keys: PushKeys {
            p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4".into(),
            auth: "BTBZMqHH6r4Tts7J_aSIgg".into(),
        },
    };
    s.add(&real, &alert(json!({})));
    s.add(&sub(2), &alert(json!({})));
    tokio::time::sleep(Duration::from_millis(2100)).await;
    s.stop();
    let board: BoardFn = Arc::new(|_d: String| Box::pin(async { Ok(None) }));
    let again = PushAlerts::new(file.clone(), status_send(Arc::default(), 201), board).load();
    // sub(2) carries keys that are not a P-256 point
    assert_eq!(again.size(), 1);
    again.stop();
    cleanup(&file);
}

#[tokio::test(start_paused = true)]
async fn restores_a_node_written_file_holding_a_lone_surrogate_escape() {
    // JSON.parse takes "\ud800" (JSON.stringify wrote it from a client's key), so Node restores every entry
    let file = temp_file();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let sub = |n: u32| {
        format!(
            r#"{{"endpoint":"https://fcm.googleapis.com/fcm/send/{n}","keys":{{"p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","auth":"BTBZMqHH6r4Tts7J_aSIgg"}}}}"#
        )
    };
    let alert = |key: &str| {
        format!(
            r#"{{"key":"{key}","designator":"123","stopName":"S","line":"120","dest":"D","leadMin":5,"until":{}}}"#,
            *NOW + 1800.0
        )
    };
    let text = format!(
        r#"[{{"sub":{},"alerts":[{},{}]}},{{"sub":{},"alerts":[{}]}}]"#,
        sub(1),
        alert(r"\ud800"),
        alert(r"a\\ud800\udc00\ud83d\ude00"),
        sub(2),
        alert("ok"),
    );
    std::fs::write(&file, text).unwrap();
    let board: BoardFn = Arc::new(|_d: String| Box::pin(async { Ok(None) }));
    let s = PushAlerts::new(file.clone(), status_send(Arc::default(), 201), board).load();
    assert_eq!(s.size(), 3);
    s.stop();
    cleanup(&file);
}
