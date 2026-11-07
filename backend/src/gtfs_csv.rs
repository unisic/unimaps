//! lib/gtfs-csv.ts: CSV helpers of the GTFS readers. The built feed is plain RFC-4180 with CRLF line endings.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

/// Minimal RFC-4180 line parser (quoted fields with embedded commas and doubled quotes).
pub fn parse_csv_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == ',' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

/// Column index by header name.
pub fn col(header: &[String], name: &str) -> Option<usize> {
    header.iter().position(|h| h == name)
}

/// Splits on CR, LF or CRLF, so a trailing '\r' never sticks to the last column.
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(['\r', '\n']) {
        out.push(&rest[..i]);
        let skip = if rest[i..].starts_with("\r\n") { 2 } else { 1 };
        rest = &rest[i + skip..];
    }
    out.push(rest);
    out
}

/// A feed file as text (invalid UTF-8 replaced, like Node's readFileSync "utf-8"); None when it can't be read.
pub fn read_text(file: &Path) -> Option<String> {
    fs::read(file).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `f[i]` of a CSV row, None for a missing column or a short row (undefined in the TS).
pub fn field(f: &[String], i: Option<usize>) -> Option<&str> {
    f.get(i?).map(String::as_str)
}

/// One parsed table: the header and every non-empty row.
pub fn table(text: &str) -> (Vec<String>, Vec<Vec<String>>) {
    let lines = split_lines(text);
    let header = parse_csv_line(lines.first().copied().unwrap_or(""));
    let rows = lines
        .iter()
        .skip(1)
        .filter(|l| !l.is_empty())
        .map(|l| parse_csv_line(l))
        .collect();
    (header, rows)
}

/// A value read from the built feed on first use and kept until a rebuild drops it (lines, trips, stop directions).
pub struct FeedCache<T>(Mutex<Option<Arc<T>>>);

impl<T> FeedCache<T> {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// The cached value, read under the lock on a miss so concurrent first readers parse the feed once.
    pub fn get(&self, read: impl FnOnce() -> T) -> Arc<T> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        slot.get_or_insert_with(|| Arc::new(read())).clone()
    }

    pub fn invalidate(&self) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

impl<T> Default for FeedCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// stop_times pickup/drop-off bits, one byte per call (the router honours NO_PICKUP / NO_DROP_OFF).
pub const NO_PICKUP: u8 = 1;
pub const NO_DROP_OFF: u8 = 2;
pub const PICKUP_ON_REQUEST: u8 = 4;
pub const DROP_OFF_ON_REQUEST: u8 = 8;

/// GTFS pickup_type / drop_off_type -> bits ("1" none, "2"/"3" on request).
pub fn pickup_flags(pickup: Option<&str>, drop: Option<&str>) -> u8 {
    let mut f = 0;
    match pickup {
        Some("1") => f |= NO_PICKUP,
        Some("2" | "3") => f |= PICKUP_ON_REQUEST,
        _ => {}
    }
    match drop {
        Some("1") => f |= NO_DROP_OFF,
        Some("2" | "3") => f |= DROP_OFF_ON_REQUEST,
        _ => {}
    }
    f
}
