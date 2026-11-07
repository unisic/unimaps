//! lib/gzm.ts lines 428-691 and 932-962: the positions and SDIP loops of [`GzmLive`], how one response replaces
//! the live state (`apply`, `applySdip`), the prebuilt `/api/vehicles` body and the fleet tracker's input.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use jiff::Timestamp;
use serde_json::{Map, Value, json};

use super::parse::{
    AREA, BODY_SLACK_MS, Fix, GzmFleetSource, GzmFleetStop, GzmNextTrip, MAX_BODY, POLAND, POLL_MS, POLL_PHASE_MS,
    SCHED_ROUTE_TYPE, SDIP_GAP_SEC, SDIP_MS, SDIP_PAUSE_MS, SDIP_PHASE_MS, STALE_SEC, SdipPos, SdipSample, TIMEOUT,
    Track, WATCH_MS, ZbRecord, ZbTransport, next_poll_delay, parse_sdip, parse_zbiorkom, sdip_list_text, sdip_session,
};
use super::state::{GzmLive, State};
use crate::config;
use crate::fetch::string_err;
use crate::gzm_feed::GzmFeed;
use crate::js::{encode_uri_component, num_value, number_to_string};
use crate::logger;
use crate::route_info::{PrevFix, estimate_fix_at, vehicle_extras};
use crate::time::{agency_clock, service_day_base};
use crate::vehicle::vehicle_to_json;

/// A vehicle in the last poll, on a trip or not (TS `liveVehicle`'s answer).
#[derive(Debug, Clone, PartialEq)]
pub struct GzmLiveVehicle {
    pub label: String,
    pub model: Option<String>,
    pub line: String,
    pub lat: f64,
    pub lon: f64,
    /// epoch secs, floored
    pub fix_at: f64,
}

impl State {
    /// The last good positions poll is recent enough to show.
    pub(crate) fn fresh(&self, now_s: f64) -> bool {
        now_s - self.last_good <= STALE_SEC
    }
}

impl<T: ZbTransport> GzmLive<T> {
    pub fn running(&self) -> bool {
        !self.state().tasks.is_empty()
    }

    /// TS `sdipMoved`: vehicles the last SDIP list moved.
    pub fn sdip_moved(&self) -> u64 {
        self.state().sdip_moved
    }

    /// Counts as "someone is watching": the SDIP overlay (GZM) and the positions loop of any other city run only
    /// then.
    pub fn touch(&self) {
        let now = (self.now)();
        self.state().last_watch = now;
    }

    pub(crate) fn watched(&self) -> bool {
        let now = (self.now)();
        now - self.state().last_watch <= WATCH_MS
    }

    /// Stops both loops at once (an in-flight request is dropped with its task).
    pub fn stop(&self) {
        for task in self.state().tasks.drain(..) {
            task.abort();
        }
    }

    /// The positions URL: fixed (GZM), or the feed's bbox (all of Poland while that feed parses).
    fn positions_url(&self) -> String {
        if let Some(url) = &self.url {
            return url.clone();
        }
        let a = (self.get_feed)().map_or(POLAND, |f| f.area);
        format!(
            "{}/{}/positions/{},{},{},{}",
            *config::ZB_API_URL,
            encode_uri_component(&self.slug),
            number_to_string(a.lon_min),
            number_to_string(a.lat_min),
            number_to_string(a.lon_max),
            number_to_string(a.lat_max)
        )
    }

    /// One request; never fails. True when it applied a response.
    pub async fn poll_once(&self) -> bool {
        let url = self.positions_url();
        let t0 = (self.now)();
        {
            let mut st = self.state();
            st.scan_count += 1;
            st.last_scan = t0 as f64 / 1000.0;
        }
        let res = self.fetch_positions(&url, t0).await;
        let poll_ms = (self.now)() - t0;
        let mut st = self.state();
        st.poll_ms = poll_ms;
        match res {
            Ok(()) => true,
            Err(err) => {
                let err = string_err(err);
                st.failures += 1;
                if st.failures == 1 || st.failures.is_multiple_of(30) {
                    logger::warn("gzm", format!("positions poll failed ({}x): {err}", st.failures));
                }
                st.last_error = Some(err);
                false
            }
        }
    }

    async fn fetch_positions(&self, url: &str, t0: i64) -> Result<(), String> {
        let headers = [
            ("User-Agent", config::USER_AGENT.as_str()),
            ("Accept", "application/json"),
        ];
        let res = self.transport.get(url, &headers, TIMEOUT, MAX_BODY).await?;
        if !res.ok() {
            return Err(format!("HTTP {}", res.status));
        }
        self.state().bytes += res.body.encode_utf16().count() as u64;
        // ponytail: serde's message, not V8's ("Unexpected token '<', ..."): the class alone matches
        let body: Value = serde_json::from_str(&res.body).map_err(|e| format!("SyntaxError: {e}"))?;
        let feed = (self.get_feed)();
        let area = match (&self.url, &feed) {
            (Some(_), _) => AREA,
            (None, Some(f)) => f.area,
            (None, None) => POLAND,
        };
        let recs = parse_zbiorkom(&body, t0, &area, self.slug != "gzm")?;
        let days = days(t0);
        let sources = {
            let mut st = self.state();
            self.apply_locked(&mut st, feed, recs, &days, t0);
            // in the same lock as the apply: the TS step from the response to lastGood is synchronous
            st.last_good = t0 as f64 / 1000.0;
            if st.failures > 0 {
                logger::info("gzm", format!("positions back after {} failed polls", st.failures));
            }
            st.failures = 0;
            st.last_error = None;
            self.fleet.as_ref().map(|_| self.sources(&st))
        };
        // an empty list would close every running course: skip it (feed still loading, or nothing matched)
        if let (Some(fleet), Some(sources)) = (&self.fleet, sources)
            && !sources.is_empty()
        {
            fleet(sources);
        }
        Ok(())
    }

    /// One SDIP request (a fresh session when the old one expired); never fails. True when it applied a response.
    pub async fn poll_sdip_once(&self) -> bool {
        let Some(url) = self.sdip_url.as_deref() else {
            return false;
        };
        let t0 = (self.now)();
        match self.fetch_sdip(url).await {
            Ok(list) => {
                self.apply_sdip(&list, t0);
                let mut st = self.state();
                st.sdip_last_good = t0 as f64 / 1000.0;
                st.sdip_fails = 0;
                st.sdip_error = None;
                true
            }
            Err(err) => {
                let err = string_err(err);
                let mut st = self.state();
                st.sdip_cookie.clear();
                st.sdip_fails += 1;
                if st.sdip_fails >= 3 {
                    st.sdip_fails = 0;
                    st.sdip_paused_until = t0 + SDIP_PAUSE_MS;
                    logger::warn("gzm", format!("SDIP failed 3x, paused 5 min: {err}"));
                }
                st.sdip_error = Some(err);
                false
            }
        }
    }

    async fn fetch_sdip(&self, url: &str) -> Result<IndexMap<String, SdipPos>, String> {
        let mut cookie = self.state().sdip_cookie.clone();
        if cookie.is_empty() {
            cookie = self.sdip_login(url).await?;
        }
        let mut list = self.sdip_vehicles(url, &cookie).await?;
        if list.is_none() {
            cookie = self.sdip_login(url).await?;
            list = self.sdip_vehicles(url, &cookie).await?;
        }
        let list = list.ok_or("SDIP sent no JSON with a fresh session")?;
        parse_sdip(&list)
    }

    async fn sdip_login(&self, url: &str) -> Result<String, String> {
        let cookie = sdip_session(&self.transport, url).await?;
        self.state().sdip_cookie.clone_from(&cookie);
        Ok(cookie)
    }

    /// The vehicle list, or None when SDIP answered something else than JSON (its expired-session page).
    async fn sdip_vehicles(&self, url: &str, cookie: &str) -> Result<Option<Value>, String> {
        let text = sdip_list_text(&self.transport, url, cookie).await?;
        self.state().sdip_bytes += text.encode_utf16().count() as u64;
        // JSON.parse("null") is null too: the TS reads it as "no JSON"
        Ok(serde_json::from_str::<Value>(&text).ok().filter(|v| !v.is_null()))
    }

    /// Dates SDIP positions and moves every tracked vehicle whose SDIP position changed.
    pub fn apply_sdip(&self, list: &IndexMap<String, SdipPos>, now_ms: i64) {
        let recv = now_ms as f64 / 1000.0;
        let days = days(now_ms);
        let mut guard = self.state();
        let st = &mut *guard;
        let mut next = IndexMap::with_capacity(list.len());
        let mut moved = 0;
        for (key, s) in list {
            let old = st.sdip.get(key).copied();
            let changed = old.is_none_or(|o| o.lat != s.lat || o.lon != s.lon);
            let fix_at = match old {
                Some(o) if recv - o.recv <= SDIP_GAP_SEC && changed => Some(estimate_fix_at(
                    Some(PrevFix {
                        fix_at: None,
                        updated_at: o.recv,
                    }),
                    recv,
                    true,
                    SDIP_GAP_SEC,
                )),
                Some(o) if recv - o.recv <= SDIP_GAP_SEC => o.fix_at,
                _ => None,
            };
            let sample = SdipSample {
                lat: s.lat,
                lon: s.lon,
                bearing: s.bearing,
                recv,
                fix_at,
            };
            next.insert(key.clone(), sample);
            if !changed || fix_at.is_none() {
                continue;
            }
            moved += 1;
            let Some(t) = st.tracks.get(key).cloned() else { continue };
            let Some(fix) = fix_for(&st.sdip, key, Some(sample), recv) else {
                continue;
            };
            if t.pos.fix_at == Some(fix.fix_at) {
                continue;
            }
            let nt = Arc::new(self.track(t.rec.clone(), Some(&t), t.feed.as_ref(), &days, recv, fix, t.zb_fix_at));
            if let Some(k) = trip_key(&nt) {
                st.by_trip.insert(k, Arc::clone(&nt));
            }
            st.tracks.insert(key.clone(), nt);
        }
        // a vehicle missing from one list keeps its sample: dropping it would hand the map to zbiorkom's older
        // position
        for (key, s) in &st.sdip {
            if !next.contains_key(key) && recv - s.recv <= SDIP_GAP_SEC {
                next.insert(key.clone(), *s);
            }
        }
        st.sdip = next;
        st.sdip_moved = moved;
        rebuild_body(st, recv);
    }

    /// Replaces the live state with one response's records (prunes every vehicle not in it).
    pub fn apply(&self, recs: Vec<ZbRecord>, now_ms: i64) {
        let feed = (self.get_feed)();
        let days = days(now_ms);
        let mut st = self.state();
        self.apply_locked(&mut st, feed, recs, &days, now_ms);
    }

    // ponytail: the whole apply (track joins, body JSON) runs under the state lock, the TS's single-threaded
    // atomicity against the SDIP loop; readers wait those few ms per poll. Build outside + swap if it shows.
    fn apply_locked(
        &self,
        st: &mut State,
        feed: Option<Arc<GzmFeed>>,
        recs: Vec<ZbRecord>,
        days: &[(String, i64)],
        now_ms: i64,
    ) {
        let now_s = now_ms as f64 / 1000.0;
        // a line some live record serves (a metro that does send positions) is never doubled by the timetable
        let live: HashSet<String> = recs
            .iter()
            .filter(|r| r.kind == SCHED_ROUTE_TYPE && r.agency.as_deref().is_none_or(str::is_empty))
            .map(|r| r.line.clone())
            .collect();
        let mut tracks = IndexMap::with_capacity(recs.len());
        let mut by_trip = HashMap::new();
        for rec in recs {
            let prev = st.tracks.get(&rec.key).cloned();
            let ts_s = rec.ts / 1000.0;
            // zbiorkom's timestamp is its 10 s snapshot, so the fix lies inside the window before it: its midpoint
            let zb_fix_at = match &prev {
                Some(p) => estimate_fix_at(
                    Some(PrevFix {
                        fix_at: Some(p.zb_fix_at),
                        updated_at: p.rec.ts / 1000.0,
                    }),
                    ts_s,
                    rec.ts != p.rec.ts,
                    60.0,
                ),
                None => ts_s - POLL_MS as f64 / 2000.0,
            };
            let fix = fix_for(&st.sdip, &rec.key, None, now_s).unwrap_or(Fix {
                lat: rec.lat,
                lon: rec.lon,
                bearing: rec.bearing,
                fix_at: zb_fix_at,
            });
            let key = rec.key.clone();
            let t = Arc::new(self.track(rec, prev.as_deref(), feed.as_ref(), days, now_s, fix, zb_fix_at));
            if let Some(k) = trip_key(&t) {
                by_trip.insert(k, Arc::clone(&t));
            }
            tracks.insert(key, t);
        }
        if let Some(feed) = feed.as_ref().filter(|_| self.slug != "gzm") {
            for t in self.scheduled_tracks(st, feed, days, now_s, &live) {
                let t = Arc::new(t);
                if let Some(k) = trip_key(&t) {
                    by_trip.insert(k, Arc::clone(&t));
                }
                tracks.insert(t.rec.key.clone(), t);
            }
        }
        st.tracks = tracks;
        st.by_trip = by_trip;
        rebuild_body(st, now_s);
    }

    /// A vehicle in the last poll (`<op>_<fleet>`), on a trip or not; None when it is not on the map.
    pub fn live_vehicle(&self, side: &str) -> Option<GzmLiveVehicle> {
        let st = self.state();
        let t = st.tracks.get(side)?;
        Some(GzmLiveVehicle {
            label: t.rec.label.clone(),
            model: t.rec.model.clone(),
            line: t.pos.line.clone(),
            lat: t.pos.lat,
            lon: t.pos.lon,
            fix_at: t.pos.fix_at.unwrap_or(t.zb_fix_at).floor(),
        })
    }

    /// The vehicles that serve a GTFS trip now, as the fleet tracker reads them.
    pub fn fleet_sources(&self) -> Vec<GzmFleetSource> {
        let st = self.state();
        self.sources(&st)
    }

    fn sources(&self, st: &State) -> Vec<GzmFleetSource> {
        let mut out = Vec::new();
        for t in st.tracks.values() {
            let (Some(ti), Some(feed)) = (t.trip, &t.feed) else {
                continue;
            };
            let (rec, pos) = (&t.rec, &t.pos);
            let trip = feed.trip_at(ti);
            let geom = pos.shape_key.as_deref().and_then(|k| feed.shapes.geometry(k));
            let stop_name = |id: &str| feed.stops.get(id).map_or_else(String::new, |s| s.name.clone());
            let mut next_trips = Vec::new();
            let mut n = trip.x.next;
            // bounded by the feed: a chain of call-less trips must not spin
            for _ in 0..feed.extra.len() {
                let Some(ni) = n.filter(|_| next_trips.len() < 5) else {
                    break;
                };
                let nt = feed.trip_at(ni);
                if let (Some(first), Some(&dep)) = (nt.t.stop_ids.first(), nt.t.dep.first()) {
                    next_trips.push(GzmNextTrip {
                        line: nt.t.line.clone(),
                        headsign: nt.t.headsign.clone(),
                        first_stop_name: stop_name(first),
                        first_stop_id: first.clone(),
                        dep,
                    });
                }
                n = nt.x.next;
            }
            out.push(GzmFleetSource {
                side: rec.key.clone(),
                label: rec.label.clone(),
                model: rec.model.clone(),
                vehicle_type: rec.kind.clone(),
                line: pos.line.clone(),
                brigade: rec
                    .brigade
                    .clone()
                    .or_else(|| Some(trip.x.brigade.clone()).filter(|b| !b.is_empty())),
                trip_id: trip.t.trip_id.get(self.prefix.len()..).unwrap_or_default().to_owned(),
                headsign: pos.headsign.clone(),
                stops: trip
                    .t
                    .stop_ids
                    .iter()
                    .zip(trip.t.dep.iter())
                    .enumerate()
                    .map(|(i, (id, &dep))| GzmFleetStop {
                        id: id.clone(),
                        name: stop_name(id),
                        dep,
                        dist_m: geom.as_ref().and_then(|g| g.stops.get(i).copied().flatten()),
                    })
                    .collect(),
                served_idx: t.next.checked_sub(1),
                next_idx: Some(t.next),
                reached_m: pos.dist_m,
                at_stop: pos.at_stop,
                not_started: t.not_started,
                delay_sec: pos.delay,
                lat: pos.lat,
                lon: pos.lon,
                bearing: pos.bearing,
                fix_at: pos.fix_at,
                next_trips,
            });
        }
        out
    }

    /// Epoch ms the next body should be ready, for the client to poll right after it (X-Next-Update): SDIP's 5 s
    /// grid while it runs (zbiorkom's 10 s update rides along on the next one), else zbiorkom's. A poll running
    /// late = 1 s from now; a loop idle for TIMEOUT (SDIP paused, nobody watching) = None.
    pub fn next_body_at(&self) -> Option<i64> {
        let now = (self.now)();
        let idle = now - TIMEOUT.as_millis() as i64;
        let st = self.state();
        let t = if st.sdip_next_at > idle {
            st.sdip_next_at
        } else {
            st.zb_next_at
        };
        if t <= idle {
            return None;
        }
        Some(if t > now { t } else { now + 1000 })
    }

    /// GET /api/vehicles?city=<slug> body (prebuilt per poll; empty once the last good poll is stale).
    pub fn vehicles_body(&self) -> Arc<str> {
        let now_ms = (self.now)();
        let mut st = self.state();
        st.last_watch = now_ms;
        let now_s = now_ms as f64 / 1000.0;
        if !st.body.is_empty() && st.fresh(now_s) {
            return Arc::clone(&st.body);
        }
        let empty = json!({
            "timestamp": num_value(st.last_good),
            "scan_count": st.scan_count,
            "last_scan": num_value(st.last_scan),
            "count": 0,
            "vehicles": [],
        });
        empty.to_string().into()
    }
}

impl<T: ZbTransport + Send + Sync + 'static> GzmLive<T> {
    /// Starts the positions loop (every 10 s, 3 s past zbiorkom's grid; another city only while watched) and, with an
    /// SDIP URL, the SDIP loop (5 s grid, only while watched and not paused). Idempotent.
    pub fn start(self: &Arc<Self>) {
        let mut st = self.state();
        if !st.tasks.is_empty() {
            return;
        }
        let me = Arc::clone(self);
        st.tasks.push(tokio::spawn(async move { me.positions_loop().await }));
        if self.sdip_url.is_some() {
            let me = Arc::clone(self);
            st.tasks.push(tokio::spawn(async move { me.sdip_loop().await }));
        }
    }

    async fn positions_loop(&self) {
        let gated = self.slug != "gzm";
        loop {
            // ponytail: an unwatched city polls nothing and checks once a second; no wake-up signal from touch()
            if gated && !self.watched() {
                sleep_ms(1000).await;
                continue;
            }
            let fed = (self.get_feed)().is_some();
            self.poll_once().await;
            let mut wait = next_poll_delay((self.now)(), POLL_MS, POLL_PHASE_MS);
            let now = (self.now)();
            {
                let mut st = self.state();
                st.zb_next_at = now + wait + st.poll_ms + BODY_SLACK_MS;
            }
            if fed {
                sleep_ms(wait).await;
                continue;
            }
            // a poll made while the feed parsed shows bare positions: the next one joins the trips as soon as it
            // lands, not a grid step (10 s) later
            while wait > 0 && (self.get_feed)().is_none() {
                sleep_ms(wait.min(1000)).await;
                wait -= 1000;
            }
        }
    }

    async fn sdip_loop(&self) {
        loop {
            let t0 = (self.now)();
            let run = self.watched() && t0 >= self.state().sdip_paused_until;
            if run {
                self.poll_sdip_once().await;
            }
            let end = (self.now)();
            let wait = next_poll_delay(end, SDIP_MS, SDIP_PHASE_MS);
            if run {
                self.state().sdip_next_at = end + wait + (end - t0) + BODY_SLACK_MS;
            }
            sleep_ms(wait).await;
        }
    }
}

async fn sleep_ms(ms: i64) {
    tokio::time::sleep(Duration::from_millis(u64::try_from(ms).unwrap_or(0))).await;
}

/// Today and yesterday in Warsaw as (date, `service_day_base`), the days a record may join a trip of.
fn days(now_ms: i64) -> Vec<(String, i64)> {
    let (today, _) = agency_clock(Timestamp::from_millisecond(now_ms).unwrap_or(Timestamp::UNIX_EPOCH));
    [Some(today), today.yesterday().ok()]
        .into_iter()
        .flatten()
        .map(|d| (d.to_string(), service_day_base(d)))
        .collect()
}

/// `byTrip`'s key, "<trip_id>|<date>", of a track on a trip.
fn trip_key(t: &Track) -> Option<String> {
    let (Some(i), Some(feed)) = (t.trip, &t.feed) else {
        return None;
    };
    Some(format!("{}|{}", feed.trip_at(i).t.trip_id, t.date))
}

/// SDIP's dated fix while SDIP still reports the vehicle (None: zbiorkom's). zbiorkom serves the same positions
/// later (5 s median, 10 s p90, 60 s p99 behind SDIP; SDIP never behind it: 358 vehicles, 2026-10-30), so a
/// standing bus must not hand over to zbiorkom: its estimated fix time looks newer, its position is older.
fn fix_for(sdip: &IndexMap<String, SdipSample>, key: &str, s: Option<SdipSample>, now_s: f64) -> Option<Fix> {
    let s = s.or_else(|| sdip.get(key).copied())?;
    let fix_at = s.fix_at?;
    if now_s - s.recv > SDIP_GAP_SEC {
        return None;
    }
    Some(Fix {
        lat: s.lat,
        lon: s.lon,
        bearing: s.bearing,
        fix_at,
    })
}

fn rebuild_body(st: &mut State, now_s: f64) {
    let vehicles: Vec<Value> = st
        .tracks
        .values()
        .map(|t| {
            let mut o: Map<String, Value> = vehicle_to_json(&t.pos);
            let extras = match &t.feed {
                Some(f) => vehicle_extras(&t.pos, Some(&|k: &str| f.shapes.wire_id(k)), now_s),
                None => vehicle_extras(&t.pos, None, now_s),
            };
            // a spread: a key already in vehicleToJson keeps its place
            o.extend(extras);
            Value::Object(o)
        })
        .collect();
    let res = json!({
        "timestamp": num_value(now_s),
        "scan_count": st.scan_count,
        "last_scan": num_value(st.last_scan),
        "count": vehicles.len(),
        "vehicles": vehicles,
    });
    st.body = res.to_string().into();
}
