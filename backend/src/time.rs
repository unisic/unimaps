//! The agency's wall clock: the `Intl.DateTimeFormat` helpers with `timeZone: AGENCY_TIMEZONE` in lib/config.ts
//! (todayLocalISO), lib/poller.ts (nowSecs) and lib/gzm-feed.ts (warsawClock, serviceDayBase).

use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

/// `KB_AGENCY_TIMEZONE` (default Europe/Warsaw). The system's database first, the bundled copy when the image has
/// none; an unknown name falls back to the system zone like the TS `catch` (UTC in a container), loudly.
pub static AGENCY_TZ: LazyLock<TimeZone> = LazyLock::new(|| {
    let name = crate::config::AGENCY_TIMEZONE.as_str();
    TimeZone::get(name).unwrap_or_else(|e| {
        crate::logger::warn(
            "time",
            format!("KB_AGENCY_TIMEZONE {name:?}: {e}; using the system zone"),
        );
        TimeZone::system()
    })
});

/// Agency-local date and seconds since its midnight at an instant (`warsawClock`).
pub fn agency_clock(ts: Timestamp) -> (Date, i32) {
    let dt = AGENCY_TZ.to_datetime(ts);
    (
        dt.date(),
        i32::from(dt.hour()) * 3600 + i32::from(dt.minute()) * 60 + i32::from(dt.second()),
    )
}

/// Seconds since the agency's midnight now (`nowSecs`).
pub fn now_secs() -> i32 {
    agency_clock(Timestamp::now()).1
}

/// The agency's date now (`todayLocalISO`; `Display` prints "YYYY-MM-DD").
pub fn today_local() -> Date {
    agency_clock(Timestamp::now()).0
}

/// Epoch secs of a service day's GTFS origin: noon minus 12 h, so DST days and 25:10:00 resolve per the spec
/// (`serviceDayBase`; its offset is the wall clock at noon UTC minus 12 h, i.e. the zone's offset then).
pub fn service_day_base(date: Date) -> i64 {
    let noon_utc = date
        .at(12, 0, 0, 0)
        .to_zoned(TimeZone::UTC)
        .expect("a civil noon is in range")
        .timestamp();
    noon_utc.as_second() - i64::from(AGENCY_TZ.to_offset(noon_utc).seconds()) - 43_200
}

#[cfg(test)]
mod tests {
    use super::*;

    // pinned against Node: `new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", ... })` and the TS
    // serviceDayBase on the same inputs
    #[test]
    fn warsaw_clock_and_service_day_base_match_the_ts() {
        let ts = |s: i64| Timestamp::from_second(s).unwrap();
        assert_eq!(agency_clock(ts(1_790_000_000)), ("2026-09-21".parse().unwrap(), 58_400));
        assert_eq!(agency_clock(ts(1_793_570_400)), ("2026-11-01".parse().unwrap(), 82_800));
        for (date, want) in [
            ("2026-03-29", 1_774_735_200),
            ("2026-10-25", 1_792_882_800),
            ("2026-11-06", 1_793_919_600),
            ("2026-03-30", 1_774_821_600),
        ] {
            assert_eq!(service_day_base(date.parse().unwrap()), want, "{date}");
        }
    }
}
