//! lib/gzm.ts lines 963-1227: what the routes ask a [`GzmLive`]: a stop's board, a pole's timetable, static and
//! live trips (with the road-match request of their shape), feed shapes, connections and the health block.

use std::collections::HashMap;
use std::sync::{Arc, PoisonError};

use indexmap::IndexMap;
use jiff::Timestamp;
use jiff::civil::Date;
use serde_json::{Map, Value, json};

use super::parse::{
    BOARD_ROWS, CONN_MEMO, CONN_MEMO_MS, FOCUS_M, GROUP_M, GROUP_MAX, LAYOVER_GRACE_SEC, Lookup, WATCH_MS, ZbTransport,
    around, clock,
};
use super::state::{GzmLive, State};
use crate::geo::nearest_within;
use crate::gzm_feed::{GzmFeed, GzmTrip, ShapeLookup, gzm_feed_health};
use crate::gzm_match::MATCHER;
use crate::js::{is_space, num_value, round};
use crate::router::{ConnectionItinerary, LiveFn, Point, RouteQuery, find_connections_at, stop_events};
use crate::shared::departures::{gzm_row_key, hhmm, pre_sort_rows};
use crate::shared::gzm_stop_key::gzm_stop_key;
use crate::shared::polyline::{LatLng, LatLonBox};
use crate::time::{agency_clock, service_day_base};

impl<T: ZbTransport> GzmLive<T> {
    /// The board of pole `stop_id` from the feed with the live delays, `{rows, server_ts, poles?}`; with `all`, of
    /// every same-name pole within GROUP_M, each row with its post number (`pole`).
    pub fn departures(&self, stop_id: &str, all: bool) -> Lookup<Value> {
        let Some(feed) = (self.get_feed)() else {
            return Lookup::Loading;
        };
        let Some(me) = feed.stops.get(stop_id) else {
            return Lookup::Unknown;
        };
        let name_key = feed.router.stops.get(stop_id).map_or("", |s| s.name_key.as_str());
        let named = feed.router.poles_by_name.get(name_key);
        let poles = named
            .into_iter()
            .flatten()
            .map(String::as_str)
            .chain(named.is_none().then_some(stop_id));
        let group = nearest_within(
            (me.lat, me.lon),
            poles.filter_map(|id| feed.stops.get(id)),
            |p| (p.lat, p.lon),
            GROUP_M,
            GROUP_MAX,
        );
        let post: HashMap<&str, &str> = if all {
            group.iter().map(|p| (p.id.as_str(), post_number(&p.name))).collect()
        } else {
            HashMap::new()
        };
        let ids: Vec<&str> = if all {
            group.iter().map(|p| p.id.as_str()).collect()
        } else {
            vec![stop_id]
        };
        let now_ms = (self.now)();
        let now_s = now_ms as f64 / 1000.0;
        let (date, secs) = agency_clock(Timestamp::from_millisecond(now_ms).unwrap_or(Timestamp::UNIX_EPOCH));
        let date = date.to_string();
        let mut bases: HashMap<String, i64> = HashMap::new();
        let mut rows = Vec::new();
        let st = self.state();
        let live = st.fresh(now_s);
        // an hour back: a late bus still departs; the row filter below drops what is gone
        for e in stop_events(&feed.router, &ids, &date, secs - 3600, secs + 3 * 3600, None) {
            let Some(trip) = feed.trip(&e.trip.trip_id) else {
                continue;
            };
            let (Some(&dep), Some(&dep0), Some(&seq)) =
                (trip.t.dep.get(e.pos), trip.t.dep.first(), trip.t.seqs.get(e.pos))
            else {
                continue;
            };
            let tr = if live {
                st.by_trip.get(&format!("{}|{}", trip.t.trip_id, e.service_date))
            } else {
                None
            };
            if tr.is_some_and(|t| t.next > e.pos) {
                continue;
            }
            let b = match bases.get(&e.service_date) {
                Some(&b) => b,
                None => {
                    let Ok(d) = e.service_date.parse::<Date>() else {
                        continue;
                    };
                    let b = service_day_base(d);
                    bases.insert(e.service_date.clone(), b);
                    b
                }
            };
            let plan = (b + i64::from(dep)) as f64;
            let not_started = tr.is_some_and(|t| t.not_started);
            let (eta, delay) = match tr {
                Some(_) if not_started => (Some(plan + (now_s - (b + i64::from(dep0)) as f64).max(0.0)), None),
                Some(t) => (t.pos.delay.map(|d| plan + d), t.pos.delay),
                None => (None, None),
            };
            if eta.unwrap_or(plan) < now_s - LAYOVER_GRACE_SEC {
                continue;
            }
            let mut r = Map::new();
            r.insert(
                "trip_execution_id".into(),
                tr.map_or("", |t| t.pos.exec_id.as_str()).into(),
            );
            r.insert("trip_id".into(), trip.t.trip_id.as_str().into());
            r.insert("static_time".into(), hhmm(plan).into());
            r.insert("time".into(), hhmm(eta.unwrap_or(plan)).into());
            r.insert("time_diff".into(), num_value(delay.unwrap_or(0.0)));
            r.insert("is_estimated".into(), delay.is_some().into());
            if not_started {
                r.insert("not_started".into(), true.into());
            }
            r.insert(
                "direction".into(),
                stop_headsign(trip, e.pos).unwrap_or(&trip.t.headsign).into(),
            );
            r.insert("line_name".into(), trip.t.line.as_str().into());
            r.insert("operator".into(), "GZM".into());
            if let Some(t) = tr {
                r.insert("side_number".into(), t.rec.label.as_str().into());
                if let Some(m) = t.rec.model.as_deref().filter(|m| !m.is_empty()) {
                    r.insert("model".into(), m.into());
                }
            }
            r.insert("plan_ts".into(), num_value(plan));
            r.insert("eta_ts".into(), eta.map_or(Value::Null, num_value));
            r.insert("delay_sec".into(), delay.map_or(Value::Null, num_value));
            r.insert("at_stop".into(), false.into());
            r.insert("canceled".into(), false.into());
            r.insert("trip_index".into(), e.pos.into());
            let raw_id = trip.t.trip_id.get(self.prefix.len()..).unwrap_or("");
            r.insert("row_key".into(), gzm_row_key(raw_id, i64::from(seq)).into());
            if all {
                let pole = trip
                    .t
                    .stop_ids
                    .get(e.pos)
                    .and_then(|id| post.get(id.as_str()))
                    .filter(|p| !p.is_empty());
                r.insert("pole".into(), pole.map_or(Value::Null, |p| (*p).into()));
            }
            rows.push(Value::Object(r));
        }
        drop(st);
        let mut rows = pre_sort_rows(rows, now_s);
        rows.truncate(BOARD_ROWS);
        let mut out = Map::new();
        out.insert("rows".into(), Value::Array(rows));
        out.insert("server_ts".into(), num_value(now_s));
        if group.len() > 1 {
            out.insert("poles".into(), group.len().into());
        }
        Lookup::Found(Value::Object(out))
    }

    /// A pole's whole-day timetable, `{departures}`.
    pub fn timetable(&self, stop_id: &str, date: &str) -> Lookup<Value> {
        let Some(feed) = (self.get_feed)() else {
            return Lookup::Loading;
        };
        if !feed.stops.contains_key(stop_id) {
            return Lookup::Unknown;
        }
        // never build a day table for a date the feed does not cover
        let (start, end) = (feed.start_date.as_str(), feed.end_date.as_str());
        if !start.is_empty() && !end.is_empty() && (date < start || date > end) {
            return Lookup::Found(json!({ "departures": [] }));
        }
        let departures: Vec<Value> = stop_events(&feed.router, [stop_id], date, 0, 86400, None)
            .iter()
            .map(|e| {
                let direction = feed.trip(&e.trip.trip_id).and_then(|t| stop_headsign(t, e.pos));
                json!({
                    "trip_id": e.trip.trip_id,
                    "departure": e.dep,
                    "line": e.trip.line,
                    "direction": direction.unwrap_or(&e.trip.headsign),
                    "operator": "GZM",
                })
            })
            .collect();
        Lookup::Found(json!({ "departures": departures }))
    }

    /// Static trip (no live estimates: /api/trip and /api/trips responses are cached), flat like the MZK branch of
    /// /api/trip: the trip body with the shape ref beside `times`, not the trip_execution envelope. `open` also
    /// requests the road match of its shape.
    pub fn trip(&self, trip_id: &str, open: bool) -> Lookup<Value> {
        let Some(feed) = (self.get_feed)() else {
            return Lookup::Loading;
        };
        let Some(trip) = feed.trip(trip_id) else {
            return Lookup::Unknown;
        };
        let matching = open && self.match_shape(&feed, trip, None);
        let mut env = trip_json(&feed, trip, None);
        let mut out = match env.remove("trip") {
            Some(Value::Object(body)) => body,
            _ => Map::new(),
        };
        for k in ["shape", "shape_id", "shape_status"] {
            if let Some(v) = env.remove(k) {
                out.insert(k.into(), v);
            }
        }
        if matching {
            out.insert("shape_matching".into(), true.into());
        }
        Lookup::Found(Value::Object(out))
    }

    /// Road-match the shape of an opened trip: GZM buses and trolleybuses (`gzm_match`), the part in `focus` first;
    /// true while the match runs.
    fn match_shape(&self, feed: &GzmFeed, trip: GzmTrip<'_>, focus: Option<LatLonBox>) -> bool {
        // TS also asks `unmatched` first: MATCHER.request does that before anything else
        let Some(key) = trip.x.shape_id.as_deref().filter(|_| self.slug == "gzm") else {
            return false;
        };
        let kind = feed
            .lines
            .iter()
            .find(|l| l.id == trip.t.route_id)
            .map(|l| l.kind.as_str());
        if !matches!(kind, Some("3" | "11")) {
            return false;
        }
        let refs: Vec<Option<LatLng>> = trip
            .t
            .stop_ids
            .iter()
            .map(|id| feed.stops.get(id).map(|s| [s.lat, s.lon]))
            .collect();
        MATCHER.request(&feed.shapes, key, &refs, focus)
    }

    /// Point the running road matches of shapes `ids` (wire ids) at what the rider sees.
    pub fn focus_match(&self, ids: &[String], focus: LatLonBox) {
        if self.slug != "gzm" {
            return;
        }
        let Some(feed) = (self.get_feed)() else {
            return;
        };
        for id in ids {
            MATCHER.focus(&feed.shapes, strip_rev(id), focus);
        }
    }

    /// The feed in use (None while it loads).
    pub fn current_feed(&self) -> Option<Arc<GzmFeed>> {
        (self.get_feed)()
    }

    /// Feed road shapes by wire id; every id missing while the feed loads.
    pub fn shapes(&self, ids: &[String]) -> ShapeLookup {
        match (self.get_feed)() {
            Some(feed) => feed.shapes.lookup(ids),
            None => ShapeLookup {
                missing: ids.to_vec(),
                ..ShapeLookup::default()
            },
        }
    }

    /// Connection search over the feed alone (no cross-city routing), legs tagged GZM with their shape ids; None
    /// while the feed loads. Memoized per minute (a hit keeps the delays of its minute) and searching only one
    /// fallback day. `avoid_types` = GTFS route types never ridden; running trips board at their live times.
    /// One call at a time (TS runs a search to its end on the event loop): an identical query waits, then hits
    /// the memo, and a search on a swapped-out feed cannot finish after the new feed's.
    // ponytail: the search runs on the calling thread, 100 ms to over 1 s on GZM (TS profile, 2026-10-28): a route
    // calls it from spawn_blocking; a dedicated worker pool if p95 passes ~300 ms. A caller timing this call for
    // the search budget also counts its wait for the running search; return the search's own time if that matters
    pub fn connections(&self, q: &RouteQuery<'_>, avoid_types: &[String]) -> Option<Arc<Vec<ConnectionItinerary>>> {
        let _search = self.search.lock().unwrap_or_else(PoisonError::into_inner);
        let feed = (self.get_feed)()?;
        let now = (self.now)();
        let (today, secs) = agency_clock(Timestamp::from_millisecond(now).unwrap_or(Timestamp::UNIX_EPOCH));
        let today = today.to_string();
        let after_secs = q.after_secs.or_else(|| {
            q.date
                .is_none_or(|d| d.is_empty() || d == today)
                .then_some(secs - secs % 60)
        });
        let avoid_routes: Vec<String> = feed
            .lines
            .iter()
            .filter(|l| avoid_types.contains(&l.kind))
            .map(|l| l.id.clone())
            .collect();
        let (from_ids, to_ids) = ([q.from.to_owned()], [q.to.to_owned()]);
        let mut query = RouteQuery {
            after_secs,
            from_ids: &from_ids,
            to_ids: &to_ids,
            fallback_days: Some(1),
            avoid_routes: &avoid_routes,
            live: None,
            ..*q
        };
        let key = memo_key(&query);
        let delays = {
            let mut st = self.state();
            if let Some((at, res)) = memo(&mut st, &feed).get(&key)
                && now - at <= CONN_MEMO_MS
            {
                return Some(res.clone());
            }
            st.fresh(now as f64 / 1000.0).then(|| {
                st.by_trip
                    .iter()
                    .filter(|(_, t)| !t.not_started)
                    .filter_map(|(k, t)| Some((k.clone(), t.pos.delay? as i32)))
                    .collect::<HashMap<String, i32>>()
            })
        };
        let live = delays
            .as_ref()
            .map(|m| move |id: &str, d: &str| m.get(&format!("{id}|{d}")).copied());
        query.live = live.as_ref().map(|f| f as &LiveFn);
        let mut res = find_connections_at(&query, &feed.router, &today, secs);
        for leg in res.iter_mut().flat_map(|c| c.legs.iter_mut()) {
            leg.operator = Some("GZM");
            let shape = feed.trip(&leg.trip_id).and_then(|t| t.x.shape_id.as_deref());
            if let Some(id) = shape.and_then(|s| feed.shapes.wire_id(s)) {
                leg.shape_id = Some(id);
            }
        }
        let res = Arc::new(res);
        let mut st = self.state();
        let m = memo(&mut st, &feed);
        m.shift_remove(&key);
        m.insert(key, (now, res.clone()));
        if m.len() > CONN_MEMO {
            m.shift_remove_index(0);
        }
        Some(res)
    }

    /// Live trip of vehicle `<slug>:<key>`; None when it is not on a known trip or the feed is stale.
    pub fn trip_execution(&self, exec_id: &str) -> Option<Value> {
        let key = exec_id.strip_prefix(self.prefix.as_str())?;
        let now_s = (self.now)() as f64 / 1000.0;
        let tr = {
            let st = self.state();
            if !st.fresh(now_s) {
                return None;
            }
            st.tracks.get(key).cloned()?
        };
        let (Some(idx), Some(feed)) = (tr.trip, tr.feed.as_ref()) else {
            return None;
        };
        let trip = feed.trip_at(idx);
        let matching = self.match_shape(feed, trip, Some(around(tr.pos.lat, tr.pos.lon, FOCUS_M)));
        let delay = if tr.not_started { None } else { tr.pos.delay };
        let mut out = trip_json(feed, trip, delay.map(|d| (tr.next, d)));
        if matching {
            out.insert("shape_matching".into(), true.into());
        }
        let mut vehicle = Map::new();
        vehicle.insert("lat".into(), num_value(tr.pos.lat));
        vehicle.insert("lon".into(), num_value(tr.pos.lon));
        if let Some(b) = tr.pos.bearing {
            vehicle.insert("bearing".into(), num_value(b));
        }
        out.insert("vehicle".into(), Value::Object(vehicle));
        out.insert("vehicle_trip_index".into(), tr.next.into());
        if let Some(a) = &tr.pos.arrivals {
            out.insert(
                "arrived".into(),
                a.arrived.iter().map(|t| t.map_or(Value::Null, num_value)).collect(),
            );
        }
        if tr.not_started {
            out.insert("not_started".into(), true.into());
        }
        Some(Value::Object(out))
    }

    /// The `/api/health` -> `gzm` / `zb` block of this city.
    pub fn health(&self) -> Value {
        let now = (self.now)();
        let hours = ((now - self.started_at) as f64 / 3_600_000.0).max(1.0 / 60.0);
        let mut out = {
            let st = self.state();
            let (mut matched, mut not_started, mut sdip_used, mut scheduled) = (0usize, 0usize, 0usize, 0usize);
            for t in st.tracks.values() {
                scheduled += usize::from(t.pos.scheduled);
                matched += usize::from(t.trip.is_some());
                not_started += usize::from(t.not_started);
                sdip_used += usize::from(t.pos.fix_at != Some(t.zb_fix_at));
            }
            let size = st.tracks.len();
            let vehicles = if st.fresh(now as f64 / 1000.0) { size } else { 0 };
            let watching = now - st.last_watch <= WATCH_MS;
            let paused_until = if st.sdip_paused_until > now {
                num_value(st.sdip_paused_until as f64 / 1000.0)
            } else {
                Value::Null
            };
            let m = json!({
                "slug": self.slug,
                "started": !st.tasks.is_empty(),
                "watching": watching,
                "vehicles": vehicles,
                "matched": matched,
                "unmatched": size - matched,
                "not_started": not_started,
                "scheduled": scheduled,
                "scan_count": st.scan_count,
                "last_scan": num_value(st.last_scan),
                "last_good": num_value(st.last_good),
                "last_error": st.last_error,
                "failures": st.failures,
                "poll_ms": st.poll_ms,
                "bytes_per_hour": num_value(round(st.bytes as f64 / hours)),
                "sdip": {
                    "enabled": self.sdip_url.is_some(),
                    "watching": watching,
                    "last_good": num_value(st.sdip_last_good),
                    "last_error": st.sdip_error,
                    "paused_until": paused_until,
                    "moved": st.sdip_moved,
                    "vehicles_on_sdip_fix": sdip_used,
                    "bytes_per_hour": num_value(round(st.sdip_bytes as f64 / hours)),
                },
            });
            match m {
                Value::Object(m) => m,
                _ => Map::new(),
            }
        };
        out.insert("heap_used_mb".into(), rss_mb().map_or(Value::Null, num_value));
        out.insert("feed".into(), gzm_feed_health(&self.slug));
        Value::Object(out)
    }
}

/// The post number: "02" of "Pszczelnik Park 02".
fn post_number(name: &str) -> &str {
    name.get(gzm_stop_key(name).len()..)
        .unwrap_or("")
        .trim_matches(is_space)
}

/// `trip.stopHeadsigns?.[pos]`
fn stop_headsign(trip: GzmTrip<'_>, pos: usize) -> Option<&str> {
    trip.x.stop_headsigns.as_ref()?.get(pos)?.as_deref()
}

/// `id.replace(/\.[0-9a-f]{6}$/, "")`: a shape wire id to its key.
fn strip_rev(id: &str) -> &str {
    let Some(cut) = id.len().checked_sub(7) else {
        return id;
    };
    match id.as_bytes().get(cut..) {
        Some([b'.', rev @ ..]) if rev.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) => {
            id.get(..cut).unwrap_or(id)
        }
        _ => id,
    }
}

/// The connection memo of `feed`; another feed's is dropped (its answers must not outlive it).
fn memo<'s>(st: &'s mut State, feed: &Arc<GzmFeed>) -> &'s mut IndexMap<String, (i64, Arc<Vec<ConnectionItinerary>>)> {
    let m = &mut st.conn_memo;
    if m.feed.as_ptr() != Arc::as_ptr(feed) {
        m.map.clear();
        m.feed = Arc::downgrade(feed);
    }
    &mut m.map
}

/// One string per distinct search (TS `JSON.stringify(query)`; from_ids, to_ids and fallback_days follow from it).
fn memo_key(q: &RouteQuery<'_>) -> String {
    let pt = |p: Option<Point>| p.map(|p| (p.lat, p.lon, p.walk_m));
    json!([
        q.from,
        q.to,
        pt(q.from_point),
        pt(q.to_point),
        q.after_secs,
        q.arrive_by,
        q.limit,
        q.direct_only,
        q.min_transfer_secs,
        q.max_transfer_secs,
        q.date,
        q.day_label,
        q.sort_by as u8,
        q.avoid_lines,
        q.avoid_routes,
    ])
    .to_string()
}

/// TS `tripJson`: the trip_execution envelope of `trip`; `est` = (first call index, delay s) of the live estimates.
fn trip_json(feed: &GzmFeed, trip: GzmTrip<'_>, est: Option<(usize, f64)>) -> Map<String, Value> {
    let shape_id = trip.x.shape_id.as_deref().and_then(|k| feed.shapes.wire_id(k));
    let times: Vec<Value> = trip
        .t
        .stop_ids
        .iter()
        .zip(trip.t.dep.iter())
        .enumerate()
        .map(|(i, (id, &dep))| {
            let mut m = Map::new();
            m.insert(
                "stop_name".into(),
                feed.stops.get(id).map_or("", |s| s.name.as_str()).into(),
            );
            m.insert("designator".into(), Value::Null);
            m.insert("place_id".into(), id.as_str().into());
            m.insert("departure_time".into(), clock(dep).into());
            m.insert("index".into(), i.into());
            m.insert("platform".into(), Value::Null);
            if let Some((_, diff)) = est.filter(|&(from, _)| i >= from) {
                m.insert("estimate".into(), json!({ "time_diff": num_value(diff) }));
            }
            Value::Object(m)
        })
        .collect();
    let mut out = Map::new();
    out.insert(
        "trip".into(),
        json!({
            "times": times,
            "direction": trip.t.headsign,
            "line": { "name": trip.t.line },
            "lineName": trip.t.line,
            "operator": "GZM",
        }),
    );
    out.insert("vehicle".into(), Value::Null);
    out.insert("vehicle_trip_index".into(), 0.into());
    // road geometry is fetched by id from /api/shapes (MapApp buildTrip), never inlined
    out.insert("shape".into(), Value::Null);
    if let Some(id) = shape_id {
        out.insert("shape_id".into(), id.into());
    }
    out.insert(
        "shape_status".into(),
        feed.shapes.status(trip.x.shape_id.as_deref()).into(),
    );
    out
}

/// `heap_used_mb`: a Rust process has no JS heap, so its resident memory stands in (MB, one decimal); None off Linux.
// ponytail: whole-process RSS under the TS key name; a real heap figure needs an allocator with stats
fn rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let kb: f64 = status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))?
        .trim()
        .strip_suffix("kB")?
        .trim()
        .parse()
        .ok()?;
    Some(round(kb * 1024.0 / 1e5) / 10.0)
}

#[cfg(test)]
mod tests {
    use super::strip_rev;

    #[test]
    fn strip_rev_drops_only_a_trailing_rev6() {
        assert_eq!(strip_rev("gzm:shA.0a1b2c"), "gzm:shA");
        assert_eq!(strip_rev("gzm:shA.0A1B2C"), "gzm:shA.0A1B2C");
        assert_eq!(strip_rev("gzm:sh.A.0a1b2"), "gzm:sh.A.0a1b2");
        assert_eq!(strip_rev(".abcdef"), "");
        assert_eq!(strip_rev("abcdef"), "abcdef");
    }
}
