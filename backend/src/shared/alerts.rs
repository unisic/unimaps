//! "Powiadom mnie" rules of lib/shared/alerts.ts: the page watcher and the server's web push take one decision and
//! show one message, so the two never disagree about a departure.

use serde::{Deserialize, Serialize};

use super::departures::{BoardRow, minutes_until, resolve};
use crate::js::{encode_uri_component, number_to_string};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// rowKey of the departure: stable across refetches
    pub key: String,
    pub designator: String,
    pub stop_name: String,
    pub line: String,
    pub dest: String,
    pub lead_min: f64,
    /// epoch s after which the alert is dropped unfired (plan + 30 min)
    pub until: f64,
}

pub const ALERT_LEADS: [f64; 3] = [3.0, 5.0, 10.0];
/// per city: both cities share one stored list
pub const MAX_ALERTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AlertAction {
    Wait,
    Cancelled,
    Expired,
    Fire { mins: f64 },
}

/// `alertAction`: what one board refresh means for an alert, on the board's own ETA (no vehicle).
pub fn alert_action<R: BoardRow>(a: &Alert, rows: &[R], now_ts: f64) -> AlertAction {
    if now_ts > a.until {
        return AlertAction::Expired;
    }
    // not on the board (truncated, or gone): keep waiting until `until`
    let Some(row) = rows.iter().map(BoardRow::timing_row).find(|r| r.row_key == a.key) else {
        return AlertAction::Wait;
    };
    let t = resolve(&row);
    if t.canceled {
        return AlertAction::Cancelled;
    }
    let mins = minutes_until(&t, now_ts);
    // set with less time left than the lead: fires on the first board, with the real minutes
    if mins <= a.lead_min {
        AlertAction::Fire { mins }
    } else {
        AlertAction::Wait
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertMessage {
    pub title: String,
    pub body: String,
    pub tag: String,
    pub url: String,
}

/// `alertMessage`: the notification an action shows; None while waiting or expired.
pub fn alert_message(a: &Alert, r: AlertAction) -> Option<AlertMessage> {
    let title = match r {
        AlertAction::Fire { mins } if mins > 0.0 => format!("{} za {} min", a.line, number_to_string(mins)),
        AlertAction::Fire { .. } => format!("{} odjeżdża", a.line),
        AlertAction::Cancelled => format!("{}: kurs odwołany", a.line),
        AlertAction::Wait | AlertAction::Expired => return None,
    };
    Some(AlertMessage {
        title,
        body: format!("{}, przystanek {}", a.dest, a.stop_name),
        tag: a.key.clone(),
        url: format!("/?stop={}", encode_uri_component(&a.designator)),
    })
}
