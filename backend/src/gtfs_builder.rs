//! lib/gtfs-builder.ts: the static GTFS feed of KB (the weekday, Saturday and Sunday services sampled from the
//! upstream timetables), built into `<out>.tmp` and swapped in, so a reader never sees a half-written feed.
//! Nothing runs at load: `build_gtfs` is called by the nightly refresh and the `unimaps build-gtfs` CLI.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{ErrorKind, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use indexmap::IndexMap;
use jiff::ToSpan;
use jiff::civil::Date;
use serde_json::Value;

use crate::config;
use crate::fleet_tracker::blocking_io;
use crate::gtfs_csv::{col, parse_csv_line, read_text, split_lines};
use crate::js;
use crate::kb_api::{KbSource, join_all, parse_int_strict_str, py_truthy};
use crate::logger;
use crate::merged_stops::is_station_name;
use crate::types::Stop;

/// calendar/feed_info validity from the build date; the feed is rebuilt daily, this only bounds a stalled rebuild
const FEED_VALID_DAYS: i64 = 30;
/// share of failed upstream fetches above which a build fails (and the old feed stays) instead of publishing
const MAX_FAILED_SHARE: f64 = 0.1;

/// `getServiceDates`: the day each service is sampled on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceDates {
    pub weekday_date: String,
    pub saturday_date: String,
    pub sunday_date: String,
}

/// `BuildGtfsOptions` minus `api` and `concurrency` (the caller builds the client:
/// `KbApi::new(HttpZb).with_concurrency(n)`).
#[derive(Debug, Clone)]
pub struct BuildGtfsOptions {
    /// YYYY-MM-DD reference date
    pub date: String,
    pub out_dir: PathBuf,
    /// also write kb_gtfs.zip
    pub zip: bool,
    /// the weekday, Saturday and Sunday services; false = one service for `date` alone
    pub full_schedule: bool,
}

impl Default for BuildGtfsOptions {
    /// today in the agency zone, config::GTFS_DIR, zip, full schedule (the TS defaults)
    fn default() -> Self {
        Self {
            date: crate::time::today_local().to_string(),
            out_dir: PathBuf::from(&*config::GTFS_DIR),
            zip: true,
            full_schedule: true,
        }
    }
}

/// `compact`: CR/LF as spaces, surrounding whitespace trimmed.
fn compact(s: &str) -> String {
    s.replace(['\r', '\n'], " ").trim_matches(js::is_space).to_owned()
}

/// `hhmmToSeconds`: "HH:MM" as seconds since midnight, 0 when unparseable (JS numbers throughout).
fn hhmm_to_seconds(hhmm: &str) -> f64 {
    let mut parts = hhmm.split(':');
    let (Some(h), Some(m)) = (parts.next(), parts.next()) else {
        return 0.0;
    };
    match (parse_int_strict_str(h), parse_int_strict_str(m)) {
        (Some(h), Some(m)) => h * 3600.0 + m * 60.0,
        _ => 0.0,
    }
}

/// `fmtTime`: "HH:MM" as "HH:MM:SS"; an unparseable but non-empty value passes through.
fn fmt_time(hhmm: &str) -> String {
    let secs = hhmm_to_seconds(hhmm);
    if secs <= 0.0 && !hhmm.is_empty() {
        return hhmm.to_owned();
    }
    let pad = |n: f64| format!("{:0>2}", js::number_to_string(n));
    let rem = secs % 3600.0;
    format!(
        "{}:{}:{}",
        pad((secs / 3600.0).floor()),
        pad((rem / 60.0).floor()),
        pad(rem % 60.0)
    )
}

/// RFC 4180 field escaping: quoted when the field holds , " CR or LF.
fn csv_field(s: &str) -> String {
    if s.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_owned()
    }
}

/// `writeCsv` as a text builder: LF line endings, every cell compacted (a no-op on the numbers and the toFixed
/// coordinates the TS leaves uncompacted) and escaped.
struct Csv(String);

impl Csv {
    fn new(header: &[&str]) -> Self {
        let mut c = Csv(String::new());
        c.0.push_str(&header.iter().map(|h| csv_field(h)).collect::<Vec<_>>().join(","));
        c.0.push('\n');
        c
    }

    fn row(&mut self, cells: &[&str]) {
        for (i, cell) in cells.iter().enumerate() {
            if i > 0 {
                self.0.push(',');
            }
            self.0.push_str(&csv_field(&compact(cell)));
        }
        self.0.push('\n');
    }

    fn write(self, dir: &Path, name: &str) -> std::io::Result<()> {
        let file = dir.join(name);
        fs::write(&file, self.0).map_err(|e| with_path(e, "write", &file))
    }
}

/// The `YYYY-MM-DD` check and calendar validation of `weekdayMonday0` (TS messages). Years below 100 fail as in
/// the TS, where `Date.UTC` maps them onto 1900-1999.
fn parse_date(date: &str) -> Result<Date, String> {
    let parts: Vec<&str> = date.split('-').collect();
    let (y, m, d) = match parts.as_slice() {
        [y, m, d]
            if y.len() == 4
                && m.len() == 2
                && d.len() == 2
                && date.bytes().all(|b| b.is_ascii_digit() || b == b'-') =>
        {
            (y.parse::<i16>(), m.parse::<i8>(), d.parse::<i8>())
        }
        _ => return Err(format!("invalid date: {date} (expected YYYY-MM-DD)")),
    };
    match (y, m, d) {
        (Ok(y), Ok(m), Ok(d)) if y >= 100 => Date::new(y, m, d).map_err(|_| format!("invalid date: {date}")),
        _ => Err(format!("invalid date: {date}")),
    }
}

/// `addDays` as "YYYY-MM-DD". ponytail: past 9999-12-31 this fails where the TS prints "+010000-..".
fn add_days(d: Date, days: i64) -> Result<String, String> {
    d.checked_add(days.days())
        .map(|x| x.to_string())
        .map_err(|e| format!("invalid date: {d} + {days} days: {e}"))
}

/// `getServiceDates`: the weekday service from `ref_date` (the next Monday on a weekend), the next Saturday and
/// Sunday (`ref_date` itself when it is one). Never a past day.
pub fn get_service_dates(ref_date: &str) -> Result<ServiceDates, String> {
    let d = parse_date(ref_date)?;
    // 0 = Sun, 1 = Mon, ..., 6 = Sat
    let dow = i64::from((d.weekday().to_monday_zero_offset() + 1) % 7);
    Ok(ServiceDates {
        weekday_date: add_days(
            d,
            match dow {
                6 => 2,
                0 => 1,
                _ => 0,
            },
        )?,
        saturday_date: add_days(d, (6 - dow + 7) % 7)?,
        sunday_date: add_days(d, (7 - dow) % 7)?,
    })
}

struct Service {
    id: String,
    date: String,
    /// monday..sunday
    days: [u8; 7],
}

struct RouteRow {
    short_name: String,
    long_name: String,
    route_type: u8,
}

struct TripRow {
    route_id: String,
    service_id: String,
    trip_id: String,
    raw_trip_id: String,
    headsign: String,
    short_name: String,
    shape_id: String,
}

struct StopTimeRow {
    trip_id: String,
    time: String,
    stop_id: String,
    seq: usize,
}

struct ShapeRow {
    shape_id: String,
    lat: String,
    lon: String,
    seq: usize,
}

/// Everything `writeGtfs` turns into files.
struct Feed<'a> {
    date: &'a str,
    stops: &'a [Stop],
    routes: IndexMap<String, RouteRow>,
    trips: Vec<TripRow>,
    stop_times: Vec<StopTimeRow>,
    shapes: Vec<ShapeRow>,
    services: Vec<Service>,
}

fn with_path(e: std::io::Error, op: &str, p: &Path) -> std::io::Error {
    std::io::Error::new(e.kind(), format!("{op} {}: {e}", p.display()))
}

/// `path.resolve`: absolute against the working directory, `.` and `..` folded, no trailing separator.
fn resolve(p: &Path) -> std::io::Result<PathBuf> {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()?.join(p)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    Ok(out)
}

fn sibling(dir: &Path, suffix: &str) -> PathBuf {
    let mut s = OsString::from(dir.as_os_str());
    s.push(suffix);
    PathBuf::from(s)
}

/// `fs.rmSync(p, { recursive: true, force: true })`
fn rm_rf(p: &Path) -> std::io::Result<()> {
    let r = match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
        Err(e) => Err(e),
    };
    match r {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        r => r.map_err(|e| with_path(e, "rm", p)),
    }
}

fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
        .map_err(|e| std::io::Error::new(e.kind(), format!("rename {} -> {}: {e}", from.display(), to.display())))
}

/// `buildGtfs` / `build`: fetch, write into `<out>.tmp`, move the old feed to `<out>.old`, rename the new one in.
/// A failure leaves the published feed untouched (or the finished temp build on disk when the last rename fails).
pub async fn build_gtfs<K: KbSource>(api: &K, opts: &BuildGtfsOptions) -> Result<(), String> {
    let date = opts.date.as_str();
    parse_date(date)?;
    let final_dir = resolve(&opts.out_dir).map_err(|e| e.to_string())?;
    let tmp = sibling(&final_dir, ".tmp");
    blocking_io(|| {
        rm_rf(&tmp)?;
        fs::create_dir_all(&tmp).map_err(|e| with_path(e, "mkdir", &tmp))
    })
    .map_err(|e| e.to_string())?;
    if let Err(e) = build_into(date, &tmp, api, opts.zip, opts.full_schedule).await {
        let _ = blocking_io(|| rm_rf(&tmp));
        return Err(e);
    }
    let old = sibling(&final_dir, ".old");
    blocking_io(|| {
        rm_rf(&old)?;
        if final_dir.exists() {
            rename(&final_dir, &old)?;
        }
        if let Err(e) = rename(&tmp, &final_dir) {
            if old.exists() {
                rename(&old, &final_dir)?;
            }
            logger::error(
                "gtfs",
                format_args!("publish failed; built feed left at {}", tmp.display()),
            );
            return Err(e);
        }
        rm_rf(&old)
    })
    .map_err(|e| e.to_string())?;
    logger::info("gtfs", format_args!("published feed to {}", final_dir.display()));
    Ok(())
}

async fn build_into<K: KbSource>(
    date: &str,
    out_dir: &Path,
    api: &K,
    do_zip: bool,
    full_schedule: bool,
) -> Result<(), String> {
    let rev = api.fetch_revision().await;
    logger::info("gtfs", format_args!("stops revision: {rev}"));
    let stops = api.fetch_stops(Some(&rev)).await?;
    logger::info("gtfs", format_args!("loaded {} stops", stops.len()));
    if stops.is_empty() {
        return Err("upstream returned no stops, keeping the old feed".into());
    }

    // a failed fetch counts as "no data" too: count the failures, so a build during an upstream outage or rate
    // limiting fails instead of publishing a partial feed
    let failed = AtomicUsize::new(0);
    let check_failures = |what: &str, total: usize| -> Result<(), String> {
        let n = failed.swap(0, Ordering::Relaxed);
        if n as f64 > total as f64 * MAX_FAILED_SHARE {
            return Err(format!("{n}/{total} {what} fetches failed, keeping the old feed"));
        }
        Ok(())
    };
    fn counted<R>(failed: &AtomicUsize, r: Result<R, String>) -> Option<R> {
        if r.is_err() {
            failed.fetch_add(1, Ordering::Relaxed);
        }
        r.ok()
    }

    let mut stop_by_url: HashMap<&str, &Stop> = HashMap::new();
    let mut stop_by_id: HashMap<i64, &Stop> = HashMap::new();
    for s in &stops {
        stop_by_url.insert(&s.url_id, s);
        stop_by_id.insert(s.internal_id, s);
    }

    let services = if full_schedule {
        let d = get_service_dates(date)?;
        vec![
            Service {
                id: "KB_WEEKDAY".into(),
                date: d.weekday_date,
                days: [1, 1, 1, 1, 1, 0, 0],
            },
            Service {
                id: "KB_SATURDAY".into(),
                date: d.saturday_date,
                days: [0, 0, 0, 0, 0, 1, 0],
            },
            Service {
                id: "KB_SUNDAY".into(),
                date: d.sunday_date,
                days: [0, 0, 0, 0, 0, 0, 1],
            },
        ]
    } else {
        let weekday = usize::try_from(parse_date(date)?.weekday().to_monday_zero_offset()).unwrap_or(0);
        let mut days = [0u8; 7];
        if let Some(d) = days.get_mut(weekday) {
            *d = 1;
        }
        vec![Service {
            id: format!("KB_{}", date.replace('-', "")),
            date: date.to_owned(),
            days,
        }]
    };

    // trip id -> indices into `services`, in discovery order (a Set in the TS; at most 3 entries)
    let mut trip_to_services: HashMap<String, Vec<usize>> = HashMap::new();
    for (si, svc) in services.iter().enumerate() {
        logger::info(
            "gtfs",
            format_args!("fetching timetables for {} ({}) ...", svc.id, svc.date),
        );
        let results = join_all(
            stops
                .iter()
                .map(|s| async { counted(&failed, api.fetch_timetable(&s.url_id, &svc.date).await) }),
        )
        .await;
        check_failures(&format!("{} timetable", svc.id), stops.len())?;
        for tt in results.iter().flatten() {
            if !py_truthy(Some(tt)) {
                continue;
            }
            let Some(departures) = tt.get("departures").and_then(Value::as_array) else {
                continue;
            };
            for tid in departures.iter().filter_map(|d| d.as_object()?.get("trip_id")) {
                if tid.is_null() {
                    continue;
                }
                let set = trip_to_services.entry(js::value_to_string(Some(tid))).or_default();
                if !set.contains(&si) {
                    set.push(si);
                }
            }
        }
    }
    logger::info(
        "gtfs",
        format_args!("discovered {} unique trips across all services", trip_to_services.len()),
    );

    logger::info("gtfs", "fetching trip details ...");
    let mut trip_ids: Vec<&String> = trip_to_services.keys().collect();
    // Array.prototype.sort: UTF-16 code unit order
    trip_ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    // ponytail: join_all re-polls every pending future on each wake, O(n) per wake (~5000 trips, mostly parked on
    // KbApi's 40-permit semaphore); swap in a FuturesOrdered-style waker per future if the build shows on a profile.
    let trip_results = join_all(
        trip_ids
            .iter()
            .map(|t| async { counted(&failed, api.fetch_trip(t, 0).await).flatten() }),
    )
    .await;
    check_failures("trip", trip_ids.len())?;

    let mut feed = Feed {
        date,
        stops: &stops,
        routes: IndexMap::new(),
        trips: Vec::new(),
        stop_times: Vec::new(),
        shapes: Vec::new(),
        services,
    };
    let mut seen_trips = std::collections::HashSet::new();
    for trip in trip_results.into_iter().flatten() {
        if !seen_trips.insert(trip.trip_id.clone()) {
            continue;
        }
        let mut ordered = trip.times.clone();
        ordered.sort_by_key(|t| t.index);
        if ordered.is_empty() {
            continue;
        }

        let route_id = format!(
            "L_{}",
            if trip.line_name.is_empty() {
                "X"
            } else {
                &trip.line_name
            }
        );
        match feed.routes.get_mut(&route_id) {
            None => {
                feed.routes.insert(
                    route_id.clone(),
                    RouteRow {
                        short_name: trip.line_name.clone(),
                        long_name: trip.direction.clone(),
                        route_type: config::route_type_for(trip.line_type.as_deref()),
                    },
                );
            }
            Some(r) if !trip.direction.is_empty() && r.long_name.is_empty() => r.long_name = trip.direction.clone(),
            Some(_) => {}
        }

        let shape_id = format!("shp_{}", trip.trip_id);
        for (seq, ts) in ordered.iter().enumerate() {
            let place = ts.place_id.as_deref().filter(|p| !p.is_empty());
            let stop_id = match ts.designator {
                Some(d) => d.to_string(),
                None => match place.and_then(|p| stop_by_url.get(p)) {
                    Some(s) => s.stop_id.clone(),
                    None => continue,
                },
            };
            let time = fmt_time(&ts.departure_time);
            feed.stop_times.push(StopTimeRow {
                trip_id: trip.trip_id.clone(),
                time,
                stop_id,
                seq,
            });
            let point = match ts.designator {
                Some(d) => stop_by_id.get(&d),
                None => place.and_then(|p| stop_by_url.get(p)),
            };
            if let Some(s) = point {
                feed.shapes.push(ShapeRow {
                    shape_id: shape_id.clone(),
                    lat: js::to_fixed(s.lat, 6),
                    lon: js::to_fixed(s.lon, 6),
                    seq,
                });
            }
        }

        let svc_list: Vec<usize> = match trip_to_services.get(&trip.trip_id) {
            Some(s) if !s.is_empty() => s.clone(),
            _ => vec![0],
        };
        for &si in &svc_list {
            let service_id = feed.services.get(si).map(|s| s.id.clone()).unwrap_or_default();
            feed.trips.push(TripRow {
                route_id: route_id.clone(),
                trip_id: if svc_list.len() > 1 {
                    format!("{}_{service_id}", trip.trip_id)
                } else {
                    trip.trip_id.clone()
                },
                service_id,
                raw_trip_id: trip.trip_id.clone(),
                headsign: compact(&trip.direction),
                short_name: if trip.show_name {
                    trip.line_name.clone()
                } else {
                    String::new()
                },
                shape_id: shape_id.clone(),
            });
        }
    }

    if feed.trips.is_empty() {
        return Err("no trips built, keeping the old feed".into());
    }

    // out_dir is build_gtfs's temp sibling, published by rename only after this returns
    let stop_times = blocking_io(|| {
        let n = write_gtfs(out_dir, &feed)?;
        if do_zip {
            write_zip(out_dir)?;
        }
        Ok::<_, std::io::Error>(n)
    })
    .map_err(|e| e.to_string())?;

    logger::info("gtfs", format_args!("wrote files to {}", out_dir.display()));
    logger::info(
        "gtfs",
        format_args!(
            "trips={} routes={} stop_times={stop_times} shapes={}",
            feed.trips.len(),
            feed.routes.len(),
            feed.shapes.len()
        ),
    );
    Ok(())
}

/// `writeGtfs`: the same files, column orders and values. Returns the stop_times row count.
fn write_gtfs(dir: &Path, f: &Feed) -> std::io::Result<usize> {
    let date_compact = f.date.replace('-', "");
    let end_date = add_days(parse_date(f.date).map_err(std::io::Error::other)?, FEED_VALID_DAYS)
        .map_err(std::io::Error::other)?
        .replace('-', "");

    let mut agency = Csv::new(&[
        "agency_id",
        "agency_name",
        "agency_url",
        "agency_timezone",
        "agency_lang",
    ]);
    agency.row(&[
        &*config::AGENCY_ID,
        &*config::AGENCY_NAME,
        &*config::AGENCY_URL,
        &*config::AGENCY_TIMEZONE,
        &*config::AGENCY_LANG,
    ]);
    agency.write(dir, "agency.txt")?;

    let mut stops = Csv::new(&[
        "stop_id",
        "stop_name",
        "stop_lat",
        "stop_lon",
        "stop_url",
        "location_type",
        "parent_station",
        "stop_timezone",
        "wheelchair_boarding",
    ]);
    for s in f.stops {
        let loc = if s.show_platforms || is_station_name(&s.name) {
            "1"
        } else {
            "0"
        };
        stops.row(&[
            &s.stop_id,
            &s.name,
            &js::to_fixed(s.lat, 6),
            &js::to_fixed(s.lon, 6),
            "",
            loc,
            "",
            "",
            "",
        ]);
    }
    stops.write(dir, "stops.txt")?;

    let mut routes = Csv::new(&[
        "route_id",
        "agency_id",
        "route_short_name",
        "route_long_name",
        "route_desc",
        "route_type",
        "route_url",
        "route_color",
        "route_text_color",
    ]);
    for (id, r) in &f.routes {
        let rt = r.route_type.to_string();
        routes.row(&[
            id,
            &*config::AGENCY_ID,
            &r.short_name,
            &r.long_name,
            "",
            &rt,
            "",
            "",
            "",
        ]);
    }
    routes.write(dir, "routes.txt")?;

    let mut trips = Csv::new(&[
        "route_id",
        "service_id",
        "trip_id",
        "trip_headsign",
        "trip_short_name",
        "direction_id",
        "block_id",
        "shape_id",
    ]);
    for t in &f.trips {
        trips.row(&[
            &t.route_id,
            &t.service_id,
            &t.trip_id,
            &t.headsign,
            &t.short_name,
            "",
            "",
            &t.shape_id,
        ]);
    }
    trips.write(dir, "trips.txt")?;

    // a trip in several services is written once per service under `<raw>_<service>`, and its rows under the raw
    // id stay too (the TS / Python output)
    let mut extra: HashMap<&str, Vec<&str>> = HashMap::new();
    for t in &f.trips {
        if !t.raw_trip_id.is_empty() && t.trip_id != t.raw_trip_id {
            extra.entry(&t.raw_trip_id).or_default().push(&t.trip_id);
        }
    }
    let mut stop_times = Csv::new(&[
        "trip_id",
        "arrival_time",
        "departure_time",
        "stop_id",
        "stop_sequence",
        "stop_headsign",
        "pickup_type",
        "drop_off_type",
        "shape_dist_traveled",
    ]);
    let mut n = 0;
    for st in &f.stop_times {
        let seq = st.seq.to_string();
        let ids =
            std::iter::once(st.trip_id.as_str()).chain(extra.get(st.trip_id.as_str()).into_iter().flatten().copied());
        for id in ids {
            stop_times.row(&[id, &st.time, &st.time, &st.stop_id, &seq, "", "", "", ""]);
            n += 1;
        }
    }
    stop_times.write(dir, "stop_times.txt")?;

    let mut calendar = Csv::new(&[
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
    ]);
    for s in &f.services {
        let mut cells = vec![s.id.clone()];
        cells.extend(s.days.iter().map(u8::to_string));
        cells.push(date_compact.clone());
        cells.push(end_date.clone());
        calendar.row(&cells.iter().map(String::as_str).collect::<Vec<_>>());
    }
    calendar.write(dir, "calendar.txt")?;

    let mut shapes = Csv::new(&[
        "shape_id",
        "shape_pt_lat",
        "shape_pt_lon",
        "shape_pt_sequence",
        "shape_dist_traveled",
    ]);
    for s in &f.shapes {
        shapes.row(&[&s.shape_id, &s.lat, &s.lon, &s.seq.to_string(), ""]);
    }
    shapes.write(dir, "shapes.txt")?;

    let mut info = Csv::new(&[
        "feed_publisher_name",
        "feed_publisher_url",
        "feed_lang",
        "feed_start_date",
        "feed_end_date",
        "feed_version",
    ]);
    info.row(&[
        &*config::AGENCY_NAME,
        &*config::AGENCY_URL,
        &*config::AGENCY_LANG,
        &date_compact,
        &end_date,
        &format!("KB-GTFS {}", f.date),
    ]);
    info.write(dir, "feed_info.txt")?;
    Ok(n)
}

/// kb_gtfs.zip of every .txt in `dir`, in readdir order (libuv sorts names bytewise), deflate level 6 as fflate.
fn write_zip(dir: &Path) -> std::io::Result<()> {
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".txt"))
        .collect();
    names.sort();
    let file = dir.join("kb_gtfs.zip");
    let mut w = zip::ZipWriter::new(fs::File::create(&file).map_err(|e| with_path(e, "create", &file))?);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(6));
    for n in &names {
        w.start_file(n.as_str(), opts).map_err(std::io::Error::other)?;
        w.write_all(&fs::read(dir.join(n))?)?;
    }
    w.finish().map_err(std::io::Error::other)?;
    Ok(())
}

/// `gtfsFeedDate`: the published feed's service date ("YYYY-MM-DD" from feed_info.txt's feed_start_date), None
/// when the feed is absent or unreadable.
pub fn gtfs_feed_date(dir: &Path) -> Option<String> {
    let text = read_text(&dir.join("feed_info.txt"))?;
    let lines = split_lines(&text);
    let header = parse_csv_line(lines.first()?);
    let i = col(&header, "feed_start_date")?;
    let row = lines.get(1).filter(|l| !l.is_empty())?;
    let v = parse_csv_line(row).into_iter().nth(i)?;
    (v.len() == 8 && v.bytes().all(|b| b.is_ascii_digit())).then(|| format!("{}-{}-{}", &v[..4], &v[4..6], &v[6..]))
}
