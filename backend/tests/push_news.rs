//! test/push-news.test.ts: "Powiadamiaj o utrudnieniach" over fake send and list fns.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use unimaps::announcements::{AnnouncementItem, Announcements};
use unimaps::push_news::{City, ListFn, PushNews};
use unimaps::web_push::{PushKeys, PushSub, SendFn};

// real P-256 keys (the RFC 8291 test vector): parse_push_sub drops anything else on reload
fn sub(n: u32) -> PushSub {
    PushSub {
        endpoint: format!("https://fcm.googleapis.com/fcm/send/{n}"),
        keys: PushKeys {
            p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4".into(),
            auth: "BTBZMqHH6r4Tts7J_aSIgg".into(),
        },
    }
}

fn item(id: u32, rev: u32, operator: &str) -> AnnouncementItem {
    let Value::Object(m) = json!({
        "id": id,
        "rev": rev,
        "operator": operator,
        "content_markdown": format!("**[{operator}] Objazd {id}**\n\ntreść"),
    }) else {
        return Map::new();
    };
    m
}

type Items = Arc<Mutex<Vec<AnnouncementItem>>>;
type Sent = Arc<Mutex<Vec<(String, Value)>>>;

fn temp_file(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!("unimaps-push-news-{}-{name}", std::process::id()))
        .join("news.json")
}

fn send(sent: Sent, status: u16) -> SendFn {
    Arc::new(move |to: PushSub, msg: Value, _ttl: f64| {
        sent.lock().unwrap().push((to.endpoint, msg));
        Box::pin(async move { Ok(status) })
    })
}

fn list(lists: Vec<(City, Items)>) -> ListFn {
    Arc::new(move |city: City| {
        let items = lists
            .iter()
            .find(|(c, _)| *c == city)
            .map(|(_, l)| l.lock().unwrap().clone())
            .unwrap_or_default();
        let hash = items
            .iter()
            .map(|a| format!("{}:{}", a["id"], a["rev"]))
            .collect::<Vec<_>>()
            .join("|");
        Box::pin(async move {
            Ok(Announcements {
                announcements: items,
                hash,
            })
        })
    })
}

fn cleanup(file: &std::path::Path) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tokio::test(start_paused = true)]
async fn records_the_first_list_silently_then_pushes_only_what_is_new_per_city() {
    let bb: Items = Arc::new(Mutex::new(vec![item(1, 1, "KB"), item(2, 1, "KB")]));
    let gzm: Items = Arc::new(Mutex::new(vec![item(7, 1, "GZM")]));
    let lists = vec![(City::Bb, bb.clone()), (City::Gzm, gzm.clone())];
    let file = temp_file("first");
    let sent: Sent = Arc::default();
    let s = PushNews::new(file.clone(), send(sent.clone(), 201), list(lists.clone())).load();
    assert!(s.add(&sub(1), City::Bb));
    assert!(s.add(&sub(2), City::Gzm));
    assert!(s.add(&sub(2), City::Bb));
    assert_eq!(s.size(), 2);
    s.tick().await;
    assert_eq!(sent.lock().unwrap().len(), 0);
    bb.lock().unwrap().extend([item(3, 1, "KB"), item(4, 1, "KB")]);
    s.tick().await;
    let got: Vec<Vec<Value>> = sent
        .lock()
        .unwrap()
        .iter()
        .map(|(endpoint, m)| {
            let last = endpoint.get(endpoint.len() - 1..).unwrap_or("");
            vec![json!(last), m["body"].clone(), m["tag"].clone(), m["url"].clone()]
        })
        .collect();
    assert_eq!(
        got,
        vec![
            vec![json!("1"), json!("[KB] Objazd 3 (+1)"), json!("news:bb"), json!("/")],
            vec![json!("2"), json!("[KB] Objazd 3 (+1)"), json!("news:bb"), json!("/")],
        ]
    );
    s.tick().await;
    assert_eq!(sent.lock().unwrap().len(), 2);
    // an edit = a new rev = a notification again
    for a in bb.lock().unwrap().iter_mut().filter(|a| a["id"] == 1) {
        a.insert("rev".into(), json!(2));
    }
    s.tick().await;
    assert_eq!(sent.lock().unwrap().len(), 4);
    // persisted and reloaded: nothing is "new" again
    tokio::time::sleep(Duration::from_millis(2100)).await;
    s.stop();
    let again = PushNews::new(file.clone(), send(sent.clone(), 201), list(lists)).load();
    assert_eq!(again.size(), 2);
    let before = sent.lock().unwrap().len();
    again.tick().await;
    assert_eq!(sent.lock().unwrap().len(), before);
    again.stop();
    cleanup(&file);
}

#[tokio::test(start_paused = true)]
async fn drops_a_subscription_the_push_service_reports_gone_removing_the_last_city_removes_it() {
    let bb: Items = Arc::new(Mutex::new(vec![item(1, 1, "KB")]));
    let file = temp_file("gone");
    let sent: Sent = Arc::default();
    let s = PushNews::new(
        file.clone(),
        send(sent.clone(), 410),
        list(vec![(City::Bb, bb.clone())]),
    )
    .load();
    s.add(&sub(1), City::Bb);
    s.add(&sub(2), City::Bb);
    s.add(&sub(2), City::Gzm);
    s.tick().await;
    *bb.lock().unwrap() = vec![item(1, 1, "KB"), item(2, 1, "KB")];
    s.tick().await;
    assert_eq!(sent.lock().unwrap().len(), 2);
    assert_eq!(s.size(), 0);
    s.add(&sub(3), City::Bb);
    s.add(&sub(3), City::Gzm);
    s.remove(&sub(3).endpoint, City::Bb);
    assert_eq!(s.size(), 1);
    s.remove(&sub(3).endpoint, City::Gzm);
    assert_eq!(s.size(), 0);
    s.stop();
    cleanup(&file);
}

#[tokio::test(start_paused = true)]
async fn restores_a_node_written_file_holding_a_lone_surrogate_escape() {
    // TS stores the raw subscription whole, so an extra field can carry "\udc00", which JSON.parse takes
    let file = temp_file("surrogate");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let raw = |n: u32, extra: &str| {
        let mut v = serde_json::to_value(sub(n)).unwrap().to_string();
        v.insert_str(1, extra);
        v
    };
    let text = format!(
        r#"{{"subs":[{{"sub":{},"cities":["bb"]}},{{"sub":{},"cities":["gzm"]}}],"seen":{{"bb":["KB:1:1"],"gzm":[]}}}}"#,
        raw(1, r#""junk":"\udc00","#),
        raw(2, ""),
    );
    std::fs::write(&file, text).unwrap();
    let s = PushNews::new(file.clone(), send(Arc::default(), 201), list(Vec::new())).load();
    assert_eq!(s.size(), 2);
    s.stop();
    cleanup(&file);
}
