//! The live half of the tracker (lib/fleet-tracker.ts updateFromRunningVehicles .. sampleTimeline): running
//! vehicles in, courses archived, stats and "where next" recomputed.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{
    CourseOutcomeInput, DEFAULT_LAYOVER_MIN, FleetRunningInput, FleetTracker, HALF_DAY_SEC, MAX_LAYOVER_SEC,
    MIN_LAYOVER_SEC, TrackerState, course_driven_meters, date_to_agency_secs, day_secs, determine_course_outcome,
    finite_non_neg, secs_to_hhmm, sort_courses_desc, stops_length_meters, today_key,
};
use crate::fleet_history::{CourseEnd, course_chain, day_kind, history_reason};
use crate::gzm::GzmNextTrip;
use crate::js::{self, JsNum};
use crate::mzk_state::is_mzk_not_started;
use crate::shared::fleet::{
    CourseStatus, CourseStopStatus, DelayClass, FleetCurrentCourse, FleetOperator, FleetTimelinePoint,
    FleetVehicleDetail, FleetVehicleStats, LastKnownLocation, PredictedLaterCourse, PredictedNextCourse,
    PredictionConfidence, PredictionSource, TIMELINE_SLOT_SECS, VehicleCourseRecord, VehicleCourseStop, VehicleStatus,
    classify_delay, fold_text, is_on_time, median,
};

impl FleetTracker {
    /// One poll of the running fleet. `static_vehs` = OnTime's getVehicles.json records by side number (MZK),
    /// `stops_by_symbol` = stop (lat, lon) by symbol, read for the "course not begun" test of MZK records.
    pub fn update_from_running_vehicles(
        &self,
        running: &[FleetRunningInput],
        static_vehs: Option<&HashMap<String, Value>>,
        stops_by_symbol: Option<&HashMap<String, (f64, f64)>>,
    ) {
        self.lock()
            .update_from_running_vehicles(running, static_vehs, stops_by_symbol);
    }
}

/// `v.direction || v.optionalDirection || fallback`
fn direction_or(v: &FleetRunningInput, fallback: &str) -> String {
    [Some(v.direction.as_str()), v.optional_direction.as_deref()]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn rank(c: PredictionConfidence) -> u8 {
    match c {
        PredictionConfidence::High => 2,
        PredictionConfidence::Medium => 1,
        PredictionConfidence::Low => 0,
    }
}

fn round_i(x: f64) -> i64 {
    js::round(x) as i64
}

impl TrackerState {
    fn update_from_running_vehicles(
        &mut self,
        running: &[FleetRunningInput],
        static_vehs: Option<&HashMap<String, Value>>,
        stops_by_symbol: Option<&HashMap<String, (f64, f64)>>,
    ) {
        let today = today_key(self.now_ms());
        if today != self.current_day {
            self.roll_over(&today);
        }

        let now_epoch = self.now_ms().div_euclid(1000);
        self.updated_at = now_epoch;
        self.version += 1;
        let archive_stops = self.opts.archive_stops;
        let mut active_sides: HashSet<&str> = HashSet::new();

        for v in running {
            if v.vehicle_id.is_empty() || v.line_name.is_empty() {
                continue;
            }
            let side = v.vehicle_id.as_str();
            // OnTime occasionally lists one bus twice in a snapshot: the first record wins
            if !active_sides.insert(side) {
                continue;
            }

            let static_info = static_vehs.and_then(|m| m.get(side));
            if !self.vehicles.contains_key(side) {
                let detail = self.new_vehicle((self.opts.details)(v, static_info));
                self.vehicles.insert(side.to_owned(), detail);
                if static_info.is_some() {
                    self.live_features.insert(side.to_owned());
                }
            } else if static_info.is_some() && !self.live_features.contains(side) {
                // getVehicles.json knows this bus's real equipment (ticket machine, A/C): the static list only the model's
                let info = (self.opts.details)(v, static_info);
                if let Some(detail) = self.vehicles.get_mut(side) {
                    detail.features = info.features;
                    detail.fuel_type = info.fuel_type;
                }
                self.live_features.insert(side.to_owned());
            }
            let Some(detail) = self.vehicles.get_mut(side) else {
                continue;
            };
            update_vehicle(detail, v, stops_by_symbol, now_epoch, archive_stops);
            Self::recalculate_stats(detail);
            let next = self.predict_next_course(side, &v.next_trips);
            if let Some(detail) = self.vehicles.get_mut(side) {
                detail.predicted_next_course = next;
            }
        }

        // vehicles that left the running list: the course they ran is history now
        for (side, detail) in self.vehicles.iter_mut() {
            if active_sides.contains(side.as_str()) || detail.status != VehicleStatus::Active {
                continue;
            }
            detail.status = VehicleStatus::Depot;
            detail.predicted_next_course = None;
            if let Some(finished) = detail.current_course.take() {
                let archived = Self::archive_course(detail, &finished, now_epoch, false, archive_stops);
                let delay_mins = round_i(finished.delay_sec as f64 / 60.0);
                let line = &finished.line_name;
                let name = if finished.not_started == Some(true) {
                    format!(
                        "Linia {line} → {} (kurs nie został rozpoczęty)",
                        finished.last_stop_name
                    )
                } else if archived == Some(CourseStatus::Cancelled) {
                    let late = if delay_mins >= 5 {
                        format!(", opóźnienie {delay_mins} min")
                    } else {
                        String::new()
                    };
                    format!(
                        "Utrata sygnału GPS na przystanku {} (linia {line}{late})",
                        finished.current_stop_name
                    )
                } else {
                    format!("Ostatni kurs: linia {line} do {}", finished.last_stop_name)
                };
                detail.last_known_location = Some(LastKnownLocation {
                    lat: finished.lat,
                    lon: finished.lon,
                    name,
                });
            }
            Self::recalculate_stats(detail);
        }

        self.sample_timeline(self.now_ms());
        self.schedule_save();
    }

    /// Moves a course that left the live feed to the day's history (a course that never began is not history).
    /// Returns the archived record's status, None when nothing was archived.
    fn archive_course(
        detail: &mut FleetVehicleDetail,
        prev: &FleetCurrentCourse,
        now_epoch: i64,
        switched: bool,
        archive_stops: bool,
    ) -> Option<CourseStatus> {
        if prev.not_started == Some(true) {
            return None;
        }
        if detail.today_courses.iter().any(|c| c.course_loid == prev.course_loid) {
            return None;
        }
        let outcome = determine_course_outcome(&CourseOutcomeInput {
            current_stop_index: prev.current_stop_index,
            stops_count: prev.stops_count,
            delay_sec: prev.delay_sec,
            current_stop_name: &prev.current_stop_name,
            length_meters: prev.length_meters.map(|x| x.0),
            driven_meters: prev.driven_meters.map(|x| x.0),
            switched,
        });
        let completed = outcome.status == CourseStatus::Completed;
        let stops = if archive_stops {
            prev.stops.as_ref().map(|stops| {
                stops
                    .iter()
                    .enumerate()
                    .map(|(idx, s)| {
                        let idx = idx as i64;
                        let status = if completed || idx < prev.current_stop_index {
                            CourseStopStatus::Passed
                        } else if idx == prev.current_stop_index {
                            CourseStopStatus::Current
                        } else {
                            CourseStopStatus::Upcoming
                        };
                        VehicleCourseStop { status, ..s.clone() }
                    })
                    .collect()
            })
        } else {
            None
        };
        let record = VehicleCourseRecord {
            id: prev.id.clone(),
            course_loid: prev.course_loid,
            line_name: prev.line_name.clone(),
            direction: prev.direction.clone(),
            first_stop_name: prev.first_stop_name.clone(),
            last_stop_name: prev.last_stop_name.clone(),
            first_stop_symbol: prev.first_stop_symbol.clone(),
            last_stop_symbol: prev.last_stop_symbol.clone(),
            start_time: prev.start_time.clone(),
            end_time: prev.end_time.clone(),
            start_secs: prev.start_secs,
            end_secs: prev.end_secs,
            brigade: prev.brigade.clone().filter(|b| !b.is_empty()),
            delay_sec: prev.delay_sec,
            stops_count: prev.stops_count,
            status: outcome.status,
            cancelled_reason: outcome.cancelled_reason,
            cancelled_at_stop_name: outcome.cancelled_at_stop_name,
            completed_at: Some(now_epoch),
            length_meters: prev.length_meters,
            driven_meters: if completed {
                prev.length_meters
            } else {
                prev.driven_meters
            },
            stops,
        };
        detail.today_courses.push(record);
        detail.today_courses.sort_by(sort_courses_desc);
        Some(outcome.status)
    }

    /// "Where next" once the current course ends, and the courses after it. GZM: the brigade's scheduled trips,
    /// when the feed knows them. MZK publishes no duty rosters: the course this one was followed by on past days of
    /// the same kind (when today's timetable runs it), else the next timetable course from the terminus
    /// (fleet_history). Otherwise an ESTIMATE, labelled as such: the same line back after the layover this vehicle
    /// showed today (or a typical one), never earlier than a short turnaround after the expected (delayed) arrival.
    /// None for a course into the depot.
    pub(super) fn predict_next_course(
        &mut self,
        side: &str,
        next_trips: &[GzmNextTrip],
    ) -> Option<PredictedNextCourse> {
        let detail = self.vehicles.get(side)?;
        let cur = detail.current_course.as_ref()?;
        let expected_arrival = cur.end_secs
            + if cur.not_started == Some(true) {
                0
            } else {
                cur.delay_sec.max(0)
            };
        if let Some((n, rest)) = next_trips.split_first() {
            let departure_secs = day_secs(f64::from(n.dep));
            let mut pause = departure_secs - expected_arrival;
            if pause < -HALF_DAY_SEC {
                pause += 86_400;
            }
            let reason = match cur.brigade.as_deref().filter(|b| !b.is_empty()) {
                Some(b) => format!("Według rozkładu brygady {}/{b}.", cur.line_name),
                None => "Według rozkładu.".to_owned(),
            };
            let later = (!rest.is_empty()).then(|| {
                rest.iter()
                    .take(4)
                    .map(|t| PredictedLaterCourse {
                        line_name: t.line.clone(),
                        direction: t.headsign.clone(),
                        departure_time: secs_to_hhmm(day_secs(f64::from(t.dep)) as f64),
                        from_stop_name: t.first_stop_name.clone(),
                        confidence: PredictionConfidence::High,
                    })
                    .collect()
            });
            return Some(PredictedNextCourse {
                line_name: n.line.clone(),
                direction: n.headsign.clone(),
                departure_time: secs_to_hhmm(departure_secs as f64),
                departure_secs: JsNum(departure_secs as f64),
                from_stop_name: n.first_stop_name.clone(),
                from_stop_symbol: Some(n.first_stop_id.clone()),
                pause_minutes: round_i(pause as f64 / 60.0).max(0),
                confidence: PredictionConfidence::High,
                source: PredictionSource::Schedule,
                seen: None,
                reason,
                later,
            });
        }
        if cur.stops_count < 2 || cur.end_secs == 0 {
            return None;
        }
        if fold_text(&cur.last_stop_name).contains("zajezdnia") {
            return None;
        }

        let sched = self.opts.schedule.as_ref().and_then(|f| f(&self.current_day));
        if let Some(sched) = sched {
            let kind = day_kind(&self.current_day);
            let history = &mut self.history;
            let steps = course_chain(
                CourseEnd {
                    line: cur.line_name.clone(),
                    first_sym: cur.first_stop_symbol.clone(),
                    start: cur.start_secs as f64,
                    end: cur.end_secs as f64,
                    last_name: cur.last_stop_name.clone(),
                    arrival: expected_arrival as f64,
                },
                &sched,
                |key| history.successor(kind, key),
                5,
            );
            if let Some((first, rest)) = steps.split_first() {
                let c = &first.course;
                let reason = match first.seen {
                    Some(seen) => history_reason(seen, kind),
                    None if c.line == cur.line_name => format!(
                        "Najbliższy kurs linii {} z przystanku {} według rozkładu MZK (MZK nie publikuje obiegów brygad).",
                        c.line, c.first_name
                    ),
                    None => format!(
                        "Linia {} nie ma stąd kursu w ciągu 45 min; najbliżej z przystanku {} odjeżdża linia {}.",
                        cur.line_name, c.first_name, c.line
                    ),
                };
                // a step is no surer than the one it follows
                let mut conf = first.confidence;
                let later = (!rest.is_empty()).then(|| {
                    rest.iter()
                        .map(|st| {
                            if rank(st.confidence) < rank(conf) {
                                conf = st.confidence;
                            }
                            PredictedLaterCourse {
                                line_name: st.course.line.clone(),
                                direction: st.course.headsign.clone(),
                                departure_time: secs_to_hhmm(st.course.start),
                                from_stop_name: st.course.first_name.clone(),
                                confidence: conf,
                            }
                        })
                        .collect()
                });
                return Some(PredictedNextCourse {
                    line_name: c.line.clone(),
                    direction: c.headsign.clone(),
                    departure_time: secs_to_hhmm(c.start),
                    departure_secs: JsNum(c.start),
                    from_stop_name: c.first_name.clone(),
                    from_stop_symbol: Some(c.first_sym.clone()),
                    pause_minutes: round_i((c.start - expected_arrival as f64) / 60.0).max(0),
                    confidence: first.confidence,
                    source: first.source,
                    seen: first.seen,
                    reason,
                    later,
                });
            }
        }

        let mut chain: Vec<&VehicleCourseRecord> = detail
            .today_courses
            .iter()
            .filter(|c| c.status == CourseStatus::Completed)
            .collect();
        chain.sort_by_key(|c| c.start_secs);
        let gaps: Vec<i64> = chain
            .iter()
            .enumerate()
            .map(|(i, c)| chain.get(i + 1).map_or(cur.start_secs, |n| n.start_secs) - c.end_secs)
            .filter(|gap| (0..=MAX_LAYOVER_SEC).contains(gap))
            .collect();
        let layover_min = median(&gaps).map_or(DEFAULT_LAYOVER_MIN, |observed| round_i(observed / 60.0).clamp(3, 30));

        let shuttle = chain.last().is_some_and(|prev| {
            prev.line_name == cur.line_name
                && fold_text(&prev.last_stop_name) == fold_text(&cur.first_stop_name)
                && fold_text(&prev.first_stop_name) == fold_text(&cur.last_stop_name)
        });

        let departure_secs = (cur.end_secs + layover_min * 60).max(expected_arrival + MIN_LAYOVER_SEC);
        let reason = if shuttle {
            format!(
                "Pojazd kursuje dziś wahadłowo na linii {}, postój na pętli ok. {layover_min} min.",
                cur.line_name
            )
        } else if self.opts.operator == FleetOperator::Mzk {
            format!(
                "MZK nie publikuje obiegów brygad. Zakładamy powrót tą samą linią po ok. {layover_min} min postoju."
            )
        } else {
            format!(
                "Rozkład nie podaje kolejnego kursu tej brygady. Zakładamy powrót tą samą linią po ok. {layover_min} min postoju."
            )
        };
        Some(PredictedNextCourse {
            line_name: cur.line_name.clone(),
            direction: cur.first_stop_name.clone(),
            departure_time: secs_to_hhmm(departure_secs as f64),
            departure_secs: JsNum(departure_secs as f64),
            from_stop_name: cur.last_stop_name.clone(),
            from_stop_symbol: cur.last_stop_symbol.clone(),
            pause_minutes: round_i((departure_secs - expected_arrival) as f64 / 60.0),
            confidence: if shuttle {
                PredictionConfidence::Medium
            } else {
                PredictionConfidence::Low
            },
            source: PredictionSource::Estimate,
            seen: None,
            reason,
            later: None,
        })
    }

    /// Per-vehicle day figures, served lines and main line: all from observed courses.
    pub(super) fn recalculate_stats(veh: &mut FleetVehicleDetail) {
        let cur = veh.current_course.as_ref();
        let started = cur.filter(|c| c.not_started != Some(true));
        let mut completed = 0;
        let mut cancelled = 0;
        let mut meters = 0.0;
        let mut measured: Vec<i64> = Vec::new();
        for c in &veh.today_courses {
            meters += course_driven_meters(c);
            match c.status {
                CourseStatus::Completed => {
                    completed += 1;
                    measured.push(c.delay_sec);
                }
                CourseStatus::Cancelled => cancelled += 1,
                CourseStatus::InProgress => {}
            }
        }
        if let Some(s) = started {
            meters += s.driven_meters.map_or(0.0, |d| d.0);
            measured.push(s.delay_sec);
        }

        // lines in order of first service; the assigned (not yet begun) course counts as served
        let mut by_start: Vec<(&str, i64)> = veh
            .today_courses
            .iter()
            .map(|c| (c.line_name.as_str(), c.start_secs))
            .chain(cur.map(|c| (c.line_name.as_str(), c.start_secs)))
            .collect();
        by_start.sort_by_key(|&(_, start)| start);
        let mut lines: Vec<&str> = Vec::new();
        let mut counts: HashMap<&str, (i64, i64)> = HashMap::new();
        for (line, start) in by_start {
            let e = counts.entry(line).or_insert_with(|| {
                lines.push(line);
                (0, start)
            });
            *e = (e.0 + 1, start);
        }
        let mut main_line: Option<&str> = None;
        for &l in &lines {
            let better = main_line.is_none_or(|m| {
                let ((lc, ll), (mc, ml)) = (counts[l], counts[m]);
                lc > mc || (lc == mc && ll > ml)
            });
            if better {
                main_line = Some(l);
            }
        }
        let lines: Vec<String> = lines.into_iter().map(str::to_owned).collect();
        let main_line = main_line.map(str::to_owned);

        let n = measured.len();
        let on_time = measured.iter().filter(|&&d| is_on_time(d)).count();
        let sum: i64 = measured.iter().sum();
        let stats = FleetVehicleStats {
            total_courses_today: (veh.today_courses.len() + usize::from(started.is_some())) as i64,
            completed_courses_today: completed,
            cancelled_courses_today: cancelled,
            km_today: JsNum(js::round(meters / 100.0) / 10.0),
            measured_courses: n as i64,
            average_delay_secs: if n > 0 { round_i(sum as f64 / n as f64) } else { 0 },
            punctuality_pct: (n > 0).then(|| round_i(on_time as f64 / n as f64 * 100.0)),
        };
        veh.lines = lines;
        veh.main_line = main_line;
        veh.stats = stats;
    }

    /// The running fleet by punctuality class, kept as the last sample of each 5-minute slot.
    fn sample_timeline(&mut self, now_ms: i64) {
        let secs = date_to_agency_secs(now_ms as f64);
        let t = secs - secs % TIMELINE_SLOT_SECS;
        let mut point = FleetTimelinePoint {
            t,
            waiting: 0,
            early: 0,
            on_time: 0,
            late: 0,
            very_late: 0,
        };
        for v in self.vehicles.values() {
            let Some(cur) = v.current_course.as_ref().filter(|_| v.status == VehicleStatus::Active) else {
                continue;
            };
            if cur.not_started == Some(true) {
                point.waiting += 1;
                continue;
            }
            match classify_delay(cur.delay_sec) {
                DelayClass::Early => point.early += 1,
                DelayClass::OnTime => point.on_time += 1,
                DelayClass::Late => point.late += 1,
                DelayClass::VeryLate => point.very_late += 1,
            }
        }
        self.timeline.insert(t, point);
    }
}

/// One running record onto its vehicle: status, the live course (archiving the previous one on a switch) and the
/// last known location.
fn update_vehicle(
    detail: &mut FleetVehicleDetail,
    v: &FleetRunningInput,
    stops_by_symbol: Option<&HashMap<String, (f64, f64)>>,
    now_epoch: i64,
    archive_stops: bool,
) {
    detail.status = VehicleStatus::Active;
    detail.last_seen_at = now_epoch;

    let stop_points = &v.stop_points;
    let total_stops = stop_points.len();

    // course not begun: OnTime's delay / planned times are a placeholder (mzk_state)
    let not_started = v.not_started.unwrap_or_else(|| {
        let first = stop_points
            .first()
            .and_then(|sp| stops_by_symbol.and_then(|m| m.get(&sp.symbol)))
            .copied();
        is_mzk_not_started(&v.lifecycle, first)
    });

    // last stop served + the next one (the same reading the map uses, mzk_shape)
    let mut order = 0;
    let mut next_idx = (total_stops > 1).then_some(1);
    if total_stops > 0 && !not_started {
        order = v
            .served_idx
            .unwrap_or_else(|| v.next_idx.map_or(total_stops - 1, |n| n.saturating_sub(1)));
        next_idx = v.next_idx;
    }
    // the same reading as the map's at_stop (mzk-poller)
    let at_stop = not_started || v.on_stop_point;

    // GZM sends service-day seconds per stop: no time zone call per stop for ~1 350 vehicles
    let stop_secs = v.stop_secs.as_deref();
    let delay = if not_started {
        0
    } else {
        round_i(if v.delay_sec.is_nan() { 0.0 } else { v.delay_sec })
    };
    let sched_secs = |i: usize| -> i64 {
        match stop_secs {
            Some(s) => day_secs(s.get(i).copied().unwrap_or(0) as f64),
            None => date_to_agency_secs(stop_points[i].scheduled_departure),
        }
    };
    let planned_secs = |i: usize| -> i64 {
        if let Some(s) = stop_secs {
            return day_secs((s.get(i).copied().unwrap_or(0) + delay) as f64);
        }
        let sp = &stop_points[i];
        // no estimate yet (not begun) or none sent (null planned) -> the schedule, never "00:00"
        let none = sp.planned_departure == 0.0 || sp.planned_departure.is_nan();
        date_to_agency_secs(if not_started || none {
            sp.scheduled_departure
        } else {
            sp.planned_departure
        })
    };

    let mut first_stop_name = "Początek trasy".to_owned();
    let mut last_stop_name = direction_or(v, "Koniec trasy");
    let mut first_stop_symbol = None;
    let mut last_stop_symbol = None;
    let mut start_secs = 0;
    let mut end_secs = 0;
    if let (Some(first), Some(last)) = (stop_points.first(), stop_points.last()) {
        first_stop_name = first.name.clone();
        first_stop_symbol = Some(first.symbol.clone());
        start_secs = sched_secs(0);
        last_stop_name = last.name.clone();
        last_stop_symbol = Some(last.symbol.clone());
        end_secs = sched_secs(total_stops - 1);
    }

    let course_stops: Vec<VehicleCourseStop> = stop_points
        .iter()
        .enumerate()
        .map(|(idx, sp)| VehicleCourseStop {
            symbol: sp.symbol.clone(),
            name: sp.name.clone(),
            scheduled_time: secs_to_hhmm(sched_secs(idx) as f64),
            planned_time: secs_to_hhmm(planned_secs(idx) as f64),
            status: if idx < order {
                CourseStopStatus::Passed
            } else if idx == order {
                CourseStopStatus::Current
            } else {
                CourseStopStatus::Upcoming
            },
            distance_meters: finite_non_neg(Some(sp.distance)).map(JsNum),
        })
        .collect();

    // distance driven: OnTime's reachedMeters, kept between the last stop served and the next one
    let length_meters = stops_length_meters(Some(&course_stops), None);
    let mut driven_meters = 0.0;
    if !not_started && total_stops > 0 {
        let lo = stops_length_meters(Some(&course_stops), Some(order as i64));
        let hi = next_idx.map_or(length_meters, |n| {
            stops_length_meters(Some(&course_stops), Some(n as i64))
        });
        let reached = finite_non_neg(v.reached_meters);
        driven_meters = js::round(hi.min(lo.max(reached.unwrap_or(lo))));
    }
    let progress_pct = if length_meters > 0.0 {
        round_i(driven_meters / length_meters * 100.0).min(100)
    } else if total_stops > 1 {
        round_i(order as f64 / (total_stops - 1) as f64 * 100.0).min(100)
    } else {
        0
    };

    // the bus was archived during a temporary GPS dropout and is back on the same course: it stays live
    if let Some(i) = detail
        .today_courses
        .iter()
        .position(|c| c.course_loid == Some(v.course_loid))
    {
        detail.today_courses.remove(i);
    }

    if let Some(prev) = detail.current_course.take_if(|c| c.course_loid != Some(v.course_loid)) {
        TrackerState::archive_course(detail, &prev, now_epoch, true, archive_stops);
    }

    let direction = direction_or(v, &last_stop_name);
    detail.last_known_location = Some(LastKnownLocation {
        lat: JsNum(v.latitude),
        lon: JsNum(v.longitude),
        name: format!("Linia {} → {direction}", v.line_name),
    });
    detail.current_course = Some(FleetCurrentCourse {
        id: format!("c-{}", v.course_loid),
        course_loid: Some(v.course_loid),
        line_name: v.line_name.clone(),
        direction,
        first_stop_name,
        last_stop_name,
        first_stop_symbol,
        last_stop_symbol,
        start_time: secs_to_hhmm(start_secs as f64),
        end_time: secs_to_hhmm(end_secs as f64),
        start_secs,
        end_secs,
        brigade: v.brigade.clone().filter(|b| !b.is_empty()),
        delay_sec: delay,
        not_started: Some(not_started),
        at_stop: Some(at_stop),
        stops_count: total_stops as i64,
        current_stop_index: order as i64,
        current_stop_name: stop_points
            .get(order)
            .map_or_else(|| "W trasie".to_owned(), |s| s.name.clone()),
        next_stop_name: next_idx.and_then(|n| stop_points.get(n)).map(|s| s.name.clone()),
        lat: JsNum(v.latitude),
        lon: JsNum(v.longitude),
        bearing: v.angle.filter(|a| a.is_finite()).map(JsNum),
        fix_at: v
            .last_ping_date
            .filter(|&p| p != 0.0 && !p.is_nan())
            .map(|p| (p / 1000.0).floor() as i64),
        progress_pct,
        length_meters: Some(JsNum(length_meters)),
        driven_meters: Some(JsNum(driven_meters)),
        status: CourseStatus::InProgress,
        stops: Some(course_stops),
    });
}
