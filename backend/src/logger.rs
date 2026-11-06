//! lib/logger.ts: `<ISO time> <LEVEL> [tag] message`, info to stdout, warn and error to stderr.
//! Minimum level from KB_LOG_LEVEL=info|warn|error (default info).

use std::fmt::Display;
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, PartialOrd)]
enum Level {
    Info,
    Warn,
    Error,
}

fn min_level() -> Level {
    static MIN: OnceLock<Level> = OnceLock::new();
    *MIN.get_or_init(|| {
        match std::env::var("KB_LOG_LEVEL")
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "warn" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    })
}

fn emit(level: Level, tag: &str, msg: impl Display) {
    if level < min_level() {
        return;
    }
    let name = match level {
        Level::Info => "INFO",
        Level::Warn => "WARN",
        Level::Error => "ERROR",
    };
    let line = format!("{:.3} {name:<5} [{tag}] {msg}", jiff::Timestamp::now());
    if level == Level::Info {
        println!("{line}");
    } else {
        eprintln!("{line}");
    }
}

pub fn info(tag: &str, msg: impl Display) {
    emit(Level::Info, tag, msg);
}

pub fn warn(tag: &str, msg: impl Display) {
    emit(Level::Warn, tag, msg);
}

pub fn error(tag: &str, msg: impl Display) {
    emit(Level::Error, tag, msg);
}
