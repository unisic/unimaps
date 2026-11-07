//! What the routes read from the tracker (lib/fleet-tracker.ts getFleetSummary .. getStats): the fleet list, one
//! vehicle's card and past days, the punctuality timeline and the day's overview.

use std::cmp::Ordering;

use serde::Serialize;

use super::{FleetTracker, FleetVehicleInfo, TrackerState, compare_gzm_sides};
use crate::js::{self, JsNum};
use crate::shared::fleet::{
    FleetHistoryDay, FleetLengthCategory, FleetOperator, FleetStats, FleetSummaryItem, FleetTimelinePoint,
    FleetVehicleDetail, LastKnownLocation, VehicleStatus, compare_line_names, is_on_time, matches_fleet_query, median,
};

/// The optional filters of /api/fleet. An empty string filters nothing, like "all".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FleetSummaryFilter<'a> {
    /// None = all
    pub status: Option<VehicleStatus>,
    /// "electric" | "hydrogen" | "hybrid" | "mega"; any other value filters nothing
    pub propulsion: Option<&'a str>,
    pub line: Option<&'a str>,
    pub query: Option<&'a str>,
}

/// A vehicle's past days (today excluded), newest first; `complete` false while the day files are still being read.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FleetVehicleHistory {
    pub days: Vec<FleetHistoryDay>,
    pub complete: bool,
}

/// Where and when a vehicle the tracker never saw on a course was last seen (TS idleDetail `seen`).
#[derive(Debug, Clone, PartialEq)]
pub struct FleetSighting {
    /// epoch secs
    pub at: i64,
    pub lat: f64,
    pub lon: f64,
    pub name: String,
}

impl FleetTracker {
    /// The fleet list: running first (begun before waiting), then by line, then by side number.
    pub fn get_fleet_summary(&self, filter: &FleetSummaryFilter<'_>) -> Vec<FleetSummaryItem> {
        self.lock().fleet_summary(filter)
    }

    /// One vehicle's full card; a leading "#" and surrounding whitespace are ignored.
    pub fn get_vehicle_detail(&self, side_number: &str) -> Option<FleetVehicleDetail> {
        self.lock().vehicles.get(clean_side(side_number)).cloned()
    }

    pub fn vehicle_history(&self, side_number: &str) -> FleetVehicleHistory {
        let s = self.lock();
        FleetVehicleHistory {
            days: s.history.vehicle_days(clean_side(side_number)),
            complete: s.history.complete(),
        }
    }

    /// An idle card for a vehicle this tracker never saw on a course (GZM: on the map, off a trip). Not stored.
    pub fn idle_detail(&self, info: FleetVehicleInfo, seen: FleetSighting) -> FleetVehicleDetail {
        let mut v = self.lock().new_vehicle(info);
        v.last_seen_at = seen.at;
        v.last_known_location = Some(LastKnownLocation {
            lat: JsNum(seen.lat),
            lon: JsNum(seen.lon),
            name: seen.name,
        });
        v
    }

    /// Today's 5-minute punctuality snapshots of the running fleet, oldest first.
    pub fn get_timeline(&self) -> Vec<FleetTimelinePoint> {
        self.lock().timeline.values().copied().collect()
    }

    pub fn get_stats(&self) -> FleetStats {
        self.lock().stats()
    }

    /// `getVersion()`, `getFleetSummary()` and `getStats()` under one lock (the GZM list body): an update in between
    /// cannot mix two polls into one body.
    pub fn list_snapshot(&self) -> (u64, Vec<FleetSummaryItem>, FleetStats) {
        let s = self.lock();
        (s.version, s.fleet_summary(&FleetSummaryFilter::default()), s.stats())
    }
}

/// `side.replace(/^#/, "").trim()`
fn clean_side(side: &str) -> &str {
    side.strip_prefix('#').unwrap_or(side).trim_matches(js::is_space)
}

/// A filter value that filters: truthy and not "all".
fn active_filter(v: Option<&str>) -> Option<&str> {
    v.filter(|s| !s.is_empty() && *s != "all")
}

fn rank(x: &FleetSummaryItem) -> u8 {
    if x.status != VehicleStatus::Active {
        2
    } else if x.not_started == Some(true) {
        1
    } else {
        0
    }
}

/// `parseInt(a) - parseInt(b)` as the sort reads it: NaN compares equal.
fn compare_numeric_sides(a: &str, b: &str) -> Ordering {
    (js::parse_int(a) - js::parse_int(b))
        .partial_cmp(&0.0)
        .unwrap_or(Ordering::Equal)
}

/// Stable merge sort that never panics on an inconsistent comparator (std's sort may: the summary order compares
/// lines only when both rows have one, so a row without a line can close a cycle). Same order as V8's stable sort
/// whenever the comparator is consistent on the input.
fn stable_sort<T>(mut v: Vec<T>, cmp: &impl Fn(&T, &T) -> Ordering) -> Vec<T> {
    if v.len() <= 1 {
        return v;
    }
    let right = stable_sort(v.split_off(v.len() / 2), cmp);
    let left = stable_sort(v, cmp);
    let mut out = Vec::with_capacity(left.len() + right.len());
    let (mut l, mut r) = (left.into_iter().peekable(), right.into_iter().peekable());
    while let (Some(a), Some(b)) = (l.peek(), r.peek()) {
        let next = if cmp(b, a) == Ordering::Less {
            r.next()
        } else {
            l.next()
        };
        out.extend(next);
    }
    out.extend(l);
    out.extend(r);
    out
}

impl TrackerState {
    fn fleet_summary(&self, filter: &FleetSummaryFilter<'_>) -> Vec<FleetSummaryItem> {
        let propulsion = active_filter(filter.propulsion);
        let line = active_filter(filter.line);
        let query = filter.query.filter(|q| !q.is_empty());
        let mut list = Vec::new();
        for v in self.vehicles.values() {
            if filter.status.is_some_and(|s| s != v.status) {
                continue;
            }
            let f = &v.features;
            let skip = match propulsion {
                Some("electric") => f.electric != Some(true),
                Some("hydrogen") => f.hydrogen != Some(true),
                Some("hybrid") => f.hybrid != Some(true),
                Some("mega") => v.length_category != Some(FleetLengthCategory::Mega),
                _ => false,
            };
            if skip {
                continue;
            }
            let item = summarize(v);
            if let Some(l) = line
                && item.line_name.as_deref() != Some(l)
                && !item.lines.iter().any(|x| x == l)
            {
                continue;
            }
            if query.is_some_and(|q| !matches_fleet_query(&item, q)) {
                continue;
            }
            list.push(item);
        }
        let gzm = self.opts.operator == FleetOperator::Gzm;
        stable_sort(list, &|a: &FleetSummaryItem, b: &FleetSummaryItem| {
            let r = rank(a).cmp(&rank(b));
            if r != Ordering::Equal {
                return r;
            }
            if let (Some(la), Some(lb)) = (&a.line_name, &b.line_name)
                && !la.is_empty()
                && !lb.is_empty()
                && la != lb
            {
                return compare_line_names(la, lb);
            }
            if gzm {
                compare_gzm_sides(&a.side_number, &b.side_number)
            } else {
                compare_numeric_sides(&a.side_number, &b.side_number)
            }
        })
    }

    fn stats(&self) -> FleetStats {
        let (mut active, mut waiting, mut electric, mut hydrogen, mut hybrid, mut mega) = (0, 0, 0, 0, 0, 0);
        let (mut seen_today, mut completed, mut cancelled) = (0, 0, 0);
        let mut km = 0.0;
        let mut delays: Vec<i64> = Vec::new();
        let mut lines: Vec<&str> = Vec::new();
        for v in self.vehicles.values() {
            if v.status == VehicleStatus::Active {
                active += 1;
                if let Some(cur) = &v.current_course {
                    // waiting buses (course not begun) have no delay: out of the punctuality figures
                    if cur.not_started == Some(true) {
                        waiting += 1;
                    } else {
                        delays.push(cur.delay_sec);
                    }
                    if !cur.line_name.is_empty() && !lines.contains(&cur.line_name.as_str()) {
                        lines.push(&cur.line_name);
                    }
                }
            }
            if v.last_seen_at > 0 {
                seen_today += 1;
            }
            km += v.stats.km_today.0;
            completed += v.stats.completed_courses_today;
            cancelled += v.stats.cancelled_courses_today;
            let f = &v.features;
            electric += i64::from(f.electric == Some(true));
            hydrogen += i64::from(f.hydrogen == Some(true));
            hybrid += i64::from(f.hybrid == Some(true));
            mega += i64::from(v.length_category == Some(FleetLengthCategory::Mega));
        }
        lines.sort_by(|a, b| compare_line_names(a, b));
        let total = self.vehicles.len() as i64;
        let n = delays.len() as f64;
        let on_time = delays.iter().filter(|d| is_on_time(**d)).count() as f64;
        FleetStats {
            total_fleet: total,
            active_count: active,
            depot_count: total - active,
            waiting_count: waiting,
            measured_count: delays.len() as i64,
            electric_count: electric,
            hydrogen_count: hydrogen,
            hybrid_count: hybrid,
            mega_count: mega,
            average_delay_sec: if delays.is_empty() {
                0
            } else {
                js::round(delays.iter().sum::<i64>() as f64 / n) as i64
            },
            median_delay_sec: median(&delays).map(|m| js::round(m) as i64),
            on_time_percentage: if delays.is_empty() {
                100
            } else {
                js::round(on_time / n * 100.0) as i64
            },
            active_lines: lines.into_iter().map(str::to_owned).collect(),
            seen_today_count: seen_today,
            km_today: JsNum(js::round(km * 10.0) / 10.0),
            courses_completed_today: completed,
            courses_cancelled_today: cancelled,
            updated_at: self.updated_at,
        }
    }
}

fn summarize(v: &FleetVehicleDetail) -> FleetSummaryItem {
    let cur = v.current_course.as_ref();
    FleetSummaryItem {
        side_number: v.side_number.clone(),
        label: v.label.clone(),
        company: v.company.clone(),
        model: v.model.clone(),
        producer: v.producer.clone(),
        year: v.year.clone(),
        length_category: v.length_category,
        fuel_type: v.fuel_type,
        status: v.status,
        lines: v.lines.clone(),
        line_name: cur.map(|c| c.line_name.clone()),
        direction: cur.map(|c| c.direction.clone()),
        brigade: cur.and_then(|c| c.brigade.clone()).filter(|b| !b.is_empty()),
        start_time: cur.map(|c| c.start_time.clone()),
        first_stop_name: cur.map(|c| c.first_stop_name.clone()),
        current_stop_name: cur.map(|c| c.current_stop_name.clone()),
        next_stop_name: cur.and_then(|c| c.next_stop_name.clone()),
        at_stop: cur.and_then(|c| c.at_stop),
        delay_sec: cur.filter(|c| c.not_started != Some(true)).map(|c| c.delay_sec),
        not_started: cur.and_then(|c| c.not_started).filter(|&b| b),
        progress_pct: cur.map(|c| c.progress_pct),
        courses_count_today: v.stats.total_courses_today,
        cancelled_courses_today: v.stats.cancelled_courses_today,
        km_today: v.stats.km_today,
        last_seen_at: v.last_seen_at,
        last_line_name: if cur.is_some() {
            None
        } else {
            v.today_courses.first().map(|c| c.line_name.clone())
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_sort_keeps_ties_and_survives_a_cyclic_comparator() {
        let pairs = vec![(2, 'a'), (1, 'b'), (2, 'c'), (1, 'd'), (0, 'e')];
        let sorted = stable_sort(pairs, &|a: &(i32, char), b: &(i32, char)| a.0.cmp(&b.0));
        assert_eq!(sorted, vec![(0, 'e'), (1, 'b'), (1, 'd'), (2, 'a'), (2, 'c')]);
        // rock-paper-scissors: no total order exists; the sort must still return every element
        let rps = |a: &u8, b: &u8| match (a, b) {
            (0, 1) | (1, 2) | (2, 0) => Ordering::Less,
            (1, 0) | (2, 1) | (0, 2) => Ordering::Greater,
            _ => Ordering::Equal,
        };
        let out = stable_sort((0..60u8).map(|i| i % 3).collect(), &rps);
        assert_eq!(out.len(), 60);
        assert!((0..3u8).all(|k| out.iter().filter(|&&x| x == k).count() == 20));
    }
}
