//! lib/gzm.ts lines 359-427 and 692-931: `GzmLive`'s options, fields and constructor, and how one record (or a
//! timetable-placed metro train) becomes a [`Track`] (`track`, `scheduledTracks`, `scheduledTrack`,
//! `attachRouteInfo`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use indexmap::IndexMap;
use sha1::{Digest, Sha1};
use tokio::task::JoinHandle;

use super::parse::{
    AT_STOP_M, Fix, GzmFleetSource, GzmMatch, HttpZb, LAYOVER_GRACE_SEC, MATCH_SLACK_SEC, NOT_STARTED_M,
    SCHED_ROUTE_TYPE, STUCK_SEC, SchedAt, SdipSample, Track, ZbRecord, ZbTransport, fits, match_trip, off_route,
    schedule_position,
};
use crate::config;
use crate::geo::{bearing, meters_between};
use crate::gzm_feed::{GzmFeed, GzmStop, GzmTrip, get_gzm_feed};
use crate::js::{number, round, to_base64url};
use crate::kb_progress::step_arrivals;
use crate::route_info::{kb_ahead_m, kb_dist_along, next_speed, sched_speed};
use crate::router::ConnectionItinerary;
use crate::shared::polyline::{point_at, tangent_bearing};
use crate::vehicle::VehiclePos;

/// epoch ms
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type FeedFn = Arc<dyn Fn() -> Option<Arc<GzmFeed>> + Send + Sync>;
pub type FleetFn = Arc<dyn Fn(Vec<GzmFleetSource>) + Send + Sync>;

/// One feed's connection searches by query key (TS `connMemo`): (epoch ms, result), oldest first. A `Weak` so a
/// swapped-out feed is freed; a memo of another feed is cleared, not kept beside the new one.
#[derive(Default)]
pub(crate) struct ConnMemo {
    pub(crate) feed: Weak<GzmFeed>,
    pub(crate) map: IndexMap<String, (i64, Arc<Vec<ConnectionItinerary>>)>,
}

/// The feed's metro trips (route_type 1), picked once per feed (TS `sched`).
pub(crate) struct Sched {
    pub(crate) feed: Weak<GzmFeed>,
    pub(crate) trips: Vec<u32>,
}

/// Every mutable field of the TS class, behind `GzmLive::state`. Never held across an `.await`.
#[derive(Default)]
pub(crate) struct State {
    /// by record key, in the last apply's order (the `/api/vehicles` order); an SDIP update keeps a key's place
    pub(crate) tracks: IndexMap<String, Arc<Track>>,
    /// `<trip_id>|<date>` of the trip shown -> its vehicle
    pub(crate) by_trip: HashMap<String, Arc<Track>>,
    pub(crate) body: Arc<str>,
    pub(crate) scan_count: u64,
    /// epoch secs
    pub(crate) last_scan: f64,
    pub(crate) last_good: f64,
    pub(crate) failures: u64,
    pub(crate) last_error: Option<String>,
    pub(crate) poll_ms: i64,
    pub(crate) bytes: u64,
    pub(crate) sdip: IndexMap<String, SdipSample>,
    pub(crate) sdip_cookie: String,
    pub(crate) sdip_fails: u32,
    /// epoch ms
    pub(crate) sdip_paused_until: i64,
    pub(crate) sdip_bytes: u64,
    /// epoch secs
    pub(crate) sdip_last_good: f64,
    pub(crate) sdip_error: Option<String>,
    /// keys whose SDIP position changed in the last SDIP poll
    pub(crate) sdip_moved: u64,
    /// epoch ms of the last `touch`
    pub(crate) last_watch: i64,
    /// epoch ms the next zbiorkom / SDIP body should be ready: the next poll's start + the last one's duration
    pub(crate) zb_next_at: i64,
    pub(crate) sdip_next_at: i64,
    pub(crate) conn_memo: ConnMemo,
    pub(crate) sched: Option<Sched>,
    /// the poll loops while running (TS `abort`); stop aborts them
    pub(crate) tasks: Vec<JoinHandle<()>>,
}

/// The live layer of one zbiorkom city. Lives in an `Arc`; configure with the `with_*` setters before `start`.
pub struct GzmLive<T: ZbTransport = HttpZb> {
    pub slug: String,
    /// `<slug>:`
    pub(crate) prefix: String,
    pub(crate) transport: T,
    pub(crate) get_feed: FeedFn,
    pub(crate) now: NowFn,
    /// fixed positions URL; None = built from the feed's bbox once it loaded
    pub(crate) url: Option<String>,
    /// SDIP map page (the session comes from it); None disables the overlay
    pub(crate) sdip_url: Option<String>,
    /// receives the matched vehicles after every good zbiorkom poll (the /brygady tracker)
    pub(crate) fleet: Option<FleetFn>,
    /// epoch ms
    pub(crate) started_at: i64,
    pub(crate) state: Mutex<State>,
    /// held for a whole `connections` call: searches run one at a time, as on the TS event loop
    pub(crate) search: Mutex<()>,
}

impl<T: ZbTransport> GzmLive<T> {
    /// The TS defaults: GZM ("gzm") keeps its fixed positions URL and the SDIP overlay (unless `KB_GZM_SDIP=0`),
    /// another slug builds its URL from the feed's bbox and has no SDIP; the feed is `get_gzm_feed(slug)`.
    pub fn new(slug: &str, transport: T) -> Self {
        let gzm = slug == "gzm";
        let now: NowFn = Arc::new(|| jiff::Timestamp::now().as_millisecond());
        let feed_slug = slug.to_owned();
        Self {
            slug: slug.to_owned(),
            prefix: format!("{slug}:"),
            transport,
            get_feed: Arc::new(move || get_gzm_feed(&feed_slug)),
            started_at: now(),
            now,
            url: gzm.then(|| config::GZM_POSITIONS_URL.clone()),
            sdip_url: (gzm && *config::GZM_SDIP_ENABLED).then(|| config::GZM_SDIP_URL.clone()),
            fleet: None,
            state: Mutex::default(),
            search: Mutex::default(),
        }
    }

    /// The clock (epoch ms); also restarts `started_at` on it, as the TS constructor reads the injected clock.
    pub fn with_now(mut self, now: NowFn) -> Self {
        self.started_at = now();
        self.now = now;
        self
    }

    pub fn with_feed(mut self, feed: FeedFn) -> Self {
        self.get_feed = feed;
        self
    }

    pub fn with_url(mut self, url: Option<String>) -> Self {
        self.url = url;
        self
    }

    pub fn with_sdip_url(mut self, sdip_url: Option<String>) -> Self {
        self.sdip_url = sdip_url;
        self
    }

    pub fn with_fleet(mut self, fleet: Option<FleetFn>) -> Self {
        self.fleet = fleet;
        self
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// One record (or SDIP fix) applied to the vehicle's previous track. `days` are the candidate service days as
    /// (Warsaw date, `service_day_base`), today first; `now_s` epoch secs.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn track(
        &self,
        rec: ZbRecord,
        prev: Option<&Track>,
        feed: Option<&Arc<GzmFeed>>,
        days: &[(String, i64)],
        now_s: f64,
        fix: Fix,
        zb_fix_at: f64,
    ) -> Track {
        let matched = feed.and_then(|feed| {
            let cached = prev
                .filter(|p| p.feed.as_ref().is_some_and(|pf| Arc::ptr_eq(pf, feed)))
                .and_then(|p| p.matched.as_ref());
            match cached {
                Some(c)
                    if rec.upcoming.is_empty()
                        || fits(feed.trip_at(c.trip), c.base, &rec.upcoming, MATCH_SLACK_SEC) =>
                {
                    Some(c.clone())
                }
                _ => match_trip(feed, &rec, days),
            }
        });
        let ts_s = rec.ts / 1000.0;
        let delay_s = rec.delay_ms.map(|d| round(d / 1000.0));
        let Fix { lat, lon, .. } = fix;
        let p = prev.map(|t| &t.pos);
        let anchor = p.filter(|p| meters_between(p.anchor_lat, p.anchor_lon, lat, lon) <= 15.0);
        let last_moved_at = anchor.map_or(fix.fix_at, |p| p.last_moved_at);
        // ponytail: a bus held 10+ min mid-route by a blockade also reads as stuck (position only until it moves),
        // and a stuck trip comes back while the bus drives to the depot; a cold start needs 10 min to see either
        // now_s, not fix.fix_at: an SDIP fix of a standing bus keeps the time it stopped
        let stuck = delay_s.is_some_and(|d| d >= STUCK_SEC) && now_s - last_moved_at >= STUCK_SEC;

        let mut trip = matched.as_ref().map(|m| m.trip);
        let mut next = rec.upcoming.first().map_or(0, |c| c.seq);
        let mut layover = false;
        if let (Some(m), Some(feed)) = (&matched, feed) {
            let mt = feed.trip_at(m.trip);
            let last = mt.t.stop_ids.len().checked_sub(1);
            let u = &rec.upcoming;
            let at_end = last
                .and_then(|l| mt.t.stop_ids.get(l))
                .and_then(|id| feed.stops.get(id))
                .is_some_and(|end| meters_between(lat, lon, end.lat, end.lon) <= AT_STOP_M);
            // the trip is done once the bus stands at its last stop or that stop is behind it: zbiorkom keeps listing
            // it (delay frozen or growing with the clock) or lists nothing; the brigade's next trip is what the
            // vehicle serves now
            layover = match u.as_slice() {
                [] => true,
                [c] => {
                    Some(c.seq) == last
                        && (at_end || stuck || c.dep + delay_s.unwrap_or(0.0) < ts_s - LAYOVER_GRACE_SEC)
                }
                _ => false,
            };
            if layover {
                trip = mt.x.next;
                next = 0;
            } else if stuck {
                trip = None;
            }
        }
        let gt = trip.and_then(|i| Some(feed?.trip_at(i)));
        let gt = gt.filter(|t| next < t.t.stop_ids.len());
        let trip = gt.map(|t| t.idx);

        let stop_at = |i: usize| -> Option<&GzmStop> { feed?.stops.get(gt?.t.stop_ids.get(i)?) };
        let next_stop = stop_at(next);
        let near = |s: Option<&GzmStop>, m: f64| s.is_some_and(|s| meters_between(lat, lon, s.lat, s.lon) <= m);
        let not_started = gt.is_some_and(|t| {
            next == 0 && (layover || near(stop_at(0), NOT_STARTED_M) || feed.is_some_and(|f| off_route(f, t, lat, lon)))
        });
        let prev_stop = if next > 0 { stop_at(next - 1) } else { None };
        let at_stop = near(next_stop, AT_STOP_M) || near(prev_stop, AT_STOP_M);

        let step = p.map_or(0.0, |p| meters_between(p.lat, p.lon, lat, lon));
        let moved = p.filter(|_| step >= 8.0).and_then(|p| bearing(p.lat, p.lon, lat, lon));
        // SDIP's bearing can flip while a bus stands and stick there: a clear move the other way overrules it
        let told = match (fix.bearing, moved) {
            (Some(b), Some(m)) if step >= 20.0 && (((b - m + 540.0) % 360.0) - 180.0).abs() > 90.0 => None,
            _ => fix.bearing,
        };
        let heading = told
            .or(moved)
            .or(p.and_then(|p| p.bearing))
            .or_else(|| next_stop.and_then(|s| bearing(lat, lon, s.lat, s.lon)));

        let vt = number(&rec.kind);
        let line = if rec.line.is_empty() {
            gt.map(|t| t.t.line.clone()).unwrap_or_default()
        } else {
            rec.line.clone()
        };
        let headsign = if layover || rec.headsign.is_empty() {
            gt.map(|t| t.t.headsign.clone()).unwrap_or_default()
        } else {
            rec.headsign.clone()
        };
        let mut pos = VehiclePos {
            exec_id: format!("{}{}", self.prefix, rec.key),
            trip_id: gt.map(|t| t.t.trip_id.clone()).unwrap_or_default(),
            route_id: gt.map(|t| t.t.route_id.clone()).unwrap_or_default(),
            line,
            headsign,
            lat,
            lon,
            vehicle_type: if vt == 11.0 {
                11
            } else if vt == 0.0 {
                0
            } else {
                3
            },
            current_stop_sequence: gt.map(|_| next.saturating_sub(1) as i64),
            at_stop,
            delay: if gt.is_none() || not_started { None } else { delay_s },
            timestamp: ts_s.floor(),
            updated_at: now_s,
            bearing: heading,
            next_stop_name: next_stop.map(|s| s.name.clone()),
            next_stop_lat: next_stop.map(|s| s.lat),
            next_stop_lon: next_stop.map(|s| s.lon),
            last_moved_at,
            anchor_lat: anchor.map_or(lat, |p| p.anchor_lat),
            anchor_lon: anchor.map_or(lon, |p| p.anchor_lon),
            finished: false,
            not_started,
            operator: Some("GZM"),
            side_number: Some(rec.label.clone()),
            model: rec.model.clone().filter(|m| !m.is_empty()),
            agency: rec.agency.clone().filter(|a| !a.is_empty()),
            sched_trip_id: gt.map(|t| t.t.trip_id.clone()),
            next_stop_seq: gt.map(|_| next as i64),
            fix_at: Some(fix.fix_at),
            ..Default::default()
        };
        if let (Some(t), Some(feed)) = (gt, feed) {
            attach_route_info(&mut pos, t, next, prev, feed);
        }
        let date = matched.as_ref().map(|m| m.date.clone()).unwrap_or_default();
        // the exec id is the vehicle, not the trip: a new trip (or the same one on another day) starts a new log
        if trip.is_some() {
            let same = prev
                .filter(|pt| pt.trip == trip && same_feed(pt.feed.as_ref(), feed) && pt.date == date)
                .and_then(|pt| pt.pos.arrivals.as_ref());
            pos.arrivals = Some(step_arrivals(same, next as i64 - 1, now_s, fix.fix_at));
        }
        let base = matched.as_ref().map_or(0, |m| m.base);
        Track {
            rec,
            pos,
            feed: feed.cloned(),
            matched,
            trip,
            date,
            base,
            next,
            not_started,
            zb_fix_at,
        }
    }

    /// Metro trains placed by the timetable: no live source sends them. One track per running trip and service day,
    /// its key stable for that pair so the marker glides between polls. ~60 trains on Warsaw's 4000 metro trips.
    /// `live` = lines some live record serves (never doubled by the timetable).
    // ponytail: timetable only (a held train still drives on the map); join a live source per line once one exists
    pub(crate) fn scheduled_tracks(
        &self,
        st: &mut State,
        feed: &Arc<GzmFeed>,
        days: &[(String, i64)],
        now_s: f64,
        live: &HashSet<String>,
    ) -> Vec<Track> {
        let sched = match st.sched.take() {
            Some(s) if s.feed.as_ptr() == Arc::as_ptr(feed) => s,
            _ => {
                let ids: HashSet<&str> = feed
                    .lines
                    .iter()
                    .filter(|l| l.kind == SCHED_ROUTE_TYPE)
                    .map(|l| l.id.as_str())
                    .collect();
                let trips = if ids.is_empty() {
                    Vec::new()
                } else {
                    feed.trips()
                        .filter(|t| ids.contains(t.t.route_id.as_str()))
                        .map(|t| t.idx)
                        .collect()
                };
                Sched {
                    feed: Arc::downgrade(feed),
                    trips,
                }
            }
        };
        let mut out = Vec::new();
        for &i in &sched.trips {
            let trip = feed.trip_at(i);
            if live.contains(&trip.t.line) {
                continue;
            }
            for (date, base) in days {
                let at = if trip.runs_on(date) {
                    schedule_position(&trip.t.arr, &trip.t.dep, now_s - *base as f64)
                } else {
                    None
                };
                if let Some(t) = at.and_then(|at| self.scheduled_track(feed, trip, date, *base, at, now_s)) {
                    out.push(t);
                }
            }
        }
        st.sched = Some(sched);
        out
    }

    fn scheduled_track(
        &self,
        feed: &Arc<GzmFeed>,
        trip: GzmTrip<'_>,
        date: &str,
        base: i64,
        at: SchedAt,
        now_s: f64,
    ) -> Option<Track> {
        let SchedAt { i, f, next } = at;
        let s = &trip.t.stop_ids;
        let stop = |k: usize| s.get(k).and_then(|id| feed.stops.get(id));
        let (a, b) = (stop(i), stop(i + 1));
        let shape_id = trip.x.shape_id.as_deref().filter(|k| !k.is_empty());
        let g = shape_id
            .and_then(|k| feed.shapes.geometry(k))
            .filter(|g| g.stops.len() == s.len());
        let c0 = g.as_ref().and_then(|g| g.stops.get(i).copied().flatten());
        let c1 = g.as_ref().and_then(|g| g.stops.get(i + 1).copied().flatten());
        let leg_s = f64::from(*trip.t.arr.get(i + 1)?) - f64::from(*trip.t.dep.get(i)?);
        let (lat, lon, heading, dist_m, leg_m) = match (&g, c0, c1, a, b) {
            (Some(g), Some(c0), Some(c1), _, _) => {
                let d = c0 + (c1 - c0) * f;
                let p = point_at(&g.pl, d, None);
                (p.lat, p.lon, tangent_bearing(&g.pl, d, 5.0, 15.0), Some(d), c1 - c0)
            }
            (_, _, _, Some(a), Some(b)) => (
                a.lat + (b.lat - a.lat) * f,
                a.lon + (b.lon - a.lon) * f,
                bearing(a.lat, a.lon, b.lat, b.lon),
                None,
                meters_between(a.lat, a.lon, b.lat, b.lon),
            ),
            _ => return None,
        };
        let mut sha = to_base64url(&Sha1::digest(format!("{}|{date}", trip.t.trip_id)));
        sha.truncate(10);
        let key = format!("{SCHED_ROUTE_TYPE}_S{sha}");
        let next_stop = stop(next);
        let headsign = trip
            .x
            .stop_headsigns
            .as_ref()
            .and_then(|h| h.get(next).cloned().flatten())
            .unwrap_or_else(|| trip.t.headsign.clone());
        let shaped = g.as_ref().zip(dist_m);
        let pos = VehiclePos {
            exec_id: format!("{}{key}", self.prefix),
            trip_id: trip.t.trip_id.clone(),
            route_id: trip.t.route_id.clone(),
            line: trip.t.line.clone(),
            headsign: headsign.clone(),
            lat,
            lon,
            vehicle_type: 1,
            current_stop_sequence: Some(next.saturating_sub(1) as i64),
            at_stop: next == i,
            delay: None,
            timestamp: now_s.floor(),
            updated_at: now_s,
            bearing: heading,
            next_stop_name: next_stop.map(|s| s.name.clone()),
            next_stop_lat: next_stop.map(|s| s.lat),
            next_stop_lon: next_stop.map(|s| s.lon),
            last_moved_at: now_s,
            anchor_lat: lat,
            anchor_lon: lon,
            finished: false,
            operator: Some("GZM"),
            scheduled: true,
            sched_trip_id: Some(trip.t.trip_id.clone()),
            next_stop_seq: Some(next as i64),
            fix_at: Some(now_s),
            // the timetable speed of the leg, so the client glides between 10 s polls; 0 while it stands at a stop
            speed: Some(if next == i || leg_s <= 0.0 { 0.0 } else { leg_m / leg_s }),
            speed_at: Some(now_s),
            shape_key: shaped.and(shape_id.map(str::to_owned)),
            dist_m: shaped.map(|(_, d)| d),
            dist_rev: shaped.map(|(g, _)| g.rev.clone()),
            ..Default::default()
        };
        let rec = ZbRecord {
            key,
            label: String::new(),
            kind: SCHED_ROUTE_TYPE.to_owned(),
            model: None,
            agency: None,
            line: trip.t.line.clone(),
            brigade: Some(trip.x.brigade.clone()).filter(|b| !b.is_empty()),
            lat,
            lon,
            ts: now_s * 1000.0,
            bearing: heading,
            delay_ms: None,
            headsign,
            upcoming: Vec::new(),
        };
        Some(Track {
            rec,
            pos,
            feed: Some(feed.clone()),
            matched: Some(GzmMatch {
                trip: trip.idx,
                date: date.to_owned(),
                base,
            }),
            trip: Some(trip.idx),
            date: date.to_owned(),
            base,
            next,
            not_started: false,
            zb_fix_at: now_s,
        })
    }
}

fn same_feed(a: Option<&Arc<GzmFeed>>, b: Option<&Arc<GzmFeed>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

/// Shape key, along-route distance and cruise speed (the MzkPoller pattern). The TS catches a throw per vehicle;
/// nothing here can fail (every lookup is an Option), so neither the catch nor its `routeErrLoggedAt` exist.
fn attach_route_info(pos: &mut VehiclePos, trip: GzmTrip<'_>, next: usize, prev: Option<&Track>, feed: &GzmFeed) {
    let shape_id = trip.x.shape_id.as_deref().filter(|k| !k.is_empty());
    // the shape's stop chainage comes from one trip of that shape; a trip with other calls gets no shape
    let geom = shape_id
        .and_then(|k| feed.shapes.geometry(k))
        .filter(|g| g.stops.len() == trip.t.stop_ids.len());
    pos.shape_key = geom.as_ref().and(shape_id.map(str::to_owned));
    let p = prev.map(|t| &t.pos);
    if let Some(geom) = &geom {
        let hint = p
            .filter(|p| p.trip_id == pos.trip_id && p.dist_rev.as_deref() == Some(geom.rev.as_str()))
            .and_then(|p| p.dist_m);
        let gap = match (p.and_then(|p| p.fix_at), pos.fix_at) {
            (Some(a), Some(b)) => b - a,
            _ => 0.0,
        };
        let vti = next.saturating_sub(1) as i64;
        let d = kb_dist_along(
            geom,
            pos.lat,
            pos.lon,
            Some(vti),
            Some(next as i64),
            hint,
            Some(kb_ahead_m(gap)),
        );
        if let Some(d) = d {
            let dep: Vec<Option<f64>> = trip.t.dep.iter().map(|&x| Some(f64::from(x))).collect();
            pos.dist_m = Some(d);
            pos.dist_rev = Some(geom.rev.clone());
            pos.sched_speed = sched_speed(&geom.stops, &dep, d);
        }
    }
    let (Some(p), Some(fix_at)) = (p, pos.fix_at) else {
        return;
    };
    let prev_fix = p.fix_at.unwrap_or(p.updated_at);
    if fix_at - prev_fix < 0.5 {
        pos.move_ds = p.move_ds;
        pos.speed = p.speed;
        pos.speed_at = p.speed_at;
        return;
    }
    let along = match (pos.dist_m, p.dist_m) {
        (Some(a), Some(b)) if p.dist_rev == pos.dist_rev && p.trip_id == pos.trip_id => Some(a - b),
        _ => None,
    };
    let ds = along.unwrap_or_else(|| meters_between(p.lat, p.lon, pos.lat, pos.lon));
    let s = next_speed(p.speed, p.move_ds, ds, fix_at - prev_fix, 0.0, p.at_stop || pos.at_stop);
    pos.move_ds = Some(ds);
    pos.speed = s.or(p.speed);
    pos.speed_at = if s.is_some() { Some(fix_at) } else { p.speed_at };
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::gzm::parse::ZbCall;
    use crate::gzm_feed::parse_gzm_zip;

    const DATE: &str = "2026-10-28";
    const LAT: f64 = 50.25;

    fn feed() -> Arc<GzmFeed> {
        let files = [
            ("routes.txt", "route_id,agency_id,route_short_name,route_long_name,route_type\nr7,1,7,T7,0\nrM,1,M1,Metro,1".to_owned()),
            ("stops.txt", format!("stop_id,stop_name,stop_lat,stop_lon,location_type\na,Alfa 01,{LAT},19.0,0\nb,Beta 01,{LAT},19.01,0\nc,Gamma 01,{LAT},19.02,0")),
            ("trips.txt", "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,brigade\nr7,s1,tA,Gamma,0,shA,3\nr7,s1,tB,Alfa,1,,3\nrM,s1,tM,Gamma,0,shA,9".to_owned()),
            ("stop_times.txt", ["trip_id,arrival_time,departure_time,stop_id,stop_sequence", "tA,08:00:00,08:00:00,a,0", "tA,08:05:00,08:05:00,b,1", "tA,08:10:00,08:10:00,c,2", "tB,08:20:00,08:20:00,c,0", "tB,08:25:00,08:25:00,b,1", "tB,08:30:00,08:30:00,a,2", "tM,08:00:00,08:00:00,a,0", "tM,08:05:00,08:05:00,b,1", "tM,08:10:00,08:10:00,c,2"].join("\n")),
            ("shapes.txt", format!("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshA,{LAT},19.0,1\nshA,{LAT},19.01,2\nshA,{LAT},19.02,3")),
            ("calendar.txt", "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns1,1,1,1,1,1,1,1,20261020,20261110".to_owned()),
        ];
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, body) in &files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("unimaps-gzm-state-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("gtfs.zip");
        std::fs::write(&file, w.finish().unwrap().into_inner()).unwrap();
        let feed = parse_gzm_zip(&file, "x", &|_| None);
        let _ = std::fs::remove_dir_all(&dir);
        Arc::new(feed.unwrap())
    }

    fn at(secs: i64) -> f64 {
        (crate::time::service_day_base(DATE.parse().unwrap()) + secs) as f64
    }

    #[test]
    fn track_joins_then_lays_over_to_the_brigades_next_trip() {
        let (feed, live) = (feed(), GzmLive::new("x", HttpZb));
        let days = [(DATE.to_owned(), at(0) as i64)];
        let rec = ZbRecord {
            key: "283_4285".into(),
            label: "4285".into(),
            kind: "0".into(),
            model: None,
            agency: None,
            line: "7".into(),
            brigade: Some("3".into()),
            lat: LAT,
            lon: 19.01,
            ts: at(29_100) * 1000.0,
            bearing: Some(90.0),
            delay_ms: Some(60_000.0),
            headsign: "Gamma".into(),
            upcoming: vec![
                ZbCall {
                    seq: 1,
                    dep: at(29_100),
                },
                ZbCall {
                    seq: 2,
                    dep: at(29_400),
                },
            ],
        };
        let fix = Fix {
            lat: LAT,
            lon: 19.01,
            bearing: Some(90.0),
            fix_at: at(29_095),
        };
        let t1 = live.track(rec.clone(), None, Some(&feed), &days, at(29_101), fix, fix.fix_at);
        assert_eq!(t1.pos.trip_id, "x:tA");
        assert_eq!(
            (t1.next, t1.pos.at_stop, t1.pos.delay, t1.not_started),
            (1, true, Some(60.0), false)
        );
        assert_eq!(t1.pos.shape_key.as_deref(), Some("x:shA"));
        assert!(t1.pos.dist_m.is_some_and(|d| (d - 713.0).abs() < 5.0));

        let rec2 = ZbRecord {
            lon: 19.02,
            ts: at(29_400) * 1000.0,
            upcoming: vec![rec.upcoming[1]],
            ..rec
        };
        let fix2 = Fix {
            lon: 19.02,
            fix_at: at(29_395),
            ..fix
        };
        let t2 = live.track(rec2, Some(&t1), Some(&feed), &days, at(29_401), fix2, fix2.fix_at);
        assert_eq!((t2.pos.trip_id.as_str(), t2.pos.headsign.as_str()), ("x:tB", "Alfa"));
        assert_eq!((t2.next, t2.not_started, t2.pos.delay), (0, true, None));
    }

    #[test]
    fn scheduled_metro_sits_mid_leg_unless_a_live_record_serves_its_line() {
        let (feed, live) = (feed(), GzmLive::new("x", HttpZb));
        let mut st = State::default();
        let days = [(DATE.to_owned(), at(0) as i64)];
        let out = live.scheduled_tracks(&mut st, &feed, &days, at(28_950), &HashSet::new());
        let [t] = out.as_slice() else {
            panic!("one train expected, got {}", out.len())
        };
        assert!(t.pos.exec_id.starts_with("x:1_S") && t.rec.key.len() == 13);
        assert_eq!(
            (t.next, t.pos.at_stop, t.pos.scheduled, t.pos.vehicle_type),
            (1, false, true, 1)
        );
        assert!((t.pos.lon - 19.005).abs() < 1e-4);
        assert!(t.pos.speed.is_some_and(|s| (s * 300.0 - 713.0).abs() < 5.0));
        let lines = HashSet::from(["M1".to_owned()]);
        assert!(
            live.scheduled_tracks(&mut st, &feed, &days, at(28_950), &lines)
                .is_empty()
        );
    }
}
