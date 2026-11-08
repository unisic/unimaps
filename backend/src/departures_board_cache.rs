//! lib/departures-board-cache.ts: N viewers of one stop cost one upstream call per 4 s; only complete boards are
//! cached.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::micro_cache::MicroCache;

/// An upstream leg of a board.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardLeg {
    Kb,
    Mzk,
}

/// One built departures board (rows are already normalised/pre-sorted, see lib/shared/departures).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Board {
    pub rows: Vec<Map<String, Value>>,
    /// upstream legs that failed
    pub failed: Vec<BoardLeg>,
    /// how many upstream fetches failed (a hub's MZK symbols count one each)
    pub failed_legs: usize,
    /// how many upstream fetches were made (KB + one per MZK symbol)
    pub legs: usize,
}

/// The TS `departuresBoardCache` (ttl 4 s, the micro cache's default max of 500 boards).
pub static DEPARTURES_BOARD_CACHE: LazyLock<MicroCache<Arc<Board>, String>> =
    LazyLock::new(|| MicroCache::new(Duration::from_millis(4000), 500, |b| b.failed.is_empty()));
